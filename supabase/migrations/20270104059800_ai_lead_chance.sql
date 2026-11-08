-- =====================================================================
-- 🔮 Chance of admission by AI (Claude), with what to do and say
--   For each open lead the AI reads the calls (answered or not, minutes,
--   the hour they answer), every note by everyone, visits, fee talks,
--   papers, hand-overs and next calls, plus how often leads like this one
--   were admitted before. It gives a chance (0-100%), why, the doubts it
--   heard, the next steps, and short lines to say (in Bangla).
--   · When: a person presses "Check" on the lead page, and by itself after
--     a new call / note (at most once a day for each lead: a second one
--     the same day is looked at the next morning)
--   · Everyone sees it on the leads they can see (Settings → AI can narrow)
--   · Works in the background (queue + the ai-lead-chance Edge Function);
--     the lists only read the saved answer
--   Needs 20270104059700_ai_admission_credit (the key, the story builder).
--   (Dated before 20270104060000_lead_merge so both can go in any order.)
-- =====================================================================

-- ---------------------------------------------------------------------
-- ⚙️ Setting
-- ---------------------------------------------------------------------
insert into public.app_settings (key, value, description)
values ('ai_chance', jsonb_build_object(
  'enabled', true,
  'auto', true,
  'model', 'claude-sonnet-5-5',
  'effort', 'medium',
  'window_days', 180,
  'daily_auto_limit', 100,
  'view', jsonb_build_object('all', true, 'roles', '[]'::jsonb, 'people', '[]'::jsonb),
  'guidance', ''
), 'AI chance of admission: on/off, by itself after calls/notes, who sees it, the most a day, extra guidance')
on conflict (key) do nothing;

create or replace function public.ai_chance_setting()
returns jsonb
language sql
stable
security definer
set search_path = public
as $$
  select coalesce((select value from public.app_settings where key = 'ai_chance'), '{}'::jsonb);
$$;
revoke all on function public.ai_chance_setting() from public, anon, authenticated;

-- May I see AI chances? (admins always; then Settings → AI)
create or replace function public.ai_chance_can_view()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select public.is_active_user()
    and coalesce((public.ai_chance_setting() ->> 'enabled')::boolean, false)
    and (
      public.has_permission('settings.manage')
      or exists (
        select 1
        from public.profiles p
        where p.id = auth.uid()
          and (coalesce((public.ai_chance_setting() -> 'view' ->> 'all')::boolean, false)
               or (public.ai_chance_setting() -> 'view' -> 'roles') ? p.role_key
               or (public.ai_chance_setting() -> 'view' -> 'people') ? p.id::text)));
$$;
revoke all on function public.ai_chance_can_view() from public, anon;
grant execute on function public.ai_chance_can_view() to authenticated;

-- ---------------------------------------------------------------------
-- 🔮 The answers, one row per lead
--   status: pending (waits until due_at) → working → done (or failed)
--   stale: something new came while the AI was working → look again
-- ---------------------------------------------------------------------
create table if not exists public.lead_chances (
  lead_id      uuid primary key references public.leads (id) on delete cascade,
  status       text not null default 'pending' check (status in ('pending', 'working', 'done', 'failed')),
  due_at       timestamptz not null default now(),
  manual       boolean not null default false,      -- someone pressed "Check"
  requested_by uuid references public.profiles (id) on delete set null,
  requested_at timestamptz not null default now(),
  stale        boolean not null default false,
  chance       smallint check (chance is null or chance between 0 and 100),
  level        text check (level is null or level in ('hot', 'warm', 'cold')),
  prev_chance  smallint,
  summary      text,
  good         jsonb not null default '[]'::jsonb,  -- ["…"]
  risks        jsonb not null default '[]'::jsonb,  -- ["…"]
  objections   jsonb not null default '[]'::jsonb,  -- [{kind, detail}]
  actions      jsonb not null default '[]'::jsonb,  -- [{text, why}]
  script       jsonb not null default '[]'::jsonb,  -- [{situation, lines: ["…"]}]
  best_time    text,
  next_call_days smallint,
  next_call_why  text,
  model        text,
  usage        jsonb,
  error        text,
  attempts     int not null default 0,
  started_at   timestamptz,
  done_at      timestamptz,
  stage_at_done text                                 -- open / won / lost later: how right it was
);
create index if not exists lead_chances_due_idx on public.lead_chances (due_at) where status = 'pending';
create index if not exists lead_chances_chance_idx on public.lead_chances (chance desc) where chance is not null;
alter table public.lead_chances enable row level security;
drop policy if exists "lead chances: read" on public.lead_chances;
create policy "lead chances: read" on public.lead_chances
  for select to authenticated
  using ((select public.ai_chance_can_view()) and exists (select 1 from public.leads l where l.id = lead_chances.lead_id));
