-- =====================================================================
-- Sync health (#7): one screen for admins / team leads
--   Who syncs, from which phone, when last, errors, calls waiting.
-- =====================================================================

-- ---------------------------------------------------------------------
-- 1. May a GIVEN user sync? (same rules as can_sync_calls, for anyone)
--    Admin roles (super_admin, admin) always may, like settings.manage.
--    Only used inside other functions, never called by the app directly.
-- ---------------------------------------------------------------------
create or replace function public.can_user_sync_calls(p_user uuid)
returns boolean
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_cfg    jsonb := public.call_sync_setting();
  v_role   text;
  v_active boolean;
begin
  select role_key, is_active into v_role, v_active from public.profiles where id = p_user;
  if not coalesce(v_active, false) then return false; end if;
  if not coalesce((v_cfg->>'enabled')::boolean, true) then return false; end if;

  case coalesce(v_cfg->>'mode', 'all')
    when 'all' then
      return true;
    when 'roles' then
      return v_role in ('super_admin', 'admin') or coalesce(v_cfg->'roles', '[]'::jsonb) ? v_role;
    when 'users' then
      return v_role in ('super_admin', 'admin') or coalesce(v_cfg->'user_ids', '[]'::jsonb) ? p_user::text;
    else
      return false;
  end case;
end;
$$;

revoke all on function public.can_user_sync_calls(uuid) from public, anon, authenticated;

-- ---------------------------------------------------------------------
-- 2. The health list: one row per user + phone
--    (a user with no phone yet gets one row with empty phone fields)
--    Admins (users.manage) see everyone; Team Leads see their team; others see themselves.
-- ---------------------------------------------------------------------
create or replace function public.call_sync_health()
returns table (
  user_id            uuid,
  user_name          text,
  role_key           text,
  team_lead_id       uuid,
  allowed            boolean,
  device_id          text,
  device_label       text,
  app_version        text,
  permission_ok      boolean,
  sync_on            boolean,
  sim_label          text,
  pending_count      int,
  last_sync_at       timestamptz,
  last_error         text,
  updated_at         timestamptz,
  phone_calls_today  int,
  last_phone_call_at timestamptz
)
language sql
stable
security definer
set search_path = public
as $$
  select
    p.id,
    p.full_name,
    p.role_key,
    p.team_lead_id,
    public.can_user_sync_calls(p.id),
    d.device_id,
    d.device_label,
    d.app_version,
    d.permission_ok,
    d.sync_on,
    d.sim_label,
    d.pending_count,
    d.last_sync_at,
    d.last_error,
    d.updated_at,
    (
      select count(*)::int
      from public.call_logs c
      where c.user_id = p.id
        and c.phone_verified is true
        and (d.device_id is null or c.device_id = d.device_id)
        and (c.called_at at time zone 'Asia/Dhaka')::date = (now() at time zone 'Asia/Dhaka')::date
    ),
    (
      select max(c.called_at)
      from public.call_logs c
      where c.user_id = p.id
        and c.phone_verified is true
        and (d.device_id is null or c.device_id = d.device_id)
    )
  from public.profiles p
  left join public.call_sync_devices d on d.user_id = p.id
  where p.is_active
    and public.is_active_user()
    and (
      public.has_permission('users.manage')
      or p.id = auth.uid()
      or p.team_lead_id = auth.uid()
    )
  order by p.full_name, d.updated_at desc nulls last;
$$;

grant execute on function public.call_sync_health() to authenticated;

-- ---------------------------------------------------------------------
-- 3. Forget an old phone (the user changed phones)
--    Admins: anyone's. Team Leads: their team's. Users: their own.
--    The calls already saved stay; only the health row goes.
-- ---------------------------------------------------------------------
create or replace function public.forget_sync_device(p_user_id uuid, p_device_id text)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if not public.is_active_user() then
    raise exception 'Not allowed.';
  end if;

  if not (
    public.has_permission('users.manage')
    or p_user_id = auth.uid()
    or exists (select 1 from public.profiles where id = p_user_id and team_lead_id = auth.uid())
  ) then
    raise exception 'You can only remove phones of your own team.';
  end if;

  delete from public.call_sync_devices
  where user_id = p_user_id and device_id = p_device_id;
end;
$$;

grant execute on function public.forget_sync_device(uuid, text) to authenticated;

-- Faster "calls from this phone" counts
create index if not exists call_logs_user_device_called_idx
  on public.call_logs (user_id, device_id, called_at desc)
  where phone_verified is true;

notify pgrst, 'reload schema';