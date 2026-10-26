-- =====================================================================
-- 0005 · Remove branches (single location client)
-- =====================================================================

-- ---------------------------------------------------------------------
-- 1. Profile guard without branch (must change before the column is dropped)
-- ---------------------------------------------------------------------
create or replace function public.protect_profile_fields()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_actor_role   text := public.current_role_key();
  v_sensitive    boolean;
  v_other_supers integer;
begin
  if coalesce(current_setting('app.bypass_profile_guard', true), '') = 'on' then
    return new;
  end if;

  v_sensitive :=
       new.role_key     is distinct from old.role_key
    or new.team_lead_id is distinct from old.team_lead_id
    or new.is_active    is distinct from old.is_active;

  if v_sensitive then
    if not public.has_permission('users.manage') then
      raise exception 'You are not allowed to change role, team or status';
    end if;

    if new.id = auth.uid()
       and (new.role_key is distinct from old.role_key
            or new.is_active is distinct from old.is_active) then
      raise exception 'You cannot change your own role or status';
    end if;

    if (old.role_key = 'super_admin' or new.role_key = 'super_admin')
       and v_actor_role is distinct from 'super_admin' then
      raise exception 'Only a Super Admin can change a Super Admin account';
    end if;

    if old.role_key = 'super_admin' and old.is_active
       and (new.role_key is distinct from 'super_admin' or not new.is_active) then
      select count(*) into v_other_supers
      from public.profiles
      where role_key = 'super_admin'
        and is_active
        and id <> old.id;

      if v_other_supers = 0 then
        raise exception 'There must always be at least one active Super Admin';
      end if;
    end if;

    if new.team_lead_id is not null
       and new.team_lead_id is distinct from old.team_lead_id then
      if new.team_lead_id = new.id then
        raise exception 'A user cannot be their own Team Lead';
      end if;
      if not exists (
        select 1 from public.profiles
        where id = new.team_lead_id
          and is_active
          and role_key in ('team_lead', 'admin', 'super_admin')
      ) then
        raise exception 'The selected Team Lead is not an active Team Lead';
      end if;
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

-- ---------------------------------------------------------------------
-- 2. First-run setup without branch
-- ---------------------------------------------------------------------
drop function if exists public.complete_first_run_setup(text, text, text, text);

create or replace function public.complete_first_run_setup(
  p_full_name        text,
  p_institution_name text
)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_user_id uuid := auth.uid();
begin
  if v_user_id is null then
    raise exception 'You must be signed in to complete setup';
  end if;

  perform pg_advisory_xact_lock(hashtext('first_run_setup'));

  if public.is_setup_complete() then
    raise exception 'Setup has already been completed';
  end if;

  if coalesce(trim(p_full_name), '') = ''
     or coalesce(trim(p_institution_name), '') = '' then
    raise exception 'Name and institution are required';
  end if;

  update public.app_settings
  set value = to_jsonb(trim(p_institution_name)),
      updated_by = v_user_id
  where key = 'institution_name';

  perform set_config('app.bypass_profile_guard', 'on', true);

  update public.profiles
  set role_key  = 'super_admin',
      is_active = true,
      full_name = trim(p_full_name)
  where id = v_user_id;

  if not found then
    raise exception 'Profile not found for this user';
  end if;
end;
$$;

revoke all on function public.complete_first_run_setup(text, text) from public;
grant execute on function public.complete_first_run_setup(text, text) to authenticated;

-- ---------------------------------------------------------------------
-- 3. Receipt number prefix now lives in settings
-- ---------------------------------------------------------------------
insert into public.app_settings (key, value, description)
values ('receipt_prefix', '"RCP"', 'Prefix for money receipt numbers, e.g. RCP-2026-00001')
on conflict (key) do nothing;

-- ---------------------------------------------------------------------
-- 4. Remove the branch column and table
-- ---------------------------------------------------------------------
alter table public.profiles drop column if exists branch_id;

drop table if exists public.branches;