-- =====================================================================
-- Fix: an undone admission still counted as admitted
--   Admitted → Cancel admission → Reopen left admitted_at (and the course,
--   batch, note) on the lead, so Reports and the "Admitted" filter still
--   counted it.
--   1. Reopen now clears the admission (the student ID is kept, so
--      admitting again gives the same ID)
--   2. Leads that are open or lost now lose the old admission data
--   3. Reports count "admitted" / "lost" by the lead's stage now
-- =====================================================================

-- ---------------------------------------------------------------------
-- 1. Reopen (replaces the earlier version)
-- ---------------------------------------------------------------------
create or replace function public.reopen_lead(
  p_lead_id  uuid,
  p_stage_id uuid default null,
  p_note     text default null
)
returns void
language plpgsql
security invoker
set search_path = public
as $$
declare
  v_kind  text;
  v_stage uuid := p_stage_id;
  v_rows  int;
begin
  if not public.is_active_user() then raise exception 'Your account is not active.'; end if;

  select s.kind into v_kind
  from public.leads l
  join public.pipeline_stages s on s.id = l.stage_id
  where l.id = p_lead_id and l.deleted_at is null;

  if v_kind is null then raise exception 'Lead not found.'; end if;
  if v_kind = 'open' then raise exception 'This lead is already open.'; end if;
  if v_kind = 'won' then raise exception 'This lead is admitted. Use Cancel admission instead.'; end if;

  -- Default: "Interested", else the first open stage
  if v_stage is null then
    select id into v_stage from public.pipeline_stages where key = 'interested' and kind = 'open' and is_active;
    if v_stage is null then
      select id into v_stage from public.pipeline_stages where kind = 'open' and is_active order by sort_order limit 1;
    end if;
  elsif not exists (select 1 from public.pipeline_stages where id = v_stage and kind = 'open' and is_active) then
    raise exception 'Please choose a normal stage.';
  end if;

  perform set_config('app.pipeline_action', 'on', true);
  perform set_config('app.stage_note', concat_ws(' · ', 'Reopened', nullif(trim(coalesce(p_note, '')), '')), true);

  update public.leads
     set stage_id       = v_stage,
         closed_at      = null,
         lost_reason_id = null,
         lost_at        = null,
         lost_by        = null,
         lost_note      = null,
         cancelled_at   = null,
         cancelled_by   = null,
         cancel_reason  = null,
         -- An undone admission must not count as admitted any more.
         -- The student ID stays, so admitting again gives the same ID.
         admitted_at        = null,
         admitted_by        = null,
         admitted_course_id = null,
         admitted_batch_id  = null,
         admission_note     = null,
         call_attempts  = 0,
         unreachable_at = null
   where id = p_lead_id;

  get diagnostics v_rows = row_count;
  if v_rows = 0 then raise exception 'You can''t change this lead.'; end if;

  -- An old "♻️ Revive" call has done its job
  update public.follow_ups
     set status = 'done', completed_at = now(), completed_by = auth.uid()
   where lead_id = p_lead_id and status = 'pending' and purpose = 'revive';
end;
$$;

-- ---------------------------------------------------------------------
-- 2. Clean the leads that were reopened before this fix
--    (cancelled leads keep their admission: their card shows it)
-- ---------------------------------------------------------------------
do $$
begin
  perform set_config('app.pipeline_action', 'on', true);
  update public.leads l
     set admitted_at        = null,
         admitted_by        = null,
         admitted_course_id = null,
         admitted_batch_id  = null,
         admission_note     = null
    from public.pipeline_stages s
   where s.id = l.stage_id
     and s.kind in ('open', 'lost')
     and (l.admitted_at is not null or l.admitted_batch_id is not null);
  perform set_config('app.pipeline_action', '', true);
end;
$$;

-- ---------------------------------------------------------------------
-- 3. Reports: admitted = in the Admitted stage now, lost = in Lost now
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
  -- How far each lead got (sort order of its furthest open stage; admitted = the end)
  reach as (
    select c.id,
           case
             when c.stage_kind = 'won' then 1000000
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
