-- =====================================================================
-- 0003 · First-run setup: the first user becomes Super Admin
-- =====================================================================

-- Institution name, filled in during first-run setup
insert into public.app_settings (key, value, description)
values ('institution_name', '""', 'Name of the institution, shown in the app and on receipts')
on conflict (key) do nothing;

-- ---------------------------------------------------------------------
-- Has setup been done? (callable before login, so the app knows
-- whether to show the setup screen or the login screen)
-- ---------------------------------------------------------------------
create or replace function public.is_setup_complete()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1 from public.profiles
    where role_key = 'super_admin'
  );
$$;

-- ---------------------------------------------------------------------
-- Complete first-run setup
-- Called by the freshly signed-up first user.
-- Creates the first branch and makes this user an active Super Admin.
-- ---------------------------------------------------------------------
create or replace function public.complete_first_run_setup(
  p_full_name        text,
  p_institution_name text,
  p_branch_name      text,
  p_branch_code      text
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_user_id   uuid := auth.uid();
  v_branch_id uuid;
  v_code      text := upper(trim(p_branch_code));
begin
  if v_user_id is null then
    raise exception 'You must be signed in to complete setup';
  end if;

  -- Only one setup can run at a time (prevents two people racing)
  perform pg_advisory_xact_lock(hashtext('first_run_setup'));

  if public.is_setup_complete() then
    raise exception 'Setup has already been completed';
  end if;

  if coalesce(trim(p_full_name), '') = ''
     or coalesce(trim(p_institution_name), '') = ''
     or coalesce(trim(p_branch_name), '') = '' then
    raise exception 'Name, institution and branch are required';
  end if;

  if v_code !~ '^[A-Z]{2,6}$' then
    raise exception 'Branch code must be 2 to 6 letters, for example DHK';
  end if;

  -- First branch
  insert into public.branches (name, code, created_by)
  values (trim(p_branch_name), v_code, v_user_id)
  returning id into v_branch_id;

  -- Institution name
  update public.app_settings
  set value = to_jsonb(trim(p_institution_name)),
      updated_by = v_user_id
  where key = 'institution_name';

  -- Make this user an active Super Admin (switch the profile guard off
  -- for this transaction only)
  perform set_config('app.bypass_profile_guard', 'on', true);

  update public.profiles
  set role_key  = 'super_admin',
      is_active = true,
      branch_id = v_branch_id,
      full_name = trim(p_full_name)
  where id = v_user_id;

  if not found then
    raise exception 'Profile not found for this user';
  end if;

  return v_branch_id;
end;
$$;

-- ---------------------------------------------------------------------
-- Who may call these functions
-- ---------------------------------------------------------------------
revoke all on function public.is_setup_complete() from public;
grant execute on function public.is_setup_complete() to anon, authenticated;

revoke all on function public.complete_first_run_setup(text, text, text, text) from public;
grant execute on function public.complete_first_run_setup(text, text, text, text) to authenticated;