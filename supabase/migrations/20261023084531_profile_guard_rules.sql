-- =====================================================================
-- 0004 · Stricter rules for changing users
-- =====================================================================

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
  -- Trusted server functions (e.g. first-run setup) can switch the guard off
  if coalesce(current_setting('app.bypass_profile_guard', true), '') = 'on' then
    return new;
  end if;

  v_sensitive :=
       new.role_key     is distinct from old.role_key
    or new.branch_id    is distinct from old.branch_id
    or new.team_lead_id is distinct from old.team_lead_id
    or new.is_active    is distinct from old.is_active;

  if v_sensitive then
    -- 1. Must be allowed to manage users
    if not public.has_permission('users.manage') then
      raise exception 'You are not allowed to change role, branch, team or status';
    end if;

    -- 2. Nobody changes their own role or status
    if new.id = auth.uid()
       and (new.role_key is distinct from old.role_key
            or new.is_active is distinct from old.is_active) then
      raise exception 'You cannot change your own role or status';
    end if;

    -- 3. Only a Super Admin may touch a Super Admin, or create one
    if (old.role_key = 'super_admin' or new.role_key = 'super_admin')
       and v_actor_role is distinct from 'super_admin' then
      raise exception 'Only a Super Admin can change a Super Admin account';
    end if;

    -- 4. Never remove the last active Super Admin
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

    -- 5. A Team Lead must really be an active Team Lead (or higher)
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

  -- Keep the deactivation date correct
  if new.is_active = false and old.is_active = true then
    new.deactivated_at = now();
  elsif new.is_active = true then
    new.deactivated_at = null;
  end if;

  return new;
end;
$$;