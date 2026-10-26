-- =====================================================================
-- "Remind to set up" call sync
--   Super Admin reminds users; the app shows a one-tap setup sheet.
--   A reminder closes itself when the phone reports sync on + permission OK.
-- =====================================================================

-- ---------------------------------------------------------------------
-- 1. Is the signed-in user the Super Admin?
-- ---------------------------------------------------------------------
create or replace function public.is_super_admin()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1 from public.profiles
    where id = auth.uid() and role_key = 'super_admin' and is_active
  );
$$;

grant execute on function public.is_super_admin() to authenticated;

-- ---------------------------------------------------------------------
-- 2. Reminders
-- ---------------------------------------------------------------------
create table if not exists public.app_nudges (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null references public.profiles(id) on delete cascade,
  kind        text not null default 'call_sync_setup' check (kind in ('call_sync_setup')),
  reason      text check (reason in ('not_set_up', 'sync_off', 'permission_off', 'late', 'error')),
  message     text,
  sent_by     uuid references public.profiles(id) on delete set null,
  created_at  timestamptz not null default now(),
  seen_at     timestamptz,
  done_at     timestamptz
);

create index if not exists app_nudges_open_idx
  on public.app_nudges (user_id, kind, created_at desc)
  where done_at is null;

alter table public.app_nudges enable row level security;

-- Read: your own reminders; the Super Admin reads all. Writes only through the functions below.
create policy "app_nudges: view"
  on public.app_nudges for select
  to authenticated
  using (public.is_active_user() and (user_id = auth.uid() or public.is_super_admin()));

-- ---------------------------------------------------------------------
-- 3. Why does this user need a reminder? (from their latest phone report)
-- ---------------------------------------------------------------------
create or replace function public.sync_nudge_reason(p_user uuid)
returns text
language sql
stable
security definer
set search_path = public
as $$
  select case
    when d.device_id is null then 'not_set_up'
    when d.sync_on is false then 'sync_off'
    when d.permission_ok is false then 'permission_off'
    when d.last_error is not null then 'error'
    else 'late'
  end
  from (select 1) one
  left join lateral (
    select * from public.call_sync_devices
    where user_id = p_user
    order by updated_at desc
    limit 1
  ) d on true;
$$;

revoke all on function public.sync_nudge_reason(uuid) from public, anon, authenticated;

-- ---------------------------------------------------------------------
-- 4. Send reminders (Super Admin only)
--    Skips: users not allowed to sync, and anyone reminded in the last 15 minutes.
--    An older open reminder is replaced by the new one.
-- ---------------------------------------------------------------------
create or replace function public.send_sync_nudge(p_user_ids uuid[], p_message text default null)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid       uuid;
  v_msg       text := nullif(left(trim(coalesce(p_message, '')), 200), '');
  v_sent      int := 0;
  v_cooldown  int := 0;
  v_blocked   int := 0;
begin
  if not public.is_super_admin() then
    raise exception 'Only the Super Admin can send reminders.';
  end if;

  foreach v_uid in array coalesce(p_user_ids, '{}'::uuid[])
  loop
    -- Not allowed to sync (admin setting) or inactive
    if not public.can_user_sync_calls(v_uid) then
      v_blocked := v_blocked + 1;
      continue;
    end if;

    -- Reminded in the last 15 minutes
    if exists (
      select 1 from public.app_nudges
      where user_id = v_uid and kind = 'call_sync_setup'
        and created_at > now() - interval '15 minutes'
    ) then
      v_cooldown := v_cooldown + 1;
      continue;
    end if;

    -- Only one open reminder per person: close the older one
    update public.app_nudges
       set done_at = now()
     where user_id = v_uid and kind = 'call_sync_setup' and done_at is null;

    insert into public.app_nudges (user_id, kind, reason, message, sent_by)
    values (v_uid, 'call_sync_setup', public.sync_nudge_reason(v_uid), v_msg, auth.uid());

    v_sent := v_sent + 1;
  end loop;

  return jsonb_build_object('sent', v_sent, 'cooldown', v_cooldown, 'not_allowed', v_blocked);
