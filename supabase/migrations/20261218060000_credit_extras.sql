-- =====================================================================
-- 🏆 Credits, step 2: 🔔 notifications (Friday's winner, "you are now
--   #2", "only 25 credits to #3"), 🔥 streaks, 🎖 badges, and credits in
--   Team activity. Settings: app_settings.credit_extras
-- =====================================================================

insert into public.app_settings (key, value, description)
values (
  'credit_extras',
  '{"winner": {"on": true, "dow": 5, "hour": 14},
    "rank":   {"on": true},
    "nudge":  {"on": true, "hour": 16, "gap": 50},
    "streak_min": 50,
    "badges": true}'::jsonb,
  'Leaderboard notifications, streaks and badges'
)
on conflict (key) do nothing;

-- ---------------------------------------------------------------------
-- 1. Credits per person, day and kind (rules of the day, caps)
--    credit_rows (per person and kind) now builds on it
-- ---------------------------------------------------------------------
create or replace function public.credit_day_kind(p_from date, p_to date)
returns table (user_id uuid, day date, kind text, qty numeric, pts numeric)
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
    select w.user_id, w.day, w.kind, w.qty, rs.rules -> w.kind as rule
    from w
    cross join cfg
    cross join lateral (
      select rules from public.credit_rule_sets x
      where cfg.retro or x.effective_from <= w.day
      order by x.effective_from desc, x.created_at desc
      limit 1
    ) rs
    where cfg.enabled
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
  )
  select user_id, day, kind, qty,
         case when cap > 0 and raw > cap then cap
              when cap > 0 and raw < -cap then -cap
              else raw end
  from per_day
  union all
  select a.user_id, a.day, 'manual', 1::numeric, a.points::numeric
  from public.credit_adjustments a, cfg
  where cfg.enabled and a.day between p_from and p_to;
$$;
revoke all on function public.credit_day_kind(date, date) from public, anon, authenticated;

create or replace function public.credit_rows(p_from date, p_to date)
returns table (user_id uuid, kind text, qty numeric, points numeric)
language sql
stable
security definer
set search_path = public
as $$
  select user_id, kind,
         sum(case when kind = 'app_time' then floor(qty / 60) else qty end),
         sum(pts)
  from public.credit_day_kind(p_from, p_to)
  group by user_id, kind;
$$;
revoke all on function public.credit_rows(date, date) from public, anon, authenticated;

-- Totals and ranks without a signed-in user (for the scheduled notices)
create or replace function public.credit_ranks(p_from date, p_to date)
returns table (user_id uuid, name text, total numeric, rank int)
language sql
stable
security definer
set search_path = public
as $$
  with t as (select r.user_id, sum(r.points) as total from public.credit_rows(p_from, p_to) r group by r.user_id)
  select p.id, p.full_name, coalesce(t.total, 0), (rank() over (order by coalesce(t.total, 0) desc))::int
  from public.profiles p
  left join t on t.user_id = p.id
  where p.is_active and not p.leaderboard_hidden;
$$;
revoke all on function public.credit_ranks(date, date) from public, anon, authenticated;

-- ---------------------------------------------------------------------
-- 2. 🔥 Streaks: days in a row with at least N credits (today counts
--    once reached; a day still in progress doesn't break it)
-- ---------------------------------------------------------------------
create or replace function public.credit_streaks()
returns table (user_id uuid, streak int)
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  today date := (now() at time zone 'Asia/Dhaka')::date;
  need numeric := coalesce((select (value->>'streak_min')::numeric from public.app_settings where key = 'credit_extras'), 50);
begin
  if not public.is_active_user() then return; end if;
  return query
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
  )
  select l.user_id, max(l.len)::int
  from latest l
  where l.last_day >= today - 1
  group by l.user_id;
end;
$$;
revoke all on function public.credit_streaks() from public, anon;
grant execute on function public.credit_streaks() to authenticated;

-- ---------------------------------------------------------------------
-- 3. 👑 Weekly winners (kept when they are announced) and 🎖 badges
-- ---------------------------------------------------------------------
create table if not exists public.credit_winners (
  week_start date primary key,
  user_id    uuid references public.profiles(id) on delete set null,
  total      numeric not null,
  created_at timestamptz not null default now()
);
alter table public.credit_winners enable row level security;
create policy "credit_winners: read" on public.credit_winners for select to authenticated using (public.is_active_user());

