-- =====================================================================
-- 🏆 Credits and the leaderboard
--   Credits are worked out from what is already saved (calls, notes,
--   changes, app time, leads, payments…), so the leaderboard covers the
--   past too. Settings → Credits says how many credits each kind of work
--   is worth and the most per day; with "apply changes to the past" off,
--   each day keeps the rules that were in force then.
--   Everyone sees the totals; the breakdown: yourself, and the Super
--   Admin everyone's. The Super Admin can leave anyone (themself too)
--   out of the leaderboard.
-- =====================================================================

-- ---------------------------------------------------------------------
-- 1. The rules (each save is kept with the day it starts)
-- ---------------------------------------------------------------------
create table if not exists public.credit_rule_sets (
  id             uuid primary key default gen_random_uuid(),
  effective_from date not null default ((now() at time zone 'Asia/Dhaka')::date),
  rules          jsonb not null,
  created_by     uuid references public.profiles(id) on delete set null,
  created_at     timestamptz not null default now()
);
alter table public.credit_rule_sets enable row level security;
create policy "credit_rule_sets: read" on public.credit_rule_sets for select to authenticated using (public.is_active_user());

-- points = credits for one; cap = most credits a day (0 = no limit)
insert into public.credit_rule_sets (effective_from, rules)
select '2000-01-01', '{
  "call_any":          {"points": 1,  "cap": 0,  "on": true},
  "call_connected":    {"points": 3,  "cap": 0,  "on": true, "min_sec": 10},
  "talk_minute":       {"points": 1,  "cap": 0,  "on": true, "per_call": 10},
  "incoming":          {"points": 2,  "cap": 0,  "on": true},
  "wa_message":        {"points": 1,  "cap": 0,  "on": true},
  "wa_call":           {"points": 2,  "cap": 0,  "on": true},
  "template":          {"points": 1,  "cap": 0,  "on": true},
  "note":              {"points": 2,  "cap": 0,  "on": true, "min_chars": 15},
  "voice":             {"points": 2,  "cap": 0,  "on": true},
  "follow_up_set":     {"points": 1,  "cap": 0,  "on": true},
  "follow_up_on_time": {"points": 2,  "cap": 0,  "on": true},
  "lead_added":        {"points": 5,  "cap": 0,  "on": true},
  "lead_imported":     {"points": 0,  "cap": 0,  "on": true},
  "stage_forward":     {"points": 3,  "cap": 0,  "on": true},
  "visit_planned":     {"points": 5,  "cap": 0,  "on": true},
  "visit_done":        {"points": 10, "cap": 0,  "on": true},
  "paper":             {"points": 2,  "cap": 0,  "on": true},
  "admitted":          {"points": 50, "cap": 0,  "on": true},
  "payment":           {"points": 2,  "cap": 0,  "on": true, "per_taka": 1000},
  "app_time":          {"points": 1,  "cap": 30, "on": true, "per_min": 10},
  "overdue":           {"points": -1, "cap": 0,  "on": false}
}'::jsonb
where not exists (select 1 from public.credit_rule_sets);

insert into public.app_settings (key, value, description)
values ('credits', '{"enabled": true, "retro": true}'::jsonb, 'Credits and the leaderboard')
on conflict (key) do nothing;

-- ---------------------------------------------------------------------
-- 2. Hand-given credits (a bonus, or a deduction) with a reason
-- ---------------------------------------------------------------------
create table if not exists public.credit_adjustments (
  id         uuid primary key default gen_random_uuid(),
  user_id    uuid not null references public.profiles(id) on delete cascade,
  day        date not null default ((now() at time zone 'Asia/Dhaka')::date),
  points     int not null check (points <> 0),
  reason     text not null check (length(trim(reason)) > 0),
  created_by uuid references public.profiles(id) on delete set null,
  created_at timestamptz not null default now()
);
create index if not exists credit_adjustments_user_idx on public.credit_adjustments (user_id, day);
alter table public.credit_adjustments enable row level security;
create policy "credit_adjustments: read own or super admin" on public.credit_adjustments
  for select to authenticated
  using (user_id = auth.uid() or public.current_role_key() = 'super_admin');

