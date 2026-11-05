-- =====================================================================
-- 🏛 A simpler student flow. Listed, the admission approval and the
--   registration are gone. Instead:
--     ✅ Admitted → 📤 Submitted Online (NU Admission ID, no money)
--                 → 🏛 Received by ITTC (the course's admission fee paid)
--   • Admission Officer / admins do both steps (Settings → Admission flow).
--   • Received needs Submitted first.
--   • The admission fee is per course (Settings → Courses → the course);
--     a course without its own uses the default (৳1,000).
--   • Undo: Officer / admin, with a reason (kept in the timeline).
--   • The old approval / registration columns stay for history only.
-- =====================================================================

-- ---------------------------------------------------------------------
-- 1. Columns
-- ---------------------------------------------------------------------
alter table public.courses
  add column if not exists admission_fee numeric(12, 2) check (admission_fee is null or admission_fee >= 0);

alter table public.leads
  add column if not exists submitted_at timestamptz,
  add column if not exists submitted_by uuid references public.profiles(id) on delete set null,
  add column if not exists received_at  timestamptz,
  add column if not exists received_by  uuid references public.profiles(id) on delete set null,
  add column if not exists admission_fee_need numeric(12, 2);

alter table public.leads
  add column if not exists admission_fee_ok boolean
  generated always as (coalesce(fee_paid, 0) >= admission_fee_need) stored;

create index if not exists leads_submitted_idx on public.leads (submitted_at) where submitted_at is not null;
create index if not exists leads_received_idx on public.leads (received_at) where received_at is not null;

-- ---------------------------------------------------------------------
-- 2. The admission fee of a course (its own, or the default)
-- ---------------------------------------------------------------------
create or replace function public.course_admission_fee(p_course uuid)
returns numeric
language sql
stable
security definer
set search_path = public
as $$
  select coalesce(
    (select admission_fee from public.courses where id = p_course),
    (public.admission_approval_setting() ->> 'admission_min_paid')::numeric,
    1000);
$$;
grant execute on function public.course_admission_fee(uuid) to authenticated;

-- Kept on the lead, so lists can filter "fee paid / not yet"
create or replace function public.leads_admission_fee_need()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  new.admission_fee_need := case when new.admitted_course_id is null then null
                                 else public.course_admission_fee(new.admitted_course_id) end;
  return new;
end;
$$;
drop trigger if exists leads_admission_fee_need on public.leads;
create trigger leads_admission_fee_need
  before insert or update of admitted_course_id on public.leads
  for each row execute function public.leads_admission_fee_need();

-- A course's fee changed → its students
create or replace function public.courses_admission_fee_sync()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if new.admission_fee is distinct from old.admission_fee then
    update public.leads
       set admission_fee_need = public.course_admission_fee(new.id)
     where admitted_course_id = new.id
       and admission_fee_need is distinct from public.course_admission_fee(new.id);
  end if;
  return null;
end;
$$;
drop trigger if exists courses_admission_fee_sync on public.courses;
create trigger courses_admission_fee_sync
  after update of admission_fee on public.courses
  for each row execute function public.courses_admission_fee_sync();

-- The default changed → students of courses without their own
create or replace function public.app_settings_admission_fee_sync()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if new.key = 'admission_approval'
     and (new.value ->> 'admission_min_paid') is distinct from (old.value ->> 'admission_min_paid') then
    update public.leads l
       set admission_fee_need = public.course_admission_fee(l.admitted_course_id)
      from public.courses c
     where c.id = l.admitted_course_id and c.admission_fee is null
       and l.admission_fee_need is distinct from public.course_admission_fee(l.admitted_course_id);
  end if;
  return null;
end;
$$;
drop trigger if exists app_settings_admission_fee_sync on public.app_settings;
create trigger app_settings_admission_fee_sync
  after update on public.app_settings
  for each row execute function public.app_settings_admission_fee_sync();

-- Officer / admin: set a course's admission fee (null = the default)
create or replace function public.set_course_admission_fee(p_course uuid, p_amount numeric)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if not public.has_permission('settings.manage') and not public.can_approve_admission() then
    raise exception 'Only admins or the Admission Officer can change this.';
  end if;
  if p_amount is not null and p_amount < 0 then raise exception 'The fee can''t be below 0.'; end if;
  update public.courses set admission_fee = p_amount where id = p_course;
  if not found then raise exception 'Course not found.'; end if;
end;
$$;
grant execute on function public.set_course_admission_fee(uuid, numeric) to authenticated;

-- ---------------------------------------------------------------------
-- 3. The guard: admitted → fresh (no approval waiting any more);
--    cancelled → cleared; the fields only through the functions below
-- ---------------------------------------------------------------------
create or replace function public.leads_admission_approval()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_by_rpc boolean := coalesce(current_setting('app.admission_approval', true), '') = 'on';
  v_admit_section text := coalesce(current_setting('app.admit_section', true), '');
begin
  if new.admitted_at is not null and old.admitted_at is null then
    new.approval_status := null;
    new.approval_by := null;
    new.approval_at := null;
    new.approval_note := null;
    new.nu_admission_id := null;
    new.admitted_section_id := nullif(v_admit_section, '')::uuid;
    new.registration_status := null;
    new.registration_by := null;
    new.registration_at := null;
    new.registration_note := null;
    new.listed_at := null;
    new.listed_by := null;
    new.submitted_at := null;
    new.submitted_by := null;
    new.received_at := null;
    new.received_by := null;
    return new;
  end if;

  if (new.admitted_at is null and old.admitted_at is not null)
     or (new.cancelled_at is not null and old.cancelled_at is null) then
    if old.nu_admission_id is not null or old.submitted_at is not null or old.received_at is not null
       or old.admitted_section_id is not null then
      insert into public.lead_activity (lead_id, user_id, action, details)
      values (new.id, auth.uid(), 'admission_approval_cleared', jsonb_build_object(
        'nu_admission_id', old.nu_admission_id, 'student_ref', old.student_ref,
        'submitted', old.submitted_at is not null, 'received', old.received_at is not null,
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
    new.submitted_at := null;
    new.submitted_by := null;
    new.received_at := null;
    new.received_by := null;
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
    or new.listed_by           is distinct from old.listed_by
    or new.submitted_at        is distinct from old.submitted_at
    or new.submitted_by        is distinct from old.submitted_by
    or new.received_at         is distinct from old.received_at
    or new.received_by         is distinct from old.received_by) then
    raise exception 'Use Submitted Online, Received by ITTC or Change for this.';
  end if;
  return new;
end;
$$;

-- The old steps are closed
create or replace function public.ittc_old_step()
returns void
language plpgsql
as $$
begin
  raise exception 'Approval and registration are replaced by 📤 Submitted Online and 🏛 Received by ITTC. Please update the app.';
end;
$$;

create or replace function public.approve_admission(p_lead uuid, p_nu_admission_id text default null, p_note text default null,
  p_course uuid default null, p_batch uuid default null, p_section uuid default null)
returns void language plpgsql security definer set search_path = public as $$
begin perform public.ittc_old_step(); end; $$;
create or replace function public.return_admission(p_lead uuid, p_reason text)
returns void language plpgsql security definer set search_path = public as $$
begin perform public.ittc_old_step(); end; $$;
create or replace function public.resubmit_admission(p_lead uuid, p_note text default null)
returns void language plpgsql security definer set search_path = public as $$
begin perform public.ittc_old_step(); end; $$;
create or replace function public.approve_registration(p_lead uuid, p_note text default null)
returns void language plpgsql security definer set search_path = public as $$
begin perform public.ittc_old_step(); end; $$;
create or replace function public.return_registration(p_lead uuid, p_reason text)
returns void language plpgsql security definer set search_path = public as $$
begin perform public.ittc_old_step(); end; $$;
create or replace function public.resubmit_registration(p_lead uuid, p_note text default null)
returns void language plpgsql security definer set search_path = public as $$
begin perform public.ittc_old_step(); end; $$;
create or replace function public.list_admission(p_lead uuid, p_course uuid, p_batch uuid, p_section uuid,
  p_nu_admission_id text, p_note text default null)
returns void language plpgsql security definer set search_path = public as $$
begin perform public.ittc_old_step(); end; $$;

-- ---------------------------------------------------------------------
-- 4. Tell the people of a student (who admitted, who has the lead)
-- ---------------------------------------------------------------------
create or replace function public.ittc_tell(l public.leads, p_title text, p_body text, p_urgent boolean default false)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  u uuid;
begin
  for u in
    select distinct x from unnest(array[l.admitted_by, l.assigned_to]) x
    where x is not null and x is distinct from auth.uid()
  loop
    perform public.notify(u, 'admission_approved', p_title, p_body, jsonb_build_object('lead_id', l.id), null, p_urgent);
  end loop;
end;
$$;
revoke execute on function public.ittc_tell(public.leads, text, text, boolean) from public, anon, authenticated;

-- ---------------------------------------------------------------------
-- 5. 📤 Submitted Online: the NU Admission ID (a must), no money
-- ---------------------------------------------------------------------
create or replace function public.submit_online(p_lead uuid, p_nu_admission_id text, p_note text default null)
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
  if not public.can_approve_admission() then
    raise exception 'Only the Admission Officer (or an admin) can mark Submitted Online.';
  end if;
  if l.cancelled_at is not null then raise exception 'This admission is cancelled.'; end if;
  if v_nu is null then raise exception 'Please type the NU Admission ID.'; end if;
  if l.submitted_at is not null and v_nu is not distinct from l.nu_admission_id then return; end if;

  perform set_config('app.admission_approval', 'on', true);
  update public.leads
     set nu_admission_id = v_nu,
         submitted_at = coalesce(submitted_at, now()),
         submitted_by = coalesce(submitted_by, auth.uid())
   where id = l.id;
  perform set_config('app.admission_approval', 'off', true);

  if l.submitted_at is not null then
    insert into public.lead_activity (lead_id, user_id, action, details)
    values (l.id, auth.uid(), 'nu_id_set', jsonb_build_object('from', l.nu_admission_id, 'to', v_nu));
    return;
  end if;

  insert into public.lead_activity (lead_id, user_id, action, details)
  values (l.id, auth.uid(), 'submitted_online', jsonb_build_object('nu_admission_id', v_nu, 'note', v_note));

  perform public.ittc_tell(l, '📤 Submitted online: ' || l.name, 'NU Admission ID ' || v_nu || '.');
end;
$$;
grant execute on function public.submit_online(uuid, text, text) to authenticated;

-- The NU Admission ID by itself (a submitted student can't lose it)
create or replace function public.set_nu_admission_id(p_lead uuid, p_value text)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  l    public.leads := public.admitted_lead(p_lead);
  v_nu text := public.check_nu_admission_id(p_lead, p_value);
begin
  if not public.can_approve_admission() then raise exception 'Only the Admission Officer (or an admin) can set the NU Admission ID.'; end if;
  if v_nu is not distinct from l.nu_admission_id then return; end if;
  if v_nu is null and l.submitted_at is not null then
    raise exception 'A submitted student needs the NU Admission ID. Undo "Submitted Online" first.';
  end if;

  perform set_config('app.admission_approval', 'on', true);
  update public.leads set nu_admission_id = v_nu where id = l.id;
  perform set_config('app.admission_approval', 'off', true);

  insert into public.lead_activity (lead_id, user_id, action, details)
  values (l.id, auth.uid(), 'nu_id_set', jsonb_build_object('from', l.nu_admission_id, 'to', v_nu));
end;
$$;
grant execute on function public.set_nu_admission_id(uuid, text) to authenticated;

-- ---------------------------------------------------------------------
-- 6. 🏛 Received by ITTC: submitted first, and the admission fee paid
-- ---------------------------------------------------------------------
create or replace function public.mark_received(p_lead uuid, p_note text default null)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  l      public.leads := public.admitted_lead(p_lead);
  v_note text := nullif(trim(coalesce(p_note, '')), '');
  v_need numeric := public.course_admission_fee(l.admitted_course_id);
  v_paid numeric := public.lead_paid(p_lead);
begin
  if not public.can_approve_admission() then
    raise exception 'Only the Admission Officer (or an admin) can mark Received by ITTC.';
  end if;
  if l.cancelled_at is not null then raise exception 'This admission is cancelled.'; end if;
  if l.submitted_at is null then raise exception 'Mark "Submitted Online" first.'; end if;
  if l.received_at is not null then return; end if;
  if v_paid < v_need then
    raise exception 'The admission fee is % (paid %): % more is needed.',
      public.fee_money(v_need), public.fee_money(v_paid), public.fee_money(v_need - v_paid);
  end if;

  perform set_config('app.admission_approval', 'on', true);
  update public.leads set received_at = now(), received_by = auth.uid() where id = l.id;
  perform set_config('app.admission_approval', 'off', true);

  insert into public.lead_activity (lead_id, user_id, action, details)
  values (l.id, auth.uid(), 'received_by_ittc', jsonb_build_object('note', v_note, 'paid', v_paid, 'fee', v_need));

  perform public.ittc_tell(l, '🏛 Received by ITTC: ' || l.name, 'Admission fee ' || public.fee_money(v_need) || ' paid.');
end;
$$;
grant execute on function public.mark_received(uuid, text) to authenticated;

-- ---------------------------------------------------------------------
-- 7. ↩ Undo (Officer / admin, with a reason)
-- ---------------------------------------------------------------------
create or replace function public.undo_ittc_step(p_lead uuid, p_step text, p_reason text)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  l        public.leads := public.admitted_lead(p_lead);
  v_reason text := nullif(trim(coalesce(p_reason, '')), '');
begin
  if not public.can_approve_admission() then raise exception 'Only the Admission Officer (or an admin) can undo this.'; end if;
  if v_reason is null then raise exception 'Please write why.'; end if;
  if p_step not in ('submitted', 'received') then raise exception 'Unknown step.'; end if;

  if p_step = 'received' then
    if l.received_at is null then return; end if;
    perform set_config('app.admission_approval', 'on', true);
    update public.leads set received_at = null, received_by = null where id = l.id;
    perform set_config('app.admission_approval', 'off', true);
  else
    if l.submitted_at is null then return; end if;
    if l.received_at is not null then raise exception 'Undo "Received by ITTC" first.'; end if;
    perform set_config('app.admission_approval', 'on', true);
    update public.leads set submitted_at = null, submitted_by = null where id = l.id;
    perform set_config('app.admission_approval', 'off', true);
  end if;

  insert into public.lead_activity (lead_id, user_id, action, details)
  values (l.id, auth.uid(), 'ittc_undone', jsonb_build_object('step', p_step, 'reason', v_reason));

  perform public.ittc_tell(l,
    case p_step when 'received' then '↩ Received by ITTC undone: ' else '↩ Submitted Online undone: ' end || l.name,
    v_reason, true);
end;
$$;
grant execute on function public.undo_ittc_step(uuid, text, text) to authenticated;

-- ---------------------------------------------------------------------
-- 8. Many at once: 🏛 Received (the ready ones; the others are left out)
-- ---------------------------------------------------------------------
create or replace function public.bulk_mark_received(p_leads uuid[], p_dry boolean default true)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  r          record;
  v_ready    uuid[] := '{}';
  v_done     int := 0;
  v_already  int := 0;
  v_not_sub  int := 0;
  v_short    int := 0;
  v_skip     int := 0;
begin
  if not public.can_approve_admission() then
    raise exception 'Only the Admission Officer (or an admin) can mark Received by ITTC.';
  end if;
  for r in
    select l.id, l.admitted_at, l.cancelled_at, l.submitted_at, l.received_at,
           public.lead_paid(l.id) as paid, public.course_admission_fee(l.admitted_course_id) as need
    from public.leads l
    where l.id = any(p_leads) and l.deleted_at is null and public.fee_can_see_lead(l.id)
  loop
    if r.admitted_at is null or r.cancelled_at is not null then v_skip := v_skip + 1;
    elsif r.received_at is not null then v_already := v_already + 1;
    elsif r.submitted_at is null then v_not_sub := v_not_sub + 1;
    elsif r.paid < r.need then v_short := v_short + 1;
    else v_ready := v_ready || r.id;
    end if;
  end loop;

  if not p_dry then
    for r in select unnest(v_ready) as id loop
      perform public.mark_received(r.id, null);
      v_done := v_done + 1;
    end loop;
  end if;

  return jsonb_build_object('ready', cardinality(v_ready), 'done', v_done, 'already', v_already,
                            'not_submitted', v_not_sub, 'short', v_short, 'skipped', v_skip);
end;
$$;
grant execute on function public.bulk_mark_received(uuid[], boolean) to authenticated;

-- ---------------------------------------------------------------------
-- 9. 🔔 The admission fee is now paid by a submitted student: the officers
-- ---------------------------------------------------------------------
create or replace function public.leads_ittc_ready_notify()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  r record;
begin
  if new.admission_fee_ok and not coalesce(old.admission_fee_ok, false)
     and new.submitted_at is not null and new.received_at is null and new.cancelled_at is null then
    for r in
      select p.id from public.profiles p
      where p.is_active and p.id is distinct from auth.uid() and public.can_approve_admission(p.id)
    loop
      perform public.notify(r.id, 'admission_waiting', '🏛 Ready for ITTC: ' || new.name,
        'The admission fee is paid. Mark it Received by ITTC.', jsonb_build_object('lead_id', new.id),
        'ittc_ready:' || new.id);
    end loop;
  end if;
  return null;
end;
$$;
drop trigger if exists leads_ittc_ready_notify on public.leads;
create trigger leads_ittc_ready_notify
  after update of fee_paid, admission_fee_need on public.leads
  for each row execute function public.leads_ittc_ready_notify();

-- ---------------------------------------------------------------------
-- 10. 💵 The last payment's day on the lead (Students: sort "Last paid",
--     filter "paid this week / month")
-- ---------------------------------------------------------------------
alter table public.leads add column if not exists fee_last_paid_at timestamptz;

create or replace function public.refresh_lead_payments(p_lead_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v      record;
  v_last timestamptz;
begin
  select * into v from public.lead_fee_numbers(p_lead_id);
  select max(paid_at) into v_last from public.fee_payments
   where lead_id = p_lead_id and voided_at is null and coalesce(kind, 'payment') <> 'refund';
  update public.leads
     set fee_paid = nullif(v.paid, 0), fee_due = v.due, fee_next_due = v.next_due, fee_last_paid_at = v_last
   where id = p_lead_id
     and (fee_paid, fee_due, fee_next_due, fee_last_paid_at)
         is distinct from (nullif(v.paid, 0), v.due, v.next_due, v_last);
end;
$$;

-- Paid with ৳0 for "no payment yet" (filters: under ৳1,000 takes them in)
alter table public.leads
  add column if not exists fee_paid_total numeric(12, 2) generated always as (coalesce(fee_paid, 0)) stored;
create index if not exists leads_fee_paid_total_idx on public.leads (fee_paid_total) where admitted_at is not null;

create index if not exists leads_fee_last_paid_idx on public.leads (fee_last_paid_at) where fee_last_paid_at is not null;

-- ---------------------------------------------------------------------
-- 11. The students we have now
--   Registered, or approved with the admission fee paid → 🏛 Received
--   Listed, or approved with an NU Admission ID          → 📤 Submitted
--   The rest: just admitted
-- ---------------------------------------------------------------------
do $$
begin
  alter table public.leads disable trigger user;

  update public.leads
     set admission_fee_need = public.course_admission_fee(admitted_course_id)
   where admitted_course_id is not null;

  update public.leads l
     set fee_last_paid_at = p.last
    from (select lead_id, max(paid_at) as last from public.fee_payments
           where voided_at is null and coalesce(kind, 'payment') <> 'refund' group by lead_id) p
   where p.lead_id = l.id;

  update public.leads
     set submitted_at = coalesce(listed_at, approval_at, registration_at, admitted_at),
         submitted_by = coalesce(listed_by, approval_by, registration_by),
         received_at  = coalesce(registration_at, approval_at, now()),
         received_by  = coalesce(registration_by, approval_by)
   where admitted_at is not null and cancelled_at is null and deleted_at is null and received_at is null
     and (registration_status = 'approved'
          or (approval_status = 'approved' and coalesce(fee_paid, 0) >= coalesce(admission_fee_need, 1000)));

  update public.leads
     set submitted_at = coalesce(listed_at, approval_at, admitted_at),
         submitted_by = coalesce(listed_by, approval_by)
   where admitted_at is not null and cancelled_at is null and deleted_at is null and submitted_at is null
     and nu_admission_id is not null
     and (listed_at is not null or approval_status = 'approved');

  -- nothing waits for the old approvals now
  update public.leads set approval_status = null where approval_status = 'waiting';
  update public.leads set registration_status = null where registration_status = 'waiting';

  alter table public.leads enable trigger user;
end;
$$;

notify pgrst, 'reload schema';
