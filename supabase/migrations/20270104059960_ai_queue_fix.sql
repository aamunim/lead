-- =====================================================================
-- 🔧 AI chance / credit: the queue, more carefully
--   · "Check" and admins' "now" groups no longer use up the daily limit
--     for the by-itself looks (each look remembers how it was asked)
--   · "Check" pressed while the AI is already looking: the next look is at
--     once, not tomorrow
--   · a lead the server keeps getting stopped on (too slow) gives up after
--     3 tries instead of being sent again every 10 minutes
--   · admission credit: a failed try waits 5 minutes before the next one
--   · the 2-minute job wakes the server only when something can really run
--   (Dated before 20270104060000_lead_merge so both can go in any order.)
-- =====================================================================

alter table public.lead_chances add column if not exists stale_manual boolean not null default false;
-- how the last look was asked: auto (call / note / daily run), manual ("Check"), bulk (an admin's group)
alter table public.lead_chances add column if not exists last_kind text;
update public.lead_chances set last_kind = 'auto' where last_kind is null and done_at is not null;

create or replace function public.ai_chance_mark(p_leads uuid[], p_manual boolean default false)
returns int
language plpgsql
security definer
set search_path = public
as $$
declare
  s       jsonb := public.ai_chance_setting();
  v_today date := (now() at time zone 'Asia/Dhaka')::date;
  v_next  timestamptz := public.ai_chance_next_run();
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
          when lc.status = 'pending' then lc.due_at
          when lc.done_at is not null and (lc.done_at at time zone 'Asia/Dhaka')::date = v_today then v_next
          else excluded.due_at end
    where lc.status <> 'working';
  get diagnostics n = row_count;

  -- being worked on right now: look again after it (at once if someone pressed "Check")
  update public.lead_chances set stale = true, stale_manual = stale_manual or p_manual
  where lead_id = any (p_leads) and status = 'working';
  return n;
end;
$$;
revoke all on function public.ai_chance_mark(uuid[], boolean) from public, anon, authenticated;

create or replace function public.ai_chance_claim(p_limit int default 3)
returns setof uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_cap    int := greatest(0, coalesce((public.ai_chance_setting() ->> 'daily_auto_limit')::int, 100));
  v_today  date := (now() at time zone 'Asia/Dhaka')::date;
  v_used   int;
  v_budget boolean := public.ai_budget_ok();
begin
  select count(*) into v_used from public.lead_chances
  where last_kind = 'auto' and done_at is not null and (done_at at time zone 'Asia/Dhaka')::date = v_today;

  -- tried 3 times and the server was stopped each time (too slow): give up
  update public.lead_chances
     set status = 'failed', error = 'The AI took too long (3 tries).', manual = false, bulk = false
   where status = 'working' and started_at < now() - interval '10 minutes' and attempts >= 3;

  return query
  update public.lead_chances lc
     set status = 'working', started_at = now(), attempts = lc.attempts + 1, stale = false, stale_manual = false,
         last_kind = case when lc.manual then 'manual' when lc.bulk then 'bulk' else 'auto' end
   where lc.lead_id in (
     select x.lead_id from public.lead_chances x
     where (x.status = 'pending' and x.due_at <= now()
            and (x.manual or (v_budget and (x.bulk or v_used < v_cap))))
        or (x.status = 'working' and x.started_at < now() - interval '10 minutes')
     order by x.manual desc, x.bulk desc, x.due_at
     limit greatest(1, least(p_limit, 10))
     for update skip locked)
  returning lc.lead_id;
end;
$$;
revoke all on function public.ai_chance_claim(int) from public, anon, authenticated;
grant execute on function public.ai_chance_claim(int) to service_role;

create or replace function public.ai_chance_save(p_lead uuid, p_r jsonb, p_model text, p_usage jsonb)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_chance int := greatest(0, least(100, round(coalesce((p_r ->> 'chance')::numeric, 0))));
  v_stale  boolean;
  v_now_again boolean;
  v_next   timestamptz := public.ai_chance_next_run();
begin
  select stale, stale_manual into v_stale, v_now_again from public.lead_chances where lead_id = p_lead;
  update public.lead_chances
     set status = case when coalesce(v_stale, false) then 'pending' else 'done' end,
         -- something new came while working: again (at once if someone pressed "Check")
         due_at = case when coalesce(v_stale, false) then
                    case when coalesce(v_now_again, false) then now() else v_next end
                  else due_at end,
         stale = false,
         stale_manual = false,
         manual = coalesce(v_stale, false) and coalesce(v_now_again, false),
         bulk = false,
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

create or replace function public.ai_chance_counts(p_older_days int default 15)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
set jit = off
as $$
declare
  v_today date := (now() at time zone 'Asia/Dhaka')::date;
  v_out   jsonb;
begin
  if not public.has_permission('settings.manage') then raise exception 'Only an admin can see this.'; end if;
  with o as (
    select l.id, c.status, c.chance, c.done_at, c.manual, c.bulk, c.due_at,
           (c.chance is not null and public.ai_chance_changed(l.id, c.done_at)) as changed
    from public.leads l
    join public.pipeline_stages s on s.id = l.stage_id and s.kind = 'open'
    left join public.lead_chances c on c.lead_id = l.id
    where l.deleted_at is null
  ), u as (
    select coalesce(sum(runs), 0) as runs, coalesce(sum(public.ai_cost_usd(input_tokens, output_tokens)), 0) as cost
    from public.ai_usage_daily where feature = 'chance'
  )
  select jsonb_build_object(
    'open', (select count(*) from o),
    'never', (select count(*) from o where chance is null and coalesce(status, '') not in ('pending', 'working')),
    'changed', (select count(*) from o where changed and status not in ('pending', 'working')),
    'older', (select count(*) from o where chance is not null and status not in ('pending', 'working')
                and done_at < now() - make_interval(days => greatest(1, coalesce(p_older_days, 15)))),
    'today', (select count(*) from o where chance is not null and status not in ('pending', 'working')
                and (done_at at time zone 'Asia/Dhaka')::date = v_today),
    'today_changed', (select count(*) from o where changed and status not in ('pending', 'working')
                and (done_at at time zone 'Asia/Dhaka')::date = v_today),
    'waiting_now', (select count(*) from public.lead_chances where status = 'pending' and due_at <= now()),
    'waiting_later', (select count(*) from public.lead_chances where status = 'pending' and due_at > now()),
    'working', (select count(*) from public.lead_chances where status = 'working'),
    'done_today', (select count(*) from public.lead_chances where done_at is not null
                     and (done_at at time zone 'Asia/Dhaka')::date = v_today),
    'auto_today', (select count(*) from public.lead_chances where last_kind = 'auto' and done_at is not null
                     and (done_at at time zone 'Asia/Dhaka')::date = v_today),
    'avg_cost', (select case when runs >= 5 then round(cost / runs, 4) else 0.03 end from u),
    'spent_month', public.ai_month_spent(),
    'budget_ok', public.ai_budget_ok(),
    'last_daily_run', (select last_day from public.ai_jobs where name = 'chance_daily'))
  into v_out;
  return v_out;
end;
$$;
revoke all on function public.ai_chance_counts(int) from public, anon;
grant execute on function public.ai_chance_counts(int) to authenticated;

create or replace function public.ai_chance_request_many(p_leads uuid[], p_force boolean default false)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_today date := (now() at time zone 'Asia/Dhaka')::date;
  v_ids   uuid[];
  v_fresh int;
  v_n     int;
begin
  if not public.ai_chance_can_view() then raise exception 'AI chance is not on for you.'; end if;
  if not exists (select 1 from public.ai_secrets where name = 'anthropic') then
    raise exception 'The Claude API key is not set yet (Settings → AI).';
  end if;
  if coalesce(array_length(p_leads, 1), 0) > 50 then raise exception 'Mark at most 50 leads for AI at a time.'; end if;
  if not public.has_permission('settings.manage')
     and (select count(*) from public.lead_chances where requested_by = auth.uid()
            and (manual or last_kind = 'manual')
            and requested_at > now() - interval '1 hour') + coalesce(array_length(p_leads, 1), 0) > 100 then
    raise exception 'Too many AI checks this hour. Please wait a little.';
  end if;

  -- the open leads they can see
  select array_agg(l.id) into v_ids
  from public.leads l
  join public.pipeline_stages s on s.id = l.stage_id and s.kind = 'open'
  where l.id = any (p_leads) and l.deleted_at is null and public.can_view_lead(l.assigned_to);

  -- looked at today, nothing new since
  select count(*) into v_fresh
  from public.lead_chances c
  where c.lead_id = any (coalesce(v_ids, '{}')) and c.chance is not null and c.status = 'done'
    and (c.done_at at time zone 'Asia/Dhaka')::date = v_today and not public.ai_chance_changed(c.lead_id, c.done_at);
  if not p_force then
    select array_agg(x) into v_ids
    from unnest(coalesce(v_ids, '{}')) x
    where not exists (select 1 from public.lead_chances c
                      where c.lead_id = x and c.chance is not null and c.status = 'done'
                        and (c.done_at at time zone 'Asia/Dhaka')::date = v_today
                        and not public.ai_chance_changed(c.lead_id, c.done_at));
  end if;

  v_n := public.ai_chance_mark(coalesce(v_ids, '{}'), true);
  return jsonb_build_object('queued', v_n, 'fresh_today', v_fresh,
                            'skipped', coalesce(array_length(p_leads, 1), 0) - v_n);
end;
$$;
revoke all on function public.ai_chance_request_many(uuid[], boolean) from public, anon;
grant execute on function public.ai_chance_request_many(uuid[], boolean) to authenticated;

create or replace function public.ai_credit_claim(p_limit int default 3)
returns setof uuid
language sql
security definer
set search_path = public
as $$
  -- tried 3 times and the server was stopped each time (too slow): give up
  update public.admission_credits
     set status = 'failed', error = 'The AI took too long (3 tries).'
   where status = 'working' and started_at < now() - interval '10 minutes' and attempts >= 3;
  update public.admission_credits ac
     set status = 'working', started_at = now(), attempts = ac.attempts + 1
   where ac.lead_id in (
     select lead_id from public.admission_credits
     where (status = 'pending' and requested_at <= now() and public.ai_budget_ok())
        or (status = 'working' and started_at < now() - interval '10 minutes' and attempts < 3)
     order by requested_at
     limit greatest(1, least(p_limit, 10))
     for update skip locked)
  returning ac.lead_id;
$$;
revoke all on function public.ai_credit_claim(int) from public, anon, authenticated;
grant execute on function public.ai_credit_claim(int) to service_role;

-- 40 an hour each ("Check"): count the asked ones, also after they are done
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
  if (select count(*) from public.lead_chances where requested_by = auth.uid() and (manual or last_kind = 'manual')
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

-- Admission credit: a failed try waits 5 minutes (not straight back in)
create or replace function public.ai_credit_fail(p_lead uuid, p_error text, p_retry boolean default true)
returns void
language sql
security definer
set search_path = public
as $$
  update public.admission_credits
     set status = case when p_retry and attempts < 3 then 'pending' else 'failed' end,
         requested_at = case when p_retry and attempts < 3 then now() + interval '5 minutes' else requested_at end,
         error = left(p_error, 500)
   where lead_id = p_lead and status = 'working';
$$;
revoke all on function public.ai_credit_fail(uuid, text, boolean) from public, anon, authenticated;
grant execute on function public.ai_credit_fail(uuid, text, boolean) to service_role;

-- ⏱ Wake the server only when a look can really be taken now
create or replace function public.ai_chance_kick()
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_url    text := (select value from public.ai_secrets where name = 'functions_url');
  v_secret text := (select value from public.ai_secrets where name = 'cron_secret');
  v_cap    int := greatest(0, coalesce((public.ai_chance_setting() ->> 'daily_auto_limit')::int, 100));
  v_today  date := (now() at time zone 'Asia/Dhaka')::date;
  v_used   int;
  v_budget boolean;
begin
  if to_regproc('net.http_post') is null or v_url is null or v_secret is null then return; end if;
  if not coalesce((public.ai_chance_setting() ->> 'enabled')::boolean, false)
     or not exists (select 1 from public.ai_secrets where name = 'anthropic' and last_error is null) then
    return;
  end if;
  v_budget := public.ai_budget_ok();
  select count(*) into v_used from public.lead_chances
  where last_kind = 'auto' and done_at is not null and (done_at at time zone 'Asia/Dhaka')::date = v_today;
  if not exists (select 1 from public.lead_chances
                 where (status = 'pending' and due_at <= now() and (manual or (v_budget and (bulk or v_used < v_cap))))
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
