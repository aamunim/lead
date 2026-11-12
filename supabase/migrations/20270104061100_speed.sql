-- =====================================================================
-- ⚡ The slow database calls, made fast (from the Supabase "slow queries" list)
--   1. Reports (lead_report): only the columns it needs (it carried every
--      column of every lead, ~45 MB on a big list, and read it again for
--      each part) — 8 s → 0.1 s on 33,000 leads.
--   2. Heavy functions don't use JIT: Postgres spent seconds compiling these
--      big queries before running them (3.8 s of a 3.9 s report).
--   3. Credits (leaderboard, my level, streak, ranks): the totals are kept a
--      short while (2 min for today, 30 min for past days) instead of being
--      worked out from all work since 2020 on every open; a change of the
--      credit rules / manual credits / credit settings clears them at once.
--      The work count itself uses the date indexes.
--   4. credit_tick: ranks are worked out once, not once per person.
--   5. notifications_tick: old notifications are cleared once an hour (was
--      every minute, reading the whole table); indexes for it.
--   6. my_lead_directory (call sync): the saved phone hashes and the
--      "last note" table instead of hashing every phone / reading every call.
-- =====================================================================


-- ---------------------------------------------------------------------
-- 1. lead_report: only the columns it uses
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.lead_report(p_from date, p_to date, p_user_id uuid DEFAULT NULL::uuid, p_course_id uuid DEFAULT NULL::uuid)
 RETURNS jsonb
 LANGUAGE sql
 STABLE
 SET search_path TO 'public'
 SET jit TO 'off'
AS $function$
  with
  -- Every lead I can see, with the person / course filters
  scope as (
    select l.id, l.stage_id, l.assigned_to, l.source_id, l.campaign_id, l.lost_reason_id, l.visit_status,
           l.created_at, l.last_contacted_at, l.admitted_at, l.lost_at, l.closed_at, l.next_follow_up_at,
           st.kind as stage_kind
    from public.leads l
    join public.pipeline_stages st on st.id = l.stage_id
    where l.deleted_at is null
      and (p_user_id is null or l.assigned_to = p_user_id)
      and (p_course_id is null
           or l.admitted_course_id = p_course_id
           or exists (select 1 from public.lead_courses lc where lc.lead_id = l.id and lc.course_id = p_course_id))
  ),
  -- Added in the period
  cohort as (
    select * from scope
    where (created_at at time zone 'Asia/Dhaka')::date between p_from and p_to
  ),
  stages as (
    select id, key, name, color, kind, sort_order, is_active from public.pipeline_stages
  ),
  -- The board's columns: open stages, then Admitted and Lost
  pipeline_steps as (
    select s.id, s.key, s.name, s.color, s.kind,
           case s.kind when 'open' then s.sort_order when 'won' then 1000000 else 1000001 end as pos
    from stages s
    where (s.kind = 'open' and s.is_active) or s.kind in ('won', 'lost')
  ),
  visited_leads as (
    select distinct v.lead_id from public.lead_visits v
    join cohort c on c.id = v.lead_id
    where v.status = 'visited'
  )
  select jsonb_build_object(
    -- ① Summary
    'summary', (
      select jsonb_build_object(
        'new_leads', (select count(*) from cohort),
        'contacted', (select count(*) from cohort where last_contacted_at is not null),
        'cohort_admitted', (select count(*) from cohort where stage_kind = 'won'),
        'admitted', (select count(*) from scope
                     where stage_kind = 'won'
                       and (admitted_at at time zone 'Asia/Dhaka')::date between p_from and p_to),
        'lost', (select count(*) from scope
                 where stage_kind = 'lost'
                   and (lost_at at time zone 'Asia/Dhaka')::date between p_from and p_to),
        'avg_days_to_admit', (select round(avg(extract(epoch from (admitted_at - created_at)) / 86400)::numeric, 1)
                              from scope
                              where stage_kind = 'won'
                                and (admitted_at at time zone 'Asia/Dhaka')::date between p_from and p_to)
      )
    ),

    -- ② Pipeline now: who is in which stage right now (same as the board)
    --    all    = every lead (period not used)
    --    period = only the leads added in the period
    'pipeline', coalesce((
      select jsonb_agg(jsonb_build_object(
               'stage_id', p.id, 'key', p.key, 'name', p.name, 'color', p.color, 'kind', p.kind,
               'all', (select count(*) from scope s where s.stage_id = p.id),
               'period', (select count(*) from cohort c where c.stage_id = p.id)
             ) order by p.pos)
      from pipeline_steps p
    ), '[]'::jsonb),

    -- ③ Campus visits
    'visits', jsonb_build_object(
      'planned_now', (select count(*) from cohort where visit_status = 'planned'),
      'visited', (select count(*) from visited_leads),
      'missed', (select count(distinct v.lead_id) from public.lead_visits v
                 join cohort c on c.id = v.lead_id where v.status = 'missed'),
      'visited_admitted', (select count(*) from cohort c join visited_leads vl on vl.lead_id = c.id
                           where c.stage_kind = 'won'),
      'not_visited', (select count(*) from cohort c where not exists (select 1 from visited_leads vl where vl.lead_id = c.id)),
      'not_visited_admitted', (select count(*) from cohort c
                               where c.stage_kind = 'won'
                                 and not exists (select 1 from visited_leads vl where vl.lead_id = c.id))
    ),

    -- ④ Sources and campaigns (leads added in the period)
    'sources', coalesce((
      select jsonb_agg(row_to_json(x) order by x.leads desc, x.name)
      from (
        select coalesce(src.name, 'No source') as name,
               count(*)::int as leads,
               count(*) filter (where c.stage_kind = 'won')::int as admitted
        from cohort c left join public.lead_sources src on src.id = c.source_id
        group by src.name
      ) x
    ), '[]'::jsonb),
    'campaigns', coalesce((
      select jsonb_agg(row_to_json(x) order by x.leads desc, x.name)
      from (
        select cmp.name,
               count(*)::int as leads,
               count(*) filter (where c.stage_kind = 'won')::int as admitted
        from cohort c join public.campaigns cmp on cmp.id = c.campaign_id
        group by cmp.name
      ) x
    ), '[]'::jsonb),

    -- ⑤ Team (per assigned person)
    'team', coalesce((
      select jsonb_agg(row_to_json(x) order by x.admitted desc, x.leads desc, x.name, x.user_id)
      from (
        -- one pass over the leads (not three per person)
        select p.id as user_id, p.full_name as name,
               count(*) filter (where (s.created_at at time zone 'Asia/Dhaka')::date between p_from and p_to)::int as leads,
               count(*) filter (where s.stage_kind = 'won'
                                  and (s.admitted_at at time zone 'Asia/Dhaka')::date between p_from and p_to)::int as admitted,
               count(*) filter (where s.closed_at is null and s.next_follow_up_at < now())::int as overdue
        from scope s
        join public.profiles p on p.id = s.assigned_to
        group by p.id, p.full_name
      ) x
    ), '[]'::jsonb),

    -- ⑥ Why leads are lost (lost in the period) and from which stage
    'lost_reasons', coalesce((
      select jsonb_agg(row_to_json(x) order by x.leads desc)
      from (
        select coalesce(lr.name, 'No reason') as name, count(*)::int as leads
        from scope s left join public.lost_reasons lr on lr.id = s.lost_reason_id
        where s.stage_kind = 'lost' and (s.lost_at at time zone 'Asia/Dhaka')::date between p_from and p_to
        group by lr.name
      ) x
    ), '[]'::jsonb),
    'lost_from', coalesce((
      select jsonb_agg(row_to_json(x) order by x.leads desc)
      from (
        select coalesce(fs.name, 'Unknown') as name, count(*)::int as leads
        from scope s
        join lateral (
          select h.from_stage_id from public.lead_stage_history h
          join stages ls on ls.id = h.to_stage_id and ls.kind = 'lost'
          where h.lead_id = s.id
          order by h.changed_at desc limit 1
        ) last_lost on true
        left join stages fs on fs.id = last_lost.from_stage_id
        where s.stage_kind = 'lost' and (s.lost_at at time zone 'Asia/Dhaka')::date between p_from and p_to
        group by fs.name
      ) x
    ), '[]'::jsonb)
  );
