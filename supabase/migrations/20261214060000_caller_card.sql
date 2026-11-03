-- =====================================================================
-- 📲 Caller card: the on-phone lead list gets a few more details, so the
--   card over the call screen can show them with no internet:
--   student ID, money due, next call, and whose lead it is.
--   (Older apps ignore the new fields.)
-- =====================================================================

drop function if exists public.my_lead_directory();

create or replace function public.my_lead_directory()
returns table (hash text, lead_id uuid, name text, rating text, stage text, course text, last_note text,
               student_ref text, fee_due numeric, next_call timestamptz, owner text)
language sql
stable
security invoker
set search_path = public, extensions
as $$
  with visible as (
    select
      l.id, l.name, l.rating, l.phone, l.alt_phone, l.whatsapp_number, l.whatsapp_username,
      l.student_ref, l.next_follow_up_at,
      case when s.kind = 'won' and coalesce(l.fee_due, 0) > 0 then l.fee_due end as fee_due,
      p.full_name as owner,
      case s.kind
        when 'won'       then '🎓 Admitted' || coalesce(' · ' || b.name, '')
        when 'lost'      then '✕ Lost' || coalesce(' · ' || lr.name, '')
        when 'cancelled' then 'Admission cancelled'
        else s.name
      end as stage,
      coalesce(
        ac.name,
        (select c.name from public.lead_courses lc join public.courses c on c.id = lc.course_id
          where lc.lead_id = l.id limit 1)
      ) as course,
      (select cl.notes from public.call_logs cl
        where cl.lead_id = l.id and cl.notes is not null
        order by cl.called_at desc limit 1) as last_note
    from public.leads l
    left join public.pipeline_stages s on s.id = l.stage_id
    left join public.courses ac on ac.id = l.admitted_course_id and s.kind = 'won'
    left join public.batches b on b.id = l.admitted_batch_id
    left join public.lost_reasons lr on lr.id = l.lost_reason_id
    left join public.profiles p on p.id = l.assigned_to
    where l.deleted_at is null
    order by l.updated_at desc nulls last
    limit 10000
  ),
  keys as (
    select v.*, k.key
    from visible v
    cross join lateral (values
      (v.phone),
      (v.alt_phone),
      (v.whatsapp_number),
      ('u:' || v.whatsapp_username)
    ) as k(key)
    where k.key is not null
  )
  select distinct on (encode(digest(k.key, 'sha256'), 'hex'))
         encode(digest(k.key, 'sha256'), 'hex'), k.id, k.name, k.rating, k.stage, k.course, left(k.last_note, 120),
         k.student_ref, k.fee_due, k.next_follow_up_at, k.owner
  from keys k;
$$;

grant execute on function public.my_lead_directory() to authenticated;

notify pgrst, 'reload schema';
