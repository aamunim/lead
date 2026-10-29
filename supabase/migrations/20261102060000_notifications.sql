-- =====================================================================
-- Notifications (🔔 in the app, and push to the phone)
--   1. Extensions: pg_net (send to Expo's push service), pg_cron (every minute)
--   2. Setting: each kind on/off (Settings → Notifications)
--   3. Tables: notifications (the 🔔 list), push_tokens (one per phone),
--      notification_prefs (the Super Admin can mute kinds for themselves)
--   4. notify(): save + push now, or after quiet hours
--   5. Hand over: anyone may give a lead to anyone (setting), with a note
--   6. Events: assigned / auto-assigned, admitted / lost, new sign-up,
--      call sync reminder, a lead's missed call
--   7. Every minute: follow-up reminders, campus visits, new leads not
--      called (→ Team Lead → admins), and pushes held back by quiet hours
--
--   Kinds: assigned, follow_up, visit, auto_assigned, speed_to_lead,
--          outcome, signup, sync_nudge, missed_call
-- =====================================================================

-- ---------------------------------------------------------------------
-- 1. Extensions (Supabase has both; a plain Postgres may not)
-- ---------------------------------------------------------------------
do $$
begin
  begin
    create extension if not exists pg_net with schema extensions;
  exception when others then
    raise notice 'pg_net is not available: pushes are saved but not sent';
  end;
  begin
    create extension if not exists pg_cron;
  exception when others then
    raise notice 'pg_cron is not available: reminders need notifications_tick() to be run';
  end;
end;
$$;

-- ---------------------------------------------------------------------
-- 2. Setting
-- ---------------------------------------------------------------------
insert into public.app_settings (key, value)
values ('notifications', '{
  "kinds": {"assigned": true, "follow_up": true, "visit": true, "auto_assigned": true,
            "speed_to_lead": true, "outcome": true, "signup": true, "sync_nudge": true,
            "missed_call": true},
  "assigned_in_quiet_hours": true
}'::jsonb)
on conflict (key) do nothing;

create or replace function public.notification_setting()
returns jsonb
language sql
stable
security definer
set search_path = public
as $$
  select jsonb_build_object(
           'kinds', jsonb_build_object('assigned', true, 'follow_up', true, 'visit', true, 'auto_assigned', true,
                                       'speed_to_lead', true, 'outcome', true, 'signup', true,
                                       'sync_nudge', true, 'missed_call', true),
           'assigned_in_quiet_hours', true
         )
         || coalesce((select value from public.app_settings where key = 'notifications'), '{}'::jsonb);
$$;

-- A number setting (e.g. early_reminder_minutes), with a default
create or replace function public.setting_int(p_key text, p_default int)
returns int
language sql
stable
security definer
set search_path = public
as $$
  select coalesce((select (value #>> '{}')::int from public.app_settings where key = p_key), p_default);
$$;

-- ---------------------------------------------------------------------
-- 3. Tables
-- ---------------------------------------------------------------------
create table if not exists public.notifications (
  id            uuid primary key default gen_random_uuid(),
  user_id       uuid not null references public.profiles(id) on delete cascade,
  kind          text not null,
  title         text not null,
  body          text,
  data          jsonb not null default '{}'::jsonb,   -- {"lead_id"} or {"lead_ids": []} or {"route"}
  dedupe        text,                                 -- one notification per key and person
  created_at    timestamptz not null default now(),
  deliver_after timestamptz not null default now(),   -- later during quiet hours
  sent_at       timestamptz,
  push_status   text,                                 -- sent / no_device / no_push_service
  read_at       timestamptz
);

create unique index if not exists notifications_dedupe on public.notifications (user_id, dedupe) where dedupe is not null;
create index if not exists notifications_user_idx on public.notifications (user_id, created_at desc);
create index if not exists notifications_queue_idx on public.notifications (deliver_after) where sent_at is null;

alter table public.notifications enable row level security;

create policy "notifications: own"
  on public.notifications for select
  to authenticated
  using (user_id = auth.uid());

create table if not exists public.push_tokens (
  token       text primary key,                       -- ExponentPushToken[…]
  user_id     uuid not null references public.profiles(id) on delete cascade,
  device_id   text,
  platform    text,
  updated_at  timestamptz not null default now()
);

create index if not exists push_tokens_user_idx on public.push_tokens (user_id);
alter table public.push_tokens enable row level security;  -- only through the functions below

create table if not exists public.notification_prefs (
  user_id  uuid primary key references public.profiles(id) on delete cascade,
  muted    text[] not null default '{}'
);

alter table public.notification_prefs enable row level security;

create policy "notification_prefs: own"
  on public.notification_prefs for select
  to authenticated
  using (user_id = auth.uid());

-- Phones: save / remove this phone's push token
create or replace function public.register_push_token(p_token text, p_device_id text default null, p_platform text default null)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if auth.uid() is null or nullif(trim(coalesce(p_token, '')), '') is null then return; end if;
  -- The same phone moves to whoever signs in on it
  insert into public.push_tokens (token, user_id, device_id, platform, updated_at)
  values (p_token, auth.uid(), p_device_id, p_platform, now())
  on conflict (token) do update
     set user_id = excluded.user_id, device_id = excluded.device_id,
         platform = excluded.platform, updated_at = now();
end;
$$;

create or replace function public.remove_push_token(p_token text)
returns void
language sql
security definer
set search_path = public
as $$
  delete from public.push_tokens where token = p_token and user_id = auth.uid();
$$;

-- The 🔔 list: mark read
create or replace function public.mark_notifications_read(p_ids uuid[] default null)
returns void
language sql
security definer
set search_path = public
as $$
  update public.notifications
     set read_at = now()
   where user_id = auth.uid() and read_at is null
     and (p_ids is null or id = any (p_ids));
$$;

-- Only the Super Admin may switch kinds off for themselves
create or replace function public.set_my_muted_notifications(p_kinds text[])
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if not public.is_super_admin() then
    raise exception 'Only the Super Admin can change their own notifications.';
  end if;
  insert into public.notification_prefs (user_id, muted)
  values (auth.uid(), coalesce(p_kinds, '{}'))
  on conflict (user_id) do update set muted = excluded.muted;
end;
$$;

grant execute on function public.register_push_token(text, text, text) to authenticated;
grant execute on function public.remove_push_token(text) to authenticated;
grant execute on function public.mark_notifications_read(uuid[]) to authenticated;
grant execute on function public.set_my_muted_notifications(text[]) to authenticated;
grant execute on function public.notification_setting() to authenticated;

-- ---------------------------------------------------------------------
-- 4. Sending
-- ---------------------------------------------------------------------
-- When quiet hours end, if we are in them now (Bangladesh time); else null
create or replace function public.quiet_until(p_at timestamptz default now())
returns timestamptz
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_q     jsonb := (select value from public.app_settings where key = 'quiet_hours');
  v_local timestamp := p_at at time zone 'Asia/Dhaka';
  v_start time := coalesce((v_q ->> 'start')::time, '22:00');
  v_end   time := coalesce((v_q ->> 'end')::time, '08:00');
  v_now   time := v_local::time;
begin
  if v_start = v_end then return null; end if;
  if v_start > v_end then                       -- over midnight, e.g. 22:00 – 08:00
    if v_now >= v_start then
      return ((v_local::date + 1) + v_end) at time zone 'Asia/Dhaka';
    elsif v_now < v_end then
      return (v_local::date + v_end) at time zone 'Asia/Dhaka';
    end if;
  elsif v_now >= v_start and v_now < v_end then
    return (v_local::date + v_end) at time zone 'Asia/Dhaka';
  end if;
  return null;
end;
$$;

-- Send one saved notification to every phone of its person
create or replace function public.push_notification(p_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_n        public.notifications;
  v_messages jsonb;
  v_unread   int;
begin
  select * into v_n from public.notifications where id = p_id and sent_at is null for update skip locked;
  if v_n.id is null then return; end if;

  select count(*) into v_unread from public.notifications where user_id = v_n.user_id and read_at is null;

  select jsonb_agg(jsonb_build_object(
           'to', t.token,
           'title', v_n.title,
           'body', coalesce(v_n.body, ''),
           'data', v_n.data || jsonb_build_object('notification_id', v_n.id, 'kind', v_n.kind),
           'sound', 'default',
           'priority', 'high',
           'channelId', 'leads',
           'badge', v_unread))
    into v_messages
  from public.push_tokens t where t.user_id = v_n.user_id;

  if v_messages is null then
    update public.notifications set sent_at = now(), push_status = 'no_device' where id = p_id;
    return;
  end if;

  if to_regproc('net.http_post') is null then
    update public.notifications set sent_at = now(), push_status = 'no_push_service' where id = p_id;
    return;
  end if;

  perform net.http_post(
    url     := 'https://exp.host/--/api/v2/push/send',
    body    := v_messages,
    headers := '{"Content-Type": "application/json", "Accept": "application/json"}'::jsonb
  );
  update public.notifications set sent_at = now(), push_status = 'sent' where id = p_id;
end;
$$;

-- Save a notification and push it (now, or when quiet hours end).
--   p_urgent: ignore quiet hours. Returns the id, or null when skipped.
create or replace function public.notify(
  p_user   uuid,
  p_kind   text,
  p_title  text,
  p_body   text default null,
  p_data   jsonb default '{}'::jsonb,
  p_dedupe text default null,
  p_urgent boolean default false
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_setting jsonb := public.notification_setting();
  v_after   timestamptz;
  v_id      uuid;
begin
  if p_user is null then return null; end if;
  if not coalesce((v_setting -> 'kinds' ->> p_kind)::boolean, true) then return null; end if;
  if not exists (select 1 from public.profiles where id = p_user and is_active) then return null; end if;
  if exists (select 1 from public.notification_prefs where user_id = p_user and p_kind = any (muted)) then
    return null;
  end if;

  v_after := case when p_urgent then null else public.quiet_until() end;

  insert into public.notifications (user_id, kind, title, body, data, dedupe, deliver_after)
  values (p_user, p_kind, left(p_title, 120), left(p_body, 400), coalesce(p_data, '{}'::jsonb), p_dedupe,
          coalesce(v_after, now()))
  on conflict (user_id, dedupe) where dedupe is not null do nothing
  returning id into v_id;

  if v_id is not null and v_after is null then
    perform public.push_notification(v_id);
  end if;
  return v_id;
end;
$$;

-- People who look after everything (admins) and a person's Team Lead
create or replace function public.admin_ids()
returns setof uuid
language sql
stable
security definer
set search_path = public
as $$
  select p.id from public.profiles p
  join public.roles r on r.key = p.role_key
  where p.is_active and ('*' = any (r.permissions) or 'leads.view_all' = any (r.permissions));
$$;

create or replace function public.person_name(p_user uuid)
returns text
language sql
stable
security definer
set search_path = public
as $$
  select coalesce((select nullif(trim(full_name), '') from public.profiles where id = p_user), 'Someone');
$$;

-- ---------------------------------------------------------------------
-- 5. Hand over: give leads to someone, with an optional note
--    Setting (Settings → Lead assignment → Hand over):
--      anyone   - any active user (default)
--      team     - only my team (same Team Lead), or my Team Lead
--      managers - only Team Leads and admins
--      off      - only people who may assign (the old rule)
-- ---------------------------------------------------------------------
create or replace function public.can_hand_over_to(p_target uuid)
returns boolean
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_rule text := coalesce(public.assignment_setting() ->> 'handover', 'anyone');
  v_me   public.profiles;
  v_t    public.profiles;
begin
  if p_target is null then return false; end if;
  if public.can_assign_to(p_target) then return true; end if;

  select * into v_me from public.profiles where id = auth.uid();
  select * into v_t  from public.profiles where id = p_target;
  if v_t.id is null or not v_t.is_active or not public.is_active_user() then return false; end if;

  return case v_rule
    when 'anyone'   then true
    when 'team'     then (v_t.team_lead_id is not distinct from v_me.team_lead_id and v_me.team_lead_id is not null)
                         or v_t.id = v_me.team_lead_id
                         or v_t.team_lead_id = v_me.id
    when 'managers' then v_t.role_key in ('team_lead', 'admin', 'super_admin')
    else false
  end;
end;
$$;

grant execute on function public.can_hand_over_to(uuid) to authenticated;

-- The two guards on leads let a hand over through (set by hand_over_leads only)
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

  -- A hand over (checked in hand_over_leads)
  if coalesce(current_setting('app.handover', true), '') = 'on' then
    new.assignment_method := 'manual';
    return new;
  end if;

  if not public.can_assign_to(new.assigned_to) then
    raise exception 'You cannot assign leads to this person.';
  end if;

  new.assignment_method := 'manual';
  return new;
end;
$$;

create or replace function public.leads_before_write()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  new.name           := trim(new.name);
  new.phone          := public.normalize_bd_phone(new.phone);
  new.alt_phone      := public.normalize_bd_phone(new.alt_phone);
  new.guardian_phone := public.normalize_bd_phone(new.guardian_phone);
  new.email          := nullif(lower(trim(new.email)), '');

  if new.name = '' then
    raise exception 'Lead name is required';
  end if;
  if new.phone is null then
    raise exception 'A phone number is required';
  end if;

  if tg_op = 'INSERT' then
    new.created_by := coalesce(new.created_by, auth.uid());

    if new.stage_id is null then
      select id into new.stage_id from public.pipeline_stages where key = 'new';
    end if;

    -- Without the assign permission, a new lead is always your own
    if not public.has_permission('leads.assign') then
      new.assigned_to := auth.uid();
    end if;

  else -- UPDATE
    -- The first source never changes (keeps reports honest)
    if old.source_id is not null
       and new.source_id is distinct from old.source_id
       and not public.has_permission('leads.edit_all') then
      raise exception 'The original source of a lead cannot be changed';
    end if;

    if new.assigned_to is distinct from old.assigned_to
       and not public.has_permission('leads.assign')
       and coalesce(current_setting('app.handover', true), '') <> 'on' then
      raise exception 'You are not allowed to reassign leads';
    end if;

    if new.deleted_at is distinct from old.deleted_at
       and not public.has_permission('leads.delete') then
      raise exception 'You are not allowed to delete leads';
    end if;

    new.created_by := old.created_by;
    new.created_at := old.created_at;
  end if;

  return new;
end;
$$;

-- Give leads to a person. Leads I can't edit, or already theirs, are skipped.
-- Returns {"done": n, "skipped": n}
create or replace function public.hand_over_leads(p_lead_ids uuid[], p_to uuid, p_note text default null)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_note text := nullif(trim(coalesce(p_note, '')), '');
  v_ids  uuid[];
  v_done int;
begin
  if not public.is_active_user() then raise exception 'Your account is not active.'; end if;
  if not public.can_hand_over_to(p_to) then raise exception 'You cannot give leads to this person.'; end if;

  -- Leads I may work on (same rules as editing a lead)
  select array_agg(l.id) into v_ids
  from public.leads l
  where l.id = any (coalesce(p_lead_ids, '{}'::uuid[]))
    and l.deleted_at is null
    and l.assigned_to is distinct from p_to
    and (public.can_edit_lead(l.assigned_to) or public.leads_shared_mode() or l.created_by = auth.uid());

  if v_ids is null then
    return jsonb_build_object('done', 0, 'skipped', coalesce(array_length(p_lead_ids, 1), 0));
  end if;

  perform set_config('app.handover', 'on', true);
  perform set_config('app.handover_note', coalesce(v_note, ''), true);
  update public.leads set assigned_to = p_to where id = any (v_ids);
  get diagnostics v_done = row_count;
  perform set_config('app.handover', '', true);
  perform set_config('app.handover_note', '', true);

  return jsonb_build_object('done', v_done, 'skipped', coalesce(array_length(p_lead_ids, 1), 0) - v_done);
end;
$$;

grant execute on function public.hand_over_leads(uuid[], uuid, text) to authenticated;

-- The note goes into the "Assigned" timeline line
create or replace function public.add_handover_note()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_note text := nullif(current_setting('app.handover_note', true), '');
begin
  if new.action = 'assigned' and v_note is not null then
    new.details := new.details || jsonb_build_object('note', v_note);
  end if;
  return new;
end;
$$;

drop trigger if exists lead_activity_handover_note on public.lead_activity;
create trigger lead_activity_handover_note
  before insert on public.lead_activity
  for each row execute function public.add_handover_note();

-- ---------------------------------------------------------------------
-- 6. Events
-- ---------------------------------------------------------------------
-- 6a. Leads given to someone (one notification per person, however many leads)
--     p_rows: the leads that changed hands ({id, name, phone, assigned_to, auto})
create or replace function public.notify_assigned(p_rows jsonb)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  r        record;
  v_who    text := public.person_name(auth.uid());
  v_note   text := nullif(current_setting('app.handover_note', true), '');
  v_urgent boolean := coalesce((public.notification_setting() ->> 'assigned_in_quiet_hours')::boolean, true);
begin
  for r in
    select x.assigned_to as user_id, array_agg(x.id) as ids, min(x.name) as first_name,
           min(x.phone) as first_phone, count(*) as n, bool_and(x.auto) as auto
    from jsonb_to_recordset(coalesce(p_rows, '[]'::jsonb))
         as x(id uuid, name text, phone text, assigned_to uuid, auto boolean)
    group by x.assigned_to
  loop
    perform public.notify(
      r.user_id,
      case when r.auto then 'auto_assigned' else 'assigned' end,
      case
        when r.n = 1 then '👥 ' || case when r.auto then 'A new lead for you' else v_who || ' gave you a lead' end
        else '👥 ' || case when r.auto then r.n || ' new leads for you' else v_who || ' gave you ' || r.n || ' leads' end
      end,
      concat_ws(E'\n',
        case when r.n = 1 then r.first_name || ' · ' || r.first_phone else 'Tap to see them.' end,
        case when v_note is not null then '“' || v_note || '”' end),
      case when r.n = 1 then jsonb_build_object('lead_id', r.ids[1]) else jsonb_build_object('lead_ids', to_jsonb(r.ids)) end,
      null,
      v_urgent and not r.auto
    );
  end loop;
end;
$$;

-- New leads given to someone else (by hand, import or auto-assignment)
create or replace function public.notify_lead_inserts()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  perform public.notify_assigned((
    select jsonb_agg(jsonb_build_object('id', n.id, 'name', n.name, 'phone', n.phone,
                                        'assigned_to', n.assigned_to, 'auto', n.assignment_method = 'auto'))
    from new_rows n
    where n.assigned_to is not null and n.deleted_at is null
      and n.assigned_to is distinct from auth.uid()
  ));
  return null;
end;
$$;

-- Leads given to someone else; admitted / lost (→ admins and the Team Lead)
create or replace function public.notify_lead_updates()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  r       record;
  v_actor uuid := auth.uid();
  v_who   text := public.person_name(auth.uid());
begin
  perform public.notify_assigned((
    select jsonb_agg(jsonb_build_object('id', n.id, 'name', n.name, 'phone', n.phone,
                                        'assigned_to', n.assigned_to, 'auto', false))
    from new_rows n
    join old_rows o on o.id = n.id
    where n.assigned_to is not null and n.deleted_at is null
      and n.assigned_to is distinct from o.assigned_to
      and n.assigned_to is distinct from v_actor
  ));

  for r in
    select x.user_id, array_agg(x.id) as ids, min(x.name) as first_name, count(*) as n, x.kind
    from (
      select n.id, n.name, s.kind, a.uid as user_id
      from new_rows n
      join old_rows o on o.id = n.id
      join public.pipeline_stages s on s.id = n.stage_id
      join public.pipeline_stages so on so.id = o.stage_id
      cross join lateral (
        select public.admin_ids() as uid
        union
        select p.team_lead_id from public.profiles p where p.id = n.assigned_to and p.team_lead_id is not null
      ) a
      where s.kind in ('won', 'lost') and so.kind <> s.kind
    ) x
    where x.user_id is distinct from v_actor
    group by x.user_id, x.kind
  loop
    perform public.notify(
      r.user_id, 'outcome',
      case
        when r.kind = 'won' then '🎓 ' || case when r.n = 1 then r.first_name || ' admitted' else r.n || ' admitted' end
        else '✕ ' || case when r.n = 1 then r.first_name || ' lost' else r.n || ' leads lost' end
      end,
      'By ' || v_who,
      case when r.n = 1 then jsonb_build_object('lead_id', r.ids[1]) else jsonb_build_object('lead_ids', to_jsonb(r.ids)) end
    );
  end loop;

  return null;
end;
$$;

drop trigger if exists leads_notify_update on public.leads;
create trigger leads_notify_update
  after update on public.leads
  referencing old table as old_rows new table as new_rows
  for each statement execute function public.notify_lead_updates();

drop trigger if exists leads_notify_insert on public.leads;
create trigger leads_notify_insert
  after insert on public.leads
  referencing new table as new_rows
  for each statement execute function public.notify_lead_inserts();

-- 6b. Someone signed up and waits for approval → admins who manage users
create or replace function public.notify_signup()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_admin uuid;
begin
  if new.is_active then return null; end if;
  for v_admin in
    select p.id from public.profiles p join public.roles r on r.key = p.role_key
    where p.is_active and ('*' = any (r.permissions) or 'users.manage' = any (r.permissions))
  loop
    perform public.notify(v_admin, 'signup', '🙋 ' || coalesce(nullif(trim(new.full_name), ''), new.email, 'Someone') || ' signed up',
                          'Approve or decline in Users.', jsonb_build_object('route', '/users'), 'signup:' || new.id);
  end loop;
  return null;
end;
$$;

drop trigger if exists profiles_notify_signup on public.profiles;
create trigger profiles_notify_signup
  after insert on public.profiles
  for each row execute function public.notify_signup();

-- 6c. "Turn on call sync" reminder
create or replace function public.notify_sync_nudge()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  perform public.notify(new.user_id, 'sync_nudge', '📞 Please turn on call log sync',
                        coalesce(new.message, 'Your lead calls will be saved automatically.'),
                        jsonb_build_object('route', '/call-sync'), 'nudge:' || new.id);
  return null;
end;
$$;

drop trigger if exists app_nudges_notify on public.app_nudges;
create trigger app_nudges_notify
  after insert on public.app_nudges
  for each row execute function public.notify_sync_nudge();

-- 6d. A lead called and wasn't answered (from a phone's call log) → the lead's person
create or replace function public.notify_missed_call()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_lead public.leads;
begin
  if new.direction not in ('missed', 'rejected') then return null; end if;
  select * into v_lead from public.leads where id = new.lead_id and deleted_at is null;
  -- The phone that missed it already shows its own alert
  if v_lead.assigned_to is null or v_lead.assigned_to = new.user_id then return null; end if;
  perform public.notify(v_lead.assigned_to, 'missed_call', '📵 Missed call from ' || v_lead.name,
                        v_lead.phone || ' called ' || public.person_name(new.user_id) || '. Call back?',
                        jsonb_build_object('lead_id', v_lead.id), 'missed:' || new.id);
  return null;
end;
$$;

drop trigger if exists call_logs_notify_missed on public.call_logs;
create trigger call_logs_notify_missed
  after insert on public.call_logs
  for each row execute function public.notify_missed_call();

-- ---------------------------------------------------------------------
-- 7. Every minute (pg_cron): reminders, escalations, held-back pushes
-- ---------------------------------------------------------------------
create or replace function public.notifications_tick()
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  r          record;
  v_early    int := public.setting_int('early_reminder_minutes', 10);
  v_repeat   int := public.setting_int('repeat_reminder_minutes', 15);
  v_speed    int := public.setting_int('speed_to_lead_minutes', 15);
  v_tl_h     int := public.setting_int('escalate_team_lead_hours', 4);
  v_admin_h  int := public.setting_int('escalate_admin_hours', 24);
  v_today    date := (now() at time zone 'Asia/Dhaka')::date;
begin
  -- a. Pushes held back by quiet hours
  for r in
    select id from public.notifications
    where sent_at is null and deliver_after <= now()
    order by deliver_after limit 500
  loop
    perform public.push_notification(r.id);
  end loop;

  -- b. Next call soon, and once more if it is late
  for r in
    select f.id, f.due_at, f.note, l.id as lead_id, l.name, l.phone, coalesce(l.assigned_to, f.created_by) as user_id
    from public.follow_ups f
    join public.leads l on l.id = f.lead_id and l.deleted_at is null
    where f.status = 'pending'
      and f.due_at between now() - make_interval(mins => v_repeat) - interval '1 day'
                       and now() + make_interval(mins => v_early)
  loop
    if r.due_at > now() then
      perform public.notify(r.user_id, 'follow_up', '⏰ Call ' || r.name || ' at ' || to_char(r.due_at at time zone 'Asia/Dhaka', 'HH12:MI AM'),
                            concat_ws(' · ', r.phone, r.note), jsonb_build_object('lead_id', r.lead_id), 'fu:' || r.id);
    elsif r.due_at <= now() - make_interval(mins => v_repeat) then
      perform public.notify(r.user_id, 'follow_up', '⚠ Call ' || r.name || ' is late',
                            concat_ws(' · ', r.phone, 'was due ' || to_char(r.due_at at time zone 'Asia/Dhaka', 'HH12:MI AM'), r.note),
                            jsonb_build_object('lead_id', r.lead_id), 'fu-late:' || r.id);
    end if;
  end loop;

  -- c1. Campus visits today (one message per person, from 9 am)
  if (now() at time zone 'Asia/Dhaka')::time >= '09:00' then
    for r in
      select l.assigned_to as user_id, count(*) as n, array_agg(l.id) as ids, min(l.name) as first_name
      from public.lead_visits v
      join public.leads l on l.id = v.lead_id and l.deleted_at is null
      where v.status = 'planned' and l.assigned_to is not null
        and (v.planned_at at time zone 'Asia/Dhaka')::date = v_today
      group by l.assigned_to
    loop
      perform public.notify(r.user_id, 'visit',
        '🏫 ' || case when r.n = 1 then r.first_name || ' visits today' else r.n || ' campus visits today' end,
        'See Home for the times.',
        case when r.n = 1 then jsonb_build_object('lead_id', r.ids[1]) else jsonb_build_object('route', '/') end,
        'visit-day:' || v_today);
    end loop;
  end if;

  -- c2. A visit in the next hour
  for r in
    select v.id, v.planned_at, l.id as lead_id, l.name, l.phone, l.assigned_to as user_id
    from public.lead_visits v
    join public.leads l on l.id = v.lead_id and l.deleted_at is null
    where v.status = 'planned' and l.assigned_to is not null
      and v.planned_at between now() and now() + interval '1 hour'
  loop
    perform public.notify(r.user_id, 'visit', '🏫 ' || r.name || ' visits at ' || to_char(r.planned_at at time zone 'Asia/Dhaka', 'HH12:MI AM'),
                          r.phone, jsonb_build_object('lead_id', r.lead_id), 'visit-1h:' || r.id);
  end loop;

  -- d. New leads not called yet: the person, then the Team Lead, then admins
  --    (one message per person per step; each lead counted once per step)
  for r in
    with fresh as (
      select l.id, l.name, l.created_at, l.assigned_to
      from public.leads l
      join public.pipeline_stages s on s.id = l.stage_id and s.kind = 'open'
      where l.deleted_at is null and l.assigned_to is not null
        and l.last_contacted_at is null
        and not exists (select 1 from public.call_logs c where c.lead_id = l.id)
        and l.created_at > now() - interval '3 days'
    ),
    steps as (
      select f.id, f.name, f.assigned_to as user_id, 'stl' as step
      from fresh f where f.created_at <= now() - make_interval(mins => v_speed)
      union all
      select f.id, f.name, p.team_lead_id, 'stl-tl'
      from fresh f join public.profiles p on p.id = f.assigned_to
      where p.team_lead_id is not null and f.created_at <= now() - make_interval(hours => v_tl_h)
      union all
      select f.id, f.name, a.uid, 'stl-ad'
      from fresh f cross join lateral (select public.admin_ids() as uid) a
      where f.created_at <= now() - make_interval(hours => v_admin_h) and a.uid <> f.assigned_to
    ),
    todo as (
      select s.* from steps s
      where not exists (
        select 1 from public.notifications n
        where n.user_id = s.user_id and n.kind = 'speed_to_lead'
          and n.data -> 'lead_ids' ? s.id::text and n.data ->> 'step' = s.step
      )
    )
    select user_id, step, array_agg(id) as ids, min(name) as first_name, count(*) as n
    from todo group by user_id, step
  loop
    perform public.notify(r.user_id, 'speed_to_lead',
      case r.step
        when 'stl' then '⚡ ' || case when r.n = 1 then r.first_name || ' is waiting for a call' else r.n || ' new leads are waiting for a call' end
        when 'stl-tl' then '⚡ Team: ' || r.n || ' new ' || case when r.n = 1 then 'lead' else 'leads' end || ' not called for ' || v_tl_h || ' h'
        else '⚡ ' || r.n || ' new ' || case when r.n = 1 then 'lead' else 'leads' end || ' not called for ' || v_admin_h || ' h'
      end,
      'Tap to see them.',
      jsonb_build_object('lead_ids', to_jsonb(r.ids), 'step', r.step));
  end loop;

  -- e. Old notifications go after 60 days
  delete from public.notifications where created_at < now() - interval '60 days';
end;
$$;

-- Run it every minute when pg_cron is there
do $$
begin
  if exists (select 1 from pg_extension where extname = 'pg_cron') then
    perform cron.unschedule(jobid) from cron.job where jobname = 'lead-notifications';
    perform cron.schedule('lead-notifications', '* * * * *', 'select public.notifications_tick()');
  end if;
exception when others then
  raise notice 'Could not schedule notifications_tick(): %', sqlerrm;
end;
$$;

notify pgrst, 'reload schema';