$function$;

-- ---------------------------------------------------------------------
-- 2. credit work: date filters that use the indexes
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.credit_work(p_from date, p_to date)
 RETURNS TABLE(user_id uuid, day date, kind text, qty numeric)
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
 SET jit TO 'off'
AS $function$
  with
  latest as (select rules from public.credit_rule_sets order by effective_from desc, created_at desc limit 1),
  r as (select rules from latest),
  calls as (
    select c.*, (c.called_at at time zone 'Asia/Dhaka')::date as d
    from public.call_logs c
    where c.deleted_at is null
      and c.called_at >= (p_from::timestamp at time zone 'Asia/Dhaka') and c.called_at < ((p_to + 1)::timestamp at time zone 'Asia/Dhaka')
  )
  -- 📞 calls tried (outgoing; the same lead within 5 minutes once)
  select user_id, d, 'call_any', count(distinct (lead_id, floor(extract(epoch from called_at) / 300)))::numeric
  from calls where channel = 'phone' and direction = 'outgoing' group by 1, 2
  union all
  -- ✅ talked (outgoing, long enough)
  select user_id, d, 'call_connected', count(*)::numeric
  from calls, r
  where channel = 'phone' and direction = 'outgoing' and outcome = 'connected'
    and coalesce(duration_sec, 0) >= coalesce((r.rules->'call_connected'->>'min_sec')::int, 10)
  group by 1, 2
  union all
  -- ⏱ talk minutes (each call up to a limit)
  select user_id, d, 'talk_minute',
         sum(least(floor(coalesce(duration_sec, 0) / 60.0),
                   coalesce(nullif((r.rules->'talk_minute'->>'per_call')::int, 0), 100000)))::numeric
  from calls, r
  where channel = 'phone' and outcome = 'connected'
  group by 1, 2
  union all
  -- 📲 incoming answered
  select user_id, d, 'incoming', count(*)::numeric
  from calls where channel = 'phone' and direction = 'incoming' and outcome = 'connected' group by 1, 2
  union all
  -- 💬 WhatsApp
  select user_id, d, 'wa_message', count(*)::numeric
  from calls where channel = 'whatsapp' and outcome = 'message' and template_id is null group by 1, 2
  union all
  select user_id, d, 'wa_call', count(*)::numeric
  from calls where channel = 'whatsapp' and outcome = 'connected' group by 1, 2
  union all
  -- ✉️ a ready-made message sent
  select user_id, d, 'template', count(*)::numeric
  from calls where template_id is not null group by 1, 2
  union all
  -- 📝 notes (long enough) and 🎙 voice notes
  select a.user_id, (a.created_at at time zone 'Asia/Dhaka')::date, 'note', count(*)::numeric
  from public.lead_activity a, r
  where a.action = 'note_added'
    and a.created_at >= (p_from::timestamp at time zone 'Asia/Dhaka') and a.created_at < ((p_to + 1)::timestamp at time zone 'Asia/Dhaka')
    and length(trim(coalesce(a.details->>'note', ''))) >= coalesce((r.rules->'note'->>'min_chars')::int, 15)
  group by 1, 2
  union all
  select f.uploaded_by, (f.created_at at time zone 'Asia/Dhaka')::date, 'voice', count(*)::numeric
  from public.lead_files f
  where f.kind = 'voice' and f.deleted_at is null and f.uploaded_by is not null
    and f.created_at >= (p_from::timestamp at time zone 'Asia/Dhaka') and f.created_at < ((p_to + 1)::timestamp at time zone 'Asia/Dhaka')
  group by 1, 2
  union all
  -- ⏰ next call set / done on time
  select a.user_id, (a.created_at at time zone 'Asia/Dhaka')::date, 'follow_up_set', count(*)::numeric
  from public.lead_activity a
  where a.action = 'follow_up_set' and a.created_at >= (p_from::timestamp at time zone 'Asia/Dhaka') and a.created_at < ((p_to + 1)::timestamp at time zone 'Asia/Dhaka')
  group by 1, 2
  union all
  select f.completed_by, (f.completed_at at time zone 'Asia/Dhaka')::date, 'follow_up_on_time', count(*)::numeric
  from public.follow_ups f
  where f.status = 'done' and f.completed_by is not null
    and f.completed_at >= (p_from::timestamp at time zone 'Asia/Dhaka') and f.completed_at < ((p_to + 1)::timestamp at time zone 'Asia/Dhaka')
    and (f.completed_at at time zone 'Asia/Dhaka')::date <= (f.due_at at time zone 'Asia/Dhaka')::date
  group by 1, 2
  union all
  -- ⚠️ a next call left undone past its day (the lead's owner)
  select coalesce(l.assigned_to, f.created_by), (f.due_at at time zone 'Asia/Dhaka')::date, 'overdue', count(*)::numeric
  from public.follow_ups f
  join public.leads l on l.id = f.lead_id and l.deleted_at is null
  where f.due_at >= (p_from::timestamp at time zone 'Asia/Dhaka') and f.due_at < ((p_to + 1)::timestamp at time zone 'Asia/Dhaka')
    and (f.due_at at time zone 'Asia/Dhaka')::date < (now() at time zone 'Asia/Dhaka')::date
    and (f.status = 'pending'
         or (f.status = 'done' and (f.completed_at at time zone 'Asia/Dhaka')::date > (f.due_at at time zone 'Asia/Dhaka')::date))
  group by 1, 2
  union all
  -- ➕ leads added (typed / imported)
  select l.created_by, (l.created_at at time zone 'Asia/Dhaka')::date,
         case when l.import_batch_id is null then 'lead_added' else 'lead_imported' end, count(*)::numeric
  from public.leads l
  where l.deleted_at is null and l.created_by is not null
    and l.created_at >= (p_from::timestamp at time zone 'Asia/Dhaka') and l.created_at < ((p_to + 1)::timestamp at time zone 'Asia/Dhaka')
  group by 1, 2, 3
  union all
  -- 🚩 a stage further on
  select a.user_id, (a.created_at at time zone 'Asia/Dhaka')::date, 'stage_forward', count(*)::numeric
  from public.lead_activity a
  join public.pipeline_stages s1 on s1.id::text = a.details->>'from'
  join public.pipeline_stages s2 on s2.id::text = a.details->>'to'
  where a.action = 'stage_changed' and s2.sort_order > s1.sort_order and s2.kind = 'open'
    and a.created_at >= (p_from::timestamp at time zone 'Asia/Dhaka') and a.created_at < ((p_to + 1)::timestamp at time zone 'Asia/Dhaka')
  group by 1, 2
  union all
  -- 🏫 campus visits and 📄 papers
  select a.user_id, (a.created_at at time zone 'Asia/Dhaka')::date,
         case a.action when 'visit_planned' then 'visit_planned' when 'visit_done' then 'visit_done' else 'paper' end,
         count(*)::numeric
  from public.lead_activity a
  where a.action in ('visit_planned', 'visit_done', 'paper_received')
    and a.created_at >= (p_from::timestamp at time zone 'Asia/Dhaka') and a.created_at < ((p_to + 1)::timestamp at time zone 'Asia/Dhaka')
  group by 1, 2, 3
  union all
  -- 🎓 admitted (still admitted): 🤖 shared out by the AI's admission credit
  --   (each person's share of 1); not worked out yet / AI off → the one
  --   who marked it Admitted, as before
  select x.user_id, x.d, 'admitted', sum(x.part)
  from (
    select (s ->> 'user_id')::uuid as user_id, (l.admitted_at at time zone 'Asia/Dhaka')::date as d,
           (s ->> 'share')::numeric / 100 as part
    from public.leads l
    join public.pipeline_stages st on st.id = l.stage_id and st.kind = 'won'
    join public.admission_credits ac on ac.lead_id = l.id and ac.status = 'done'
    cross join lateral jsonb_array_elements(ac.shares) s
    where l.deleted_at is null
      and public.ai_credit_on()
      and l.admitted_at >= (p_from::timestamp at time zone 'Asia/Dhaka') and l.admitted_at < ((p_to + 1)::timestamp at time zone 'Asia/Dhaka')
    union all
    select l.admitted_by, (l.admitted_at at time zone 'Asia/Dhaka')::date, 1::numeric
    from public.leads l
    join public.pipeline_stages st on st.id = l.stage_id and st.kind = 'won'
    where l.deleted_at is null and l.admitted_by is not null
      and l.admitted_at >= (p_from::timestamp at time zone 'Asia/Dhaka') and l.admitted_at < ((p_to + 1)::timestamp at time zone 'Asia/Dhaka')
      and not (public.ai_credit_on()
               and exists (select 1 from public.admission_credits ac where ac.lead_id = l.id and ac.status = 'done'))
  ) x
  where x.user_id is not null
  group by 1, 2
  union all
  -- 💵 money taken (refunds take it back; voided ones don't count)
  select p.received_by, (p.paid_at at time zone 'Asia/Dhaka')::date, 'payment',
         sum(case when p.kind = 'refund' then -p.amount else p.amount end)
  from public.fee_payments p
  where p.voided_at is null and p.received_by is not null
    and p.paid_at >= (p_from::timestamp at time zone 'Asia/Dhaka') and p.paid_at < ((p_to + 1)::timestamp at time zone 'Asia/Dhaka')
  group by 1, 2
  union all
  -- 📱 time working in the app (seconds)
  select s.user_id, (s.started_at at time zone 'Asia/Dhaka')::date, 'app_time', sum(s.active_sec)::numeric
  from public.app_sessions s
  where s.started_at >= (p_from::timestamp at time zone 'Asia/Dhaka') and s.started_at < ((p_to + 1)::timestamp at time zone 'Asia/Dhaka')
  group by 1, 2;
$function$;
create index if not exists follow_ups_done_idx on public.follow_ups (completed_at) where status = 'done';
create index if not exists follow_ups_due_all_idx on public.follow_ups (due_at);

-- ---------------------------------------------------------------------
-- 3. Credits: totals kept a short while
-- ---------------------------------------------------------------------
create table if not exists public.credit_cache (
  key     text primary key,
  made_at timestamptz not null default now(),
  data    jsonb not null
);
alter table public.credit_cache enable row level security;
revoke all on public.credit_cache from public, anon, authenticated;

-- each person's credits in a range (only the server reads this)
create or replace function public.credit_totals(p_from date, p_to date)
returns table (user_id uuid, total numeric)
language plpgsql
volatile
security definer
set search_path = public
set jit = off
as $$
declare
  v_key  text := 'tot:' || p_from || ':' || p_to;
  v_ttl  interval := case when p_to < (now() at time zone 'Asia/Dhaka')::date
                          then interval '30 minutes' else interval '2 minutes' end;
  v_data jsonb;
begin
  select c.data into v_data from public.credit_cache c where c.key = v_key and c.made_at > now() - v_ttl;
  if v_data is null then
    select coalesce(jsonb_object_agg(t.user_id, t.total), '{}'::jsonb) into v_data
    from (select r.user_id, sum(r.points) as total
          from public.credit_rows(p_from, p_to) r
          where r.user_id is not null
          group by r.user_id) t;
    begin
      insert into public.credit_cache (key, made_at, data) values (v_key, now(), v_data)
      on conflict (key) do update set made_at = excluded.made_at, data = excluded.data;
      delete from public.credit_cache where made_at < now() - interval '1 day';
    exception when others then
      null;  -- e.g. a read-only call: the answer is still right, just not kept
    end;
  end if;
  return query select e.key::uuid, e.value::numeric from jsonb_each_text(v_data) e;
end;
$$;
revoke all on function public.credit_totals(date, date) from public, anon, authenticated;

-- all credits ever: the days before today (kept 30 min) + today (kept 2 min)
-- (credits are counted per day, so the two parts add up to the same total)
create or replace function public.credit_lifetime()
returns table (user_id uuid, total numeric)
language sql
volatile
security definer
set search_path = public
as $$
  select x.user_id, sum(x.total)
  from (
    select * from public.credit_totals('2020-01-01', (now() at time zone 'Asia/Dhaka')::date - 1)
    union all
    select * from public.credit_totals((now() at time zone 'Asia/Dhaka')::date, (now() at time zone 'Asia/Dhaka')::date)
  ) x
  group by x.user_id;
$$;
revoke all on function public.credit_lifetime() from public, anon, authenticated;

-- a change of the rules / manual credits / credit settings: worked out again at once
create or replace function public.credit_cache_clear()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if tg_table_name = 'app_settings'
     and coalesce(new.key, old.key) not in ('credits', 'credit_extras') then
    return null;
  end if;
  delete from public.credit_cache;
  return null;
end;
$$;

drop trigger if exists credit_cache_clear on public.credit_rule_sets;
create trigger credit_cache_clear after insert or update or delete on public.credit_rule_sets
  for each row execute function public.credit_cache_clear();
drop trigger if exists credit_cache_clear on public.credit_adjustments;
create trigger credit_cache_clear after insert or update or delete on public.credit_adjustments
  for each row execute function public.credit_cache_clear();
drop trigger if exists credit_cache_clear on public.app_settings;
create trigger credit_cache_clear after insert or update or delete on public.app_settings
  for each row execute function public.credit_cache_clear();

create or replace function public.credit_ranks(p_from date, p_to date)
returns table (user_id uuid, name text, total numeric, rank integer)
language sql
volatile
security definer
set search_path = public
as $$
  with t as (select * from public.credit_totals(p_from, p_to))
  select p.id, p.full_name, coalesce(t.total, 0), (rank() over (order by coalesce(t.total, 0) desc))::int
  from public.profiles p
  left join t on t.user_id = p.id
  where p.is_active and not p.leaderboard_hidden;
$$;

create or replace function public.team_credits(p_from date, p_to date)
returns table (user_id uuid, total numeric)
language sql
volatile
security definer
set search_path = public
as $$
  select t.user_id, t.total
  from public.credit_totals(p_from, p_to) t
  where public.can_see_activity(t.user_id);
$$;

create or replace function public.leaderboard(p_from date, p_to date)
returns table (user_id uuid, name text, role_key text, total numeric, rank integer, hidden boolean, team_lead_id uuid)
language sql
volatile
security definer
set search_path = public
as $$
  with t as (
    select * from public.credit_totals(p_from, p_to)
  ),
  people as (
    select p.id, p.full_name, p.role_key, p.leaderboard_hidden, p.team_lead_id, coalesce(t.total, 0) as total
    from public.profiles p
    left join t on t.user_id = p.id
    where p.is_active and public.is_active_user()
  ),
  ranked as (
    select *, rank() over (order by total desc)::int as rnk
    from people where not leaderboard_hidden
  )
  select id, full_name, role_key, total, rnk, false, team_lead_id from ranked
  union all
  -- you, when you are left out (no rank)
  select id, full_name, role_key, total, null::int, true, team_lead_id
  from people where leaderboard_hidden and id = auth.uid()
  union all
  -- the Super Admin also sees who is left out
  select id, full_name, role_key, total, null::int, true, team_lead_id
  from people where leaderboard_hidden and id <> auth.uid() and public.current_role_key() = 'super_admin'
  order by 5 nulls last, 2;
$$;

create or replace function public.credit_levels()
returns table (user_id uuid, lifetime numeric, level integer, icon text, name text, at numeric,
               next_at numeric, next_icon text, next_name text)
language sql
volatile
security definer
set search_path = public
as $$
  with
  ms as (
    select (m->>'at')::numeric as at, m->>'icon' as icon, m->>'name' as name,
           row_number() over (order by (m->>'at')::numeric) as lvl
    from public.app_settings s, jsonb_array_elements(s.value->'milestones') m
    where s.key = 'credit_extras'
  ),
  t as (select * from public.credit_lifetime())
  select p.id, coalesce(t.total, 0),
         coalesce(cur.lvl, 0)::int, cur.icon, cur.name, cur.at,
         nxt.at, nxt.icon, nxt.name
  from public.profiles p
  left join t on t.user_id = p.id
  left join lateral (select * from ms where ms.at <= coalesce(t.total, 0) order by ms.at desc limit 1) cur on true
  left join lateral (select * from ms where ms.at > coalesce(t.total, 0) order by ms.at asc limit 1) nxt on true
  where p.is_active and public.is_active_user();
$$;

-- the streak of each person (kept 2 min)
create or replace function public.credit_streaks()
returns table (user_id uuid, streak integer)
language plpgsql
volatile
security definer
set search_path = public
set jit = off
as $$
declare
  today  date := (now() at time zone 'Asia/Dhaka')::date;
  need   numeric := coalesce((select (value->>'streak_min')::numeric from public.app_settings where key = 'credit_extras'), 50);
  v_key  text := 'streaks:' || today;
  v_data jsonb;
begin
  if not public.is_active_user() then return; end if;
  select c.data into v_data from public.credit_cache c where c.key = v_key and c.made_at > now() - interval '2 minutes';
  if v_data is null then
    with daily as (
      select d.user_id, d.day, sum(d.pts) as pts from public.credit_day_kind(today - 60, today) d group by 1, 2
    ),
    good as (select daily.user_id, daily.day from daily where pts >= need),
    -- count back from today (or yesterday when today isn't reached yet)
    runs as (
      select g.user_id, g.day,
             g.day + (row_number() over (partition by g.user_id order by g.day desc))::int as key
      from good g
    ),
    latest as (
      select r.user_id, r.key, count(*)::int as len, max(r.day) as last_day
      from runs r group by r.user_id, r.key
    ),
    s as (
      select l.user_id, max(l.len)::int as streak
      from latest l
      where l.last_day >= today - 1
      group by l.user_id
    )
    select coalesce(jsonb_object_agg(s.user_id, s.streak), '{}'::jsonb) into v_data from s;
    begin
      insert into public.credit_cache (key, made_at, data) values (v_key, now(), v_data)
      on conflict (key) do update set made_at = excluded.made_at, data = excluded.data;
    exception when others then
      null;
    end;
  end if;
  return query select e.key::uuid, e.value::int from jsonb_each_text(v_data) e;
end;
$$;

create or replace function public.credit_me()
returns jsonb
language sql
volatile
security definer
set search_path = public
as $$
  select jsonb_build_object(
    'streak', coalesce((select s.streak from public.credit_streaks() s where s.user_id = auth.uid()), 0),
    'enabled', coalesce((select (value->>'enabled')::boolean from public.app_settings where key = 'credits'), true),
    'level', (select to_jsonb(l) from public.credit_levels() l where l.user_id = auth.uid())
  );
$$;

-- ---------------------------------------------------------------------
-- 3b. level notices: the kept totals
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.credit_level_tick()
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  r record;
begin
  if not coalesce((select (value->>'enabled')::boolean from public.app_settings where key = 'credits'), true) then return; end if;
  if not coalesce((select (value->'rank'->>'on')::boolean from public.app_settings where key = 'credit_extras'), true) then return; end if;
  -- credit_levels() asks for a signed-in user; count here without one
  for r in
    with
    ms as (
      select (m->>'at')::numeric as at, m->>'icon' as icon, m->>'name' as name
      from public.app_settings s, jsonb_array_elements(s.value->'milestones') m where s.key = 'credit_extras'
    ),
    t as (select * from public.credit_lifetime())
    select t.user_id, t.total, cur.at, cur.icon, cur.name
    from t
    join public.profiles p on p.id = t.user_id and p.is_active
    join lateral (select * from ms where ms.at <= t.total order by ms.at desc limit 1) cur on true
  loop
    perform public.notify(
      r.user_id, 'leaderboard',
      format('%s You reached %s!', r.icon, r.name),
      format('%s credits in all. Next level: keep going!', to_char(round(r.total), 'FM999,999,999')),
      jsonb_build_object('route', '/leaderboard'),
      'lb-level:' || r.at::text, false);
  end loop;
end;
$function$;

-- ---------------------------------------------------------------------
-- 4. credit_tick: the ranks once, not once per person
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.credit_tick()
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  x      jsonb := coalesce((select value from public.app_settings where key = 'credit_extras'), '{}'::jsonb);
  on_    boolean := coalesce((select (value->>'enabled')::boolean from public.app_settings where key = 'credits'), true);
  loc    timestamp := now() at time zone 'Asia/Dhaka';
  today  date := loc::date;
  wk     date := public.week_start(loc::date);
  top    record;
  me     record;
begin
  if not on_ then return; end if;

  -- 👑 the winner of the week, to everyone (Friday 2 PM by default)
  if coalesce((x->'winner'->>'on')::boolean, true)
     and extract(dow from loc)::int = coalesce((x->'winner'->>'dow')::int, 5)
     and extract(hour from loc)::int = coalesce((x->'winner'->>'hour')::int, 14) then
    select * into top from public.credit_ranks(wk, today) r where r.rank = 1 and r.total > 0 order by r.name limit 1;
    if found then
      insert into public.credit_winners (week_start, user_id, total) values (wk, top.user_id, top.total)
      on conflict (week_start) do update set user_id = excluded.user_id, total = excluded.total;
      for me in select * from public.credit_ranks(wk, today) loop
        perform public.notify(
          me.user_id, 'leaderboard',
          case when me.user_id = top.user_id then '👑 You are the winner of the week!'
               else format('🏆 This week’s top: %s (%s credits)', split_part(coalesce(top.name, ''), ' ', 1), round(top.total)) end,
          case when me.user_id = top.user_id then format('%s credits. Well done!', round(me.total))
               else format('You are #%s with %s credits.', me.rank, round(me.total)) end,
          jsonb_build_object('route', '/leaderboard'),
          'lb-winner:' || wk::text, false);
      end loop;
    end if;
  end if;

  -- 🥇🥈🥉 into the top 3 this week (once a day each)
  if coalesce((x->'rank'->>'on')::boolean, true) and extract(hour from loc)::int between 9 and 21 then
    for me in select * from public.credit_ranks(wk, today) r where r.rank <= 3 and r.total > 0 loop
      perform public.notify(
        me.user_id, 'leaderboard',
        format('%s You are now #%s this week!', case me.rank when 1 then '🥇' when 2 then '🥈' else '🥉' end, me.rank),
        format('%s credits. Keep going!', round(me.total)),
        jsonb_build_object('route', '/leaderboard'),
        'lb-rank:' || today::text || ':' || me.rank, false);
    end loop;
  end if;

  -- 💪 "only 25 credits to #3" (4 PM by default, once a day)
  if coalesce((x->'nudge'->>'on')::boolean, true)
     and extract(hour from loc)::int = coalesce((x->'nudge'->>'hour')::int, 16) then
    -- (the ranks worked out once, not once per person)
    for me in
      with r as materialized (select * from public.credit_ranks(wk, today))
      select m.user_id, m.rank, m.total, a.total as above_total, a.rank as above_rank
      from r m
      cross join lateral (select r2.total, r2.rank from r r2 where r2.total > m.total order by r2.total asc limit 1) a
      where m.rank > 1
    loop
      if me.above_total - me.total <= coalesce((x->'nudge'->>'gap')::numeric, 50) then
        perform public.notify(
          me.user_id, 'leaderboard',
          format('💪 Only %s credits to #%s!', greatest(1, round(me.above_total - me.total)), me.above_rank),
          format('You are #%s this week with %s credits. A few more calls today?', me.rank, round(me.total)),
          jsonb_build_object('route', '/leaderboard'),
          'lb-nudge:' || today::text, false);
      end if;
    end loop;
  end if;
end;
$function$;

-- ---------------------------------------------------------------------
-- 5. notifications_tick: old ones cleared once an hour; indexes
-- ---------------------------------------------------------------------
create index if not exists notifications_created_idx on public.notifications (created_at);
create index if not exists notifications_stl_idx on public.notifications (user_id) where kind = 'speed_to_lead';
CREATE OR REPLACE FUNCTION public.notifications_tick()
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  r          record;
  v_early    int := public.setting_int('early_reminder_minutes', 10);
  v_repeat   int := public.setting_int('repeat_reminder_minutes', 15);
  v_speed    int := public.setting_int('speed_to_lead_minutes', 15);
  v_tl_h     int := public.setting_int('escalate_team_lead_hours', 4);
  v_admin_h  int := public.setting_int('escalate_admin_hours', 24);
  v_today    date := (now() at time zone 'Asia/Dhaka')::date;
begin
  -- a. Pushes held back by quiet hours
  for r in
    select id from public.notifications
    where sent_at is null and deliver_after <= now()
    order by deliver_after limit 500
  loop
    perform public.push_notification(r.id);
  end loop;

  -- b. Next call soon, and once more if it is late
  for r in
    select f.id, f.due_at, f.note, l.id as lead_id, l.name, l.phone, coalesce(l.assigned_to, f.created_by) as user_id
    from public.follow_ups f
    join public.leads l on l.id = f.lead_id and l.deleted_at is null
    where f.status = 'pending'
      and f.due_at between now() - make_interval(mins => v_repeat) - interval '1 day'
                       and now() + make_interval(mins => v_early)
  loop
    if r.due_at > now() then
      perform public.notify(r.user_id, 'follow_up', '⏰ Call ' || r.name || ' at ' || to_char(r.due_at at time zone 'Asia/Dhaka', 'HH12:MI AM'),
                            concat_ws(' · ', r.phone, r.note), jsonb_build_object('lead_id', r.lead_id), 'fu:' || r.id);
    elsif r.due_at <= now() - make_interval(mins => v_repeat) then
      perform public.notify(r.user_id, 'follow_up', '⚠ Call ' || r.name || ' is late',
                            concat_ws(' · ', r.phone, 'was due ' || to_char(r.due_at at time zone 'Asia/Dhaka', 'HH12:MI AM'), r.note),
                            jsonb_build_object('lead_id', r.lead_id), 'fu-late:' || r.id);
    end if;
  end loop;

  -- c1. Campus visits today (one message per person, from 9 am)
  if (now() at time zone 'Asia/Dhaka')::time >= '09:00' then
    for r in
      select l.assigned_to as user_id, count(*) as n, array_agg(l.id) as ids, min(l.name) as first_name
      from public.lead_visits v
      join public.leads l on l.id = v.lead_id and l.deleted_at is null
      where v.status = 'planned' and l.assigned_to is not null
        and (v.planned_at at time zone 'Asia/Dhaka')::date = v_today
      group by l.assigned_to
    loop
      perform public.notify(r.user_id, 'visit',
        '🏫 ' || case when r.n = 1 then r.first_name || ' visits today' else r.n || ' campus visits today' end,
        'See Home for the times.',
        case when r.n = 1 then jsonb_build_object('lead_id', r.ids[1]) else jsonb_build_object('route', '/') end,
        'visit-day:' || v_today);
    end loop;
  end if;

  -- c2. A visit in the next hour
  for r in
    select v.id, v.planned_at, l.id as lead_id, l.name, l.phone, l.assigned_to as user_id
    from public.lead_visits v
    join public.leads l on l.id = v.lead_id and l.deleted_at is null
    where v.status = 'planned' and l.assigned_to is not null
      and v.planned_at between now() and now() + interval '1 hour'
  loop
    perform public.notify(r.user_id, 'visit', '🏫 ' || r.name || ' visits at ' || to_char(r.planned_at at time zone 'Asia/Dhaka', 'HH12:MI AM'),
                          r.phone, jsonb_build_object('lead_id', r.lead_id), 'visit-1h:' || r.id);
  end loop;

  -- d. New leads not called yet: the person, then the Team Lead, then admins
  --    (one message per person per step; each lead counted once per step)
  for r in
    with fresh as (
      select l.id, l.name, l.created_at, l.assigned_to
      from public.leads l
      join public.pipeline_stages s on s.id = l.stage_id and s.kind = 'open'
      where l.deleted_at is null and l.assigned_to is not null
        and l.last_contacted_at is null
        and not exists (select 1 from public.call_logs c where c.lead_id = l.id)
        and l.created_at > now() - interval '3 days'
    ),
    steps as (
      select f.id, f.name, f.assigned_to as user_id, 'stl' as step
      from fresh f where f.created_at <= now() - make_interval(mins => v_speed)
      union all
      select f.id, f.name, p.team_lead_id, 'stl-tl'
      from fresh f join public.profiles p on p.id = f.assigned_to
      where p.team_lead_id is not null and f.created_at <= now() - make_interval(hours => v_tl_h)
      union all
      select f.id, f.name, a.uid, 'stl-ad'
      from fresh f cross join lateral (select public.admin_ids() as uid) a
      where f.created_at <= now() - make_interval(hours => v_admin_h) and a.uid <> f.assigned_to
    ),
    todo as (
      select s.* from steps s
      where not exists (
        select 1 from public.notifications n
        where n.user_id = s.user_id and n.kind = 'speed_to_lead'
          and n.data -> 'lead_ids' ? s.id::text and n.data ->> 'step' = s.step
      )
    )
    select user_id, step, array_agg(id) as ids, min(name) as first_name, count(*) as n
    from todo group by user_id, step
  loop
    perform public.notify(r.user_id, 'speed_to_lead',
      case r.step
        when 'stl' then '⚡ ' || case when r.n = 1 then r.first_name || ' is waiting for a call' else r.n || ' new leads are waiting for a call' end
        when 'stl-tl' then '⚡ Team: ' || r.n || ' new ' || case when r.n = 1 then 'lead' else 'leads' end || ' not called for ' || v_tl_h || ' h'
        else '⚡ ' || r.n || ' new ' || case when r.n = 1 then 'lead' else 'leads' end || ' not called for ' || v_admin_h || ' h'
      end,
      'Tap to see them.',
      jsonb_build_object('lead_ids', to_jsonb(r.ids), 'step', r.step));
  end loop;

  -- e. Old notifications go after 60 days (once an hour is enough)
  if extract(minute from now())::int = 7 then
    delete from public.notifications where created_at < now() - interval '60 days';
  end if;
end;
$function$;

-- ---------------------------------------------------------------------
-- 6. my_lead_directory: saved phone hashes, the "last note" table
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.my_lead_directory()
 RETURNS TABLE(hash text, lead_id uuid, name text, rating text, stage text, course text, last_note text, student_ref text, fee_due numeric, next_call timestamp with time zone, owner text)
 LANGUAGE sql
 STABLE
 SET search_path TO 'public', 'extensions'
 SET jit TO 'off'
AS $function$
  with visible as (
    select
      l.id, l.name, l.rating, l.phone_hash, l.alt_phone_hash, l.whatsapp_number, l.whatsapp_username,
      l.student_ref, l.next_follow_up_at,
      case when s.kind = 'won' and coalesce(l.fee_due, 0) > 0 then l.fee_due end as fee_due,
      p.full_name as owner,
      case s.kind
        when 'won'       then '🎓 Admitted' || coalesce(' · ' || b.name, '')
        when 'lost'      then '✕ Not Now' || coalesce(' · ' || lr.name, '')
        when 'cancelled' then 'Admission cancelled'
        else s.name
      end as stage,
      coalesce(
        ac.name,
        (select c.name from public.lead_courses lc join public.courses c on c.id = lc.course_id
          where lc.lead_id = l.id limit 1)
      ) as course,
      -- the latest note (a call's or a typed one), kept up to date in lead_last
      ll.note_text as last_note
    from public.leads l
    left join public.pipeline_stages s on s.id = l.stage_id
    left join public.courses ac on ac.id = l.admitted_course_id and s.kind = 'won'
    left join public.batches b on b.id = l.admitted_batch_id
    left join public.lost_reasons lr on lr.id = l.lost_reason_id
    left join public.profiles p on p.id = l.assigned_to
    left join public.lead_last ll on ll.lead_id = l.id
    where l.deleted_at is null
    order by l.updated_at desc nulls last
    limit 10000
  ),
  alum as (
    select a.id, a.name, a.phone, a.whatsapp_number, a.student_ref, a.next_contact_at, a.last_note,
           p.full_name as owner,
           '🎓 Alumni' || coalesce(' · ' || b.name, '') ||
             case when a.cnt_referrals > 0 then ' · ' || a.cnt_referrals || ' referral' ||
                    case when a.cnt_referrals > 1 then 's' else '' end else '' end as stage,
           c.name as course
    from public.alumni a
    left join public.batches b on b.id = a.batch_id
    left join public.courses c on c.id = a.course_id
    left join public.profiles p on p.id = a.owner_id
    where a.deleted_at is null and public.alumni_can('view')
    order by a.updated_at desc
    limit 5000
  ),
  keys as (
    select 1 as prio, v.id, v.name, v.rating, v.stage, v.course, v.last_note, v.student_ref, v.fee_due,
           v.next_follow_up_at as next_call, v.owner, k.h
    from visible v
    -- (the phone numbers' hashes are kept on the lead: only WhatsApp ones are worked out here)
    cross join lateral (values
      (v.phone_hash),
      (v.alt_phone_hash),
      (case when v.whatsapp_number is not null then encode(digest(v.whatsapp_number, 'sha256'), 'hex') end),
      (case when v.whatsapp_username is not null then encode(digest('u:' || v.whatsapp_username, 'sha256'), 'hex') end)
    ) as k(h)
    where k.h is not null
    union all
    select 2, a.id, a.name, null, a.stage, a.course, a.last_note, a.student_ref, null::numeric,
           a.next_contact_at, a.owner, encode(digest(k.key, 'sha256'), 'hex')
    from alum a
    cross join lateral (values (a.phone), (a.whatsapp_number)) as k(key)
    where k.key is not null
    union all
    -- 🏦 the bank (waiting numbers only; the hash is kept on the row)
    select 3, bd.id, bd.name, null, bd.stage, null, bd.note, null, null::numeric, null::timestamptz, null, bd.hash
    from public.bank_directory() bd
  )
  select distinct on (k.h)
         k.h, k.id, k.name, k.rating, k.stage, k.course, left(k.last_note, 120),
         k.student_ref, k.fee_due, k.next_call, k.owner
  from keys k
  order by k.h, k.prio;
$function$;

notify pgrst, 'reload schema';