revoke insert, update, delete on public.lead_chances from anon, authenticated;

-- ---------------------------------------------------------------------
-- 📥 Into the queue
--   p_manual: pressed "Check" → now. By itself (after a call / note):
--   in 3 minutes (a few calls in a row become one look), or tomorrow
--   7 am if this lead was already looked at today.
-- ---------------------------------------------------------------------
create or replace function public.ai_chance_mark(p_leads uuid[], p_manual boolean default false)
returns int
language plpgsql
security definer
set search_path = public
as $$
declare
  s       jsonb := public.ai_chance_setting();
  v_today date := (now() at time zone 'Asia/Dhaka')::date;
  v_next  timestamptz := ((v_today + 1)::timestamp + interval '7 hours') at time zone 'Asia/Dhaka';
  n       int;
begin
  if coalesce(array_length(p_leads, 1), 0) = 0 then return 0; end if;
  if not coalesce((s ->> 'enabled')::boolean, false) then return 0; end if;
  if not p_manual and not coalesce((s ->> 'auto')::boolean, true) then return 0; end if;

  insert into public.lead_chances as lc (lead_id, status, due_at, manual, requested_by, requested_at)
  select l.id, 'pending',
         case when p_manual then now() else now() + interval '3 minutes' end,
         p_manual, case when p_manual then auth.uid() end, now()
  from public.leads l
  join public.pipeline_stages st on st.id = l.stage_id and st.kind = 'open'
  where l.id = any (p_leads) and l.deleted_at is null
  on conflict (lead_id) do update
    set status = 'pending',
        manual = lc.manual or excluded.manual,
        requested_by = coalesce(excluded.requested_by, lc.requested_by),
        requested_at = now(),
        attempts = case when lc.status = 'failed' then 0 else lc.attempts end,
        due_at = case
          when excluded.manual then now()
          when lc.status = 'pending' then lc.due_at                      -- already waiting: keep its time
          when lc.done_at is not null and (lc.done_at at time zone 'Asia/Dhaka')::date = v_today then v_next
          else excluded.due_at end
    where lc.status <> 'working';
  get diagnostics n = row_count;

  -- being worked on right now: look again after it
  update public.lead_chances set stale = true
  where lead_id = any (p_leads) and status = 'working' and not stale;
  return n;
end;
$$;
revoke all on function public.ai_chance_mark(uuid[], boolean) from public, anon, authenticated;

