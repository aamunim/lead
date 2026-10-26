-- =====================================================================
-- Reports: "Pipeline now" instead of the "how far they got" funnel
--   The funnel counted a lead in every stage up to the furthest one it
--   reached, so its numbers never matched the board (e.g. Follow-up 7 in
--   the report, 0 on the board). Now each lead counts once, in the stage
--   it is in right now - the same as the board.
--     all    : every lead I can see (matches the board without filters)
--     period : only the leads added in the chosen period
-- =====================================================================

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
    select l.*, st.kind as stage_kind
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
      select jsonb_agg(row_to_json(x) order by x.admitted desc, x.leads desc)
      from (
        select p.id as user_id, p.full_name as name,
               (select count(*) from cohort c where c.assigned_to = p.id)::int as leads,
               (select count(*) from scope s
                 where s.assigned_to = p.id and s.stage_kind = 'won'
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
$$;

notify pgrst, 'reload schema';
