-- =====================================================================
-- 🔮 AI, more control + 🤝 Admission Contribution
--   · Daily run (on/off, its hour, which leads: changed since the last
--     look / never looked at / older than N days)
--   · A daily limit up to 1000 (or any number) and a monthly budget in $
--     for all AI (a ledger of tokens per day and feature)
--   · Admins: counts + cost before running a group (never / changed /
--     older / today again), "now" or within the daily limit, and Stop
--   · Many leads at once from the lists (skips ones looked at today with
--     nothing new, unless asked)
--   · More sorts: lowest chance, biggest rise / drop, call first
--   · Admission Contribution: who did how much in every admission
--     (summary, students, one student, one person)
--   (Dated before 20270104060000_lead_merge so both can go in any order.)
-- =====================================================================

-- ---------------------------------------------------------------------
-- ⚙️ New setting values (kept if already there)
-- ---------------------------------------------------------------------
update public.app_settings
   set value = jsonb_build_object(
                 'daily_run', jsonb_build_object('on', true, 'hour', 7, 'changed', true, 'never', false,
                                                 'older', false, 'older_days', 15),
                 'monthly_budget', 80) || value
 where key = 'ai_chance';

-- When the next "tomorrow" look happens (the daily run's hour, Dhaka)
create or replace function public.ai_chance_next_run()
returns timestamptz
language sql
stable
security definer
set search_path = public
as $$
  select (((now() at time zone 'Asia/Dhaka')::date + 1)::timestamp
          + make_interval(hours => greatest(0, least(23, coalesce((public.ai_chance_setting() -> 'daily_run' ->> 'hour')::int, 7)))))
         at time zone 'Asia/Dhaka';
$$;
revoke all on function public.ai_chance_next_run() from public, anon, authenticated;

-- ---------------------------------------------------------------------
-- 💵 What the AI used, per day and feature (for the monthly budget)
-- ---------------------------------------------------------------------
create table if not exists public.ai_usage_daily (
  day           date not null,
  feature       text not null,
  runs          int not null default 0,
  input_tokens  bigint not null default 0,
  output_tokens bigint not null default 0,
  primary key (day, feature)
);
alter table public.ai_usage_daily enable row level security;   -- through the functions below only
revoke all on public.ai_usage_daily from anon, authenticated;

-- Claude Sonnet 5.5: $2 in / $10 out per million tokens
create or replace function public.ai_cost_usd(p_in bigint, p_out bigint)
returns numeric
language sql
immutable
as $$
  select round((coalesce(p_in, 0) * 2 + coalesce(p_out, 0) * 10) / 1000000.0, 4);
$$;

create or replace function public.ai_usage_add(p_feature text, p_in bigint, p_out bigint)
returns void
language sql
security definer
set search_path = public
as $$
  insert into public.ai_usage_daily as u (day, feature, runs, input_tokens, output_tokens)
  values ((now() at time zone 'Asia/Dhaka')::date, p_feature, 1, coalesce(p_in, 0), coalesce(p_out, 0))
  on conflict (day, feature) do update
    set runs = u.runs + 1, input_tokens = u.input_tokens + excluded.input_tokens,
        output_tokens = u.output_tokens + excluded.output_tokens;
$$;
revoke all on function public.ai_usage_add(text, bigint, bigint) from public, anon, authenticated;
grant execute on function public.ai_usage_add(text, bigint, bigint) to service_role;

-- what was used before this ledger (best guess: the day each answer was saved)
insert into public.ai_usage_daily (day, feature, runs, input_tokens, output_tokens)
select (done_at at time zone 'Asia/Dhaka')::date, 'chance', count(*),
       sum(coalesce((usage ->> 'input_tokens')::bigint, 0)), sum(coalesce((usage ->> 'output_tokens')::bigint, 0))
from public.lead_chances where usage is not null and done_at is not null
group by 1
on conflict do nothing;
insert into public.ai_usage_daily (day, feature, runs, input_tokens, output_tokens)
select (done_at at time zone 'Asia/Dhaka')::date, 'credit', count(*),
       sum(coalesce((usage ->> 'input_tokens')::bigint, 0)), sum(coalesce((usage ->> 'output_tokens')::bigint, 0))
from public.admission_credits where usage is not null and done_at is not null
group by 1
on conflict do nothing;

-- spent this month (all AI, Dhaka month)
create or replace function public.ai_month_spent()
returns numeric
language sql
stable
security definer
set search_path = public
as $$
  select coalesce(sum(public.ai_cost_usd(input_tokens, output_tokens)), 0)
  from public.ai_usage_daily
  where day >= date_trunc('month', now() at time zone 'Asia/Dhaka')::date;
$$;
revoke all on function public.ai_month_spent() from public, anon, authenticated;

-- still inside the monthly budget? (no budget / 0 = no limit)
create or replace function public.ai_budget_ok()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select coalesce((public.ai_chance_setting() ->> 'monthly_budget')::numeric, 0) <= 0
      or public.ai_month_spent() < (public.ai_chance_setting() ->> 'monthly_budget')::numeric;
$$;
revoke all on function public.ai_budget_ok() from public, anon, authenticated;

-- ---------------------------------------------------------------------
-- 🔮 lead_chances: "a group asked by an admin", and columns to sort by
-- ---------------------------------------------------------------------
alter table public.lead_chances add column if not exists bulk boolean not null default false;
alter table public.lead_chances add column if not exists trend smallint
  generated always as (chance - prev_chance) stored;
alter table public.lead_chances add column if not exists level_rank smallint
  generated always as (case level when 'hot' then 1 when 'warm' then 2 when 'cold' then 3 end) stored;

-- Something new since the AI last looked? (the newest call / note on the lead)
create or replace function public.ai_chance_changed(p_lead uuid, p_done timestamptz)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select p_done is null or exists (
    select 1 from public.leads l
    left join public.lead_last ll on ll.lead_id = l.id
    where l.id = p_lead
      and greatest(l.last_contacted_at, ll.call_at, ll.note_at) > p_done);
$$;
revoke all on function public.ai_chance_changed(uuid, timestamptz) from public, anon, authenticated;

-- Into the queue (as before; "tomorrow" now means the daily run's hour)
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

  update public.lead_chances set stale = true
  where lead_id = any (p_leads) and status = 'working' and not stale;
  return n;
end;
$$;
revoke all on function public.ai_chance_mark(uuid[], boolean) from public, anon, authenticated;

-- Take due leads: "Check" first, then an admin's group (no daily limit),
-- then by-itself ones while today's limit lasts; nothing by itself or in
-- groups once the monthly budget is used up
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
  where not manual and not bulk and done_at is not null and (done_at at time zone 'Asia/Dhaka')::date = v_today;

  return query
  update public.lead_chances lc
     set status = 'working', started_at = now(), attempts = lc.attempts + 1, stale = false
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

-- The answer (as before; also clears "group", next look at the run's hour)
create or replace function public.ai_chance_save(p_lead uuid, p_r jsonb, p_model text, p_usage jsonb)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_chance int := greatest(0, least(100, round(coalesce((p_r ->> 'chance')::numeric, 0))));
  v_stale  boolean;
  v_next   timestamptz := public.ai_chance_next_run();
begin
  select stale into v_stale from public.lead_chances where lead_id = p_lead;
  update public.lead_chances
     set status = case when coalesce(v_stale, false) then 'pending' else 'done' end,
         due_at = case when coalesce(v_stale, false) then v_next else due_at end,
         stale = false,
         manual = false,
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

-- Admission credit: also waits once the monthly budget is used up
create or replace function public.ai_credit_claim(p_limit int default 3)
returns setof uuid
language sql
security definer
set search_path = public
as $$
  update public.admission_credits ac
     set status = 'working', started_at = now(), attempts = ac.attempts + 1
   where ac.lead_id in (
     select lead_id from public.admission_credits
     where (status = 'pending' and public.ai_budget_ok())
        or (status = 'working' and started_at < now() - interval '10 minutes')
     order by requested_at
     limit greatest(1, least(p_limit, 10))
     for update skip locked)
  returning ac.lead_id;
$$;
revoke all on function public.ai_credit_claim(int) from public, anon, authenticated;
grant execute on function public.ai_credit_claim(int) to service_role;

-- ---------------------------------------------------------------------
-- ⏰ The daily run: once a day at its hour (checked every hour)
-- ---------------------------------------------------------------------
create table if not exists public.ai_jobs (
  name     text primary key,
  last_day date
);
alter table public.ai_jobs enable row level security;
revoke all on public.ai_jobs from anon, authenticated;

-- Put the leads the daily run should look at into the queue (by itself:
-- today's limit and the budget apply). Returns how many.
create or replace function public.ai_chance_queue_kind(p_kind text, p_older_days int, p_bulk boolean,
                                                      p_only_changed boolean default true)
returns int
language plpgsql
security definer
set search_path = public
as $$
declare
  v_today date := (now() at time zone 'Asia/Dhaka')::date;
  n int;
begin
  with pick as (
    select l.id
    from public.leads l
    join public.pipeline_stages s on s.id = l.stage_id and s.kind = 'open'
    left join public.lead_chances c on c.lead_id = l.id
    where l.deleted_at is null
      and (c.status is null or c.status not in ('pending', 'working'))
      and case p_kind
            when 'never' then c.chance is null
            when 'changed' then c.chance is not null and public.ai_chance_changed(l.id, c.done_at)
            when 'older' then c.chance is not null
                              and c.done_at < now() - make_interval(days => greatest(1, coalesce(p_older_days, 15)))
            when 'today' then c.chance is not null and (c.done_at at time zone 'Asia/Dhaka')::date = v_today
                              and (not p_only_changed or public.ai_chance_changed(l.id, c.done_at))
            else false end
  )
  insert into public.lead_chances as lc (lead_id, status, due_at, manual, bulk, requested_at)
  select id, 'pending', now(), false, p_bulk, now() from pick
  on conflict (lead_id) do update
    set status = 'pending', due_at = now(), bulk = excluded.bulk, attempts = 0, error = null, requested_at = now()
    where lc.status not in ('pending', 'working');
  get diagnostics n = row_count;
  return n;
end;
$$;
revoke all on function public.ai_chance_queue_kind(text, int, boolean, boolean) from public, anon, authenticated;

create or replace function public.ai_chance_daily()
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  s     jsonb := public.ai_chance_setting();
  r     jsonb := coalesce(public.ai_chance_setting() -> 'daily_run', '{}'::jsonb);
  v_now timestamp := now() at time zone 'Asia/Dhaka';
begin
  if not coalesce((s ->> 'enabled')::boolean, false) or not coalesce((r ->> 'on')::boolean, false) then return; end if;
  if extract(hour from v_now) < coalesce((r ->> 'hour')::int, 7) then return; end if;
  if exists (select 1 from public.ai_jobs where name = 'chance_daily' and last_day >= v_now::date) then return; end if;
  insert into public.ai_jobs (name, last_day) values ('chance_daily', v_now::date)
  on conflict (name) do update set last_day = excluded.last_day;

  if coalesce((r ->> 'changed')::boolean, true) then
    perform public.ai_chance_queue_kind('changed', null, false);
  end if;
  if coalesce((r ->> 'never')::boolean, false) then
    perform public.ai_chance_queue_kind('never', null, false);
  end if;
  if coalesce((r ->> 'older')::boolean, false) then
    perform public.ai_chance_queue_kind('older', coalesce((r ->> 'older_days')::int, 15), false);
  end if;
end;
$$;
revoke all on function public.ai_chance_daily() from public, anon, authenticated;

do $$
begin
  if exists (select 1 from pg_namespace where nspname = 'cron') then
    begin perform cron.unschedule('ai-lead-chance-daily'); exception when others then null; end;
    perform cron.schedule('ai-lead-chance-daily', '3 * * * *', 'select public.ai_chance_daily()');
  end if;
end $$;

-- ---------------------------------------------------------------------
-- 👤 Admins: how many, what it costs, run a group, stop
-- ---------------------------------------------------------------------
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
    'auto_today', (select count(*) from public.lead_chances where not manual and not bulk and done_at is not null
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

-- Run a group now ('never' | 'changed' | 'older' | 'today'); p_now: all at
-- once (no daily limit; the budget still applies), else within the limit
create or replace function public.ai_chance_queue(p_kind text, p_older_days int default 15,
                                                 p_only_changed boolean default true, p_now boolean default false)
returns int
language plpgsql
security definer
set search_path = public
as $$
begin
  if not public.has_permission('settings.manage') then raise exception 'Only an admin can do this.'; end if;
  if p_kind not in ('never', 'changed', 'older', 'today') then raise exception 'Unknown group.'; end if;
  return public.ai_chance_queue_kind(p_kind, p_older_days, p_now, p_only_changed);
end;
$$;
revoke all on function public.ai_chance_queue(text, int, boolean, boolean) from public, anon;
grant execute on function public.ai_chance_queue(text, int, boolean, boolean) to authenticated;

-- (the old one-button "all open leads")
create or replace function public.ai_chance_queue_open()
returns int
language sql
security definer
set search_path = public
as $$
  select public.ai_chance_queue('never', 15, true, false);
$$;
revoke all on function public.ai_chance_queue_open() from public, anon;
grant execute on function public.ai_chance_queue_open() to authenticated;

-- ⏹ Stop: waiting leads leave the queue (an old answer stays as it was)
create or replace function public.ai_chance_stop()
returns int
language plpgsql
security definer
set search_path = public
as $$
declare
  a int;
  b int;
begin
  if not public.has_permission('settings.manage') then raise exception 'Only an admin can do this.'; end if;
  delete from public.lead_chances where status = 'pending' and chance is null;
  get diagnostics a = row_count;
  update public.lead_chances set status = 'done', manual = false, bulk = false
  where status = 'pending' and chance is not null;
  get diagnostics b = row_count;
  return a + b;
end;
$$;
revoke all on function public.ai_chance_stop() from public, anon;
grant execute on function public.ai_chance_stop() to authenticated;

-- ---------------------------------------------------------------------
-- 📋 Many leads from the lists (anyone who may see AI chance; their own
--   visible leads; at most 50 at a time and 100 an hour each). Looked at
--   today with nothing new: left out unless p_force.
-- ---------------------------------------------------------------------
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
     and (select count(*) from public.lead_chances where requested_by = auth.uid() and manual
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

-- The lead page card: also "looked at today, nothing new since" (warn before again)
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
        'done_at', c.done_at, 'error', c.error,
        'fresh_today', c.chance is not null
                       and (c.done_at at time zone 'Asia/Dhaka')::date = (now() at time zone 'Asia/Dhaka')::date
                       and not public.ai_chance_changed(c.lead_id, c.done_at))
      from public.lead_chances c where c.lead_id = p_lead), jsonb_build_object('status', 'none'))
  end;
$$;
revoke all on function public.lead_ai_chance(uuid) from public, anon;
grant execute on function public.lead_ai_chance(uuid) to authenticated;

-- ---------------------------------------------------------------------
-- 🤝 Admission Contribution (people Settings → AI allows to see shares)
-- ---------------------------------------------------------------------
-- The admitted students in a period (still admitted), with their shares
create or replace function public.contrib_admissions(p_from date, p_to date, p_course uuid, p_batch uuid)
returns table (lead_id uuid, name text, student_ref text, admitted_at timestamptz, course_id uuid, course text,
               batch text, source text, status text, manual boolean, shares jsonb, decisive text)
language sql
stable
security definer
set search_path = public
as $$
  select l.id, l.name, l.student_ref, l.admitted_at, l.admitted_course_id, c.name, b.name, src.name,
         coalesce(ac.status, 'none'), coalesce(ac.manual, false),
         case when ac.status = 'done' then ac.shares else '[]'::jsonb end, ac.decisive
  from public.leads l
  join public.pipeline_stages s on s.id = l.stage_id and s.kind = 'won'
  left join public.admission_credits ac on ac.lead_id = l.id
  left join public.courses c on c.id = l.admitted_course_id
  left join public.batches b on b.id = l.admitted_batch_id
  left join public.lead_sources src on src.id = l.source_id
  where l.deleted_at is null and l.admitted_at is not null
    and (l.admitted_at at time zone 'Asia/Dhaka')::date between p_from and p_to
    and (p_course is null or l.admitted_course_id = p_course)
    and (p_batch is null or l.admitted_batch_id = p_batch);
$$;
revoke all on function public.contrib_admissions(date, date, uuid, uuid) from public, anon, authenticated;

-- Summary: totals, each person, and who leads in each source / course
create or replace function public.contrib_summary(p_from date, p_to date, p_course uuid default null,
                                                 p_batch uuid default null)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
set jit = off
as $$
declare
  v_out jsonb;
begin
  if not public.ai_credit_can_view() then raise exception 'You cannot see admission contribution.'; end if;
  with a as (
    select * from public.contrib_admissions(p_from, p_to, p_course, p_batch)
  ), sh as (
    select a.lead_id, a.source, a.course, (x ->> 'user_id')::uuid as uid, (x ->> 'share')::numeric as share
    from a cross join lateral jsonb_array_elements(a.shares) x
  ), top as (
    select distinct on (lead_id) lead_id, uid from sh order by lead_id, share desc
  ), top_n as (
    select uid, count(*)::int as n from top group by uid
  ), ppl as (
    select sh.uid, round(sum(sh.share) / 100, 2) as credit, count(*)::int as admissions,
           round(avg(sh.share), 1) as avg_share,
           coalesce((select n from top_n t where t.uid = sh.uid), 0) as top_count
    from sh group by sh.uid
  ), by_group as (
    select 'source' as g, coalesce(source, 'No source') as k, uid, round(sum(share) / 100, 2) as credit
    from sh group by 2, 3
    union all
    select 'course', coalesce(course, 'No course'), uid, round(sum(share) / 100, 2) from sh group by 2, 3
  ), g_count as (
    select 'source' as g, coalesce(source, 'No source') as k, count(distinct lead_id) as n from sh group by 2
    union all
    select 'course', coalesce(course, 'No course'), count(distinct lead_id) from sh group by 2
  )
  select jsonb_build_object(
    'totals', (select jsonb_build_object(
                 'admissions', count(*),
                 'done', count(*) filter (where status = 'done'),
                 'waiting', count(*) filter (where status in ('pending', 'working')),
                 'not_started', count(*) filter (where status = 'none'),
                 'failed', count(*) filter (where status = 'failed'),
                 'manual', count(*) filter (where manual)) from a),
    'people', coalesce((select jsonb_agg(jsonb_build_object(
                 'user_id', p.uid, 'name', pr.full_name, 'credit', p.credit, 'admissions', p.admissions,
                 'avg_share', p.avg_share, 'top_count', p.top_count) order by p.credit desc, pr.full_name)
               from ppl p left join public.profiles pr on pr.id = p.uid), '[]'::jsonb),
    'groups', coalesce((select jsonb_agg(jsonb_build_object('group', g, 'key', k, 'admissions', n, 'people', people)
                                         order by g, n desc)
               from (select bg.g, bg.k, max(gc.n) as n,
                            jsonb_agg(jsonb_build_object('user_id', bg.uid, 'name', pr.full_name, 'credit', bg.credit)
                                      order by bg.credit desc) as people
                     from by_group bg
                     join g_count gc on gc.g = bg.g and gc.k = bg.k
                     left join public.profiles pr on pr.id = bg.uid
                     group by bg.g, bg.k) q), '[]'::jsonb))
  into v_out;
  return v_out;
end;
$$;
revoke all on function public.contrib_summary(date, date, uuid, uuid) from public, anon;
grant execute on function public.contrib_summary(date, date, uuid, uuid) to authenticated;

-- The students, each with the shares (names), filtered and a page at a time
--   p_status: all | done | waiting | not_started | failed | manual
create or replace function public.contrib_students(p_from date, p_to date, p_course uuid default null,
                                                  p_batch uuid default null, p_user uuid default null,
                                                  p_status text default 'all', p_search text default null,
                                                  p_limit int default 50, p_offset int default 0)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
set jit = off
as $$
declare
  v_q   text := nullif(trim(coalesce(p_search, '')), '');
  v_out jsonb;
begin
  if not public.ai_credit_can_view() then raise exception 'You cannot see admission contribution.'; end if;
  with a as (
    select * from public.contrib_admissions(p_from, p_to, p_course, p_batch) x
    where (p_user is null or exists (select 1 from jsonb_array_elements(x.shares) s where s ->> 'user_id' = p_user::text))
      and case coalesce(p_status, 'all')
            when 'done' then x.status = 'done'
            when 'waiting' then x.status in ('pending', 'working')
            when 'not_started' then x.status = 'none'
            when 'failed' then x.status = 'failed'
            when 'manual' then x.manual
            else true end
      and (v_q is null or x.name ilike '%' || v_q || '%' or x.student_ref ilike '%' || v_q || '%')
  )
  select jsonb_build_object(
    'total', (select count(*) from a),
    'items', coalesce((select jsonb_agg(row order by admitted_at desc) from (
      select a.lead_id, a.name, a.student_ref, a.admitted_at, a.course, a.batch, a.source, a.status, a.manual,
             a.decisive,
             (select coalesce(jsonb_agg(jsonb_build_object('user_id', s ->> 'user_id', 'name', pr.full_name,
                                                           'share', (s ->> 'share')::numeric, 'reason', s ->> 'reason')
                                        order by (s ->> 'share')::numeric desc), '[]'::jsonb)
              from jsonb_array_elements(a.shares) s left join public.profiles pr on pr.id::text = s ->> 'user_id') as shares
      from a
      order by a.admitted_at desc
      limit greatest(1, least(coalesce(p_limit, 50), 5000)) offset greatest(0, coalesce(p_offset, 0))) row), '[]'::jsonb))
  into v_out;
  return v_out;
end;
$$;
revoke all on function public.contrib_students(date, date, uuid, uuid, uuid, text, text, int, int) from public, anon;
grant execute on function public.contrib_students(date, date, uuid, uuid, uuid, text, text, int, int) to authenticated;

-- One person: their total, by month, and each admission with their share
create or replace function public.contrib_person(p_user uuid, p_from date, p_to date)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
set jit = off
as $$
declare
  v_out jsonb;
begin
  if not public.ai_credit_can_view() then raise exception 'You cannot see admission contribution.'; end if;
  with a as (
    select * from public.contrib_admissions(p_from, p_to, null, null)
  ), mine as (
    select a.lead_id, a.name, a.student_ref, a.admitted_at, a.course, a.batch,
           (s ->> 'share')::numeric as share, s ->> 'reason' as reason,
           jsonb_array_length(a.shares) as people,
           (select count(*) + 1 from jsonb_array_elements(a.shares) o
            where (o ->> 'share')::numeric > (s ->> 'share')::numeric) as place
    from a cross join lateral jsonb_array_elements(a.shares) s
    where s ->> 'user_id' = p_user::text
  )
  select jsonb_build_object(
    'user_id', p_user,
    'name', (select full_name from public.profiles where id = p_user),
    'credit', coalesce((select round(sum(share) / 100, 2) from mine), 0),
    'admissions', (select count(*) from mine),
    'top_count', (select count(*) from mine where place = 1),
    'avg_share', (select round(avg(share), 1) from mine),
    'by_month', coalesce((select jsonb_agg(jsonb_build_object('month', m, 'credit', c, 'admissions', n) order by m)
                          from (select to_char(admitted_at at time zone 'Asia/Dhaka', 'YYYY-MM') as m,
                                       round(sum(share) / 100, 2) as c, count(*) as n
                                from mine group by 1) x), '[]'::jsonb),
    'items', coalesce((select jsonb_agg(jsonb_build_object(
                 'lead_id', lead_id, 'name', name, 'student_ref', student_ref, 'admitted_at', admitted_at,
                 'course', course, 'batch', batch, 'share', share, 'reason', reason, 'people', people, 'place', place)
                 order by admitted_at desc) from mine), '[]'::jsonb))
  into v_out;
  return v_out;
end;
$$;
revoke all on function public.contrib_person(uuid, date, date) from public, anon;
grant execute on function public.contrib_person(uuid, date, date) to authenticated;

-- One student's story in short (who did what, when): for the detail page
create or replace function public.contrib_timeline(p_lead uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
set jit = off
as $$
declare
  v_out jsonb;
begin
  if not public.ai_credit_can_view() then raise exception 'You cannot see admission contribution.'; end if;
  with ev as (
    select l.created_at as at, l.created_by as who, 'added' as kind, null::text as text, null::numeric as minutes
    from public.leads l where l.id = p_lead and l.created_by is not null
    union all
    select c.called_at, c.user_id,
           case when c.channel = 'whatsapp' then 'whatsapp' when c.outcome = 'connected' then 'call_answered'
                else 'call_missed' end,
           left(nullif(trim(c.notes), ''), 300),
           case when c.duration_sec > 0 then round(c.duration_sec / 60.0, 1) end
    from public.call_logs c where c.lead_id = p_lead and c.deleted_at is null and c.user_id is not null
    union all
    select a.created_at, a.user_id, a.action,
           case when a.action = 'note_added' then left(a.details ->> 'note', 300) end, null
    from public.lead_activity a
    where a.lead_id = p_lead and a.user_id is not null
      and a.action in ('note_added', 'visit_planned', 'visit_done', 'paper_received', 'assigned', 'fee_offer',
                       'fee_discount')
    union all
    select p.paid_at, p.received_by, 'payment', null, null
    from public.fee_payments p where p.lead_id = p_lead and p.voided_at is null and p.received_by is not null
    union all
    select l.admitted_at, l.admitted_by, 'admitted', null, null
    from public.leads l where l.id = p_lead and l.admitted_at is not null
  )
  select coalesce(jsonb_agg(jsonb_strip_nulls(jsonb_build_object(
           'at', e.at, 'user_id', e.who, 'name', pr.full_name, 'kind', e.kind, 'text', e.text, 'minutes', e.minutes))
         order by e.at), '[]'::jsonb)
  into v_out
  from (select * from ev order by at desc limit 120) e
  left join public.profiles pr on pr.id = e.who;
  return v_out;
end;
$$;
revoke all on function public.contrib_timeline(uuid) from public, anon;
grant execute on function public.contrib_timeline(uuid) to authenticated;
