-- =====================================================================
-- 0001 · Foundation: branches, roles, profiles, app settings, feature flags
-- =====================================================================

-- ---------------------------------------------------------------------
-- Common: keep updated_at current on every update
-- ---------------------------------------------------------------------
create or replace function public.set_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

-- ---------------------------------------------------------------------
-- Branches (one client, but ready for more than one branch)
-- ---------------------------------------------------------------------
create table public.branches (
  id          uuid primary key default gen_random_uuid(),
  name        text not null,
  code        text not null unique,          -- e.g. DHK, used in receipt numbers
  address     text,
  phone       text,
  is_active   boolean not null default true,
  sort_order  integer not null default 0,
  created_by  uuid references auth.users (id),
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  deleted_at  timestamptz
);

create trigger branches_set_updated_at
before update on public.branches
for each row execute function public.set_updated_at();

-- ---------------------------------------------------------------------
-- Roles and their permissions (permission matrix lives in data, not code)
-- ---------------------------------------------------------------------
create table public.roles (
  key          text primary key,             -- super_admin, admin, team_lead, caller
  name         text not null,
  description  text,
  rank         integer not null,             -- higher = more power
  permissions  text[] not null default '{}',
  is_system    boolean not null default true,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);

create trigger roles_set_updated_at
before update on public.roles
for each row execute function public.set_updated_at();

insert into public.roles (key, name, description, rank, permissions) values
  ('super_admin', 'Super Admin', 'Full access to everything', 100,
    array['*']),
  ('admin', 'Admin', 'Manages settings, users, leads and payments', 80,
    array[
      'settings.manage', 'users.manage',
      'leads.view_all', 'leads.edit_all', 'leads.assign', 'leads.delete', 'leads.export',
      'reports.view_all', 'payments.manage', 'discounts.approve', 'import.run'
    ]),
  ('team_lead', 'Team Lead', 'Supervises a team of callers', 50,
    array[
      'leads.view_team', 'leads.edit_team', 'leads.assign',
      'reports.view_team', 'discounts.approve_limited'
    ]),
  ('caller', 'Caller', 'Works on their own assigned leads', 10,
    array['leads.view_own', 'leads.edit_own']);

-- ---------------------------------------------------------------------
-- Profiles (one row per login user)
-- ---------------------------------------------------------------------
create table public.profiles (
  id              uuid primary key references auth.users (id) on delete cascade,
  full_name       text,
  phone           text unique,
  role_key        text not null default 'caller' references public.roles (key),
  branch_id       uuid references public.branches (id),
  team_lead_id    uuid references public.profiles (id),
  avatar_url      text,
  is_active       boolean not null default false,  -- an admin must activate new users
  deactivated_at  timestamptz,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);

create index profiles_branch_id_idx    on public.profiles (branch_id);
create index profiles_team_lead_id_idx on public.profiles (team_lead_id);
create index profiles_role_key_idx     on public.profiles (role_key);

create trigger profiles_set_updated_at
before update on public.profiles
for each row execute function public.set_updated_at();

-- ---------------------------------------------------------------------
-- App settings (rules and limits as data, not numbers in code)
-- ---------------------------------------------------------------------
create table public.app_settings (
  key          text primary key,
  value        jsonb not null,
  description  text,
  updated_by   uuid references auth.users (id),
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);

create trigger app_settings_set_updated_at
before update on public.app_settings
for each row execute function public.set_updated_at();

insert into public.app_settings (key, value, description) values
  ('min_app_version',                '"1.0.0"', 'Older app versions must update before use'),
  ('speed_to_lead_minutes',          '15',      'Alert if a new lead is not contacted within this time'),
  ('early_reminder_minutes',         '10',      'Reminder before a follow-up is due'),
  ('repeat_reminder_minutes',        '15',      'Repeat the popup if nothing was done'),
  ('escalate_team_lead_hours',       '4',       'Overdue time before the Team Lead is alerted'),
  ('escalate_admin_hours',           '24',      'Overdue time before the Admin is alerted'),
  ('call_log_lock_hours',            '24',      'Call logs can only be edited by an Admin after this'),
  ('max_call_attempts',              '5',       'Unanswered attempts before a lead becomes Unreachable'),
  ('activity_retention_days',        '90',      'How long detailed activity events are kept'),
  ('quiet_hours',                    '{"start": "22:00", "end": "08:00"}', 'Default quiet hours for notifications');

-- ---------------------------------------------------------------------
-- Feature flags (switch features on when ready)
-- ---------------------------------------------------------------------
create table public.feature_flags (
  key          text primary key,
  is_enabled   boolean not null default false,
  description  text,
  updated_by   uuid references auth.users (id),
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);

create trigger feature_flags_set_updated_at
before update on public.feature_flags
for each row execute function public.set_updated_at();

