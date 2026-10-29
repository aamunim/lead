-- =====================================================================
-- WhatsApp calls saved automatically (from WhatsApp's notifications)
--   The phone reads WhatsApp / WhatsApp Business notifications, keeps only
--   the ones from leads (matched on the phone with the lead directory),
--   and sends them here. Message text is never read or sent.
--   1. call_logs.source 'whatsapp' = saved from WhatsApp automatically
--   2. sync_whatsapp_events(): the phone's queue → call_logs
--   3. The phone's lead directory also knows WhatsApp numbers and usernames
--   4. Sync health shows WhatsApp too
-- =====================================================================

-- ---------------------------------------------------------------------
-- 1. Where a call came from
-- ---------------------------------------------------------------------
alter table public.call_logs drop constraint if exists call_logs_source_check;
alter table public.call_logs add constraint call_logs_source_check
  check (source in ('app', 'phone', 'whatsapp'));

-- ---------------------------------------------------------------------
-- 2. The phone's WhatsApp queue → call_logs
--    p_events: [{ id, lead_id, media: voice|video|message,
--                 direction: outgoing|incoming|missed,
--                 duration_sec, connected, called_at }]
--    Leads the user can't see (or deleted ones) are ignored.
--    The same event twice (same phone + id) is saved once, and a call the
--    user already wrote by hand in the app (within 15 minutes) is skipped.
-- ---------------------------------------------------------------------
create or replace function public.sync_whatsapp_events(p_device_id text, p_events jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid     uuid := auth.uid();
  v_e       jsonb;
  v_lead    uuid;
  v_media   text;
  v_dir     text;
  v_outcome text;
  v_dur     int;
  v_id      uuid;
  v_added   int := 0;
  v_ignored int := 0;
begin
  if v_uid is null or not public.is_active_user() then
    raise exception 'Your account is not active.';
  end if;
  if not public.can_sync_calls() then
    raise exception 'Call sync is turned off for you.';
  end if;
  if nullif(trim(coalesce(p_device_id, '')), '') is null then
    raise exception 'Unknown phone.';
  end if;

  for v_e in select * from jsonb_array_elements(coalesce(p_events, '[]'::jsonb))
  loop
    begin
      v_lead  := nullif(v_e->>'lead_id', '')::uuid;
      v_media := coalesce(v_e->>'media', 'voice');
      v_dir   := coalesce(v_e->>'direction', 'incoming');
      v_dur   := greatest(coalesce((v_e->>'duration_sec')::int, 0), 0);
    exception when others then
      v_ignored := v_ignored + 1;
      continue;
    end;

    if v_lead is null
       or v_media not in ('voice', 'video', 'message')
       or v_dir not in ('outgoing', 'incoming', 'missed')
       or nullif(v_e->>'id', '') is null
       or not exists (
         select 1 from public.leads l
         where l.id = v_lead and l.deleted_at is null and public.can_view_lead(l.assigned_to)
       ) then
      v_ignored := v_ignored + 1;
      continue;
    end if;

    v_outcome := case
      when v_media = 'message' then 'message'
      when v_dir = 'missed' then 'missed'
      when coalesce((v_e->>'connected')::boolean, false) then 'connected'
      when v_dir = 'incoming' then 'missed'
      else 'no_answer'
    end;
    -- An incoming call nobody answered is a missed call
    if v_media <> 'message' and v_dir = 'incoming' and v_outcome = 'missed' then
      v_dir := 'missed';
    end if;

    -- Already written by hand in the app (the "What happened on WhatsApp?" popup)
    -- within 15 minutes: keep that one, skip this
    if v_media <> 'message' and exists (
      select 1 from public.call_logs c
      where c.lead_id = v_lead and c.user_id = v_uid
        and c.channel = 'whatsapp' and c.source = 'app' and c.outcome <> 'message'
        and c.called_at between coalesce(nullif(v_e->>'called_at', '')::timestamptz, now()) - interval '15 minutes'
                            and coalesce(nullif(v_e->>'called_at', '')::timestamptz, now()) + interval '15 minutes'
    ) then
      v_ignored := v_ignored + 1;
      continue;
    end if;

    v_id := null;
    insert into public.call_logs (
      lead_id, user_id, called_at, outcome, duration_sec,
      direction, source, channel, media, device_id, device_call_id, phone_verified
    ) values (
      v_lead, v_uid,
      coalesce(nullif(v_e->>'called_at', '')::timestamptz, now()),
      v_outcome,
      case when v_outcome = 'connected' then v_dur else null end,
      case when v_media = 'message' and v_dir = 'missed' then 'incoming' else v_dir end,
      'whatsapp', 'whatsapp', v_media, p_device_id, 'wa:' || (v_e->>'id'), true
    )
    on conflict (user_id, device_id, device_call_id) where device_call_id is not null do nothing
    returning id into v_id;

    if v_id is not null then v_added := v_added + 1; else v_ignored := v_ignored + 1; end if;
  end loop;

  return jsonb_build_object('added', v_added, 'ignored', v_ignored);
end;
$$;

revoke all on function public.sync_whatsapp_events(text, jsonb) from public;
grant execute on function public.sync_whatsapp_events(text, jsonb) to authenticated;

-- A missed call from a lead → the lead's person (replaces the version in
-- 20261102060000): says WhatsApp, and works for leads with no phone
create or replace function public.notify_missed_call()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_lead public.leads;
  v_wa   boolean := new.channel = 'whatsapp';
begin
  if new.direction not in ('missed', 'rejected') then return null; end if;
  select * into v_lead from public.leads where id = new.lead_id and deleted_at is null;
  -- The phone that missed it already shows its own alert
  if v_lead.assigned_to is null or v_lead.assigned_to = new.user_id then return null; end if;
  perform public.notify(
    v_lead.assigned_to, 'missed_call',
    case when v_wa then '📵 Missed WhatsApp call from ' else '📵 Missed call from ' end || v_lead.name,
    concat_ws(' ',
      public.lead_contact_label(v_lead.phone, v_lead.whatsapp_number, v_lead.whatsapp_username),
      'called ' || public.person_name(new.user_id) || case when v_wa then ' on WhatsApp' else '' end || '. Call back?'),
    jsonb_build_object('lead_id', v_lead.id), 'missed:' || new.id);
  return null;
end;
$$;

-- ---------------------------------------------------------------------
-- 3. The phone's lead directory (replaces the version in 20261104060000):
--    phone, alternative phone, WhatsApp number, and "u:<username>"
--    hashes; leads with only WhatsApp are in it too
-- ---------------------------------------------------------------------
create or replace function public.my_lead_directory()
returns table (hash text, lead_id uuid, name text, rating text, stage text, course text, last_note text)
language sql
stable
security invoker
set search_path = public, extensions
as $$
  with visible as (
    select
      l.id, l.name, l.rating, l.phone, l.alt_phone, l.whatsapp_number, l.whatsapp_username,
      case s.kind
        when 'won'       then '🎓 Admitted' || coalesce(' · ' || b.name, '')
        when 'lost'      then '✕ Lost' || coalesce(' · ' || lr.name, '')
        when 'cancelled' then 'Admission cancelled'
        else s.name
      end as stage,
      coalesce(
        ac.name,
        (select c.name from public.lead_courses lc join public.courses c on c.id = lc.course_id
          where lc.lead_id = l.id limit 1)
      ) as course,
      (select cl.notes from public.call_logs cl
        where cl.lead_id = l.id and cl.notes is not null
        order by cl.called_at desc limit 1) as last_note
    from public.leads l
    left join public.pipeline_stages s on s.id = l.stage_id
    left join public.courses ac on ac.id = l.admitted_course_id and s.kind = 'won'
    left join public.batches b on b.id = l.admitted_batch_id
    left join public.lost_reasons lr on lr.id = l.lost_reason_id
    where l.deleted_at is null
    order by l.updated_at desc nulls last
    limit 10000
  ),
  keys as (
    select v.*, k.key
    from visible v
    cross join lateral (values
      (v.phone),
      (v.alt_phone),
      (v.whatsapp_number),
      ('u:' || v.whatsapp_username)
    ) as k(key)
    where k.key is not null
  )
  select distinct on (encode(digest(k.key, 'sha256'), 'hex'))
         encode(digest(k.key, 'sha256'), 'hex'), k.id, k.name, k.rating, k.stage, k.course, left(k.last_note, 120)
  from keys k;
$$;

grant execute on function public.my_lead_directory() to authenticated;

-- ---------------------------------------------------------------------
-- 4. Sync health: is WhatsApp on, and does the phone allow it?
-- ---------------------------------------------------------------------
alter table public.call_sync_devices
  add column if not exists wa_on     boolean,
  add column if not exists wa_access boolean;

create or replace function public.report_sync_status(p_device_id text, p_info jsonb)
returns void
language plpgsql
security invoker
set search_path = public
as $$
begin
  insert into public.call_sync_devices (
    user_id, device_id, device_label, app_version, permission_ok, sync_on,
    sim_label, pending_count, last_sync_at, last_error, updated_at, wa_on, wa_access
  )
  values (
    auth.uid(), p_device_id,
    p_info->>'device_label', p_info->>'app_version',
    (p_info->>'permission_ok')::boolean, (p_info->>'sync_on')::boolean,
    p_info->>'sim_label', (p_info->>'pending_count')::int,
    case when coalesce(p_info->>'error', '') = '' then now() else null end,
    nullif(p_info->>'error', ''),
    now(),
    (p_info->>'wa_on')::boolean, (p_info->>'wa_access')::boolean
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
    updated_at    = now(),
    wa_on         = excluded.wa_on,
    wa_access     = excluded.wa_access;

  -- Healthy now: the reminder has done its job
  if coalesce((p_info->>'sync_on')::boolean, false)
     and coalesce((p_info->>'permission_ok')::boolean, false)
     and coalesce(p_info->>'error', '') = '' then
    perform public.close_my_sync_nudges();
  end if;
end;
$$;

grant execute on function public.report_sync_status(text, jsonb) to authenticated;

-- Replaces the version in 20261025035226: phone calls today count phone
-- calls only; WhatsApp has its own columns
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
  nudge_open         boolean,
  wa_on              boolean,
  wa_access          boolean,
  wa_today           int
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
        and c.channel = 'phone'
        and c.phone_verified is true
        and (d.device_id is null or c.device_id = d.device_id)
        and (c.called_at at time zone 'Asia/Dhaka')::date = (now() at time zone 'Asia/Dhaka')::date
    ),
    (
      select max(c.called_at)
      from public.call_logs c
      where c.user_id = p.id
        and c.channel = 'phone'
        and c.phone_verified is true
        and (d.device_id is null or c.device_id = d.device_id)
    ),
    n.created_at,
    n.seen_at,
    n.id is not null and n.done_at is null,
    d.wa_on,
    d.wa_access,
    (
      select count(*)::int
      from public.call_logs c
      where c.user_id = p.id
        and c.source = 'whatsapp'
        and (d.device_id is null or c.device_id = d.device_id)
        and (c.called_at at time zone 'Asia/Dhaka')::date = (now() at time zone 'Asia/Dhaka')::date
    )
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
