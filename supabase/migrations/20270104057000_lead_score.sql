-- =====================================================================
-- 🔥 Admission chance (0-100) for every open lead, from the lead's own
--   data: no AI, no cost. Each rule adds or removes points; the lead
--   keeps the list of reasons so people see WHY.
--   Settings → Lead score: on/off, the start value and every rule's points.
--   Stored on leads.score (+ score_reasons, score_at), so lists can sort by it.
--   Worked out:
--     · whenever the lead changes (BEFORE trigger, no extra write)
--     · when a call / visit is added or changed (touches the lead)
--     · every night (the "days without contact" rules move on their own)
--   Admitted → 100, Lost / Cancelled → 0.
--   (Dated before 20270104060000_lead_merge so both can go in any order.)
-- =====================================================================

insert into public.app_settings (key, value, description)
values ('lead_score', jsonb_build_object(
  'enabled', true,
  'base', 30,
  'rules', jsonb_build_object(
    'visited',          25,   -- came to the campus
    'visit_planned',    10,   -- a campus visit is planned
    'fee_talk',         15,   -- fee / discount talked about
    'answered',         15,   -- the last call was answered
    'interested_stage', 10,   -- stage Interested or later
    'ready_stage',      10,   -- Papers pending / Ready for admission
    'referral',         10,   -- referred (alumni or a Referral source)
    'hot',              10,   -- rating Hot
    'cold',            -10,   -- rating Cold
    'silent_7',        -15,   -- no contact for 7+ days
    'silent_30',       -15,   -- no contact for 30+ days (on top)
    'missed_3',        -20,   -- the last 3 calls were not answered
    'wrong_number',    -40    -- the last call: wrong number
  )
), 'Lead score (admission chance): start value and points per rule')
on conflict (key) do nothing;

alter table public.leads add column if not exists score_reasons jsonb not null default '[]'::jsonb;
alter table public.leads add column if not exists score_at timestamptz;
create index if not exists leads_score_idx on public.leads (score desc) where deleted_at is null;

-- 🕰 Writing only the score must not make the lead look "just changed"
create or replace function public.set_updated_at()
returns trigger
language plpgsql
as $$
begin
  if coalesce(current_setting('app.keep_updated_at', true), '') = 'on' then
    return new;
  end if;
  new.updated_at = now();
  return new;
end;
$$;

-- ---------------------------------------------------------------------
-- The calculation (for one lead row)
-- ---------------------------------------------------------------------
create or replace function public.lead_score_of(l public.leads)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_cfg     jsonb := coalesce((select value from public.app_settings where key = 'lead_score'), '{}'::jsonb);
  v_rules   jsonb := coalesce(v_cfg -> 'rules', '{}'::jsonb);
  v_kind    text;
  v_stage   text;
  v_score   int := coalesce((v_cfg ->> 'base')::int, 30);
  v_reasons jsonb := '[]'::jsonb;
  v_last    text;
  v_missed  int;
  v_since   timestamptz;
  v_days    numeric;

begin
  select s.kind, s.key into v_kind, v_stage from public.pipeline_stages s where s.id = l.stage_id;
  if v_kind = 'won' then
    return jsonb_build_object('score', 100, 'reasons', jsonb_build_array(jsonb_build_object('key', 'admitted', 'points', 100)));
  end if;
  if v_kind in ('lost', 'cancelled') or l.deleted_at is not null then
    return jsonb_build_object('score', 0, 'reasons', jsonb_build_array(jsonb_build_object('key', 'closed', 'points', 0)));
  end if;

  -- the calls (newest first)
  select c.outcome into v_last
  from public.call_logs c
  where c.lead_id = l.id and c.deleted_at is null and c.direction in ('outgoing', 'incoming')
  order by c.called_at desc limit 1;

  select count(*) filter (where x.outcome <> 'connected') into v_missed
  from (select c.outcome from public.call_logs c
        where c.lead_id = l.id and c.deleted_at is null and c.direction = 'outgoing'
        order by c.called_at desc limit 3) x
  having count(*) = 3;

  v_since := coalesce(l.last_contacted_at, l.created_at);
  v_days := extract(epoch from (now() - v_since)) / 86400;

  -- each rule: (key, applies?)
  declare
    r record;
  begin
    for r in
      select * from (values
        ('visited',          l.visit_status = 'visited'
                               or exists (select 1 from public.lead_visits v where v.lead_id = l.id and v.status = 'visited')),
        ('visit_planned',    coalesce(l.visit_status, '') = 'planned' and coalesce(l.visit_at, now()) >= now() - interval '1 day'),
        ('fee_talk',         l.fee_status is not null),
        ('answered',         v_last = 'connected'),
        ('interested_stage', v_stage in ('interested', 'campus_visit', 'follow_up', 'papers_pending', 'ready')),
        ('ready_stage',      v_stage in ('papers_pending', 'ready')),
        ('referral',         l.referred_by_alumni_id is not null
                               or exists (select 1 from public.lead_sources s where s.id = l.source_id and s.name ilike '%referr%')),
        ('hot',              l.rating = 'hot'),
        ('cold',             l.rating = 'cold'),
        ('silent_7',         v_days >= 7),
        ('silent_30',        v_days >= 30),
        ('missed_3',         coalesce(v_missed, 0) = 3),
        ('wrong_number',     v_last = 'wrong_number')
      ) as t(key, applies)
    loop
      if coalesce(r.applies, false) and coalesce((v_rules ->> r.key)::int, 0) <> 0 then
        v_score := v_score + (v_rules ->> r.key)::int;
        v_reasons := v_reasons || jsonb_build_object('key', r.key, 'points', (v_rules ->> r.key)::int);
      end if;
    end loop;
  end;

  return jsonb_build_object('score', greatest(0, least(100, v_score)), 'reasons', v_reasons);