-- "Check" on the lead page (anyone who can see the lead; at most 40 an hour each)
create or replace function public.ai_chance_request(p_lead uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if not public.ai_chance_can_view() then raise exception 'AI chance is not on for you.'; end if;
  if not exists (select 1 from public.leads l where l.id = p_lead and l.deleted_at is null
                 and public.can_view_lead(l.assigned_to)) then
    raise exception 'Lead not found.';
  end if;
  if not exists (select 1 from public.leads l join public.pipeline_stages s on s.id = l.stage_id
                 where l.id = p_lead and s.kind = 'open') then
    raise exception 'Only open leads (not admitted or lost).';
  end if;
  if (select count(*) from public.lead_chances where requested_by = auth.uid() and manual
        and requested_at > now() - interval '1 hour') >= 40 then
    raise exception 'Too many checks this hour. Please wait a little.';
  end if;
  if not exists (select 1 from public.ai_secrets where name = 'anthropic') then
    raise exception 'The Claude API key is not set yet (Settings → AI).';
  end if;
  perform public.ai_chance_mark(array[p_lead], true);
end;
$$;
revoke all on function public.ai_chance_request(uuid) from public, anon;
grant execute on function public.ai_chance_request(uuid) to authenticated;

-- 📞 a new call / 📝 note → the queue (one statement: one small insert, however many rows)
create or replace function public.ai_chance_on_calls()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  perform public.ai_chance_mark(array(
    select distinct n.lead_id from new_rows n
    where n.lead_id is not null and n.user_id is not null and n.deleted_at is null), false);
  return null;
end;
$$;
drop trigger if exists call_logs_ai_chance on public.call_logs;
create trigger call_logs_ai_chance after insert on public.call_logs
  referencing new table as new_rows
  for each statement execute function public.ai_chance_on_calls();

create or replace function public.ai_chance_on_activity()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  perform public.ai_chance_mark(array(
    select distinct n.lead_id from new_rows n
    where n.lead_id is not null
      and n.action in ('note_added', 'visit_planned', 'visit_done', 'paper_received', 'fee_offer', 'fee_discount',
                       'web_form')), false);
  return null;
end;
$$;
drop trigger if exists lead_activity_ai_chance on public.lead_activity;
create trigger lead_activity_ai_chance after insert on public.lead_activity
  referencing new table as new_rows
  for each statement execute function public.ai_chance_on_activity();

-- ---------------------------------------------------------------------
-- 📜 One open lead for the AI (the server only)
-- ---------------------------------------------------------------------
create or replace function public.ai_chance_input(p_lead uuid)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  l       record;
  s       jsonb := public.ai_chance_setting();
  v_days  int := coalesce((s ->> 'window_days')::int, 180);
  v_now   timestamptz := now();
  v_hours jsonb;
  v_base  jsonb;
  v_fu    jsonb;
begin
  select ld.*, st.name as stage_name, st.kind as stage_kind, src.name as source_name,
         (select string_agg(c.name, ', ' order by c.name) from public.lead_courses lc join public.courses c on c.id = lc.course_id
          where lc.lead_id = ld.id) as course_names,
         (select lc.chance from public.lead_chances lc where lc.lead_id = ld.id) as last_chance
  into l
  from public.leads ld
  join public.pipeline_stages st on st.id = ld.stage_id
  left join public.lead_sources src on src.id = ld.source_id
  where ld.id = p_lead and ld.deleted_at is null;
  if l.id is null or l.stage_kind <> 'open' then return null; end if;

  -- ⏰ when they pick up (Dhaka hour of answered vs not answered calls)
  select jsonb_object_agg(h, jsonb_build_object('answered', a, 'not_answered', n) order by h)
  into v_hours
  from (
    select extract(hour from c.called_at at time zone 'Asia/Dhaka')::int as h,
           count(*) filter (where c.outcome = 'connected') as a,
           count(*) filter (where c.outcome <> 'connected') as n
    from public.call_logs c
    where c.lead_id = p_lead and c.deleted_at is null and c.channel = 'phone'
    group by 1
  ) x;

  -- 📊 how often leads like this were admitted (closed in the last year)
  select jsonb_build_object(
           'same_course', (select jsonb_build_object('admitted', count(*) filter (where s2.kind = 'won'),
                                                     'lost', count(*) filter (where s2.kind = 'lost'))
                           from public.leads o
                           join public.pipeline_stages s2 on s2.id = o.stage_id and s2.kind in ('won', 'lost')
                           where o.deleted_at is null and o.closed_at > v_now - interval '365 days'
                             and o.id <> p_lead
                             and exists (select 1 from public.lead_courses a join public.lead_courses b on a.course_id = b.course_id
                                         where a.lead_id = o.id and b.lead_id = p_lead)),
           'same_source', (select jsonb_build_object('admitted', count(*) filter (where s2.kind = 'won'),
                                                     'lost', count(*) filter (where s2.kind = 'lost'))
                           from public.leads o
                           join public.pipeline_stages s2 on s2.id = o.stage_id and s2.kind in ('won', 'lost')
                           where o.deleted_at is null and o.closed_at > v_now - interval '365 days'
                             and o.id <> p_lead and l.source_id is not null and o.source_id = l.source_id))
  into v_base;

  -- ⏰ next calls set and missed
  select jsonb_build_object(
           'next_call_due', to_char(l.next_follow_up_at at time zone 'Asia/Dhaka', 'YYYY-MM-DD HH24:MI'),
           'missed_next_calls', (select count(*) from public.follow_ups f where f.lead_id = p_lead and f.status = 'pending'
                                   and f.due_at < v_now - interval '1 day'),
           'done_late', (select count(*) from public.follow_ups f where f.lead_id = p_lead and f.status = 'done'
                           and (f.completed_at at time zone 'Asia/Dhaka')::date > (f.due_at at time zone 'Asia/Dhaka')::date))
  into v_fu;

  return jsonb_build_object(
    'today', to_char(v_now at time zone 'Asia/Dhaka', 'YYYY-MM-DD (Dy) HH24:MI'),
    'lead', jsonb_strip_nulls(jsonb_build_object(
      'stage', l.stage_name,
      'added', to_char(l.created_at at time zone 'Asia/Dhaka', 'YYYY-MM-DD'),
      'days_since_added', floor(extract(epoch from (v_now - l.created_at)) / 86400),
      'last_contacted_days_ago', case when l.last_contacted_at is not null
                                      then floor(extract(epoch from (v_now - l.last_contacted_at)) / 86400) end,
      'never_contacted', l.last_contacted_at is null,
      'source', l.source_name,
      'courses', l.course_names,
      'area', l.area,
      'rating_by_staff', l.rating,
      'referred_by_alumnus', l.referred_by_alumni_id is not null,
      'call_attempts', l.call_attempts,
      'campus_visit', case when l.visit_status is not null then jsonb_strip_nulls(jsonb_build_object(
                         'status', l.visit_status, 'at', to_char(l.visit_at at time zone 'Asia/Dhaka', 'YYYY-MM-DD'))) end,
      'fee', case when l.fee_status is not null then jsonb_strip_nulls(jsonb_build_object(
                'status', l.fee_status, 'full', l.fee_full, 'discount', l.fee_discount, 'final', l.fee_final)) end,
      'papers_received', nullif(l.papers_received, 0),
      'previous_ai_chance', l.last_chance,
      'window_days', v_days)),
    'next_calls', v_fu,
    'answer_hours', coalesce(v_hours, '{}'::jsonb),
    'like_this_before', v_base)
    || public.ai_lead_story(p_lead, v_now - make_interval(days => greatest(v_days, 7)), v_now, false, 200);
end;
$$;
revoke all on function public.ai_chance_input(uuid) from public, anon, authenticated;
grant execute on function public.ai_chance_input(uuid) to service_role;

-- ---------------------------------------------------------------------
-- ⚙️ The queue (the server only)
-- ---------------------------------------------------------------------
-- Take up to p_limit due leads: "Check" first; by-itself ones only while
-- today's limit lasts (the rest wait for tomorrow)
create or replace function public.ai_chance_claim(p_limit int default 3)
returns setof uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_cap   int := coalesce((public.ai_chance_setting() ->> 'daily_auto_limit')::int, 100);
  v_today date := (now() at time zone 'Asia/Dhaka')::date;
  v_used  int;
begin
  select count(*) into v_used from public.lead_chances
  where not manual and done_at is not null and (done_at at time zone 'Asia/Dhaka')::date = v_today;

  return query
  update public.lead_chances lc
     set status = 'working', started_at = now(), attempts = lc.attempts + 1, stale = false
   where lc.lead_id in (
     select x.lead_id from public.lead_chances x
     where (x.status = 'pending' and x.due_at <= now() and (x.manual or v_used < v_cap))
        or (x.status = 'working' and x.started_at < now() - interval '10 minutes')
     order by x.manual desc, x.due_at
     limit greatest(1, least(p_limit, 10))
     for update skip locked)
  returning lc.lead_id;
end;
$$;
revoke all on function public.ai_chance_claim(int) from public, anon, authenticated;
grant execute on function public.ai_chance_claim(int) to service_role;

-- The AI's answer (p_r: chance, summary, good, risks, objections, actions,
-- script, best_time, next_call_days, next_call_why)
create or replace function public.ai_chance_save(p_lead uuid, p_r jsonb, p_model text, p_usage jsonb)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_chance int := greatest(0, least(100, round(coalesce((p_r ->> 'chance')::numeric, 0))));
  v_stale  boolean;
  v_next   timestamptz := (((now() at time zone 'Asia/Dhaka')::date + 1)::timestamp + interval '7 hours') at time zone 'Asia/Dhaka';
