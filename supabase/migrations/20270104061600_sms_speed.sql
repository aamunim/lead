-- =====================================================================
-- ⚡ SMS Center, faster (from an independent review)
--   1. "Can I see this lead?" — the caller's own facts (view all, team,
--      shared mode, courses) are looked up once per call (sms_visible_ids),
--      not 6–10 small queries for every lead. The same rules as the lead
--      list's RLS.
--   2. AI suggestions: the answer carries no lead ids (it was up to ~1 MB);
--      the app asks for one group's ids when "Use" is tapped.
-- =====================================================================

-- inlined into the caller's query: every (select …) is worked out once
create or replace function public.sms_lead_visible(p_assigned_to uuid, p_created_by uuid, p_course_ids uuid[])
returns boolean
language sql
stable
as $$
  select
    ((select public.has_permission('leads.view_all'))
     or (p_assigned_to = (select auth.uid()) and (select public.is_active_user()))
     or ((select public.has_permission('leads.view_team'))
         and p_assigned_to = any (coalesce((select public.my_team_ids()), '{}'::uuid[])))
     or ((select public.is_active_user())
         and ((select public.leads_shared_mode()) or p_created_by = (select auth.uid()))))
    and ((select public.course_free())
         or case when cardinality(coalesce(p_course_ids, '{}')) = 0 then p_created_by = (select auth.uid())
                 else (select public.my_course_ids()) is null or p_course_ids && (select public.my_course_ids()) end);
$$;
revoke all on function public.sms_lead_visible(uuid, uuid, uuid[]) from public, anon, authenticated;


-- the leads I can see (of p_ids, or all when null): my own facts are read once,
-- then one plain check per lead
create or replace function public.sms_visible_ids(p_ids uuid[] default null)
returns table (id uuid)
language plpgsql
stable
security definer
set search_path = public
set jit = off
as $$
declare
  v_uid     uuid := auth.uid();
  v_all     boolean := public.has_permission('leads.view_all');
  v_team    boolean := public.has_permission('leads.view_team');
  v_team_ids uuid[] := coalesce(public.my_team_ids(), '{}'::uuid[]);
  v_active  boolean := public.is_active_user();
  v_shared  boolean := public.leads_shared_mode();
  v_free    boolean := public.course_free();
  v_courses uuid[] := public.my_course_ids();
begin
  return query
  select l.id
  from public.leads l
  where (p_ids is null or l.id = any (p_ids))
    and l.deleted_at is null
    and (v_all
         or (l.assigned_to = v_uid and v_active)
         or (v_team and l.assigned_to = any (v_team_ids))
         or (v_active and (v_shared or l.created_by = v_uid)))
    and (v_free
         or case when cardinality(coalesce(l.course_ids, '{}'::uuid[])) = 0 then l.created_by = v_uid
                 else v_courses is null or l.course_ids && v_courses end);
end;
$$;
revoke all on function public.sms_visible_ids(uuid[]) from public, anon, authenticated;

create or replace function public.sms_lead_rows(p_ids uuid[], p_group text)
returns table (lead_id uuid, name text, num text, in_group boolean, course text, stage text, student_ref text,
               fee_due numeric, owner text, owner_phone text, created_at timestamptz, got_before boolean)
language sql
stable
security definer
set search_path = public
as $$
  select l.id, l.name, public.sms_number(l.phone),
         case p_group when 'active' then st.kind = 'open' and l.closed_at is null
                      when 'not_now' then st.kind = 'lost'
                      when 'admitted' then st.kind = 'won' and l.admitted_at is not null
                      else false end,
         coalesce(ac.name, pc.name, (select c.name from public.courses c where c.id = any (l.course_ids) order by c.name limit 1)),
         st.name, l.student_ref, l.fee_due, o.full_name, o.phone, l.created_at,
         exists (select 1 from public.sms_messages m where m.lead_id = l.id and m.status = 'sent')
  from public.leads l
  join public.pipeline_stages st on st.id = l.stage_id
  left join public.courses ac on ac.id = l.admitted_course_id
  left join public.courses pc on pc.id = l.pipeline_course_id
  left join public.profiles o on o.id = l.assigned_to
  where l.id in (select v.id from public.sms_visible_ids(p_ids) v);
$$;

create or replace function public.sms_ai_segments(p_skip_days int default 3)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
set jit = off
as $$
declare
  v_today date := (now() at time zone 'Asia/Dhaka')::date;
  v_res   jsonb;
