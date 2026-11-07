-- =====================================================================
-- 📱 Push health / Sync health / App versions: only devices someone is
--   signed in on now.
--   · sign out on a device → that person's rows for it go
--     (forget_my_device, called by the app before signing out)
--   · a phone that changes hands: when the next person's app checks in,
--     the last person's rows for that phone go (a phone's id is one per
--     app install, so it never belongs to two people at once)
--   · once now: each phone keeps only the person who used it last
--   Website keys ("web:Chrome · Windows") are shared by many computers, so
--   only signing out removes them.
--   (Dated before 20270104060000_lead_merge so both can go in any order.)
-- =====================================================================

-- One phone = one app install = one id like 1b4e28ba-2fa1-11d2-883f-…
create or replace function public.is_install_id(p text)
returns boolean
language sql
immutable
as $$
  select coalesce(p ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$', false);
$$;

-- ---------------------------------------------------------------------
-- Sign out: forget this device for me
-- ---------------------------------------------------------------------
create or replace function public.forget_my_device(
  p_device_id    text default null,
  p_device_label text default null,
  p_token        text default null
)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_me uuid := auth.uid();
  v_id text := nullif(trim(coalesce(p_device_id, '')), '');
begin
  if v_me is null then return; end if;
  if v_id is not null then
    delete from public.push_devices      where user_id = v_me and device_id = v_id;
    delete from public.call_sync_devices where user_id = v_me and device_id = v_id;
    delete from public.push_tokens       where user_id = v_me and device_id = v_id;
    delete from public.app_devices       where user_id = v_me and device_key = left(v_id, 80);
  end if;
  -- an app without a device id was kept under its name
  if v_id is null and nullif(trim(coalesce(p_device_label, '')), '') is not null then
    delete from public.app_devices where user_id = v_me and device_key = left(p_device_label, 80);
  end if;
  if nullif(trim(coalesce(p_token, '')), '') is not null then
    delete from public.push_tokens where user_id = v_me and token = p_token;
  end if;
end;
$$;

revoke all on function public.forget_my_device(text, text, text) from public, anon;
grant execute on function public.forget_my_device(text, text, text) to authenticated;

-- ---------------------------------------------------------------------
-- A phone checks in for someone: the others' rows for that phone go
-- ---------------------------------------------------------------------
create or replace function public.device_claim()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  -- app_devices calls it device_key, the others device_id
  v_col text := case tg_table_name when 'app_devices' then 'device_key' else 'device_id' end;
  v_id  text := to_jsonb(new) ->> v_col;
begin
  if not public.is_install_id(v_id) then return null; end if;
  -- only when it is new for this person (not on every check-in)
  if tg_op = 'UPDATE' and old.user_id = new.user_id and (to_jsonb(old) ->> v_col) = v_id then
    return null;
  end if;
  delete from public.push_devices      where device_id = v_id and user_id <> new.user_id;
  delete from public.call_sync_devices where device_id = v_id and user_id <> new.user_id;
  delete from public.push_tokens       where device_id = v_id and user_id <> new.user_id;
  delete from public.app_devices       where device_key = v_id and user_id <> new.user_id;
  return null;
end;
$$;

revoke all on function public.device_claim() from public, anon, authenticated;

drop trigger if exists push_devices_claim on public.push_devices;
create trigger push_devices_claim after insert or update on public.push_devices
  for each row execute function public.device_claim();
drop trigger if exists call_sync_devices_claim on public.call_sync_devices;
create trigger call_sync_devices_claim after insert or update on public.call_sync_devices
  for each row execute function public.device_claim();
drop trigger if exists app_devices_claim on public.app_devices;
create trigger app_devices_claim after insert or update on public.app_devices
  for each row execute function public.device_claim();
drop trigger if exists push_tokens_claim on public.push_tokens;
create trigger push_tokens_claim after insert or update on public.push_tokens
  for each row execute function public.device_claim();

-- ---------------------------------------------------------------------
-- Once now: each phone keeps only the person who used it last
--   (the newest sign of life in any of the four lists)
-- ---------------------------------------------------------------------
with seen as (
  select device_key as id, user_id, last_seen_at as at from public.app_devices
  union all select device_id, user_id, checked_at from public.push_devices
  union all select device_id, user_id, updated_at from public.call_sync_devices
  union all select device_id, user_id, updated_at from public.push_tokens where device_id is not null
),
last_user as (
  select distinct on (id) id, user_id
  from seen
  where public.is_install_id(id)
  order by id, at desc nulls last
)
, d1 as (delete from public.app_devices a using last_user u
         where a.device_key = u.id and a.user_id <> u.user_id returning 1)
, d2 as (delete from public.push_devices p using last_user u
         where p.device_id = u.id and p.user_id <> u.user_id returning 1)
, d3 as (delete from public.call_sync_devices c using last_user u
         where c.device_id = u.id and c.user_id <> u.user_id returning 1)
, d4 as (delete from public.push_tokens t using last_user u
         where t.device_id = u.id and t.user_id <> u.user_id returning 1)
select (select count(*) from d1) + (select count(*) from d2) + (select count(*) from d3) + (select count(*) from d4);