begin
  select stale into v_stale from public.lead_chances where lead_id = p_lead;
  update public.lead_chances
     set status = case when coalesce(v_stale, false) then 'pending' else 'done' end,
         due_at = case when coalesce(v_stale, false) then v_next else due_at end,
         stale = false,
         manual = false,
         prev_chance = chance,
         chance = v_chance,
         level = case when v_chance >= 60 then 'hot' when v_chance >= 30 then 'warm' else 'cold' end,
         summary = left(p_r ->> 'summary', 600),
         good = coalesce(p_r -> 'good', '[]'::jsonb),
         risks = coalesce(p_r -> 'risks', '[]'::jsonb),
         objections = coalesce(p_r -> 'objections', '[]'::jsonb),
         actions = coalesce(p_r -> 'actions', '[]'::jsonb),
         script = coalesce(p_r -> 'script', '[]'::jsonb),
         best_time = left(p_r ->> 'best_time', 200),
         next_call_days = greatest(0, least(60, coalesce((p_r ->> 'next_call_days')::int, 1))),
         next_call_why = left(p_r ->> 'next_call_why', 300),
         model = p_model, usage = p_usage, error = null, done_at = now(), attempts = 0,
         stage_at_done = 'open'
   where lead_id = p_lead;
end;
$$;
revoke all on function public.ai_chance_save(uuid, jsonb, text, jsonb) from public, anon, authenticated;
grant execute on function public.ai_chance_save(uuid, jsonb, text, jsonb) to service_role;

