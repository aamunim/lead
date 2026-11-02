-- =====================================================================
-- 🎓 Two approvals: Admission → Registration, and sections
--   1. Setting: money needed (total paid, refunds taken off):
--        admission approval ৳1,000 · registration approval ৳6,000
--   2. Sections: each batch has its own (A, B, …): Settings → Courses → batch
--   3. leads: admitted_section_id; registration_status / by / at / note
--   4. Approving the admission: the Admission Officer must choose the
--      section (and may change the course / batch there or later)
--   5. Admission approved → registration waiting → approved / sent back
--   6. Sent back (either one) → the person who admitted is told (push + 🔔)
--   Cancelling the admission clears all of it (kept in the timeline).
-- =====================================================================

-- ---------------------------------------------------------------------
-- 1. Setting: the money needed
-- ---------------------------------------------------------------------
create or replace function public.admission_approval_setting()
returns jsonb
language sql
stable
security definer
set search_path = public
as $$
  select jsonb_build_object(
           'enabled', true,
           'who', jsonb_build_object('mode', 'roles', 'roles', '[]'::jsonb, 'user_ids', '[]'::jsonb),
           'admission_min_paid', 1000,
           'registration_min_paid', 6000
         ) || coalesce((select value from public.app_settings where key = 'admission_approval'), '{}'::jsonb);
$$;

update public.app_settings
   set value = jsonb_build_object('admission_min_paid', 1000, 'registration_min_paid', 6000) || value
 where key = 'admission_approval';

-- Paid so far (refunds taken off)
create or replace function public.lead_paid(p_lead uuid)
returns numeric
language sql
stable
security definer
set search_path = public
as $$
  select coalesce(sum(case when kind = 'refund' then -amount else amount end), 0)
  from public.fee_payments where lead_id = p_lead and voided_at is null;
$$;

revoke execute on function public.lead_paid(uuid) from public, anon;
grant execute on function public.lead_paid(uuid) to authenticated;

-- ---------------------------------------------------------------------
-- 2. Sections of a batch
-- ---------------------------------------------------------------------
create table if not exists public.batch_sections (
  id         uuid primary key default gen_random_uuid(),
  batch_id   uuid not null references public.batches(id) on delete cascade,
  name       text not null check (length(trim(name)) between 1 and 40),
  sort_order integer not null default 0,
  is_active  boolean not null default true,
  created_at timestamptz not null default now()
);

create unique index if not exists batch_sections_name_key on public.batch_sections (batch_id, lower(name));
create index if not exists batch_sections_batch_idx on public.batch_sections (batch_id, sort_order);

alter table public.batch_sections enable row level security;
drop policy if exists "batch_sections_read" on public.batch_sections;
create policy "batch_sections_read" on public.batch_sections for select to authenticated using (public.is_active_user());
drop policy if exists "batch_sections_insert" on public.batch_sections;
create policy "batch_sections_insert" on public.batch_sections for insert to authenticated
  with check (public.has_permission('settings.manage'));
drop policy if exists "batch_sections_update" on public.batch_sections;
create policy "batch_sections_update" on public.batch_sections for update to authenticated
  using (public.has_permission('settings.manage')) with check (public.has_permission('settings.manage'));
drop policy if exists "batch_sections_delete" on public.batch_sections;
create policy "batch_sections_delete" on public.batch_sections for delete to authenticated
  using (public.has_permission('settings.manage'));
grant select, insert, update, delete on public.batch_sections to authenticated;

-- ---------------------------------------------------------------------
-- 3. The student's section and registration
-- ---------------------------------------------------------------------
alter table public.leads
  add column if not exists admitted_section_id uuid references public.batch_sections(id) on delete set null,
  add column if not exists registration_status text check (registration_status in ('waiting', 'approved', 'returned')),
  add column if not exists registration_by     uuid references public.profiles(id) on delete set null,
  add column if not exists registration_at     timestamptz,
  add column if not exists registration_note   text;

create index if not exists leads_registration_status_idx
  on public.leads (registration_status) where registration_status is not null;
create index if not exists leads_admitted_section_idx
  on public.leads (admitted_section_id) where admitted_section_id is not null;

