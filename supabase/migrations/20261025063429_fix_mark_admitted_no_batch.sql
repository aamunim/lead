-- =====================================================================
-- Fix: admitting without a batch failed with
--   record "v_batch" is not assigned yet
-- The seats-left answer now uses a plain number set inside the batch
-- block, so v_batch is only read when a batch was chosen.
-- =====================================================================
create or replace function public.mark_admitted(
  p_lead_id     uuid,
  p_course_id   uuid,
  p_batch_id    uuid default null,
  p_admitted_at timestamptz default null,
  p_student_ref text default null,
  p_note        text default null
)
returns jsonb
language plpgsql
set search_path to 'public'
as $function$
declare
  v_cfg        jsonb := public.admission_setting();
  v_kind       text;
  v_ref        text;
  v_old_ref    text;
  v_batch      record;
  v_taken      int;
  v_capacity   int;           -- seats of the chosen batch (null = no batch / no limit)
  v_seats_left int;
  v_mode       text := coalesce(v_cfg->'student_id'->>'mode', 'auto');
  v_note       text := nullif(trim(coalesce(p_note, '')), '');
  v_rows       int;
begin
  if not public.can_mark_admitted() then
    raise exception 'You are not allowed to mark admissions.';
  end if;

  select s.kind, l.student_ref into v_kind, v_old_ref
  from public.leads l
  join public.pipeline_stages s on s.id = l.stage_id
  where l.id = p_lead_id and l.deleted_at is null;

  if v_kind is null then raise exception 'Lead not found.'; end if;
  if v_kind = 'won' then raise exception 'This lead is already admitted.'; end if;
  if v_kind = 'cancelled' then raise exception 'This admission was cancelled. Reopen the lead first.'; end if;

  -- Course
  if p_course_id is null then raise exception 'Please choose a course.'; end if;
  if not exists (select 1 from public.courses where id = p_course_id and is_active) then
    raise exception 'That course is not available.';
  end if;

  -- Batch
  if p_batch_id is null and coalesce((v_cfg->>'batch_required')::boolean, false) then
    raise exception 'Please choose a batch.';
  end if;

  if p_batch_id is not null then
    -- one admission at a time per batch, so two people can't take the last seat
    perform pg_advisory_xact_lock(hashtext('batch:' || p_batch_id::text));

    select id, course_id, name, seat_capacity, is_active into v_batch
    from public.batches where id = p_batch_id;

    if not found or not v_batch.is_active then raise exception 'That batch is not available.'; end if;
    if v_batch.course_id <> p_course_id then raise exception 'That batch belongs to another course.'; end if;

    v_capacity := v_batch.seat_capacity;
    v_taken := public.batch_seats_taken(p_batch_id);
    if v_capacity is not null
       and v_taken >= v_capacity
       and not coalesce((v_cfg->>'allow_overbooking')::boolean, false) then
      raise exception '% is full (% of % seats).', v_batch.name, v_taken, v_capacity;
    end if;
  end if;

  -- Student ID
  v_ref := nullif(trim(coalesce(p_student_ref, '')), '');
  if v_mode = 'off' then
    v_ref := v_old_ref;
  elsif v_mode = 'manual' then
    v_ref := coalesce(v_ref, v_old_ref);
    if v_ref is null then raise exception 'Please type the student ID.'; end if;
  else -- auto
    v_ref := coalesce(v_ref, v_old_ref, public.next_student_ref());
  end if;

  if v_ref is not null and exists (
    select 1 from public.leads where lower(student_ref) = lower(v_ref) and id <> p_lead_id
  ) then
    raise exception 'Student ID % is already used.', v_ref;
  end if;

  -- Close it
  perform set_config('app.pipeline_action', 'on', true);
  perform set_config('app.stage_note', coalesce(v_note, ''), true);

  update public.leads
     set stage_id           = public.stage_of_kind('won'),
         admitted_at        = coalesce(p_admitted_at, now()),
         admitted_by        = auth.uid(),
         admitted_course_id = p_course_id,
         admitted_batch_id  = p_batch_id,
         student_ref        = v_ref,
         admission_note     = v_note,
         closed_at          = now(),
         lost_reason_id     = null,
         lost_at            = null,
         lost_by            = null,
         lost_note          = null,
         cancelled_at       = null,
         cancelled_by       = null,
         cancel_reason      = null,
         call_attempts      = 0,
         unreachable_at     = null
   where id = p_lead_id;

  get diagnostics v_rows = row_count;
  if v_rows = 0 then raise exception 'You can''t change this lead.'; end if;

  perform public.finish_pending_follow_up(p_lead_id);

  -- Keep the course on the lead's interests too (ignore if not allowed)
  begin
    insert into public.lead_courses (lead_id, course_id) values (p_lead_id, p_course_id)
    on conflict do nothing;
  exception when others then
    null;
  end;

  -- Seats left (only when a batch with a seat limit was chosen)
  if p_batch_id is not null and v_capacity is not null then
    v_seats_left := greatest(v_capacity - public.batch_seats_taken(p_batch_id), 0);
  end if;

  return jsonb_build_object('student_ref', v_ref, 'seats_left', v_seats_left);
end;
$function$;