create or replace function public.ai_chance_fail(p_lead uuid, p_error text, p_retry boolean default true)
returns void
language sql
security definer
set search_path = public
as $$
  update public.lead_chances
     set status = case when p_retry and attempts < 3 then 'pending' else 'failed' end,
         due_at = now() + interval '5 minutes',
         manual = case when p_retry and attempts < 3 then manual else false end,
         error = left(p_error, 500)
   where lead_id = p_lead and status = 'working';
$$;
revoke all on function public.ai_chance_fail(uuid, text, boolean) from public, anon, authenticated;
grant execute on function public.ai_chance_fail(uuid, text, boolean) to service_role;

-- Busy / key refused / no credit: back to the queue, this try does not count
create or replace function public.ai_chance_release(p_lead uuid)
returns void
language sql
security definer
set search_path = public
as $$
  update public.lead_chances
     set status = 'pending', attempts = greatest(attempts - 1, 0)
   where lead_id = p_lead and status = 'working';
$$;
revoke all on function public.ai_chance_release(uuid) from public, anon, authenticated;
grant execute on function public.ai_chance_release(uuid) to service_role;

-- A lead admitted / lost: nothing more to look at; keep the last answer
-- (it shows later how right the AI was)
create or replace function public.ai_chance_on_close()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  update public.lead_chances
     set stage_at_done = case when s.kind in ('won', 'lost', 'cancelled') then s.kind else 'open' end,
         status = case when s.kind <> 'open' and lead_chances.status = 'pending' then 'done' else lead_chances.status end
  from public.pipeline_stages s
  where s.id = new.stage_id and lead_chances.lead_id = new.id;
  return null;