begin
  if not public.sms_can_send() then raise exception 'You can''t send SMS. (Settings → SMS)'; end if;

  with
  v as (
    select l.id, st.kind, l.closed_at, l.created_at, l.last_contacted_at, l.next_follow_up_at, l.visit_status,
           l.visit_at, l.admitted_at, l.fee_due, l.fee_next_due, l.papers_missing, l.lost_at, l.rating,
           coalesce(ac.name, pc.name) as course,
           exists (select 1 from public.sms_messages m
                   where m.lead_id = l.id and m.status in ('sent', 'queued', 'sending')
                     and m.created_at > now() - make_interval(days => greatest(coalesce(p_skip_days, 3), 0))) as recent_sms
    from public.leads l
    join public.pipeline_stages st on st.id = l.stage_id
    left join public.courses ac on ac.id = l.admitted_course_id
    left join public.courses pc on pc.id = l.pipeline_course_id
    where l.id in (select vi.id from public.sms_visible_ids(null) vi)
      and public.sms_number(l.phone) is not null
  ),
  seg as (
    -- Active
    select 'call_today' as key, 'active' as grp, 'Next call is today' as title, v.* from v
     where v.kind = 'open' and v.closed_at is null
       and (v.next_follow_up_at at time zone 'Asia/Dhaka')::date = v_today
    union all
    select 'call_late', 'active', 'Next call is late (missed)', v.* from v
     where v.kind = 'open' and v.closed_at is null
       and (v.next_follow_up_at at time zone 'Asia/Dhaka')::date < v_today
    union all
    select 'new_not_called', 'active', 'New in the last 3 days, not talked to yet', v.* from v
     where v.kind = 'open' and v.closed_at is null and v.last_contacted_at is null
       and v.created_at > now() - interval '3 days'
    union all
    select 'quiet_14', 'active', 'No contact for 14+ days', v.* from v
     where v.kind = 'open' and v.closed_at is null
       and coalesce(v.last_contacted_at, v.created_at) < now() - interval '14 days'
    union all
    select 'visit_soon', 'active', 'Campus visit today or tomorrow', v.* from v
     where v.kind = 'open' and v.visit_status = 'planned'
       and (v.visit_at at time zone 'Asia/Dhaka')::date between v_today and v_today + 1
    union all
    select 'hot', 'active', 'Hot leads (rating or AI chance)', v.* from v
     where v.kind = 'open' and v.closed_at is null
       and (v.rating = 'hot' or exists (select 1 from public.lead_chances c where c.lead_id = v.id and c.level = 'hot'))
    -- Admitted
    union all
    select 'fee_overdue', 'admitted', 'Fee installment overdue', v.* from v
     where v.admitted_at is not null and coalesce(v.fee_due, 0) > 0 and v.fee_next_due < v_today
    union all
    select 'fee_due_week', 'admitted', 'Fee installment due in the next 7 days', v.* from v
     where v.admitted_at is not null and coalesce(v.fee_due, 0) > 0
       and v.fee_next_due between v_today and v_today + 7
    union all
    select 'papers_missing', 'admitted', 'Papers still missing', v.* from v
     where v.admitted_at is not null and coalesce(v.papers_missing, 0) > 0
    union all
    select 'new_students', 'admitted', 'Admitted in the last 7 days (welcome)', v.* from v
     where v.admitted_at > now() - interval '7 days'
    -- Not Now
    union all
    select 'not_now_1_6m', 'not_now', 'Said “not now” 1–6 months ago', v.* from v
     where v.kind = 'lost' and v.lost_at between now() - interval '180 days' and now() - interval '30 days'
  ),
  agg as (
    select s.key, s.grp, s.title,
           count(*) filter (where not s.recent_sms) as n,
           count(*) filter (where s.recent_sms) as skipped,
           array_agg(s.id order by s.created_at desc) filter (where not s.recent_sms) as ids
    from seg s
    group by s.key, s.grp, s.title
  ),
  courses as (
    select key, jsonb_agg(jsonb_build_object('course', course, 'n', n) order by n desc) as list
    from (select s.key, coalesce(s.course, 'No course') as course, count(*) as n
          from seg s where not s.recent_sms group by 1, 2) c
    group by key
  )
  select coalesce(jsonb_agg(jsonb_build_object(
           'key', a.key, 'group', a.grp, 'title', a.title, 'count', a.n, 'skipped_recent_sms', a.skipped,
           'courses', coalesce(c.list, '[]'::jsonb),
           'lead_ids', to_jsonb(coalesce(a.ids[1:3000], '{}'::uuid[]))) order by a.n desc), '[]'::jsonb)
  into v_res
  from agg a left join courses c on c.key = a.key
  where a.n > 0;
  return v_res;
end;
$$;

-- one AI group's lead ids ("Use" on a suggestion)
create or replace function public.sms_ai_segment_ids(p_key text, p_skip_days int default 3)
returns uuid[]
language sql
stable
security definer
set search_path = public
set jit = off
as $$
  select coalesce(array(select jsonb_array_elements_text(x -> 'lead_ids')::uuid), '{}'::uuid[])
  from jsonb_array_elements(public.sms_ai_segments(p_skip_days)) x
  where x ->> 'key' = p_key
  union all
  select '{}'::uuid[]
  limit 1;
$$;
revoke all on function public.sms_ai_segment_ids(text, int) from public, anon;
grant execute on function public.sms_ai_segment_ids(text, int) to authenticated;

notify pgrst, 'reload schema';