insert into public.feature_flags (key, is_enabled, description) values
  ('excel_import',          true,  'Import leads from Excel / CSV'),
  ('document_storage',      true,  'Store paper files inside the app'),
  ('payments',              true,  'Fee plans, payments and money receipts'),
  ('campus_visits',         true,  'Campus visits and counseling appointments'),
  ('activity_monitoring',   true,  'Sessions, devices and activity timeline'),
  ('whatsapp_templates',    true,  'Ready-made WhatsApp and SMS messages'),
  ('google_contacts_sync',  false, 'Sync lead numbers to Google Contacts'),
  ('number_masking',        false, 'Hide full phone numbers from callers');

-- =====================================================================
-- Helper functions used by security rules
-- (security definer = they read profiles/roles without being blocked by RLS)
-- =====================================================================
create or replace function public.current_role_key()
returns text
language sql
stable
security definer
set search_path = public
as $$
  select p.role_key
  from public.profiles p
  where p.id = auth.uid() and p.is_active;
$$;

create or replace function public.has_permission(perm text)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1
    from public.profiles p
    join public.roles r on r.key = p.role_key
    where p.id = auth.uid()
      and p.is_active
      and ('*' = any (r.permissions) or perm = any (r.permissions))
  );
$$;

create or replace function public.is_active_user()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1 from public.profiles p
    where p.id = auth.uid() and p.is_active
  );
$$;

-- =====================================================================
-- New login user → create a profile automatically
-- =====================================================================
create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.profiles (id, phone, full_name)
  values (
    new.id,
    new.phone,
    new.raw_user_meta_data ->> 'full_name'
  )
  on conflict (id) do nothing;
  return new;
end;
$$;

create trigger on_auth_user_created
after insert on auth.users
for each row execute function public.handle_new_user();

-- =====================================================================
-- Guard: only user managers may change role, branch, team or active status
-- =====================================================================
create or replace function public.protect_profile_fields()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  -- Trusted server functions (e.g. first-run setup) can switch the guard off
  if coalesce(current_setting('app.bypass_profile_guard', true), '') = 'on' then
    return new;
  end if;

  if (new.role_key     is distinct from old.role_key
   or new.branch_id    is distinct from old.branch_id
   or new.team_lead_id is distinct from old.team_lead_id
   or new.is_active    is distinct from old.is_active) then

    if not public.has_permission('users.manage') then
      raise exception 'You are not allowed to change role, branch, team or status';
    end if;

    -- Only a Super Admin can create another Super Admin
    if new.role_key = 'super_admin'
       and old.role_key is distinct from 'super_admin'
       and public.current_role_key() is distinct from 'super_admin' then
      raise exception 'Only a Super Admin can assign the Super Admin role';
    end if;
  end if;

  if new.is_active = false and old.is_active = true then
    new.deactivated_at = now();
  elsif new.is_active = true then
    new.deactivated_at = null;
  end if;

  return new;
end;
$$;

create trigger profiles_protect_fields
before update on public.profiles
for each row execute function public.protect_profile_fields();

-- =====================================================================
-- Row Level Security
-- =====================================================================
alter table public.branches      enable row level security;
alter table public.roles         enable row level security;
alter table public.profiles      enable row level security;
alter table public.app_settings  enable row level security;
alter table public.feature_flags enable row level security;

-- Branches: active users read; settings managers write
create policy "branches_read" on public.branches
  for select to authenticated
  using (public.is_active_user());

create policy "branches_insert" on public.branches
  for insert to authenticated
  with check (public.has_permission('settings.manage'));

create policy "branches_update" on public.branches
  for update to authenticated
  using (public.has_permission('settings.manage'))
  with check (public.has_permission('settings.manage'));

-- Roles: everyone signed in can read; changes only through migrations
create policy "roles_read" on public.roles
  for select to authenticated
  using (true);

-- Profiles: a user always sees their own row; active users see colleagues
create policy "profiles_read" on public.profiles
  for select to authenticated
  using (id = auth.uid() or public.is_active_user());

-- A user can edit their own row (the guard above blocks role/branch/status);
-- user managers can edit anyone
create policy "profiles_update" on public.profiles
  for update to authenticated
  using (id = auth.uid() or public.has_permission('users.manage'))
  with check (id = auth.uid() or public.has_permission('users.manage'));

-- App settings and feature flags: active users read; settings managers write
create policy "app_settings_read" on public.app_settings
  for select to authenticated
  using (public.is_active_user());

create policy "app_settings_update" on public.app_settings
  for update to authenticated
  using (public.has_permission('settings.manage'))
  with check (public.has_permission('settings.manage'));

create policy "feature_flags_read" on public.feature_flags
  for select to authenticated
  using (public.is_active_user());

create policy "feature_flags_update" on public.feature_flags
  for update to authenticated
  using (public.has_permission('settings.manage'))
  with check (public.has_permission('settings.manage'));