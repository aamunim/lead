-- =====================================================================
-- 🏁 Weekly scorecard: each person's week (Sat–Fri) next to the week
--   before. Leads received, calls, connected, admissions, money taken
--   (the lead's counselor), response time to a new lead, missed
--   follow-ups. Admins and the people allowed in Reports see everyone
--   (Team Leads their team); everyone else sees only themselves.
--   Sunday 9:00 (Asia/Dhaka): admins get a notification with the totals.
-- =====================================================================

insert into public.app_settings (key, value, description)
values ('scorecard', '{"enabled": true, "weekday": 0, "hour": 9}', 'Weekly scorecard notification (weekday 0 = Sunday)')
on conflict (key) do nothing;

-- The Saturday that starts the week holding p_day
create or replace function public.week_start(p_day date)
returns date
language sql
immutable
as $$
  select p_day - ((extract(dow from p_day)::int + 1) % 7);
$$;

-- One week of numbers per person (everyone active; the caller filters)
create or replace function public.scorecard_week(p_start date)
returns table (
  user_id uuid, leads int, calls int, connected int, admitted int, money numeric,
  response_min numeric, follow_ups int, missed int
)
language sql
stable
security definer
set search_path = public
as $$
  with days as (select p_start as d0, p_start + 6 as d1),
  got as (
    select l.assigned_to as user_id, count(*)::int as n
    from public.leads l, days
    where l.deleted_at is null and l.assigned_to is not null
      and (l.created_at at time zone 'Asia/Dhaka')::date between d0 and d1
    group by l.assigned_to
  ),
  cl as (
    select c.user_id, count(*)::int as calls,
           count(*) filter (where c.outcome = 'connected')::int as connected
    from public.call_logs c, days
    where (c.called_at at time zone 'Asia/Dhaka')::date between d0 and d1
    group by c.user_id
  ),
  adm as (
    select coalesce(l.assigned_to, l.admitted_by) as user_id, count(*)::int as n
    from public.leads l, days
    where l.deleted_at is null and l.admitted_at is not null
      and (l.admitted_at at time zone 'Asia/Dhaka')::date between d0 and d1
    group by 1
  ),
  pay as (
    select coalesce(l.assigned_to, p.received_by) as user_id,
           sum(case when p.kind = 'refund' then -p.amount else p.amount end) as amount
    from public.fee_payments p
    join public.leads l on l.id = p.lead_id, days
    where p.voided_at is null
      and (p.paid_at at time zone 'Asia/Dhaka')::date between d0 and d1
    group by 1
  ),
  -- New leads of the week: minutes from arrival to the first call by anyone
  resp as (
    select l.assigned_to as user_id,
           avg(extract(epoch from (fc.first_at - l.created_at)) / 60) as minutes
    from public.leads l
    join lateral (select min(c.called_at) as first_at from public.call_logs c where c.lead_id = l.id) fc on true, days
    where l.deleted_at is null and l.assigned_to is not null and fc.first_at is not null
      and (l.created_at at time zone 'Asia/Dhaka')::date between d0 and d1
    group by l.assigned_to
  ),
  fu as (
    select coalesce(l.assigned_to, f.created_by) as user_id,
           count(*)::int as n,
           count(*) filter (
             where f.status = 'pending' and f.due_at < now()
                or (f.status in ('done', 'rescheduled')
                    and (f.completed_at at time zone 'Asia/Dhaka')::date > (f.due_at at time zone 'Asia/Dhaka')::date)
           )::int as missed
    from public.follow_ups f
    join public.leads l on l.id = f.lead_id, days
    where (f.due_at at time zone 'Asia/Dhaka')::date between d0 and d1
    group by 1
  )
  select p.id,
         coalesce(got.n, 0), coalesce(cl.calls, 0), coalesce(cl.connected, 0), coalesce(adm.n, 0),
         coalesce(pay.amount, 0), round(resp.minutes::numeric, 1), coalesce(fu.n, 0), coalesce(fu.missed, 0)
  from public.profiles p
  left join got on got.user_id = p.id
  left join cl on cl.user_id = p.id
  left join adm on adm.user_id = p.id
  left join pay on pay.user_id = p.id
  left join resp on resp.user_id = p.id
  left join fu on fu.user_id = p.id
  where p.is_active;
$$;

-- Who may see whose row
create or replace function public.scorecard_can_see(p_user uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select public.is_active_user() and (
    p_user = auth.uid()
    or public.has_permission('settings.manage')
    or public.has_permission('leads.view_all')
    or (public.has_permission('leads.view_team')
        and exists (select 1 from public.profiles t where t.id = p_user and t.team_lead_id = auth.uid()))
  );
$$;

-- The scorecard: this week and the one before, per person I may see
create or replace function public.weekly_scorecard(p_week date default null)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_start date := public.week_start(coalesce(p_week, (now() at time zone 'Asia/Dhaka')::date - 7));
  v_rows  jsonb;
begin
  if auth.uid() is null or not public.is_active_user() then raise exception 'Please sign in again.'; end if;
  select coalesce(jsonb_agg(jsonb_build_object(
           'user_id', p.id, 'name', p.full_name, 'role', r.name,
           'now', jsonb_build_object('leads', a.leads, 'calls', a.calls, 'connected', a.connected, 'admitted', a.admitted,
                                     'money', a.money, 'response_min', a.response_min, 'follow_ups', a.follow_ups, 'missed', a.missed),
           'before', jsonb_build_object('leads', b.leads, 'calls', b.calls, 'connected', b.connected, 'admitted', b.admitted,
                                        'money', b.money, 'response_min', b.response_min, 'follow_ups', b.follow_ups, 'missed', b.missed)
         ) order by a.admitted desc, a.money desc, p.full_name), '[]'::jsonb)
    into v_rows
  from public.profiles p
  left join public.roles r on r.key = p.role_key
  join public.scorecard_week(v_start) a on a.user_id = p.id
  left join public.scorecard_week(v_start - 7) b on b.user_id = p.id
  where p.is_active and public.scorecard_can_see(p.id)
    -- people who did nothing in both weeks stay out
    and (a.leads + a.calls + a.admitted + a.follow_ups > 0 or a.money <> 0
         or coalesce(b.leads + b.calls + b.admitted + b.follow_ups, 0) > 0 or coalesce(b.money, 0) <> 0);
  return jsonb_build_object('week_start', v_start, 'week_end', v_start + 6, 'rows', v_rows);
end;
$$;

grant execute on function public.weekly_scorecard(date) to authenticated;

-- 🔔 Sunday morning: the totals to admins (and whoever Reports allows)
create or replace function public.scorecard_tick()
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_s     jsonb := coalesce((select value from public.app_settings where key = 'scorecard'), '{}'::jsonb);
  v_local timestamp := now() at time zone 'Asia/Dhaka';
  v_start date;
  v_adm   int; v_adm0 int; v_money numeric; v_calls int; v_leads int;
  v_user  uuid;
  v_body  text;
begin
  if not coalesce((v_s ->> 'enabled')::boolean, true) then return; end if;
  if extract(dow from v_local)::int <> coalesce((v_s ->> 'weekday')::int, 0) then return; end if;
  if extract(hour from v_local)::int <> coalesce((v_s ->> 'hour')::int, 9) then return; end if;

  v_start := public.week_start(v_local::date - 7);
  select coalesce(sum(admitted), 0), coalesce(sum(money), 0), coalesce(sum(calls), 0), coalesce(sum(leads), 0)
    into v_adm, v_money, v_calls, v_leads
  from public.scorecard_week(v_start);
  select coalesce(sum(admitted), 0) into v_adm0 from public.scorecard_week(v_start - 7);

  v_body := format('Admissions %s (%s%s) · taken ৳%s · calls %s · new leads %s',
                   v_adm, case when v_adm - v_adm0 >= 0 then '+' else '' end, v_adm - v_adm0,
                   to_char(v_money, 'FM999,999,999'), v_calls, v_leads);

  for v_user in select a from public.admin_ids() a loop
    perform public.notify(v_user, 'scorecard', '🏁 Last week’s scorecard', v_body,
                          jsonb_build_object('route', '/scorecard', 'week', v_start),
                          'scorecard:' || v_start::text, false);
  end loop;
end;
$$;

do $$
begin
  if exists (select 1 from pg_extension where extname = 'pg_cron') then
    perform cron.unschedule('weekly-scorecard') where exists (select 1 from cron.job where jobname = 'weekly-scorecard');
    perform cron.schedule('weekly-scorecard', '5 * * * *', 'select public.scorecard_tick()');
  end if;
end $$;

notify pgrst, 'reload schema';
