-- =====================================================================
-- 🔀 Move many students at once (Students tab → mark → Course · Batch ·
--   Section). The same as "Change" on one student (apply_placement) for
--   each, in one go: all of them move, or none (a problem stops it all).
--   The preview says first: who moves, seats, the new IDs, fee changes.
-- =====================================================================

create or replace function public.bulk_placement_preview(p_leads uuid[], p_course uuid, p_batch uuid, p_section uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_cfg      jsonb := public.admission_setting();
  v_moving   uuid[];
  v_same     int;
  v_skip     int;
  v_cap      int;
  v_taken    int;
  v_need     int;
  r          public.student_id_rules;
  v_free     bigint;
  v_problems jsonb := '[]'::jsonb;
  v_fee_new  numeric;
  v_courses  int;
  v_over     int := 0;
  v_seats_ok boolean := true;
begin
  if not public.can_approve_admission() then
    raise exception 'Only the Admission Officer (or an admin) can change the course, batch or section.';
  end if;
  if p_course is null or p_batch is null then raise exception 'Choose the course and the batch.'; end if;
  if not exists (select 1 from public.batches where id = p_batch and course_id = p_course and is_active) then
    raise exception 'That batch is not in this course.';
  end if;
  if p_section is null then
    raise exception 'Choose the section (a batch with no sections needs one: Settings → Courses).';
  end if;
  if not exists (select 1 from public.batch_sections where id = p_section and batch_id = p_batch and is_active) then
    raise exception 'That section is not in this batch.';
  end if;

  -- who moves, who is there already, who can't (not admitted / cancelled)
  select array_agg(l.id) filter (where l.admitted_at is not null and l.cancelled_at is null
                                   and (l.admitted_course_id is distinct from p_course
                                        or l.admitted_batch_id is distinct from p_batch
                                        or l.admitted_section_id is distinct from p_section)),
         count(*) filter (where l.admitted_at is not null and l.cancelled_at is null
                            and l.admitted_course_id is not distinct from p_course
                            and l.admitted_batch_id is not distinct from p_batch
                            and l.admitted_section_id is not distinct from p_section),
         count(*) filter (where l.admitted_at is null or l.cancelled_at is not null)
    into v_moving, v_same, v_skip
  from public.leads l
  where l.id = any(p_leads) and l.deleted_at is null;
  v_moving := coalesce(v_moving, '{}');

  -- 🪑 seats in the new batch (people already in it don't need a new seat)
  select seat_capacity into v_cap from public.batches where id = p_batch;
  v_taken := public.batch_seats_taken(p_batch);
  select count(*) into v_need from public.leads where id = any(v_moving) and admitted_batch_id is distinct from p_batch;
  if v_cap is not null and v_taken + v_need > v_cap and not coalesce((v_cfg->>'allow_overbooking')::boolean, false) then
    v_seats_ok := false;
    v_problems := v_problems || to_jsonb(format('Only %s free seats in the batch for %s students.', greatest(v_cap - v_taken, 0), v_need));
  end if;

  -- 🎓 enough free IDs in the new rule's range
  r := public.student_id_rule_for(p_course, p_batch, p_section);
  if r.id is not null and r.kind = 'range' then
    select count(*) into v_free
    from generate_series(r.range_start, r.range_end) n
    where not exists (
      select 1 from public.leads l
      where l.student_ref is not null and lower(l.student_ref) = n::text and not (l.id = any(v_moving)));
    if v_free < cardinality(v_moving) then
      v_problems := v_problems || to_jsonb(format('%s has only %s free IDs (%s – %s) for %s students.',
        public.student_id_rule_label(r), v_free, r.range_start, r.range_end, cardinality(v_moving)));
    end if;
  end if;

  -- 💰 a new course: its fee; people who paid more than it
  select count(*) into v_courses from public.leads where id = any(v_moving) and admitted_course_id is distinct from p_course;
  if v_courses > 0 then
    select sum(amount) into v_fee_new from public.course_fees where course_id = p_course;
    select count(*) into v_over from public.leads l
    where l.id = any(v_moving) and l.admitted_course_id is distinct from p_course
      and v_fee_new is not null and coalesce(l.fee_paid, 0) > v_fee_new;
  end if;

  return jsonb_build_object(
    'moving', cardinality(v_moving),
    'already_there', v_same,
    'skipped', v_skip,
    'seats', jsonb_build_object('capacity', v_cap, 'taken', v_taken, 'need', v_need, 'ok', v_seats_ok),
    'id_rule', case when r.id is null then null
                    else jsonb_build_object('kind', r.kind, 'start', r.range_start, 'end', r.range_end,
                                            'pattern', r.pattern, 'free', v_free) end,
    'course_change', v_courses,
    'course_fee', v_fee_new,
    'overpaid', v_over,
    'problems', v_problems,
    'place', public.placement_text(p_course, p_batch, p_section));
end;
$$;
grant execute on function public.bulk_placement_preview(uuid[], uuid, uuid, uuid) to authenticated;

create or replace function public.bulk_set_placement(p_leads uuid[], p_course uuid, p_batch uuid, p_section uuid)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_pre   jsonb := public.bulk_placement_preview(p_leads, p_course, p_batch, p_section);
  l       record;
  v_moved int := 0;
  v_place text := public.placement_text(p_course, p_batch, p_section);
begin
  if jsonb_array_length(v_pre->'problems') > 0 then
    raise exception '%', (select string_agg(x, ' ') from jsonb_array_elements_text(v_pre->'problems') x);
  end if;

  -- all or none: any error below undoes every move
  for l in
    select id, public.placement_text(admitted_course_id, admitted_batch_id, admitted_section_id) as was
    from public.leads
    where id = any(p_leads) and deleted_at is null and admitted_at is not null and cancelled_at is null
      and (admitted_course_id is distinct from p_course or admitted_batch_id is distinct from p_batch
           or admitted_section_id is distinct from p_section)
    order by admitted_at, id
  loop
    if public.apply_placement(l.id, p_course, p_batch, p_section) then
      v_moved := v_moved + 1;
      insert into public.lead_activity (lead_id, user_id, action, details)
      values (l.id, auth.uid(), 'bulk_placement',
              jsonb_build_object('from', l.was, 'to', v_place, 'count', (v_pre->>'moving')::int));
    end if;
  end loop;

  return jsonb_build_object('moved', v_moved, 'place', v_place);
end;
$$;
grant execute on function public.bulk_set_placement(uuid[], uuid, uuid, uuid) to authenticated;

notify pgrst, 'reload schema';
