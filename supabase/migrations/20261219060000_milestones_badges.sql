-- =====================================================================
-- 🏆 Credits, step 3: 10 milestones (levels by all-time credits), more
--   badges, your own streak and level for the Home top bar (also when
--   the Super Admin left you out of the leaderboard), and a notice when
--   you reach a new level.
-- =====================================================================

update public.app_settings
   set value = value || jsonb_build_object('milestones', '[
     {"at": 100,    "icon": "🌱", "name": "Starter"},
     {"at": 500,    "icon": "🥉", "name": "Bronze"},
     {"at": 1000,   "icon": "🥈", "name": "Silver"},
     {"at": 2500,   "icon": "🥇", "name": "Gold"},
     {"at": 5000,   "icon": "💎", "name": "Platinum"},
     {"at": 10000,  "icon": "💠", "name": "Diamond"},
     {"at": 20000,  "icon": "🏅", "name": "Master"},
     {"at": 35000,  "icon": "🎖", "name": "Grand Master"},
     {"at": 50000,  "icon": "👑", "name": "Champion"},
     {"at": 100000, "icon": "🏆", "name": "Legend"}
   ]'::jsonb)
 where key = 'credit_extras' and not (value ? 'milestones');

-- ---------------------------------------------------------------------
-- 1. All-time credits and the level, for everyone (one count)
-- ---------------------------------------------------------------------
create or replace function public.credit_levels()
returns table (user_id uuid, lifetime numeric, level int, icon text, name text, at numeric,
               next_at numeric, next_icon text, next_name text)
language sql
stable
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
  t as (
    select r.user_id, sum(r.points) as total
    from public.credit_rows('2020-01-01', (now() at time zone 'Asia/Dhaka')::date) r
    group by r.user_id
  )
  select p.id, coalesce(t.total, 0),
         coalesce(cur.lvl, 0)::int, cur.icon, cur.name, cur.at,
         nxt.at, nxt.icon, nxt.name
  from public.profiles p
  left join t on t.user_id = p.id
  left join lateral (select * from ms where ms.at <= coalesce(t.total, 0) order by ms.at desc limit 1) cur on true
  left join lateral (select * from ms where ms.at > coalesce(t.total, 0) order by ms.at asc limit 1) nxt on true
  where p.is_active and public.is_active_user();
$$;
revoke all on function public.credit_levels() from public, anon;
grant execute on function public.credit_levels() to authenticated;

-- Your own streak + level (always, even when left out of the leaderboard)
create or replace function public.credit_me()
returns jsonb
language sql
stable
security definer
set search_path = public
as $$
  select jsonb_build_object(
    'streak', coalesce((select s.streak from public.credit_streaks() s where s.user_id = auth.uid()), 0),
    'enabled', coalesce((select (value->>'enabled')::boolean from public.app_settings where key = 'credits'), true),
    'level', (select to_jsonb(l) from public.credit_levels() l where l.user_id = auth.uid())
  );
$$;
revoke all on function public.credit_me() from public, anon;
grant execute on function public.credit_me() to authenticated;

