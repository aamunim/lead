-- =====================================================================
-- Reports (More → Reports, and the Home card)
--   1. Setting: who sees reports, the Home card, which parts are shown
--   2. lead_report(): everything except calls in one call, as JSON
--      Runs as the signed-in user, so each person only counts the leads
--      they can see (own / team / all), like the leads list.
--   Calls and the best-time grid use call_report() / call_heatmap().
-- =====================================================================

-- ---------------------------------------------------------------------
-- 1. Setting
-- ---------------------------------------------------------------------
insert into public.app_settings (key, value)
values ('reports', '{
  "who": {"mode": "all", "roles": [], "user_ids": []},
  "home_card": true,
  "sections": {"summary": true, "funnel": true, "visits": true, "sources": true,
               "team": true, "lost": true, "heatmap": true}
}'::jsonb)
on conflict (key) do nothing;

-- ---------------------------------------------------------------------
-- 2. The report
--   p_from, p_to : days (Bangladesh time), both included
--   p_user_id    : only leads assigned to this person (null = everyone I see)
--   p_course_id  : only leads interested in / admitted to this course
--
--   "Added in the period" leads (the cohort) feed the funnel, sources,
--   visits and conversion. Admitted / lost counts are by the day it happened.
--   Funnel: how far each lead got = its furthest open stage in the stage
--   history (or its stage now); an admitted lead got to the end.
-- ---------------------------------------------------------------------
create or replace function public.lead_report(
  p_from      date,
  p_to        date,
  p_user_id   uuid default null,
  p_course_id uuid default null
)
returns jsonb
language sql
stable
security invoker
set search_path = public
as $$
  with
  -- Every lead I can see, with the person / course filters
  scope as (
    select l.*
    from public.leads l
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
  -- How far each lead got (sort order of its furthest open stage; admitted = the end)
  reach as (
    select c.id,
           case
             when c.admitted_at is not null then 1000000
             else coalesce((
               select max(s.sort_order)
               from (
                 select h.to_stage_id as stage_id from public.lead_stage_history h where h.lead_id = c.id
                 union all
                 select c.stage_id
               ) x
               join stages s on s.id = x.stage_id and s.kind = 'open'
             ), 0)
           end as furthest
    from cohort c
  ),
  funnel_steps as (
    select s.id, s.key, s.name, s.color, s.kind, s.sort_order
    from stages s
    where s.kind = 'open' and s.is_active
    union all
    select s.id, s.key, s.name, s.color, s.kind, 1000000
    from stages s
    where s.kind = 'won'
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
        'cohort_admitted', (select count(*) from cohort where admitted_at is not null and cancelled_at is null),
        'admitted', (select count(*) from scope
                     where admitted_at is not null and cancelled_at is null
                       and (admitted_at at time zone 'Asia/Dhaka')::date between p_from and p_to),
        'lost', (select count(*) from scope
                 where lost_at is not null
                   and (lost_at at time zone 'Asia/Dhaka')::date between p_from and p_to),
        'avg_days_to_admit', (select round(avg(extract(epoch from (admitted_at - created_at)) / 86400)::numeric, 1)
                              from scope
                              where admitted_at is not null and cancelled_at is null
                                and (admitted_at at time zone 'Asia/Dhaka')::date between p_from and p_to)
      )
    ),

    -- ② Funnel (leads added in the period)
    'funnel', coalesce((
      select jsonb_agg(jsonb_build_object(
               'stage_id', f.id, 'key', f.key, 'name', f.name, 'color', f.color, 'kind', f.kind,
               'reached', (select count(*) from reach r where r.furthest >= f.sort_order),
               'now', (select count(*) from cohort c where c.stage_id = f.id)
             ) order by f.sort_order)
      from funnel_steps f
    ), '[]'::jsonb),

    -- ③ Campus visits
    'visits', jsonb_build_object(
      'planned_now', (select count(*) from cohort where visit_status = 'planned'),
      'visited', (select count(*) from visited_leads),
      'missed', (select count(distinct v.lead_id) from public.lead_visits v
                 join cohort c on c.id = v.lead_id where v.status = 'missed'),
      'visited_admitted', (select count(*) from cohort c join visited_leads vl on vl.lead_id = c.id
                           where c.admitted_at is not null and c.cancelled_at is null),
      'not_visited', (select count(*) from cohort c where not exists (select 1 from visited_leads vl where vl.lead_id = c.id)),
      'not_visited_admitted', (select count(*) from cohort c
                               where c.admitted_at is not null and c.cancelled_at is null
                                 and not exists (select 1 from visited_leads vl where vl.lead_id = c.id))
    ),

    -- ④ Sources and campaigns (leads added in the period)
    'sources', coalesce((
      select jsonb_agg(row_to_json(x) order by x.leads desc, x.name)
      from (
        select coalesce(src.name, 'No source') as name,
               count(*)::int as leads,
               count(*) filter (where c.admitted_at is not null and c.cancelled_at is null)::int as admitted
        from cohort c left join public.lead_sources src on src.id = c.source_id
        group by src.name
      ) x
    ), '[]'::jsonb),
    'campaigns', coalesce((
      select jsonb_agg(row_to_json(x) order by x.leads desc, x.name)
      from (
        select cmp.name,
               count(*)::int as leads,
               count(*) filter (where c.admitted_at is not null and c.cancelled_at is null)::int as admitted
        from cohort c join public.campaigns cmp on cmp.id = c.campaign_id
        group by cmp.name
      ) x
    ), '[]'::jsonb),

    -- ⑤ Team (per assigned person)
    'team', coalesce((
      select jsonb_agg(row_to_json(x) order by x.admitted desc, x.leads desc)
      from (
        select p.id as user_id, p.full_name as name,
               (select count(*) from cohort c where c.assigned_to = p.id)::int as leads,
               (select count(*) from scope s
                 where s.assigned_to = p.id and s.admitted_at is not null and s.cancelled_at is null
                   and (s.admitted_at at time zone 'Asia/Dhaka')::date between p_from and p_to)::int as admitted,
               (select count(*) from scope s
                 where s.assigned_to = p.id and s.closed_at is null and s.next_follow_up_at < now())::int as overdue
        from public.profiles p
        where p.id in (select assigned_to from scope where assigned_to is not null)
      ) x
    ), '[]'::jsonb),

    -- ⑥ Why leads are lost (lost in the period) and from which stage
    'lost_reasons', coalesce((
      select jsonb_agg(row_to_json(x) order by x.leads desc)
      from (
        select coalesce(lr.name, 'No reason') as name, count(*)::int as leads
        from scope s left join public.lost_reasons lr on lr.id = s.lost_reason_id
        where s.lost_at is not null and (s.lost_at at time zone 'Asia/Dhaka')::date between p_from and p_to
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
        where s.lost_at is not null and (s.lost_at at time zone 'Asia/Dhaka')::date between p_from and p_to
        group by fs.name
      ) x
    ), '[]'::jsonb)
  );
$$;

grant execute on function public.lead_report(date, date, uuid, uuid) to authenticated;

notify pgrst, 'reload schema';
