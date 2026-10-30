-- =====================================================================
-- 📎 Lead files in the institute's Google Drive
--   Papers (and, in the next part, voice notes) are uploaded through the
--   server (Edge Functions drive-*) to ONE Google account the admin
--   connects in Settings. Staff never sign in to Google; files are opened
--   through the server, so the app's rules decide who sees what.
--   1. Setting 'files': on/off, who sees everyone's files (admins always;
--      everyone else sees the files they uploaded)
--   2. google_drive_connection / drive_oauth_states / lead_drive_folders:
--      server only (no row security policies = no access from the app)
--   3. lead_files: one row per file, soft delete
--   4. drive_status(), drive_disconnect(), delete_lead_file()
-- =====================================================================

-- ---------------------------------------------------------------------
-- 1. Setting
-- ---------------------------------------------------------------------
insert into public.app_settings (key, value)
values ('files', jsonb_build_object(
  'enabled', true,
  -- who sees every file of the leads they can see (admins always)
  'view_all', jsonb_build_object('mode', 'roles', 'roles', '[]'::jsonb, 'user_ids', '[]'::jsonb)
))
on conflict (key) do nothing;

create or replace function public.files_setting()
returns jsonb
language sql
stable
security definer
set search_path = public
as $$
  select jsonb_build_object(
           'enabled', true,
           'view_all', jsonb_build_object('mode', 'roles', 'roles', '[]'::jsonb, 'user_ids', '[]'::jsonb)
         ) || coalesce((select value from public.app_settings where key = 'files'), '{}'::jsonb);
$$;

-- Sees everyone's files (on leads they can see): admins, or the setting's rule
create or replace function public.can_view_all_files(p_user uuid default auth.uid())
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  with s as (select public.files_setting() -> 'view_all' as r),
       p as (select pr.role_key, ro.permissions from public.profiles pr
             join public.roles ro on ro.key = pr.role_key
             where pr.id = p_user and pr.is_active)
  select exists (select 1 from p) and (
    (select '*' = any (permissions) or 'settings.manage' = any (permissions) from p)
    or case coalesce((select r ->> 'mode' from s), 'roles')
         when 'all' then true
         when 'roles' then (select role_key from p) in (select jsonb_array_elements_text(coalesce((select r -> 'roles' from s), '[]')))
         when 'users' then p_user::text in (select jsonb_array_elements_text(coalesce((select r -> 'user_ids' from s), '[]')))
         else false
       end
  );
$$;

grant execute on function public.can_view_all_files(uuid) to authenticated;

-- ---------------------------------------------------------------------
-- 2. The Google connection (server only)
-- ---------------------------------------------------------------------
create table if not exists public.google_drive_connection (
  id             integer primary key default 1 check (id = 1),
  email          text,
  refresh_token  text not null,
  root_folder_id text,
  connected_by   uuid references public.profiles(id) on delete set null,
  connected_at   timestamptz not null default now()
);
alter table public.google_drive_connection enable row level security;   -- no policies: the app can't read it

create table if not exists public.drive_oauth_states (
  state      text primary key,
  user_id    uuid not null references public.profiles(id) on delete cascade,
  created_at timestamptz not null default now()
);
alter table public.drive_oauth_states enable row level security;

create table if not exists public.lead_drive_folders (
  lead_id   uuid not null references public.leads(id) on delete cascade,
  kind      text not null,              -- 'lead' | 'paper' | 'voice'
  folder_id text not null,
  primary key (lead_id, kind)
);
alter table public.lead_drive_folders enable row level security;

-- Connected? (no token, only who and when) — anyone signed in may ask
create or replace function public.drive_status()
returns jsonb
language sql
stable
security definer
set search_path = public
as $$
  select jsonb_build_object(
    'connected', exists (select 1 from public.google_drive_connection),
    'email', (select email from public.google_drive_connection),
    'connected_at', (select connected_at from public.google_drive_connection),
    'connected_by', (select public.person_name(connected_by) from public.google_drive_connection)
  );
$$;

grant execute on function public.drive_status() to authenticated;

create or replace function public.drive_disconnect()
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if not public.has_permission('settings.manage') then raise exception 'Only an admin can do this.'; end if;
  delete from public.google_drive_connection;
  delete from public.lead_drive_folders;
end;
$$;

grant execute on function public.drive_disconnect() to authenticated;

-- ---------------------------------------------------------------------
-- 3. Files
-- ---------------------------------------------------------------------
create table if not exists public.lead_files (
  id            uuid primary key default gen_random_uuid(),
  lead_id       uuid not null references public.leads(id) on delete cascade,
  kind          text not null check (kind in ('paper', 'voice', 'other')),
  paper_id      uuid references public.admission_papers(id) on delete set null,
  call_id       uuid references public.call_logs(id) on delete set null,
  name          text not null,
  mime_type     text,
  size_bytes    bigint,
  duration_sec  integer,
  drive_file_id text not null,
  uploaded_by   uuid references public.profiles(id) on delete set null,
  created_at    timestamptz not null default now(),
  deleted_at    timestamptz,
  deleted_by    uuid references public.profiles(id) on delete set null
);

create index if not exists lead_files_lead_idx on public.lead_files (lead_id, created_at desc) where deleted_at is null;

alter table public.lead_files enable row level security;

-- See: leads I can see, and either my own files or everyone's (admins / the setting)
drop policy if exists "lead_files: view" on public.lead_files;
create policy "lead_files: view" on public.lead_files for select to authenticated
  using (
    deleted_at is null
    and public.fee_can_see_lead(lead_id)
    and (uploaded_by = auth.uid() or public.can_view_all_files())
  );
-- Added only by the server (drive-upload), changed only by delete_lead_file()

-- Take a file away (it stays in Drive): the person who added it, or an admin
create or replace function public.delete_lead_file(p_file_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  f public.lead_files;
begin
  select * into f from public.lead_files where id = p_file_id and deleted_at is null;
  if f.id is null or not public.fee_can_see_lead(f.lead_id) then raise exception 'Not found.'; end if;
  if f.uploaded_by is distinct from auth.uid() and not public.has_permission('settings.manage') then
    raise exception 'Only the person who added it, or an admin, can remove it.';
  end if;

  update public.lead_files set deleted_at = now(), deleted_by = auth.uid() where id = f.id;

  insert into public.lead_activity (lead_id, user_id, action, details)
  values (f.lead_id, auth.uid(), 'file_deleted', jsonb_build_object('name', f.name, 'kind', f.kind, 'file_id', f.id));
end;
$$;

grant execute on function public.delete_lead_file(uuid) to authenticated;

notify pgrst, 'reload schema';