-- Admitted → fresh; cancelled → cleared; only through the functions below
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
  -- Admitted (again): wait for the officer, nothing carried over
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

  -- Admission cancelled (or undone): hide everything (the timeline keeps what it was)
  if (new.admitted_at is null and old.admitted_at is not null)
     or (new.cancelled_at is not null and old.cancelled_at is null) then
    if old.approval_status is not null or old.nu_admission_id is not null or old.registration_status is not null
       or old.admitted_section_id is not null then
      insert into public.lead_activity (lead_id, user_id, action, details)
      values (new.id, auth.uid(), 'admission_approval_cleared', jsonb_build_object(
        'status', old.approval_status, 'nu_admission_id', old.nu_admission_id, 'student_ref', old.student_ref,
        'registration', old.registration_status,
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
    or new.registration_note   is distinct from old.registration_note) then
    raise exception 'Use Approve, Send back or Change for this.';
  end if;
  return new;
end;
$$;

-- Already approved: registration waits now
do $$
begin
  alter table public.leads disable trigger user;
  update public.leads
     set registration_status = 'waiting'
   where approval_status = 'approved' and registration_status is null and deleted_at is null;
  alter table public.leads enable trigger user;
end;
$$;

-- ---------------------------------------------------------------------
-- 4. Course / batch / section (at approval or later)
-- ---------------------------------------------------------------------
create or replace function public.placement_text(p_course uuid, p_batch uuid, p_section uuid)
returns text
language sql
stable
security definer
set search_path = public
as $$
  select concat_ws(' · ',
    (select name from public.courses where id = p_course),
    (select name from public.batches where id = p_batch),
    (select 'Section ' || name from public.batch_sections where id = p_section));
$$;

-- Checks and saves; the fee follows a new course (its fee talk, or the full fee)
create or replace function public.apply_placement(p_lead uuid, p_course uuid, p_batch uuid, p_section uuid)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  l       public.leads;
  v_cfg   jsonb := public.admission_setting();
  b       record;
  v_taken int;
  v_neg   uuid;
  v_list  numeric;
  v_disc  numeric;
begin
  select * into l from public.leads where id = p_lead;
  if p_course is null then raise exception 'Please choose a course.'; end if;
  if p_batch is null then raise exception 'Please choose a batch.'; end if;
  if p_section is null then raise exception 'Please choose a section.'; end if;

  if not exists (select 1 from public.courses where id = p_course and is_active) then
    raise exception 'That course is not available.';
  end if;

  select id, course_id, name, seat_capacity, is_active into b from public.batches where id = p_batch;
  if b.id is null or not b.is_active then raise exception 'That batch is not available.'; end if;
  if b.course_id <> p_course then raise exception 'That batch belongs to another course.'; end if;

  if not exists (select 1 from public.batch_sections where id = p_section and batch_id = p_batch and is_active) then
    raise exception 'That section is not in this batch.';
  end if;

  if p_course is not distinct from l.admitted_course_id and p_batch is not distinct from l.admitted_batch_id
     and p_section is not distinct from l.admitted_section_id then
    return false;
  end if;

  -- A new batch: a free seat (like admitting)
  if p_batch is distinct from l.admitted_batch_id then
    perform pg_advisory_xact_lock(hashtext('batch:' || p_batch::text));
    v_taken := public.batch_seats_taken(p_batch);
    if b.seat_capacity is not null and v_taken >= b.seat_capacity
       and not coalesce((v_cfg->>'allow_overbooking')::boolean, false) then
      raise exception '% is full (% of % seats).', b.name, v_taken, b.seat_capacity;
    end if;
  end if;

  -- A new course: its fee (the fee talk for it, or the full fee) becomes the final fee
  if p_course is distinct from l.admitted_course_id then
    update public.lead_negotiations set status = 'open', final_total = null, locked_at = null
     where lead_id = l.id and status = 'locked';
    select id into v_neg from public.lead_negotiations where lead_id = l.id and course_id = p_course;
    if v_neg is not null then
      select t.list_total, t.discount into v_list, v_disc from public.negotiation_totals(v_neg) t;
      update public.lead_negotiations
         set status = 'locked', final_total = greatest(v_list - v_disc, 0), locked_at = now()
       where id = v_neg;
    elsif exists (select 1 from public.course_fees where course_id = p_course) then
      insert into public.lead_negotiations (lead_id, course_id, status, final_total, locked_at, started_by)
      values (l.id, p_course, 'locked', (select sum(amount) from public.course_fees where course_id = p_course),
              now(), auth.uid());
    end if;
  end if;

  perform set_config('app.pipeline_action', 'on', true);
  perform set_config('app.admission_approval', 'on', true);
  update public.leads
     set admitted_course_id = p_course, admitted_batch_id = p_batch, admitted_section_id = p_section
   where id = l.id;
  perform set_config('app.admission_approval', 'off', true);
  perform set_config('app.pipeline_action', 'off', true);

  -- The fee numbers again, now that the lead points at the new course
  perform public.refresh_lead_fee(l.id);
  perform public.refresh_lead_payments(l.id);

  insert into public.lead_activity (lead_id, user_id, action, details)
  values (l.id, auth.uid(), 'placement_changed', jsonb_build_object(
    'from', public.placement_text(l.admitted_course_id, l.admitted_batch_id, l.admitted_section_id),
    'to', public.placement_text(p_course, p_batch, p_section),
    'course_changed', p_course is distinct from l.admitted_course_id));
  return true;
end;
$$;

revoke execute on function public.apply_placement(uuid, uuid, uuid, uuid) from public, anon, authenticated;

-- Change course / batch / section later (Admission Officer / admin)
create or replace function public.set_admission_placement(p_lead uuid, p_course uuid, p_batch uuid, p_section uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  l public.leads := public.admitted_lead(p_lead);
begin
  if not public.can_approve_admission() then
    raise exception 'Only the Admission Officer (or an admin) can change the course, batch or section.';
  end if;
  if l.cancelled_at is not null then raise exception 'This admission is cancelled.'; end if;
  perform public.apply_placement(l.id, p_course, p_batch, p_section);
end;
$$;

grant execute on function public.set_admission_placement(uuid, uuid, uuid, uuid) to authenticated;

-- ---------------------------------------------------------------------
-- 5. Admission approval: ৳ needed + section; then registration waits
-- ---------------------------------------------------------------------
drop function if exists public.approve_admission(uuid, text, text);

create or replace function public.approve_admission(
  p_lead uuid,
  p_nu_admission_id text default null,
  p_note text default null,
  p_course uuid default null,
  p_batch uuid default null,
  p_section uuid default null
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
  v_need numeric := coalesce((public.admission_approval_setting() ->> 'admission_min_paid')::numeric, 0);
  v_paid numeric := public.lead_paid(p_lead);
  r      record;
begin
  if not public.can_approve_admission() then raise exception 'Only the Admission Officer (or an admin) can approve.'; end if;
  if l.cancelled_at is not null then raise exception 'This admission is cancelled.'; end if;
  if v_paid < v_need then
    raise exception 'At least % must be paid before the admission approval (paid %).', public.fee_money(v_need), public.fee_money(v_paid);
  end if;

  perform public.apply_placement(l.id, coalesce(p_course, l.admitted_course_id), coalesce(p_batch, l.admitted_batch_id),
                                 coalesce(p_section, l.admitted_section_id));

  perform set_config('app.admission_approval', 'on', true);
  update public.leads
     set approval_status = 'approved', approval_by = auth.uid(), approval_at = now(), approval_note = v_note,
         nu_admission_id = coalesce(v_nu, nu_admission_id),
         registration_status = case when registration_status = 'approved' then 'approved' else 'waiting' end,
         registration_note = case when registration_status = 'approved' then registration_note else null end
   where id = l.id;
  perform set_config('app.admission_approval', 'off', true);

  insert into public.lead_activity (lead_id, user_id, action, details)
  values (l.id, auth.uid(), 'admission_approved', jsonb_build_object(
    'note', v_note, 'nu_admission_id', coalesce(v_nu, l.nu_admission_id), 'student_ref', l.student_ref,
    'section', (select name from public.batch_sections where id = (select admitted_section_id from public.leads where id = l.id))));

  if l.admitted_by is distinct from auth.uid() then
    perform public.notify(l.admitted_by, 'admission_approved', '✅ Admission approved: ' || l.name,
      'Approved by ' || public.person_name(auth.uid()) || '.', jsonb_build_object('lead_id', l.id), null);
  end if;

  -- The other officers: registration is next
  for r in
    select p.id from public.profiles p
    where p.is_active and p.id <> auth.uid() and public.can_approve_admission(p.id)
  loop
    perform public.notify(r.id, 'admission_waiting', '📝 Registration to check: ' || l.name,
      'Admission approved; registration is next.', jsonb_build_object('lead_id', l.id),
      'registration:' || l.id || ':' || extract(epoch from now())::bigint);
  end loop;
end;
$$;

grant execute on function public.approve_admission(uuid, text, text, uuid, uuid, uuid) to authenticated;

-- ↩ Admission sent back: registration waits for it again
create or replace function public.return_admission(p_lead uuid, p_reason text)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  l public.leads := public.admitted_lead(p_lead);
  v_reason text := nullif(trim(coalesce(p_reason, '')), '');
begin
  if not public.can_approve_admission() then raise exception 'Only the Admission Officer (or an admin) can send it back.'; end if;
  if v_reason is null then raise exception 'Please write what needs to be fixed.'; end if;

  perform set_config('app.admission_approval', 'on', true);
  update public.leads
     set approval_status = 'returned', approval_by = auth.uid(), approval_at = now(), approval_note = v_reason,
         registration_status = null, registration_by = null, registration_at = null, registration_note = null
   where id = l.id;
  perform set_config('app.admission_approval', 'off', true);

  insert into public.lead_activity (lead_id, user_id, action, details)
  values (l.id, auth.uid(), 'admission_returned', jsonb_build_object('reason', v_reason));

  if l.admitted_by is not null and l.admitted_by is distinct from auth.uid() then
    perform public.notify(l.admitted_by, 'admission_returned', '↩ Admission sent back: ' || l.name,
      v_reason, jsonb_build_object('lead_id', l.id), null, true);
  end if;
end;
$$;

-- ---------------------------------------------------------------------
-- 6. Registration approval
-- ---------------------------------------------------------------------
create or replace function public.approve_registration(p_lead uuid, p_note text default null)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  l      public.leads := public.admitted_lead(p_lead);
  v_note text := nullif(trim(coalesce(p_note, '')), '');
  v_need numeric := coalesce((public.admission_approval_setting() ->> 'registration_min_paid')::numeric, 0);
  v_paid numeric := public.lead_paid(p_lead);
begin
  if not public.can_approve_admission() then raise exception 'Only the Admission Officer (or an admin) can approve.'; end if;
  if l.cancelled_at is not null then raise exception 'This admission is cancelled.'; end if;
  if l.approval_status is distinct from 'approved' then raise exception 'Approve the admission first.'; end if;
  if l.registration_status = 'approved' then return; end if;
  if v_paid < v_need then
    raise exception 'At least % must be paid in total before the registration approval (paid %).',
      public.fee_money(v_need), public.fee_money(v_paid);
  end if;

  perform set_config('app.admission_approval', 'on', true);
  update public.leads
     set registration_status = 'approved', registration_by = auth.uid(), registration_at = now(), registration_note = v_note
   where id = l.id;
  perform set_config('app.admission_approval', 'off', true);

  insert into public.lead_activity (lead_id, user_id, action, details)
  values (l.id, auth.uid(), 'registration_approved', jsonb_build_object('note', v_note));

  if l.admitted_by is distinct from auth.uid() then
    perform public.notify(l.admitted_by, 'admission_approved', '✅ Registration approved: ' || l.name,
      'Approved by ' || public.person_name(auth.uid()) || '.', jsonb_build_object('lead_id', l.id), null);
  end if;
end;
$$;

create or replace function public.return_registration(p_lead uuid, p_reason text)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  l public.leads := public.admitted_lead(p_lead);
  v_reason text := nullif(trim(coalesce(p_reason, '')), '');
begin
  if not public.can_approve_admission() then raise exception 'Only the Admission Officer (or an admin) can send it back.'; end if;
  if v_reason is null then raise exception 'Please write what needs to be fixed.'; end if;
  if l.approval_status is distinct from 'approved' then raise exception 'Approve the admission first.'; end if;

  perform set_config('app.admission_approval', 'on', true);
  update public.leads
     set registration_status = 'returned', registration_by = auth.uid(), registration_at = now(), registration_note = v_reason
   where id = l.id;
  perform set_config('app.admission_approval', 'off', true);

  insert into public.lead_activity (lead_id, user_id, action, details)
  values (l.id, auth.uid(), 'registration_returned', jsonb_build_object('reason', v_reason));

  if l.admitted_by is not null and l.admitted_by is distinct from auth.uid() then
    perform public.notify(l.admitted_by, 'admission_returned', '↩ Registration sent back: ' || l.name,
      v_reason, jsonb_build_object('lead_id', l.id), null, true);
  end if;
end;
$$;

create or replace function public.resubmit_registration(p_lead uuid, p_note text default null)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  l public.leads := public.admitted_lead(p_lead);
  v_note text := nullif(trim(coalesce(p_note, '')), '');
  r record;
begin
  if l.registration_status is distinct from 'returned' then raise exception 'It is not sent back.'; end if;
  if not public.can_edit_lead(l.assigned_to) and not public.can_approve_admission() then
    raise exception 'You can''t change this student.';
  end if;

  perform set_config('app.admission_approval', 'on', true);
  update public.leads set registration_status = 'waiting', registration_note = v_note where id = l.id;
  perform set_config('app.admission_approval', 'off', true);

  insert into public.lead_activity (lead_id, user_id, action, details)
  values (l.id, auth.uid(), 'registration_resubmitted', jsonb_build_object('note', v_note));

  for r in
    select p.id from public.profiles p
    where p.is_active and p.id <> auth.uid() and public.can_approve_admission(p.id)
  loop
    perform public.notify(r.id, 'admission_waiting', '📝 Check registration again: ' || l.name,
      coalesce(v_note, 'Fixed and sent again.'), jsonb_build_object('lead_id', l.id), null);
  end loop;
end;
$$;

grant execute on function public.approve_registration(uuid, text) to authenticated;
grant execute on function public.return_registration(uuid, text) to authenticated;
grant execute on function public.resubmit_registration(uuid, text) to authenticated;

notify pgrst, 'reload schema';