end;
$$;
drop trigger if exists leads_ai_chance_close on public.leads;
create trigger leads_ai_chance_close after update of stage_id on public.leads
  for each row when (new.stage_id is distinct from old.stage_id)
  execute function public.ai_chance_on_close();

-- ⏱ Every 2 minutes: wake the Edge Function only when something is due
create or replace function public.ai_chance_kick()
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_url    text := (select value from public.ai_secrets where name = 'functions_url');
  v_secret text := (select value from public.ai_secrets where name = 'cron_secret');
begin
  if to_regproc('net.http_post') is null or v_url is null or v_secret is null then return; end if;
  if not coalesce((public.ai_chance_setting() ->> 'enabled')::boolean, false)
     or not exists (select 1 from public.ai_secrets where name = 'anthropic' and last_error is null) then
    return;
  end if;
  if not exists (select 1 from public.lead_chances
                 where (status = 'pending' and due_at <= now())
                    or (status = 'working' and started_at < now() - interval '10 minutes')) then
    return;
  end if;
  perform net.http_post(
    url := v_url || '/ai-lead-chance',
    body := '{}'::jsonb,
    headers := jsonb_build_object('Content-Type', 'application/json', 'x-cron-secret', v_secret),
    timeout_milliseconds := 5000);
end;
$$;
revoke all on function public.ai_chance_kick() from public, anon, authenticated;

do $$
begin
  if exists (select 1 from pg_namespace where nspname = 'cron') then
    begin perform cron.unschedule('ai-lead-chance'); exception when others then null; end;
    perform cron.schedule('ai-lead-chance', '*/2 * * * *', 'select public.ai_chance_kick()');
  end if;
end $$;

-- ---------------------------------------------------------------------
-- 👀 Reading
-- ---------------------------------------------------------------------
-- The lead page card (RLS: only leads I can see, only if allowed)
create or replace function public.lead_ai_chance(p_lead uuid)
returns jsonb
language sql
stable
security invoker
set search_path = public
as $$
  select case
    when not public.ai_chance_can_view() then null
    when not exists (select 1 from public.leads l where l.id = p_lead) then null
    else coalesce((
      select jsonb_build_object(
        'status', c.status, 'due_at', c.due_at, 'manual', c.manual,
        'chance', c.chance, 'level', c.level, 'prev_chance', c.prev_chance,
        'summary', c.summary, 'good', c.good, 'risks', c.risks, 'objections', c.objections,
        'actions', c.actions, 'script', c.script, 'best_time', c.best_time,
        'next_call_days', c.next_call_days, 'next_call_why', c.next_call_why,
        'done_at', c.done_at, 'error', c.error)
      from public.lead_chances c where c.lead_id = p_lead), jsonb_build_object('status', 'none'))
  end;
$$;
revoke all on function public.lead_ai_chance(uuid) from public, anon;
grant execute on function public.lead_ai_chance(uuid) to authenticated;

-- 🏠 Home: my open leads to call first today (a good chance, not talked
--   to today, no next call later than today)
create or replace function public.ai_chance_today(p_limit int default 5)
returns table (lead_id uuid, name text, chance smallint, level text, prev_chance smallint,
               action text, best_time text, days_since int)