-- ---------------------------------------------------------------------
-- 3. Who is left out of the leaderboard (only the Super Admin decides)
-- ---------------------------------------------------------------------
alter table public.profiles add column if not exists leaderboard_hidden boolean not null default false;

create or replace function public.guard_leaderboard_hidden()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if new.leaderboard_hidden is distinct from old.leaderboard_hidden
     and coalesce(current_setting('app.bypass_profile_guard', true), '') <> 'on'
     and public.current_role_key() is distinct from 'super_admin' then
    raise exception 'Only the Super Admin can change who is on the leaderboard.';
  end if;
  return new;
end;
$$;
drop trigger if exists profiles_guard_leaderboard on public.profiles;
create trigger profiles_guard_leaderboard before update on public.profiles
for each row execute function public.guard_leaderboard_hidden();

create or replace function public.set_leaderboard_hidden(p_user uuid, p_hidden boolean)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if public.current_role_key() is distinct from 'super_admin' then
    raise exception 'Only the Super Admin can change who is on the leaderboard.';
  end if;
  update public.profiles set leaderboard_hidden = p_hidden where id = p_user;
end;
$$;
revoke all on function public.set_leaderboard_hidden(uuid, boolean) from public, anon;
grant execute on function public.set_leaderboard_hidden(uuid, boolean) to authenticated;

-- ---------------------------------------------------------------------
-- 4. Save the rules (admins)
-- ---------------------------------------------------------------------
create or replace function public.save_credit_rules(p_rules jsonb, p_enabled boolean, p_retro boolean)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  today date := (now() at time zone 'Asia/Dhaka')::date;
begin
  if not public.has_permission('settings.manage') then raise exception 'Only admins can change the credits.'; end if;
  update public.app_settings
     set value = jsonb_build_object('enabled', p_enabled, 'retro', p_retro)
   where key = 'credits';
  -- One set per day: a second save the same day replaces it
  delete from public.credit_rule_sets where effective_from = today and effective_from <> '2000-01-01';
  insert into public.credit_rule_sets (effective_from, rules, created_by) values (today, p_rules, auth.uid());
end;
$$;
revoke all on function public.save_credit_rules(jsonb, boolean, boolean) from public, anon;
grant execute on function public.save_credit_rules(jsonb, boolean, boolean) to authenticated;

