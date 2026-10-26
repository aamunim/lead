-- =====================================================================
-- Real call log sync (Android)
--   Only calls with numbers that are leads THIS USER can see are stored.
--   The phone sends a SHA-256 hash of each number, never the number itself.
-- =====================================================================

-- 1. Setting
insert into public.app_settings (key, value)
values (
  'call_sync',
  '{
    "enabled": true,
    "mode": "all",
    "roles": ["admin", "team_lead", "caller"],
    "user_ids": [],
    "incoming": true,
    "missed_follow_up": true,
    "connected_min_sec": 5
  }'::jsonb
)
on conflict (key) do nothing;

create or replace function public.call_sync_setting()
returns jsonb
language sql
stable
security definer
set search_path = public
as $$
  select jsonb_build_object(
           'enabled', true, 'mode', 'all', 'roles', '[]'::jsonb, 'user_ids', '[]'::jsonb,
           'incoming', true, 'missed_follow_up', true, 'connected_min_sec', 5
         )
         || coalesce((select value from public.app_settings where key = 'call_sync'), '{}'::jsonb);
$$;

grant execute on function public.call_sync_setting() to authenticated;

-- May this user sync their phone's call log?
create or replace function public.can_sync_calls()
returns boolean
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_uid  uuid := auth.uid();
  v_cfg  jsonb := public.call_sync_setting();
  v_role text;
begin
  if v_uid is null or not public.is_active_user() then return false; end if;
  if not coalesce((v_cfg->>'enabled')::boolean, true) then return false; end if;

  case coalesce(v_cfg->>'mode', 'all')
    when 'all' then return true;
    when 'roles' then
      select role_key into v_role from public.profiles where id = v_uid;
      return public.has_permission('settings.manage') or coalesce(v_cfg->'roles', '[]'::jsonb) ? v_role;
    when 'users' then
      return public.has_permission('settings.manage') or coalesce(v_cfg->'user_ids', '[]'::jsonb) ? v_uid::text;
    else return false;
  end case;
end;
$$;

grant execute on function public.can_sync_calls() to authenticated;

-- 2. New columns on call_logs
alter table public.call_logs
  add column if not exists direction text not null default 'outgoing'
    check (direction in ('outgoing', 'incoming', 'missed', 'rejected')),
  add column if not exists source text not null default 'app'
    check (source in ('app', 'phone')),
  add column if not exists device_id text,          -- which phone (one id per app install)
  add column if not exists device_call_id text,     -- the call's id in that phone's call log
  add column if not exists sim_label text,          -- e.g. "SIM 1" / carrier name
  add column if not exists phone_verified boolean;  -- found in the phone's call log (step 13)

create unique index if not exists call_logs_device_call_unique
  on public.call_logs (user_id, device_id, device_call_id)
  where device_call_id is not null;

-- Missed / rejected are now possible results too
alter table public.call_logs drop constraint if exists call_logs_outcome_check;
alter table public.call_logs add constraint call_logs_outcome_check
  check (outcome in (
    'connected', 'no_answer', 'busy', 'switched_off', 'wrong_number', 'call_back',
    'missed', 'rejected'
  ));

-- 3. Own calls may be matched to the phone's record (device fields only)
create policy "call_logs: match own calls to the phone"
  on public.call_logs for update
  to authenticated
  using (public.is_active_user() and user_id = auth.uid())
  with check (user_id = auth.uid());

create or replace function public.guard_call_log_update()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  if auth.uid() is null then return new; end if;   -- database tools

  -- Only the phone-matching fields may change, and only once
  if old.device_call_id is not null
     or new.lead_id     is distinct from old.lead_id
     or new.user_id     is distinct from old.user_id
     or new.outcome     is distinct from old.outcome
     or new.notes       is distinct from old.notes
     or new.called_at   is distinct from old.called_at
     or new.created_at  is distinct from old.created_at then
    raise exception 'Call history cannot be changed.';
  end if;
  return new;
end;
$$;

drop trigger if exists call_logs_guard_update on public.call_logs;
create trigger call_logs_guard_update
  before update on public.call_logs
  for each row execute function public.guard_call_log_update();

-- =====================================================================
-- 4. After a call is saved (replaces the earlier version)
--    • "last contacted" and closing today's follow-up: only for calls WE made,
--      or calls where we actually talked
--    • a missed call FROM a lead creates a "call back" follow-up (setting)
-- =====================================================================
create or replace function public.after_call_logged()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_cfg     jsonb := public.call_sync_setting();
  v_reached boolean := new.direction = 'outgoing' or new.outcome = 'connected';