-- One person's badges and streak (everyone may see them, like the totals)
create or replace function public.credit_badges(p_user uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  today date := (now() at time zone 'Asia/Dhaka')::date;
  res jsonb;
begin
  if not public.is_active_user() then return null; end if;
  if not coalesce((select (value->>'badges')::boolean from public.app_settings where key = 'credit_extras'), true) then
    return jsonb_build_object('badges', '[]'::jsonb,
      'streak', coalesce((select s.streak from public.credit_streaks() s where s.user_id = p_user), 0));
  end if;

  with
  calls as (
    select (c.called_at at time zone 'Asia/Dhaka') as t, c.outcome, c.duration_sec, c.direction, c.channel
    from public.call_logs c
    where c.user_id = p_user and c.deleted_at is null and c.called_at >= now() - interval '365 days'
  ),
  per_day as (
    select t::date as d,
           count(*) filter (where channel = 'phone' and direction = 'outgoing') as tries,
           coalesce(sum(duration_sec) filter (where channel = 'phone' and outcome = 'connected'), 0) as talk,
           min(t) filter (where channel = 'phone' and direction = 'outgoing') as first_call
    from calls group by 1
  ),
  adm as (
    select public.week_start((l.admitted_at at time zone 'Asia/Dhaka')::date) as wk, count(*) as n
    from public.leads l
    join public.pipeline_stages st on st.id = l.stage_id and st.kind = 'won'
    where l.admitted_by = p_user and l.deleted_at is null and l.admitted_at >= now() - interval '365 days'
    group by 1
  )
  select jsonb_build_object(
    'streak', coalesce((select s.streak from public.credit_streaks() s where s.user_id = p_user), 0),
    'badges', jsonb_build_array(
      jsonb_build_object('key', 'calls100', 'icon', '💯', 'label', '100 calls in a day',
        'count', (select count(*) from per_day where tries >= 100)),
      jsonb_build_object('key', 'admit5', 'icon', '🎓', 'label', '5 admitted in a week',
        'count', (select count(*) from adm where n >= 5)),
      jsonb_build_object('key', 'talk2h', 'icon', '⏱', 'label', '2 hours of talk in a day',
        'count', (select count(*) from per_day where talk >= 7200)),
      jsonb_build_object('key', 'early', 'icon', '🌅', 'label', 'First call before 9 AM',
        'count', (select count(*) from per_day where first_call is not null and first_call::time < time '09:00')),
      jsonb_build_object('key', 'winner', 'icon', '👑', 'label', 'Winner of the week',
        'count', (select count(*) from public.credit_winners w where w.user_id = p_user))
    )
  ) into res;
  return res;
end;
$$;
revoke all on function public.credit_badges(uuid) from public, anon;
grant execute on function public.credit_badges(uuid) to authenticated;

-- ---------------------------------------------------------------------
-- 4. Credits in Team activity (whoever may see that person's activity)
-- ---------------------------------------------------------------------
create or replace function public.team_credits(p_from date, p_to date)
returns table (user_id uuid, total numeric)
language sql
stable
security definer
set search_path = public
as $$
  select r.user_id, sum(r.points)
  from public.credit_rows(p_from, p_to) r
  where public.can_see_activity(r.user_id)
  group by r.user_id;
$$;
revoke all on function public.team_credits(date, date) from public, anon;
grant execute on function public.team_credits(date, date) to authenticated;

-- ---------------------------------------------------------------------
-- 5. 🔔 Every 15 minutes: Friday's winner, "you are now #2", the nudge
-- ---------------------------------------------------------------------
create or replace function public.credit_tick()
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  x      jsonb := coalesce((select value from public.app_settings where key = 'credit_extras'), '{}'::jsonb);
  on_    boolean := coalesce((select (value->>'enabled')::boolean from public.app_settings where key = 'credits'), true);
  loc    timestamp := now() at time zone 'Asia/Dhaka';
  today  date := loc::date;
  wk     date := public.week_start(loc::date);
  top    record;
  me     record;
  above  record;
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
    for me in select * from public.credit_ranks(wk, today) r where r.rank > 1 loop
      select * into above from public.credit_ranks(wk, today) r
       where r.total > me.total order by r.total asc limit 1;
      if found and above.total - me.total <= coalesce((x->'nudge'->>'gap')::numeric, 50) then
        perform public.notify(
          me.user_id, 'leaderboard',
          format('💪 Only %s credits to #%s!', greatest(1, round(above.total - me.total)), above.rank),
          format('You are #%s this week with %s credits. A few more calls today?', me.rank, round(me.total)),
          jsonb_build_object('route', '/leaderboard'),
          'lb-nudge:' || today::text, false);
      end if;
    end loop;
  end if;
end;
$$;
revoke all on function public.credit_tick() from public, anon, authenticated;

do $$
begin
  if exists (select 1 from pg_extension where extname = 'pg_cron') then
    perform cron.unschedule('credit-tick') where exists (select 1 from cron.job where jobname = 'credit-tick');
    perform cron.schedule('credit-tick', '*/15 * * * *', 'select public.credit_tick()');
  end if;
end $$;

-- Save the extras (admins)
create or replace function public.save_credit_extras(p_value jsonb)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if not public.has_permission('settings.manage') then raise exception 'Only admins can change this.'; end if;
  update public.app_settings set value = p_value where key = 'credit_extras';
end;
$$;
revoke all on function public.save_credit_extras(jsonb) from public, anon;
grant execute on function public.save_credit_extras(jsonb) to authenticated;
