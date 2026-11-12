-- =====================================================================
-- 🤖📨 SMS Center → AI suggestions: "which leads should get which SMS today?"
--   The server puts my leads (only the ones I can see, with a mobile
--   number) into ready groups — next call today, new and not called,
--   quiet for 2 weeks, visit today/tomorrow, fee due, papers missing,
--   Not Now 1–6 months ago… — and gives the AI only each group's name,
--   size and courses (no names, no numbers). The AI picks the groups worth
--   an SMS today and writes the SMS; the app opens each with its leads.
--   Leads that got an SMS in the last p_skip_days are left out.
-- =====================================================================

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
    where l.deleted_at is null
      and public.sms_number(l.phone) is not null
      and public.sms_lead_visible(l.assigned_to, l.created_by, l.course_ids)
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
revoke all on function public.sms_ai_segments(int) from public, anon;
grant execute on function public.sms_ai_segments(int) to authenticated;

notify pgrst, 'reload schema';