begin
  if v_reached then
    update public.leads
       set last_contacted_at = greatest(coalesce(last_contacted_at, new.called_at), new.called_at)
     where id = new.lead_id;

    update public.follow_ups
       set status = 'done',
           completed_at = new.called_at,
           completed_by = new.user_id,
           call_id = new.id
     where lead_id = new.lead_id
       and status = 'pending'
       and due_at < date_trunc('day', now() at time zone 'Asia/Dhaka') at time zone 'Asia/Dhaka' + interval '1 day';
  end if;

  insert into public.lead_activity (lead_id, user_id, action, details)
  values (
    new.lead_id,
    new.user_id,
    'call_logged',
    jsonb_build_object('outcome', new.outcome, 'call_id', new.id, 'direction', new.direction, 'source', new.source)
  );

  -- Missed call from the lead → "call back" (only if nothing is planned yet)
  if new.direction in ('missed', 'rejected')
     and coalesce((v_cfg->>'missed_follow_up')::boolean, true)
     and not exists (select 1 from public.follow_ups f where f.lead_id = new.lead_id and f.status = 'pending') then
    insert into public.follow_ups (lead_id, due_at, note, created_by)
    values (new.lead_id, new.called_at, '📵 Missed call from this lead. Call back.', new.user_id);
  end if;

  return new;
end;
$$;

-- =====================================================================
-- 5. Sync calls from the phone
--   p_device_id: one id per app install
--   p_calls: [{ "id": "123", "hash": "<sha256 of 01711234567>",
--               "direction": "outgoing|incoming|missed|rejected",
--               "duration_sec": 75, "called_at": "2026-10-24T12:00:00Z",
--               "sim": "SIM 1" }]
--   Runs as the signed-in user, so only leads they can SEE are matched,
--   and calls with any other number are ignored (never stored).
-- =====================================================================
create or replace function public.sync_phone_calls(p_device_id text, p_calls jsonb)
returns jsonb
language plpgsql
security invoker
set search_path = public, extensions
as $$
declare
  v_cfg      jsonb := public.call_sync_setting();
  v_min      int := coalesce((v_cfg->>'connected_min_sec')::int, 5);
  v_incoming boolean := coalesce((v_cfg->>'incoming')::boolean, true);
  v_call     jsonb;
  v_lead     uuid;
  v_dir      text;
  v_dur      int;
  v_at       timestamptz;
  v_outcome  text;
  v_match    uuid;
  v_added    int := 0;
  v_matched  int := 0;
  v_ignored  int := 0;
begin
  if not public.can_sync_calls() then
    raise exception 'Call log sync is not turned on for you.';
  end if;

  for v_call in select * from jsonb_array_elements(coalesce(p_calls, '[]'::jsonb))
  loop
    v_dir := coalesce(v_call->>'direction', 'outgoing');
    v_dur := greatest(coalesce((v_call->>'duration_sec')::int, 0), 0);
    v_at  := (v_call->>'called_at')::timestamptz;

    -- Incoming / missed calls switched off in Settings
    if v_dir <> 'outgoing' and not v_incoming then
      v_ignored := v_ignored + 1;
      continue;
    end if;

    -- Already synced from this phone
    if exists (
      select 1 from public.call_logs
      where user_id = auth.uid() and device_id = p_device_id and device_call_id = v_call->>'id'
    ) then
      continue;
    end if;

    -- A lead this user can see, with this number (RLS decides what "can see" means)
    select l.id into v_lead
    from public.leads l
    where l.deleted_at is null
      and (encode(digest(l.phone, 'sha256'), 'hex') = v_call->>'hash'
           or (l.alt_phone is not null and encode(digest(l.alt_phone, 'sha256'), 'hex') = v_call->>'hash'))
    order by l.created_at desc
    limit 1;

    if v_lead is null then
      v_ignored := v_ignored + 1;   -- not a lead: nothing is stored
      continue;
    end if;

    -- A call saved from the app popup a few minutes around this time? Match it instead.
    select c.id into v_match
    from public.call_logs c
    where c.user_id = auth.uid()
      and c.lead_id = v_lead
      and c.device_call_id is null
      and c.called_at between v_at - interval '10 minutes' and v_at + interval '10 minutes'
    order by abs(extract(epoch from (c.called_at - v_at)))
    limit 1;

    if v_match is not null then
      update public.call_logs
         set device_id = p_device_id,
             device_call_id = v_call->>'id',
             duration_sec = v_dur,
             direction = v_dir,
             sim_label = v_call->>'sim',
             phone_verified = true
       where id = v_match;
      v_matched := v_matched + 1;
      continue;
    end if;

    v_outcome := case
      when v_dir = 'outgoing' then case when v_dur >= v_min then 'connected' else 'no_answer' end
      when v_dir = 'incoming' then case when v_dur > 0 then 'connected' else 'missed' end
      else v_dir   -- missed / rejected
    end;

    insert into public.call_logs (
      lead_id, user_id, called_at, outcome, duration_sec, notes,
      direction, source, device_id, device_call_id, sim_label, phone_verified
    )
    values (
      v_lead, auth.uid(), v_at, v_outcome, v_dur, null,
      v_dir, 'phone', p_device_id, v_call->>'id', v_call->>'sim', true
    )
    on conflict do nothing;

    v_added := v_added + 1;
  end loop;

  return jsonb_build_object('added', v_added, 'matched', v_matched, 'ignored', v_ignored);
end;
$$;

grant execute on function public.sync_phone_calls(text, jsonb) to authenticated;

notify pgrst, 'reload schema';