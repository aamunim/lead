-- =====================================================================
-- Lead assignment settings
-- =====================================================================

-- 1. The setting (one row in app_settings)
insert into public.app_settings (key, value)
values (
  'assignment',
  '{
    "enabled": true,
    "visibility": "assigned",
    "admin_auto": false,
    "admin_auto_user_id": null,
    "caller_self": true,
    "team_lead_assign": true,
    "team_lead_self": true
  }'::jsonb
)
on conflict (key) do nothing;

-- Read the setting, with defaults for anything missing
create or replace function public.assignment_setting()
returns jsonb
language sql
stable
security definer
set search_path = public
as $$
  select jsonb_build_object(
           'enabled', true,
           'visibility', 'assigned',
           'admin_auto', false,
           'admin_auto_user_id', null,
           'caller_self', true,
           'team_lead_assign', true,
           'team_lead_self', true
         )
         || coalesce((select value from public.app_settings where key = 'assignment'), '{}'::jsonb);
$$;

grant execute on function public.assignment_setting() to authenticated;

-- 2. New columns on leads
alter table public.leads
  add column if not exists created_by uuid references public.profiles(id) default auth.uid();

alter table public.leads
  add column if not exists assignment_method text
  check (assignment_method in ('manual', 'auto', 'self', 'none'));

create index if not exists leads_created_by_idx on public.leads (created_by);

-- =====================================================================
-- 3. Can this user give a lead to that person?
--    Admins (leads.assign + leads.view_all): any active user
--    Team Leads (leads.assign, setting on): themselves or their team
-- =====================================================================
create or replace function public.can_assign_to(p_target uuid)
returns boolean
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_uid uuid := auth.uid();
  v_cfg jsonb := public.assignment_setting();
begin
  if v_uid is null then
    return true; -- database tools / server jobs
  end if;
  if not public.has_permission('leads.assign') then
    return false;
  end if;
  -- "Unassigned" is always allowed for someone who may assign
  if p_target is null then
    return true;
  end if;
  -- The person must exist and be active
  if not exists (select 1 from public.profiles where id = p_target and is_active) then
    return false;
  end if;
  -- Admins: anyone
  if public.has_permission('leads.view_all') then
    return true;
  end if;
  -- Team Leads: themselves or their own team, if the setting allows
  if coalesce((v_cfg->>'team_lead_assign')::boolean, true) then
    return p_target = v_uid
        or exists (select 1 from public.profiles where id = p_target and team_lead_id = v_uid);
  end if;
  return false;
end;
$$;

grant execute on function public.can_assign_to(uuid) to authenticated;

-- =====================================================================
-- 4. New lead: decide who gets it
--    1. Switch off                          → Unassigned
--    2. Picked by hand (and allowed)        → that person
--    3. Caller adds, caller_self on         → the caller
--    4. Team Lead adds, team_lead_self on   → the Team Lead
--    5. Admin adds, admin_auto on           → the chosen user (if active)
--    6. Otherwise                           → Unassigned
-- =====================================================================
create or replace function public.assign_new_lead()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid uuid := auth.uid();
  v_cfg jsonb := public.assignment_setting();
  v_role text;
  v_manual boolean;
  v_auto_user uuid;
begin
  new.created_by := coalesce(new.created_by, v_uid);

  -- Database tools / server jobs: keep what was given
  if v_uid is null then
    new.assignment_method := coalesce(new.assignment_method, case when new.assigned_to is null then 'none' else 'manual' end);
    return new;
  end if;

  -- 1. Switch off
  if not coalesce((v_cfg->>'enabled')::boolean, true) then
    new.assigned_to := null;
    new.assignment_method := 'none';
    return new;
  end if;

  -- 2. Picked by hand. Also counts: a person given without a method
  --    (older app screens and Excel import), if the user may assign.
  v_manual := new.assignment_method = 'manual'
              or (new.assignment_method is null and new.assigned_to is not null);

  if v_manual and public.has_permission('leads.assign') then
    if not public.can_assign_to(new.assigned_to) then
      raise exception 'You cannot assign leads to this person.';
    end if;
    new.assignment_method := 'manual';
    return new;
  end if;

  select role_key into v_role from public.profiles where id = v_uid;

  -- 3. Caller adds
  if v_role = 'caller' and coalesce((v_cfg->>'caller_self')::boolean, true) then
    new.assigned_to := v_uid;
    new.assignment_method := 'self';
    return new;
  end if;

  -- 4. Team Lead adds
  if v_role = 'team_lead' and coalesce((v_cfg->>'team_lead_self')::boolean, true) then
    new.assigned_to := v_uid;
    new.assignment_method := 'self';
    return new;
  end if;

  -- 5. Admin adds
  if public.has_permission('leads.view_all') and coalesce((v_cfg->>'admin_auto')::boolean, false) then
    v_auto_user := nullif(v_cfg->>'admin_auto_user_id', '')::uuid;
    if v_auto_user is not null
       and exists (select 1 from public.profiles where id = v_auto_user and is_active) then
      new.assigned_to := v_auto_user;
      new.assignment_method := 'auto';
      return new;
    end if;
  end if;

  -- 6. Otherwise
  new.assigned_to := null;
  new.assignment_method := 'none';
  return new;
end;
$$;

drop trigger if exists leads_assign_new on public.leads;
create trigger leads_assign_new
  before insert on public.leads
  for each row execute function public.assign_new_lead();

-- =====================================================================
-- 5. Changing who a lead is assigned to (later edits, bulk assign)
--    Always counts as manual. Checked against the same rules.
-- =====================================================================
create or replace function public.check_lead_reassign()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_cfg jsonb := public.assignment_setting();
begin
  if new.assigned_to is not distinct from old.assigned_to then
    return new;
  end if;

  -- Database tools / server jobs
  if auth.uid() is null then
    new.assignment_method := 'manual';
    return new;
  end if;

  if not coalesce((v_cfg->>'enabled')::boolean, true) then
    raise exception 'Lead assignment is turned off in Settings.';
  end if;

  if not public.can_assign_to(new.assigned_to) then
    raise exception 'You cannot assign leads to this person.';
  end if;

  new.assignment_method := 'manual';
  return new;
end;
$$;

drop trigger if exists leads_check_reassign on public.leads;
create trigger leads_check_reassign
  before update of assigned_to on public.leads
  for each row execute function public.check_lead_reassign();

notify pgrst, 'reload schema';