-- ---------------------------------------------------------------------
-- 5. The work, as (person, day, kind, how many)
-- ---------------------------------------------------------------------
create or replace function public.credit_work(p_from date, p_to date)
returns table (user_id uuid, day date, kind text, qty numeric)
language sql
stable
security definer
set search_path = public
as $$
  with
  latest as (select rules from public.credit_rule_sets order by effective_from desc, created_at desc limit 1),
  r as (select rules from latest),
  calls as (
    select c.*, (c.called_at at time zone 'Asia/Dhaka')::date as d
    from public.call_logs c
    where c.deleted_at is null
      and (c.called_at at time zone 'Asia/Dhaka')::date between p_from and p_to
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
    and (a.created_at at time zone 'Asia/Dhaka')::date between p_from and p_to
    and length(trim(coalesce(a.details->>'note', ''))) >= coalesce((r.rules->'note'->>'min_chars')::int, 15)
  group by 1, 2
  union all
  select f.uploaded_by, (f.created_at at time zone 'Asia/Dhaka')::date, 'voice', count(*)::numeric
  from public.lead_files f
  where f.kind = 'voice' and f.deleted_at is null and f.uploaded_by is not null
    and (f.created_at at time zone 'Asia/Dhaka')::date between p_from and p_to
  group by 1, 2
  union all
  -- ⏰ next call set / done on time
  select a.user_id, (a.created_at at time zone 'Asia/Dhaka')::date, 'follow_up_set', count(*)::numeric
  from public.lead_activity a
  where a.action = 'follow_up_set' and (a.created_at at time zone 'Asia/Dhaka')::date between p_from and p_to
  group by 1, 2
  union all
  select f.completed_by, (f.completed_at at time zone 'Asia/Dhaka')::date, 'follow_up_on_time', count(*)::numeric
  from public.follow_ups f
  where f.status = 'done' and f.completed_by is not null
    and (f.completed_at at time zone 'Asia/Dhaka')::date between p_from and p_to
    and (f.completed_at at time zone 'Asia/Dhaka')::date <= (f.due_at at time zone 'Asia/Dhaka')::date
  group by 1, 2
  union all
  -- ⚠️ a next call left undone past its day (the lead's owner)
  select coalesce(l.assigned_to, f.created_by), (f.due_at at time zone 'Asia/Dhaka')::date, 'overdue', count(*)::numeric
  from public.follow_ups f
  join public.leads l on l.id = f.lead_id and l.deleted_at is null
  where (f.due_at at time zone 'Asia/Dhaka')::date between p_from and p_to
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
    and (l.created_at at time zone 'Asia/Dhaka')::date between p_from and p_to
  group by 1, 2, 3
  union all
  -- 🚩 a stage further on
  select a.user_id, (a.created_at at time zone 'Asia/Dhaka')::date, 'stage_forward', count(*)::numeric
  from public.lead_activity a
  join public.pipeline_stages s1 on s1.id::text = a.details->>'from'
  join public.pipeline_stages s2 on s2.id::text = a.details->>'to'
  where a.action = 'stage_changed' and s2.sort_order > s1.sort_order and s2.kind = 'open'
    and (a.created_at at time zone 'Asia/Dhaka')::date between p_from and p_to
  group by 1, 2
  union all
  -- 🏫 campus visits and 📄 papers
  select a.user_id, (a.created_at at time zone 'Asia/Dhaka')::date,
         case a.action when 'visit_planned' then 'visit_planned' when 'visit_done' then 'visit_done' else 'paper' end,
         count(*)::numeric
  from public.lead_activity a
  where a.action in ('visit_planned', 'visit_done', 'paper_received')
    and (a.created_at at time zone 'Asia/Dhaka')::date between p_from and p_to
  group by 1, 2, 3
  union all
  -- 🎓 admitted (still admitted)
  select l.admitted_by, (l.admitted_at at time zone 'Asia/Dhaka')::date, 'admitted', count(*)::numeric
  from public.leads l
  join public.pipeline_stages st on st.id = l.stage_id and st.kind = 'won'
  where l.deleted_at is null and l.admitted_by is not null
    and (l.admitted_at at time zone 'Asia/Dhaka')::date between p_from and p_to
  group by 1, 2
  union all
  -- 💵 money taken (refunds take it back; voided ones don't count)
  select p.received_by, (p.paid_at at time zone 'Asia/Dhaka')::date, 'payment',
         sum(case when p.kind = 'refund' then -p.amount else p.amount end)
  from public.fee_payments p
  where p.voided_at is null and p.received_by is not null
    and (p.paid_at at time zone 'Asia/Dhaka')::date between p_from and p_to
  group by 1, 2
  union all
  -- 📱 time working in the app (seconds)
  select s.user_id, (s.started_at at time zone 'Asia/Dhaka')::date, 'app_time', sum(s.active_sec)::numeric
  from public.app_sessions s
  where (s.started_at at time zone 'Asia/Dhaka')::date between p_from and p_to
  group by 1, 2;
$$;
revoke all on function public.credit_work(date, date) from public, anon, authenticated;

-- ---------------------------------------------------------------------
-- 6. Credits per person and kind (rules of the day, caps, hand-given)
-- ---------------------------------------------------------------------
create or replace function public.credit_rows(p_from date, p_to date)
returns table (user_id uuid, kind text, qty numeric, points numeric)
language sql
stable
security definer
set search_path = public
as $$
  with
  cfg as (select coalesce((value->>'retro')::boolean, true) as retro, coalesce((value->>'enabled')::boolean, true) as enabled
          from public.app_settings where key = 'credits'),
  w as (select * from public.credit_work(p_from, p_to) where user_id is not null),
  priced as (
    select w.user_id, w.day, w.kind, w.qty,
           rs.rules -> w.kind as rule
    from w
    cross join cfg
    cross join lateral (
      select rules from public.credit_rule_sets x
      where cfg.retro or x.effective_from <= w.day
      order by x.effective_from desc, x.created_at desc
      limit 1
    ) rs
  ),
  per_day as (
    select user_id, day, kind, qty,
           case
             when rule is null or not coalesce((rule->>'on')::boolean, false) then 0
             else
               (case kind
                  when 'payment'  then floor(qty / greatest(coalesce((rule->>'per_taka')::numeric, 1000), 1))
                  when 'app_time' then floor(qty / 60.0 / greatest(coalesce((rule->>'per_min')::numeric, 10), 1))
                  else qty
                end) * coalesce((rule->>'points')::numeric, 0)
           end as raw,
           coalesce((rule->>'cap')::numeric, 0) as cap
    from priced
  ),
  capped as (
    select user_id, kind, day, qty,
           case when cap > 0 and raw > cap then cap
                when cap > 0 and raw < -cap then -cap
                else raw end as pts
    from per_day
  )
  select c.user_id, c.kind,
         sum(case when c.kind = 'app_time' then floor(c.qty / 60) else c.qty end),
         sum(c.pts)
  from capped c, cfg
  where cfg.enabled
  group by c.user_id, c.kind
  union all
  select a.user_id, 'manual', count(*)::numeric, sum(a.points)::numeric
  from public.credit_adjustments a, cfg
  where cfg.enabled and a.day between p_from and p_to
  group by a.user_id;
$$;
revoke all on function public.credit_rows(date, date) from public, anon, authenticated;

-- ---------------------------------------------------------------------
-- 7. The leaderboard (everyone; hidden people left out, except yourself)
-- ---------------------------------------------------------------------
create or replace function public.leaderboard(p_from date, p_to date)
returns table (user_id uuid, name text, role_key text, total numeric, rank int, hidden boolean, team_lead_id uuid)
language sql
stable
security definer
set search_path = public
as $$
  with t as (
    select r.user_id, sum(r.points) as total from public.credit_rows(p_from, p_to) r group by r.user_id
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
revoke all on function public.leaderboard(date, date) from public, anon;
grant execute on function public.leaderboard(date, date) to authenticated;

-- ---------------------------------------------------------------------
-- 8. One person's breakdown: yourself, or the Super Admin anyone's
-- ---------------------------------------------------------------------
create or replace function public.credit_breakdown(p_user uuid, p_from date, p_to date)
returns table (kind text, qty numeric, points numeric)
language plpgsql
stable
security definer
set search_path = public
as $$
begin
  if p_user is distinct from auth.uid() and public.current_role_key() is distinct from 'super_admin' then
    raise exception 'Only the Super Admin can see someone else''s breakdown.';
  end if;
  return query
    select r.kind, r.qty, r.points from public.credit_rows(p_from, p_to) r
    where r.user_id = p_user and r.points <> 0
    order by r.points desc;
end;
$$;
revoke all on function public.credit_breakdown(uuid, date, date) from public, anon;
grant execute on function public.credit_breakdown(uuid, date, date) to authenticated;

-- ---------------------------------------------------------------------
-- 9. Give / take credits by hand (Super Admin), into the change log too
-- ---------------------------------------------------------------------
create or replace function public.add_credit_adjustment(p_user uuid, p_points int, p_reason text)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if public.current_role_key() is distinct from 'super_admin' then
    raise exception 'Only the Super Admin can give or take credits.';
  end if;
  if p_points = 0 or length(trim(coalesce(p_reason, ''))) = 0 then
    raise exception 'Give a number of credits and a reason.';
  end if;
  insert into public.credit_adjustments (user_id, points, reason, created_by)
  values (p_user, p_points, trim(p_reason), auth.uid());
end;
$$;
revoke all on function public.add_credit_adjustment(uuid, int, text) from public, anon;
grant execute on function public.add_credit_adjustment(uuid, int, text) to authenticated;

-- 📜 The rule sets in use (for Settings)
create or replace function public.current_credit_rules()
returns jsonb
language sql
stable
security definer
set search_path = public
as $$
  select rules from public.credit_rule_sets order by effective_from desc, created_at desc limit 1;
$$;
grant execute on function public.current_credit_rules() to authenticated;