language sql
stable
security invoker
set search_path = public
as $$
  select l.id, l.name, c.chance, c.level, c.prev_chance,
         c.actions -> 0 ->> 'text', c.best_time,
         case when l.last_contacted_at is not null
              then floor(extract(epoch from (now() - l.last_contacted_at)) / 86400)::int end
  from public.leads l
  join public.pipeline_stages s on s.id = l.stage_id and s.kind = 'open'
  join public.lead_chances c on c.lead_id = l.id and c.chance is not null
  where (select public.ai_chance_can_view())
    and l.deleted_at is null
    and l.assigned_to = auth.uid()
    and c.chance >= 30
    and (l.last_contacted_at is null
         or (l.last_contacted_at at time zone 'Asia/Dhaka')::date < (now() at time zone 'Asia/Dhaka')::date)
    and (l.next_follow_up_at is null
         or (l.next_follow_up_at at time zone 'Asia/Dhaka')::date <= (now() at time zone 'Asia/Dhaka')::date)
  order by c.chance desc, l.last_contacted_at nulls first
  limit greatest(1, least(coalesce(p_limit, 5), 20));
$$;
revoke all on function public.ai_chance_today(int) from public, anon;
grant execute on function public.ai_chance_today(int) to authenticated;

-- ⚙️ Settings → AI: how far the work is, the cost, how right it was
create or replace function public.ai_chance_overview()
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_today date := (now() at time zone 'Asia/Dhaka')::date;
begin
  if not public.has_permission('settings.manage') then raise exception 'Only an admin can see this.'; end if;
  return jsonb_build_object(
    'pending', (select count(*) from public.lead_chances where status in ('pending', 'working')),
    'done', (select count(*) from public.lead_chances where chance is not null),
    'failed', (select count(*) from public.lead_chances where status = 'failed'),
    'today', (select count(*) from public.lead_chances where done_at is not null and (done_at at time zone 'Asia/Dhaka')::date = v_today),
    'open_without', (select count(*) from public.leads l join public.pipeline_stages s on s.id = l.stage_id and s.kind = 'open'
                     where l.deleted_at is null and not exists (select 1 from public.lead_chances c where c.lead_id = l.id)),
    'last_error', (select error from public.lead_chances where error is not null order by requested_at desc limit 1),
    'tokens_in', (select coalesce(sum((usage ->> 'input_tokens')::bigint), 0) from public.lead_chances where usage is not null),
    'tokens_out', (select coalesce(sum((usage ->> 'output_tokens')::bigint), 0) from public.lead_chances where usage is not null),
    -- how right: of the leads closed after a look, how many were admitted, by the last level
    'accuracy', coalesce((select jsonb_object_agg(level, jsonb_build_object('admitted', a, 'lost', n))
                          from (select level, count(*) filter (where stage_at_done = 'won') as a,
                                       count(*) filter (where stage_at_done = 'lost') as n
                                from public.lead_chances where level is not null and stage_at_done in ('won', 'lost')
                                group by level) x), '{}'::jsonb));
end;
$$;
revoke all on function public.ai_chance_overview() from public, anon;
grant execute on function public.ai_chance_overview() to authenticated;

-- Every open lead without a look yet → the queue (admins; once, e.g. at the
-- start). They go in as "by itself": today's limit applies, the rest follow
-- on the next days.
create or replace function public.ai_chance_queue_open()
returns int
language plpgsql
security definer
set search_path = public
as $$
declare
  n int;
begin
  if not public.has_permission('settings.manage') then raise exception 'Only an admin can do this.'; end if;
  insert into public.lead_chances (lead_id, status, due_at)
  select l.id, 'pending', now()
  from public.leads l
  join public.pipeline_stages s on s.id = l.stage_id and s.kind = 'open'
  where l.deleted_at is null
  on conflict (lead_id) do update set status = 'pending', due_at = now(), attempts = 0, error = null
    where lead_chances.status = 'failed';
  get diagnostics n = row_count;
  return n;
end;
$$;
revoke all on function public.ai_chance_queue_open() from public, anon;
grant execute on function public.ai_chance_queue_open() to authenticated;
