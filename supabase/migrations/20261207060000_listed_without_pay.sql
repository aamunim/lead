-- =====================================================================
-- 📋 Listed Without Pay: before any money, the Admission Officer gives
--   the section (course / batch too) and the NU Admission ID (a must).
--   Admitted → 📋 Listed → ✅ Admission approved (৳ needed) → 📝 Registered
--   Listing is not a must: with the money paid, approving works directly.
--   Admission cancelled → cleared (kept in the timeline).
-- =====================================================================

alter table public.leads
  add column if not exists listed_at timestamptz,
  add column if not exists listed_by uuid references public.profiles(id) on delete set null;

-- The guard: listing too, cleared with the rest
create or replace function public.leads_admission_approval()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_by_rpc boolean := coalesce(current_setting('app.admission_approval', true), '') = 'on';
  r        record;
begin
  if new.admitted_at is not null and old.admitted_at is null then
    new.approval_status := 'waiting';
    new.approval_by := null;
    new.approval_at := null;
    new.approval_note := null;
    new.nu_admission_id := null;
    new.admitted_section_id := null;
    new.registration_status := null;
    new.registration_by := null;
    new.registration_at := null;
    new.registration_note := null;
    new.listed_at := null;
    new.listed_by := null;
    for r in
      select p.id from public.profiles p
      where p.is_active and p.id is distinct from new.admitted_by and public.can_approve_admission(p.id)
    loop
      perform public.notify(
        r.id, 'admission_waiting', '🎓 Admission to check: ' || new.name,
        'Admitted, waiting for approval.',
        jsonb_build_object('lead_id', new.id), 'approval:' || new.id || ':' || extract(epoch from new.admitted_at)::bigint);
    end loop;
    return new;
  end if;

  if (new.admitted_at is null and old.admitted_at is not null)
     or (new.cancelled_at is not null and old.cancelled_at is null) then
    if old.approval_status is not null or old.nu_admission_id is not null or old.registration_status is not null
       or old.admitted_section_id is not null or old.listed_at is not null then
      insert into public.lead_activity (lead_id, user_id, action, details)
      values (new.id, auth.uid(), 'admission_approval_cleared', jsonb_build_object(
        'status', old.approval_status, 'nu_admission_id', old.nu_admission_id, 'student_ref', old.student_ref,
        'registration', old.registration_status, 'listed', old.listed_at is not null,
        'section', (select name from public.batch_sections where id = old.admitted_section_id)));
    end if;
    new.approval_status := null;
    new.approval_by := null;
    new.approval_at := null;
    new.approval_note := null;
    new.nu_admission_id := null;
    new.admitted_section_id := null;
    new.registration_status := null;
    new.registration_by := null;
    new.registration_at := null;
    new.registration_note := null;
    new.listed_at := null;
    new.listed_by := null;
    return new;
  end if;

  if not v_by_rpc and (
       new.approval_status     is distinct from old.approval_status
    or new.approval_by         is distinct from old.approval_by
    or new.approval_at         is distinct from old.approval_at
    or new.approval_note       is distinct from old.approval_note
    or new.nu_admission_id     is distinct from old.nu_admission_id
    or new.admitted_section_id is distinct from old.admitted_section_id
    or new.registration_status is distinct from old.registration_status
    or new.registration_by     is distinct from old.registration_by
    or new.registration_at     is distinct from old.registration_at
    or new.registration_note   is distinct from old.registration_note
    or new.listed_at           is distinct from old.listed_at
    or new.listed_by           is distinct from old.listed_by) then
    raise exception 'Use Approve, List, Send back or Change for this.';
  end if;
  return new;
end;
$$;

-- 📋 List without pay: section (course / batch) + NU Admission ID, both a must
create or replace function public.list_admission(
  p_lead uuid,
  p_course uuid,
  p_batch uuid,
  p_section uuid,
  p_nu_admission_id text,
  p_note text default null
)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  l      public.leads := public.admitted_lead(p_lead);
  v_nu   text := public.check_nu_admission_id(p_lead, p_nu_admission_id);
  v_note text := nullif(trim(coalesce(p_note, '')), '');
begin
  if not public.can_approve_admission() then raise exception 'Only the Admission Officer (or an admin) can list a student.'; end if;
  if l.cancelled_at is not null then raise exception 'This admission is cancelled.'; end if;
  if l.approval_status = 'approved' then raise exception 'The admission is already approved.'; end if;
  if v_nu is null then raise exception 'Please type the NU Admission ID.'; end if;

  perform public.apply_placement(l.id, p_course, p_batch, p_section);

  perform set_config('app.admission_approval', 'on', true);
  update public.leads
     set nu_admission_id = v_nu, listed_at = now(), listed_by = auth.uid()
   where id = l.id;
  perform set_config('app.admission_approval', 'off', true);

  insert into public.lead_activity (lead_id, user_id, action, details)
  values (l.id, auth.uid(), 'admission_listed', jsonb_build_object(
    'nu_admission_id', v_nu, 'note', v_note,
    'section', (select name from public.batch_sections where id = p_section)));

  if l.admitted_by is not null and l.admitted_by is distinct from auth.uid() then
    perform public.notify(l.admitted_by, 'admission_approved', '📋 Listed: ' || l.name,
      'Section and NU Admission ID given (without pay).', jsonb_build_object('lead_id', l.id), null);
  end if;
end;
$$;

grant execute on function public.list_admission(uuid, uuid, uuid, uuid, text, text) to authenticated;

create index if not exists leads_listed_idx on public.leads (listed_at) where listed_at is not null;

notify pgrst, 'reload schema';
