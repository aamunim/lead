-- =====================================================================
-- 🎓 Admission approval (admitted students only, outside the pipeline)
--   After "Mark admitted", the college's Admission Officer checks
--   everything and approves (or sends it back with a reason). The
--   student's College ID is the Student ID (made as set in Settings →
--   Admission); the NU Admission ID is typed at approval or later.
--   Cancelling the admission hides all of it: the values are kept in the
--   timeline, and a new admission starts again at "waiting".
--   1. Setting 'admission_approval': on/off, who may approve (admins always)
--   2. leads: approval_status / by / at / note, nu_admission_id (unique)
--   3. On admit → waiting (and the officers are told); on cancel → cleared
--   4. approve / send back / send again / set NU ID (only through these)
-- =====================================================================

-- ---------------------------------------------------------------------
-- 1. Setting
-- ---------------------------------------------------------------------
insert into public.app_settings (key, value)
values ('admission_approval', jsonb_build_object(
  'enabled', true,
  'who', jsonb_build_object('mode', 'roles', 'roles', '[]'::jsonb, 'user_ids', '[]'::jsonb)
))
on conflict (key) do nothing;

create or replace function public.admission_approval_setting()
returns jsonb
language sql
stable
security definer
set search_path = public
as $$
  select jsonb_build_object(
           'enabled', true,
           'who', jsonb_build_object('mode', 'roles', 'roles', '[]'::jsonb, 'user_ids', '[]'::jsonb)
         ) || coalesce((select value from public.app_settings where key = 'admission_approval'), '{}'::jsonb);
$$;

grant execute on function public.admission_approval_setting() to authenticated;

-- May approve admissions: admins, or the setting's roles / people
create or replace function public.can_approve_admission(p_user uuid default auth.uid())
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  with s as (select public.admission_approval_setting() as v),
       p as (select pr.role_key, ro.permissions from public.profiles pr
             join public.roles ro on ro.key = pr.role_key
             where pr.id = p_user and pr.is_active)
  select exists (select 1 from p) and (
    (select '*' = any (permissions) or 'settings.manage' = any (permissions) from p)
    or (
      coalesce(((select v from s) ->> 'enabled')::boolean, true)
      and case coalesce((select v -> 'who' ->> 'mode' from s), 'roles')
            when 'all' then true
            when 'roles' then (select role_key from p) in (select jsonb_array_elements_text(coalesce((select v -> 'who' -> 'roles' from s), '[]')))
            when 'users' then p_user::text in (select jsonb_array_elements_text(coalesce((select v -> 'who' -> 'user_ids' from s), '[]')))
            else false
          end
    )
  );
$$;

grant execute on function public.can_approve_admission(uuid) to authenticated;

-- ---------------------------------------------------------------------
-- 2. The student's approval details
-- ---------------------------------------------------------------------
alter table public.leads
  add column if not exists approval_status text check (approval_status in ('waiting', 'approved', 'returned')),
  add column if not exists approval_by     uuid references public.profiles(id) on delete set null,
  add column if not exists approval_at     timestamptz,
  add column if not exists approval_note   text,
  add column if not exists nu_admission_id text;

create unique index if not exists leads_nu_admission_id_unique
  on public.leads (lower(nu_admission_id)) where nu_admission_id is not null;
create index if not exists leads_approval_status_idx
  on public.leads (approval_status) where approval_status is not null;

-- ---------------------------------------------------------------------
-- 3. Admitted → waiting; admission cancelled → cleared (kept in the timeline);
--    and the fields can only be changed through the functions below
-- ---------------------------------------------------------------------
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
    if old.approval_status is not null or old.nu_admission_id is not null then
      insert into public.lead_activity (lead_id, user_id, action, details)
      values (new.id, auth.uid(), 'admission_approval_cleared', jsonb_build_object(
        'status', old.approval_status, 'nu_admission_id', old.nu_admission_id, 'student_ref', old.student_ref));
    end if;
    new.approval_status := null;
    new.approval_by := null;
    new.approval_at := null;
    new.approval_note := null;
    new.nu_admission_id := null;
    return new;
  end if;

  if not v_by_rpc and (
       new.approval_status is distinct from old.approval_status
    or new.approval_by     is distinct from old.approval_by
    or new.approval_at     is distinct from old.approval_at
    or new.approval_note   is distinct from old.approval_note
    or new.nu_admission_id is distinct from old.nu_admission_id) then
    raise exception 'Use Approve, Send back or the NU Admission ID field for this.';
  end if;
  return new;
end;
$$;

drop trigger if exists leads_admission_approval on public.leads;
create trigger leads_admission_approval
  before update on public.leads
  for each row execute function public.leads_admission_approval();

-- Admitted students already there: waiting
do $$
begin
  perform set_config('app.admission_approval', 'on', true);
  alter table public.leads disable trigger user;
  update public.leads
     set approval_status = 'waiting'
   where admitted_at is not null and deleted_at is null and approval_status is null;
  alter table public.leads enable trigger user;