end;
$$;

revoke all on function public.lead_score_of(public.leads) from public, anon;

-- ---------------------------------------------------------------------
-- On every change of the lead (runs last of the BEFORE triggers)
-- ---------------------------------------------------------------------
create or replace function public.leads_score_calc()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v jsonb;
begin
  if not coalesce((select (value ->> 'enabled')::boolean from public.app_settings where key = 'lead_score'), true) then
    return new;
  end if;
  v := public.lead_score_of(new);
  new.score := (v ->> 'score')::int;
  new.score_reasons := coalesce(v -> 'reasons', '[]'::jsonb);
  new.score_at := now();
  return new;
end;
$$;

drop trigger if exists leads_zz_score on public.leads;
create trigger leads_zz_score before insert or update on public.leads
  for each row execute function public.leads_score_calc();

-- Work it out again for some leads (calls, visits, the night job, Settings)
--   Lead by lead: an old lead that breaks a newer rule (e.g. an old WhatsApp
--   number) is skipped instead of stopping all the others (and this update).
create or replace function public.refresh_lead_scores(p_lead_ids uuid[] default null)
returns int
language plpgsql
security definer
set search_path = public
as $$
declare
  n      int := 0;
  v_id   uuid;
  v_skip int := 0;
  -- put the flags back as they were (a caller may have turned them on)
  v_keep text := coalesce(current_setting('app.keep_updated_at', true), '');
  v_pipe text := coalesce(current_setting('app.pipeline_action', true), '');
begin
  perform set_config('app.keep_updated_at', 'on', true);
  perform set_config('app.pipeline_action', 'on', true);   -- not a stage move: let the guard through
  for v_id in
    select l.id from public.leads l
    where l.deleted_at is null and (p_lead_ids is null or l.id = any (p_lead_ids))
  loop
    begin
      update public.leads set score_at = now() where id = v_id;
      n := n + 1;
    exception when others then
      v_skip := v_skip + 1;
    end;
  end loop;
  perform set_config('app.pipeline_action', v_pipe, true);
  perform set_config('app.keep_updated_at', v_keep, true);
  if v_skip > 0 then
    raise notice 'Lead score: % lead(s) skipped (their data breaks a newer rule)', v_skip;
  end if;
  return n;
end;
$$;

revoke all on function public.refresh_lead_scores(uuid[]) from public, anon, authenticated;

-- 📞 / 🏫 A call or a visit changed: the lead's score moves
create or replace function public.lead_score_touch()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_lead uuid := coalesce(new.lead_id, old.lead_id);
begin
  if v_lead is not null and coalesce(current_setting('app.score_touch', true), '') <> 'on' then
    perform set_config('app.score_touch', 'on', true);
    begin
      perform public.refresh_lead_scores(array[v_lead]);
    exception when others then
      -- a score must never stop a call or a visit from being saved
      null;
    end;
    perform set_config('app.score_touch', '', true);
  end if;
  return null;
end;
$$;

drop trigger if exists call_logs_score on public.call_logs;
create trigger call_logs_score after insert or update or delete on public.call_logs
  for each row execute function public.lead_score_touch();
drop trigger if exists lead_visits_score on public.lead_visits;
create trigger lead_visits_score after insert or update or delete on public.lead_visits
  for each row execute function public.lead_score_touch();

-- ⚙️ Admins: work everything out again (after changing the points)
create or replace function public.recalc_lead_scores()
returns int
language plpgsql
security definer
set search_path = public
as $$
begin
  if not public.has_permission('settings.manage') then raise exception 'Only an admin can do this.'; end if;
  return public.refresh_lead_scores(null);
end;
$$;

revoke all on function public.recalc_lead_scores() from public, anon;
grant execute on function public.recalc_lead_scores() to authenticated;

-- 🌙 Every night (02:10 Dhaka = 20:10 UTC): open leads only
create or replace function public.lead_scores_nightly()
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  perform public.refresh_lead_scores(array(
    select l.id from public.leads l join public.pipeline_stages s on s.id = l.stage_id
    where l.deleted_at is null and s.kind = 'open'));
end;
$$;

revoke all on function public.lead_scores_nightly() from public, anon, authenticated;

do $$
begin
  if exists (select 1 from pg_namespace where nspname = 'cron') then
    begin perform cron.unschedule('lead-scores-nightly'); exception when others then null; end;
    perform cron.schedule('lead-scores-nightly', '10 20 * * *', 'select public.lead_scores_nightly()');
  end if;
end $$;

-- First time: every lead gets its score now
select public.refresh_lead_scores(null);