end;
$$;

grant execute on function public.send_sync_nudge(uuid[], text) to authenticated;

-- ---------------------------------------------------------------------
-- 5. For the user: my open reminder (newest), and marking it seen / done
-- ---------------------------------------------------------------------
create or replace function public.my_open_nudge()
returns table (
  id uuid, kind text, reason text, message text,
  sent_by_name text, created_at timestamptz, seen_at timestamptz
)
language sql
stable
security definer
set search_path = public
as $$
  select n.id, n.kind, n.reason, n.message, p.full_name, n.created_at, n.seen_at
  from public.app_nudges n
  left join public.profiles p on p.id = n.sent_by
  where n.user_id = auth.uid() and n.done_at is null
  order by n.created_at desc
  limit 1;
$$;

grant execute on function public.my_open_nudge() to authenticated;

create or replace function public.mark_nudge_seen(p_id uuid)
returns void
language sql
security definer
set search_path = public
as $$
  update public.app_nudges
     set seen_at = coalesce(seen_at, now())
   where id = p_id and user_id = auth.uid();
$$;

grant execute on function public.mark_nudge_seen(uuid) to authenticated;

create or replace function public.close_my_sync_nudges()
returns void
language sql
security definer
set search_path = public
as $$
  update public.app_nudges
     set done_at = now(), seen_at = coalesce(seen_at, now())
   where user_id = auth.uid() and kind = 'call_sync_setup' and done_at is null;
$$;

grant execute on function public.close_my_sync_nudges() to authenticated;

-- ---------------------------------------------------------------------
-- 6. Phone report (replaces the earlier version):
--    a healthy report also closes the user's open reminders
-- ---------------------------------------------------------------------
create or replace function public.report_sync_status(p_device_id text, p_info jsonb)
returns void
language plpgsql
security invoker
set search_path = public
as $$
begin
  insert into public.call_sync_devices (
    user_id, device_id, device_label, app_version, permission_ok, sync_on,
    sim_label, pending_count, last_sync_at, last_error, updated_at
  )
  values (
    auth.uid(), p_device_id,
    p_info->>'device_label', p_info->>'app_version',
    (p_info->>'permission_ok')::boolean, (p_info->>'sync_on')::boolean,
    p_info->>'sim_label', (p_info->>'pending_count')::int,
    case when coalesce(p_info->>'error', '') = '' then now() else null end,
    nullif(p_info->>'error', ''),
    now()
  )
  on conflict (user_id, device_id) do update set
    device_label  = excluded.device_label,
    app_version   = excluded.app_version,
    permission_ok = excluded.permission_ok,
    sync_on       = excluded.sync_on,
    sim_label     = excluded.sim_label,
    pending_count = excluded.pending_count,
    last_sync_at  = coalesce(excluded.last_sync_at, call_sync_devices.last_sync_at),
    last_error    = excluded.last_error,
    updated_at    = now();

  -- Healthy now: the reminder has done its job
  if coalesce((p_info->>'sync_on')::boolean, false)
     and coalesce((p_info->>'permission_ok')::boolean, false)
     and coalesce(p_info->>'error', '') = '' then
    perform public.close_my_sync_nudges();
  end if;
end;
$$;

grant execute on function public.report_sync_status(text, jsonb) to authenticated;

-- ---------------------------------------------------------------------
-- 7. Health list (replaces the earlier version): + last reminder per user
-- ---------------------------------------------------------------------
drop function if exists public.call_sync_health();

create function public.call_sync_health()
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
  last_phone_call_at timestamptz,
  nudge_at           timestamptz,
  nudge_seen_at      timestamptz,
  nudge_open         boolean
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
    ),
    n.created_at,
    n.seen_at,
    n.id is not null and n.done_at is null
  from public.profiles p
  left join public.call_sync_devices d on d.user_id = p.id
  left join lateral (
    select x.id, x.created_at, x.seen_at, x.done_at
    from public.app_nudges x
    where x.user_id = p.id and x.kind = 'call_sync_setup'
    order by x.created_at desc
    limit 1
  ) n on true
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

notify pgrst, 'reload schema';