end;
$$;

-- ---------------------------------------------------------------------
-- 4. What the app calls
-- ---------------------------------------------------------------------
-- The lead, if it is an admitted student this person may see
create or replace function public.admitted_lead(p_lead uuid)
returns public.leads
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  l public.leads;
begin
  select * into l from public.leads where id = p_lead and deleted_at is null;
  if l.id is null or not public.fee_can_see_lead(l.id) then raise exception 'Student not found.'; end if;
  if l.admitted_at is null then raise exception 'Only admitted students have an admission approval.'; end if;
  return l;
end;
$$;

revoke execute on function public.admitted_lead(uuid) from public, anon, authenticated;

-- NU Admission ID: the same check for everyone (one student per ID)
create or replace function public.check_nu_admission_id(p_lead uuid, p_value text)
returns text
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v text := nullif(trim(coalesce(p_value, '')), '');
  other text;
begin
  if v is null then return null; end if;
  select name into other from public.leads
   where lower(nu_admission_id) = lower(v) and id <> p_lead and deleted_at is null
   limit 1;
  if other is not null then raise exception 'This NU Admission ID is already given to %.', other; end if;
  return v;
end;
$$;

revoke execute on function public.check_nu_admission_id(uuid, text) from public, anon, authenticated;

-- ✅ Approve (the NU Admission ID can be typed now or later)
create or replace function public.approve_admission(p_lead uuid, p_nu_admission_id text default null, p_note text default null)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  l    public.leads := public.admitted_lead(p_lead);
  v_nu text := public.check_nu_admission_id(p_lead, p_nu_admission_id);
  v_note text := nullif(trim(coalesce(p_note, '')), '');
begin
  if not public.can_approve_admission() then raise exception 'Only the Admission Officer (or an admin) can approve.'; end if;

  perform set_config('app.admission_approval', 'on', true);
  update public.leads
     set approval_status = 'approved', approval_by = auth.uid(), approval_at = now(), approval_note = v_note,
         nu_admission_id = coalesce(v_nu, nu_admission_id)
   where id = l.id;
  perform set_config('app.admission_approval', 'off', true);

  insert into public.lead_activity (lead_id, user_id, action, details)
  values (l.id, auth.uid(), 'admission_approved', jsonb_build_object(
    'note', v_note, 'nu_admission_id', coalesce(v_nu, l.nu_admission_id), 'student_ref', l.student_ref));

  if l.admitted_by is distinct from auth.uid() then
    perform public.notify(l.admitted_by, 'admission_approved', '✅ Admission approved: ' || l.name,
      'Approved by ' || public.person_name(auth.uid()) || '.', jsonb_build_object('lead_id', l.id), null);
  end if;
end;
$$;

-- ↩ Send back with a reason
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
     set approval_status = 'returned', approval_by = auth.uid(), approval_at = now(), approval_note = v_reason
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

-- Fixed: send it to the officer again
create or replace function public.resubmit_admission(p_lead uuid, p_note text default null)
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
  if l.approval_status is distinct from 'returned' then raise exception 'It is not sent back.'; end if;
  if not public.can_edit_lead(l.assigned_to) and not public.can_approve_admission() then
    raise exception 'You can''t change this student.';
  end if;

  perform set_config('app.admission_approval', 'on', true);
  update public.leads
     set approval_status = 'waiting', approval_note = v_note
   where id = l.id;
  perform set_config('app.admission_approval', 'off', true);

  insert into public.lead_activity (lead_id, user_id, action, details)
  values (l.id, auth.uid(), 'admission_resubmitted', jsonb_build_object('note', v_note));

  for r in
    select p.id from public.profiles p
    where p.is_active and p.id <> auth.uid() and public.can_approve_admission(p.id)
  loop
    perform public.notify(r.id, 'admission_waiting', '🎓 Check again: ' || l.name,
      coalesce(v_note, 'Fixed and sent again.'), jsonb_build_object('lead_id', l.id), null);
  end loop;
end;
$$;

-- 🆔 NU Admission ID typed (or changed / removed) later
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

  perform set_config('app.admission_approval', 'on', true);
  update public.leads set nu_admission_id = v_nu where id = l.id;
  perform set_config('app.admission_approval', 'off', true);

  insert into public.lead_activity (lead_id, user_id, action, details)
  values (l.id, auth.uid(), 'nu_id_set', jsonb_build_object('from', l.nu_admission_id, 'to', v_nu));
end;
$$;

grant execute on function public.approve_admission(uuid, text, text) to authenticated;
grant execute on function public.return_admission(uuid, text) to authenticated;
grant execute on function public.resubmit_admission(uuid, text) to authenticated;
grant execute on function public.set_nu_admission_id(uuid, text) to authenticated;

notify pgrst, 'reload schema';