-- ---------------------------------------------------------------------
-- 2. Badges: the first five and nine more (last 365 days)
-- ---------------------------------------------------------------------
create or replace function public.credit_badges(p_user uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  today date := (now() at time zone 'Asia/Dhaka')::date;
  need numeric := coalesce((select (value->>'streak_min')::numeric from public.app_settings where key = 'credit_extras'), 50);
  on_ boolean := coalesce((select (value->>'badges')::boolean from public.app_settings where key = 'credit_extras'), true);
  best int := 0;
  res jsonb;
begin
  if not public.is_active_user() then return null; end if;

  -- 🔥 the longest run of the last 120 days
  select coalesce(max(len), 0) into best from (
    select count(*) as len from (
      select d.day, d.day - (row_number() over (order by d.day))::int as grp
      from (select day from public.credit_day_kind(today - 120, today) where user_id = p_user
            group by day having sum(pts) >= need) d
    ) g group by grp
  ) runs;

  if not on_ then
    return jsonb_build_object('badges', '[]'::jsonb, 'best_streak', best,
      'streak', coalesce((select s.streak from public.credit_streaks() s where s.user_id = p_user), 0),
      'level', (select to_jsonb(l) from public.credit_levels() l where l.user_id = p_user));
  end if;

  with
  calls as (
    select (c.called_at at time zone 'Asia/Dhaka') as t, c.outcome, c.duration_sec, c.direction, c.channel, c.lead_id, c.called_at
    from public.call_logs c
    where c.user_id = p_user and c.deleted_at is null and c.called_at >= now() - interval '365 days'
  ),
  per_day as (
    select t::date as d,
           count(*) filter (where channel = 'phone' and direction = 'outgoing') as tries,
           count(*) filter (where channel = 'phone' and outcome = 'connected') as talked,
           count(*) filter (where channel = 'whatsapp' and outcome = 'message') as wa,
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
  ),
  added as (
    select (l.created_at at time zone 'Asia/Dhaka')::date as d, count(*) as n
    from public.leads l
    where l.created_by = p_user and l.deleted_at is null and l.import_batch_id is null
      and l.created_at >= now() - interval '365 days'
    group by 1
  ),
  notes as (
    select (a.created_at at time zone 'Asia/Dhaka')::date as d, count(*) as n
    from public.lead_activity a
    where a.user_id = p_user and a.action = 'note_added' and a.created_at >= now() - interval '365 days'
    group by 1
  ),
  money as (
    select public.week_start((p.paid_at at time zone 'Asia/Dhaka')::date) as wk,
           sum(case when p.kind = 'refund' then -p.amount else p.amount end) as amt
    from public.fee_payments p
    where p.received_by = p_user and p.voided_at is null and p.paid_at >= now() - interval '365 days'
    group by 1
  ),
  visits as (
    select public.week_start((a.created_at at time zone 'Asia/Dhaka')::date) as wk, count(*) as n
    from public.lead_activity a
    where a.user_id = p_user and a.action = 'visit_done' and a.created_at >= now() - interval '365 days'
    group by 1
  ),
  fast as (
    -- ⚡ the first call to a new lead, within 10 minutes of it being added
    select count(*) as n
    from public.leads l
    where l.deleted_at is null and l.created_at >= now() - interval '365 days'
      and exists (
        select 1 from public.call_logs c
        where c.lead_id = l.id and c.user_id = p_user and c.deleted_at is null and c.channel = 'phone'
          and c.called_at between l.created_at and l.created_at + interval '10 minutes'
          and not exists (select 1 from public.call_logs c0
                          where c0.lead_id = l.id and c0.deleted_at is null and c0.called_at < c.called_at)
      )
  )
  select jsonb_build_object(
    'streak', coalesce((select s.streak from public.credit_streaks() s where s.user_id = p_user), 0),
    'best_streak', best,
    'level', (select to_jsonb(l) from public.credit_levels() l where l.user_id = p_user),
    'badges', jsonb_build_array(
      jsonb_build_object('key', 'calls100', 'icon', '💯', 'label', '100 calls in a day', 'count', (select count(*) from per_day where tries >= 100)),
      jsonb_build_object('key', 'talked50', 'icon', '🎯', 'label', '50 talked in a day', 'count', (select count(*) from per_day where talked >= 50)),
      jsonb_build_object('key', 'talk2h', 'icon', '⏱', 'label', '2 hours of talk in a day', 'count', (select count(*) from per_day where talk >= 7200)),
      jsonb_build_object('key', 'early', 'icon', '🌅', 'label', 'First call before 9 AM',
        'count', (select count(*) from per_day where first_call is not null and first_call::time < time '09:00')),
      jsonb_build_object('key', 'fast', 'icon', '⚡', 'label', 'New lead called within 10 min', 'count', (select n from fast)),
      jsonb_build_object('key', 'leads10', 'icon', '🆕', 'label', '10 new leads in a day', 'count', (select count(*) from added where n >= 10)),
      jsonb_build_object('key', 'notes30', 'icon', '📝', 'label', '30 notes in a day', 'count', (select count(*) from notes where n >= 30)),
      jsonb_build_object('key', 'wa50', 'icon', '💬', 'label', '50 WhatsApp messages in a day', 'count', (select count(*) from per_day where wa >= 50)),
      jsonb_build_object('key', 'admit5', 'icon', '🎓', 'label', '5 admitted in a week', 'count', (select count(*) from adm where n >= 5)),
      jsonb_build_object('key', 'visits5', 'icon', '🏫', 'label', '5 campus visits in a week', 'count', (select count(*) from visits where n >= 5)),
      jsonb_build_object('key', 'money50k', 'icon', '💵', 'label', '৳50,000 taken in a week', 'count', (select count(*) from money where amt >= 50000)),
      jsonb_build_object('key', 'streak7', 'icon', '🔥', 'label', '7 days in a row', 'count', case when best >= 7 then 1 else 0 end),
      jsonb_build_object('key', 'streak30', 'icon', '☄️', 'label', '30 days in a row', 'count', case when best >= 30 then 1 else 0 end),
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
-- 3. 🔔 A new level reached (checked once an hour; only the highest)
-- ---------------------------------------------------------------------
create or replace function public.credit_level_tick()
returns void
language plpgsql
security definer
set search_path = public
as $$
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
    t as (
      select x.user_id, sum(x.points) as total
      from public.credit_rows('2020-01-01', (now() at time zone 'Asia/Dhaka')::date) x group by x.user_id
    )
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
$$;
revoke all on function public.credit_level_tick() from public, anon, authenticated;

do $$
begin
  if exists (select 1 from pg_extension where extname = 'pg_cron') then
    perform cron.unschedule('credit-level-tick') where exists (select 1 from cron.job where jobname = 'credit-level-tick');
    perform cron.schedule('credit-level-tick', '20 * * * *', 'select public.credit_level_tick()');
  end if;
end $$;

-- ---------------------------------------------------------------------
-- 4. Saving the extras keeps the milestones when a screen leaves them
--    out, and checks them (1-10 levels, going up, each with a name)
-- ---------------------------------------------------------------------
create or replace function public.save_credit_extras(p_value jsonb)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v jsonb := p_value;
  m jsonb;
  n int;
begin
  if not public.has_permission('settings.manage') then raise exception 'Only admins can change this.'; end if;
  if not (v ? 'milestones') then
    v := v || jsonb_build_object('milestones',
      coalesce((select value->'milestones' from public.app_settings where key = 'credit_extras'), '[]'::jsonb));
  end if;
  m := v->'milestones';
  if jsonb_typeof(m) <> 'array' then raise exception 'Milestones must be a list.'; end if;
  n := jsonb_array_length(m);
  if n > 10 then raise exception 'At most 10 milestones.'; end if;
  if exists (
    select 1 from jsonb_array_elements(m) with ordinality e(x, i)
    where coalesce(trim(x->>'name'), '') = '' or coalesce((x->>'at')::numeric, 0) <= 0
  ) then raise exception 'Every milestone needs a name and credits above 0.'; end if;
  if (select count(distinct (x->>'at')::numeric) from jsonb_array_elements(m) x) <> n then
    raise exception 'Two milestones have the same credits.';
  end if;
  -- keep them in order, lowest first
  v := jsonb_set(v, '{milestones}', coalesce(
    (select jsonb_agg(x order by (x->>'at')::numeric) from jsonb_array_elements(m) x), '[]'::jsonb));
  update public.app_settings set value = v where key = 'credit_extras';
end;
$$;
revoke all on function public.save_credit_extras(jsonb) from public, anon;
grant execute on function public.save_credit_extras(jsonb) to authenticated;
