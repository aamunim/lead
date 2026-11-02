-- =====================================================================
-- 📱 App versions (admins, phone): which build and which EAS update
--   each phone runs, when it was last opened; ask people on an old
--   update to restart the app.
--   app_devices: one row per user + phone, kept up to date by
--   report_app_session() (also when Team activity is switched off).
-- =====================================================================

create table if not exists public.app_devices (
  user_id      uuid not null references public.profiles(id) on delete cascade,
  device_key   text not null,                 -- the phone's id, else its name
  device_label text,
  app_version  text,                          -- the build, e.g. 2.6.0-beta
  update_id    text,                          -- EAS update id (null = built in)
  update_at    timestamptz,                   -- when that update was published
  channel      text,
  last_seen_at timestamptz not null default now(),
  primary key (user_id, device_key)
);

alter table public.app_devices enable row level security;
-- read only through app_versions(); written only by report_app_session()

-- The old 8-argument version goes, so old and new apps both reach this one
drop function if exists public.report_app_session(uuid, timestamptz, timestamptz, integer, boolean, text, text, text);

create or replace function public.report_app_session(
  p_id           uuid,
  p_started_at   timestamptz,
  p_last_seen_at timestamptz,
  p_active_sec   integer,
  p_ended        boolean default false,
  p_device_id    text default null,
  p_device_label text default null,
  p_app_version  text default null,
  p_update_id    text default null,
  p_update_at    timestamptz default null,
  p_channel      text default null
)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_setting jsonb := public.activity_setting();
  v_last    timestamptz := least(p_last_seen_at, now() + interval '5 minutes');
  v_active  integer;
begin
  if auth.uid() is null or not public.is_active_user() then return; end if;

  -- 📱 The phone and its version (always)
  insert into public.app_devices (user_id, device_key, device_label, app_version, update_id, update_at, channel, last_seen_at)
  values (auth.uid(), left(coalesce(p_device_id, p_device_label, 'phone'), 80), left(p_device_label, 80),
          left(p_app_version, 40), left(p_update_id, 64), p_update_at, left(p_channel, 40), now())
  on conflict (user_id, device_key) do update
     set device_label = coalesce(excluded.device_label, app_devices.device_label),
         app_version  = coalesce(excluded.app_version, app_devices.app_version),
         update_id    = excluded.update_id,
         update_at    = excluded.update_at,
         channel      = coalesce(excluded.channel, app_devices.channel),
         last_seen_at = now();

  if not coalesce((v_setting ->> 'enabled')::boolean, true) then return; end if;
  if p_id is null or p_started_at is null or v_last < p_started_at then return; end if;

  -- Never more active time than the session lasted
  v_active := least(greatest(coalesce(p_active_sec, 0), 0),
                    extract(epoch from (v_last - p_started_at))::int + 60);

  insert into public.app_sessions (id, user_id, device_id, device_label, app_version,
                                   started_at, last_seen_at, active_sec, ended)
  values (p_id, auth.uid(), p_device_id, left(p_device_label, 80), left(p_app_version, 40),
          p_started_at, v_last, v_active, coalesce(p_ended, false))
  on conflict (id) do update
     set last_seen_at = greatest(app_sessions.last_seen_at, excluded.last_seen_at),
         active_sec   = greatest(app_sessions.active_sec, excluded.active_sec),
         ended        = app_sessions.ended or excluded.ended,
         device_id    = coalesce(excluded.device_id, app_sessions.device_id),
         device_label = coalesce(excluded.device_label, app_sessions.device_label),
         app_version  = coalesce(excluded.app_version, app_sessions.app_version)
   where app_sessions.user_id = auth.uid();

  -- Old sessions go after the kept days
  delete from public.app_sessions
   where user_id = auth.uid()
     and started_at < now() - make_interval(days => coalesce((v_setting ->> 'keep_days')::int, 90));
end;
$$;

grant execute on function public.report_app_session(uuid, timestamptz, timestamptz, integer, boolean, text, text, text, text, timestamptz, text) to authenticated;

-- Every active user, with each phone (none yet = one row without a phone)
create or replace function public.app_versions()
returns table (user_id uuid, full_name text, role_name text, device_label text, app_version text,
               update_id text, update_at timestamptz, channel text, last_seen_at timestamptz)
language plpgsql
stable
security definer
set search_path = public
as $$
begin
  if not public.has_permission('settings.manage') then raise exception 'Only admins can see this.'; end if;
  return query
  select p.id, p.full_name, r.name, d.device_label, d.app_version, d.update_id, d.update_at, d.channel, d.last_seen_at
  from public.profiles p
  left join public.roles r on r.key = p.role_key
  left join public.app_devices d on d.user_id = p.id
  where p.is_active
  order by p.full_name, d.last_seen_at desc nulls last;
end;
$$;

grant execute on function public.app_versions() to authenticated;

-- 🔔 "Please restart the app to get the new version"
create or replace function public.ask_app_update(p_users uuid[])
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  v_user uuid;
  v_n    integer := 0;
begin
  if not public.has_permission('settings.manage') then raise exception 'Only admins can do this.'; end if;
  foreach v_user in array coalesce(p_users, '{}') loop
    if public.notify(v_user, 'app_update', '🔄 A new version of the app is ready',
                     'Please close the app fully and open it again (or More → Check for updates).',
                     '{}'::jsonb, 'app_update:' || to_char(now(), 'YYYY-MM-DD HH24'), true) is not null then
      v_n := v_n + 1;
    end if;
  end loop;
  return v_n;
end;
$$;

grant execute on function public.ask_app_update(uuid[]) to authenticated;

notify pgrst, 'reload schema';
