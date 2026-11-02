-- =====================================================================
-- ✏️ College ID (Student ID) typed by hand, for an admitted student
--   The Admission Officer (Settings → Admission approval) or an admin can
--   change it, before or after approving. Any text; never empty; one
--   student per ID (abc = ABC). Not for a cancelled admission. The old
--   ID stays in the student's history.
-- =====================================================================

create or replace function public.set_student_ref(p_lead uuid, p_value text)
returns text
language plpgsql
security definer
set search_path = public
as $$
declare
  l       public.leads := public.admitted_lead(p_lead);
  v_ref   text := nullif(trim(coalesce(p_value, '')), '');
  v_other text;
begin
  if not public.can_approve_admission() then
    raise exception 'Only the Admission Officer (or an admin) can change the College ID.';
  end if;
  if l.cancelled_at is not null then
    raise exception 'This admission is cancelled.';
  end if;
  if v_ref is null then
    raise exception 'Please type the College ID.';
  end if;
  if v_ref is not distinct from l.student_ref then
    return v_ref;
  end if;

  select name into v_other from public.leads
  where lower(student_ref) = lower(v_ref) and id <> l.id
  limit 1;
  if v_other is not null then
    raise exception 'This College ID is already given to %.', v_other;
  end if;

  perform set_config('app.pipeline_action', 'on', true);
  update public.leads set student_ref = v_ref where id = l.id;
  perform set_config('app.pipeline_action', 'off', true);

  insert into public.lead_activity (lead_id, user_id, action, details)
  values (l.id, auth.uid(), 'student_ref_changed', jsonb_build_object('from', l.student_ref, 'to', v_ref));

  return v_ref;
end;
$$;

grant execute on function public.set_student_ref(uuid, text) to authenticated;

notify pgrst, 'reload schema';
