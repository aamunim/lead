-- =====================================================================
-- 🔔 Push health: why a phone gets no notifications
--   * each phone tells us: notifications allowed? the "Leads" channel on?
--     (also when it has no push token)
--   * what Expo answered: the ticket on sending, the receipt ~15 min later;
--     errors are kept on the token, dead tokens (DeviceNotRegistered) removed
--   * a test push to yourself
--   * push_health(): one line per person for admins
-- =====================================================================

-- Each phone's state, last reported by the app
create table if not exists public.push_devices (
  user_id     uuid not null references public.profiles (id) on delete cascade,
  device_id   text not null,
  device_label text,
  platform    text,
  app_version text,
  permission  text,            -- granted / denied / undetermined
  channel_on  boolean,         -- Android: the "Leads" channel is not switched off
  has_token   boolean not null default false,
  token_error text,            -- why the app could not get a token
  checked_at  timestamptz not null default now(),
  primary key (user_id, device_id)
);
alter table public.push_devices enable row level security;  -- only through the functions below

alter table public.push_tokens
  add column if not exists last_ok_at    timestamptz,
  add column if not exists last_error    text,
  add column if not exists last_error_at timestamptz,
  add column if not exists errors        int not null default 0;

alter table public.notifications
  add column if not exists push_request_id bigint,
  add column if not exists push_to         text[],
  add column if not exists push_error      text;

create index if not exists notifications_push_check_idx
  on public.notifications (push_request_id) where push_request_id is not null and push_status = 'sent';

-- One Expo ticket per phone and push; its receipt is asked for later
create table if not exists public.push_tickets (
  ticket_id       text primary key,
  notification_id uuid references public.notifications (id) on delete cascade,
  token           text,
  user_id         uuid,
  created_at      timestamptz not null default now(),
  receipt_request bigint,
  status          text,       -- ok / error
  error           text,
  checked_at      timestamptz
);
create index if not exists push_tickets_open_idx on public.push_tickets (created_at) where checked_at is null;
alter table public.push_tickets enable row level security;

-- ---------------------------------------------------------------------
-- The phone checks in: its state, and its token when it has one
-- ---------------------------------------------------------------------
create or replace function public.push_check_in(
  p_device_id    text,
  p_permission   text,
  p_channel_on   boolean default null,
  p_token        text default null,
  p_platform     text default null,
  p_app_version  text default null,
  p_device_label text default null,
  p_token_error  text default null
)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_token text := nullif(trim(coalesce(p_token, '')), '');
begin
  if auth.uid() is null or nullif(trim(coalesce(p_device_id, '')), '') is null then return; end if;

  insert into public.push_devices (user_id, device_id, device_label, platform, app_version, permission, channel_on,
                                   has_token, token_error, checked_at)
  values (auth.uid(), p_device_id, p_device_label, p_platform, p_app_version, p_permission, p_channel_on,
          v_token is not null, left(p_token_error, 300), now())
  on conflict (user_id, device_id) do update set
    device_label = excluded.device_label, platform = excluded.platform, app_version = excluded.app_version,
    permission = excluded.permission, channel_on = excluded.channel_on, has_token = excluded.has_token,
    token_error = excluded.token_error, checked_at = now();

  -- This phone now belongs to this person (someone else signed in on it before)
  delete from public.push_devices where device_id = p_device_id and user_id <> auth.uid();

  if v_token is not null then
    insert into public.push_tokens (token, user_id, device_id, platform, updated_at)
    values (v_token, auth.uid(), p_device_id, p_platform, now())
    on conflict (token) do update
       set user_id = excluded.user_id, device_id = excluded.device_id,
           platform = excluded.platform, updated_at = now();
    -- An older token of the same phone is dead now
    delete from public.push_tokens where device_id = p_device_id and token <> v_token;
  end if;
end;
$$;

revoke all on function public.push_check_in(text, text, boolean, text, text, text, text, text) from public;
grant execute on function public.push_check_in(text, text, boolean, text, text, text, text, text) to authenticated;

-- ---------------------------------------------------------------------
-- push_notification: keep the Expo request id and the tokens it went to
-- ---------------------------------------------------------------------
create or replace function public.push_notification(p_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_n        public.notifications;
  v_messages jsonb;
  v_tokens   text[];
  v_unread   int;
  v_req      bigint;
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
           'badge', v_unread) order by t.token),
         array_agg(t.token order by t.token)
    into v_messages, v_tokens
  from public.push_tokens t where t.user_id = v_n.user_id;

  if v_messages is null then
    update public.notifications set sent_at = now(), push_status = 'no_device' where id = p_id;
    return;
  end if;

  if to_regproc('net.http_post') is null then
    update public.notifications set sent_at = now(), push_status = 'no_push_service' where id = p_id;
    return;
  end if;

  select net.http_post(
    url     := 'https://exp.host/--/api/v2/push/send',
    body    := v_messages,
    headers := '{"Content-Type": "application/json", "Accept": "application/json"}'::jsonb
  ) into v_req;
  update public.notifications
     set sent_at = now(), push_status = 'sent', push_request_id = v_req, push_to = v_tokens
   where id = p_id;
end;
$$;

-- ---------------------------------------------------------------------
-- What Expo answered (run every minute with the notifications)
--   1. the send answer: one ticket per token, in the order sent
--   2. after 15 minutes: ask for the receipts of the ok tickets
--   3. the receipts: delivered to Google / Apple, or why not
-- ---------------------------------------------------------------------
create or replace function public.push_mark_token(p_token text, p_error text)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if p_error is null then
    update public.push_tokens set last_ok_at = now(), errors = 0 where token = p_token;
  elsif p_error = 'DeviceNotRegistered' then
    -- the app was removed or the token is old: it will never work again
    delete from public.push_tokens where token = p_token;
  else
    update public.push_tokens
       set last_error = left(p_error, 200), last_error_at = now(), errors = errors + 1
     where token = p_token;
  end if;
end;
$$;

create or replace function public.push_followup()
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  r       record;
  x       record;
  t       jsonb;
  i       int;
  v_body  jsonb;
  v_err   text;
  v_bad   int;
  v_ids   text[];
  v_req   bigint;
begin
  if to_regclass('net._http_response') is null then return; end if;

  -- 1. The send answers
  for r in execute $q$
    select n.id, n.user_id, n.push_to, h.status_code, h.content, h.timed_out, h.error_msg
    from public.notifications n
    join net._http_response h on h.id = n.push_request_id
    where n.push_status = 'sent' and n.push_request_id is not null and n.sent_at > now() - interval '6 hours'
    limit 500
  $q$
  loop
    v_bad := 0;
    v_err := null;
    begin
      v_body := r.content::jsonb;
    exception when others then
      v_body := null;
    end;
    if r.timed_out or r.status_code is null or r.status_code >= 400 or v_body is null then
      v_err := coalesce(r.error_msg, 'HTTP ' || coalesce(r.status_code::text, '?'))
               || coalesce(': ' || left(v_body #>> '{errors,0,message}', 150), '');
      update public.notifications set push_status = 'failed', push_error = left(v_err, 300) where id = r.id;
      continue;
    end if;
    i := 0;
    for t in select * from jsonb_array_elements(coalesce(v_body -> 'data', '[]'::jsonb)) loop
      i := i + 1;
      if t ->> 'status' = 'ok' then
        insert into public.push_tickets (ticket_id, notification_id, token, user_id)
        values (t ->> 'id', r.id, r.push_to[i], r.user_id)
        on conflict do nothing;
      else
        v_bad := v_bad + 1;
        v_err := coalesce(t #>> '{details,error}', t ->> 'message', 'error');
        perform public.push_mark_token(r.push_to[i], v_err);
      end if;
    end loop;
    update public.notifications
       set push_status = case when v_bad = 0 then 'accepted' when v_bad < i then 'partly' else 'failed' end,
           push_error = left(v_err, 300)
     where id = r.id;
  end loop;

  -- 2. Ask for receipts (Expo keeps them for a day; Google needs a few minutes)
  select array_agg(ticket_id) into v_ids
  from (select ticket_id from public.push_tickets
        where receipt_request is null and checked_at is null and created_at < now() - interval '15 minutes'
        order by created_at limit 900) x;
  if v_ids is not null and to_regproc('net.http_post') is not null then
    select net.http_post(
      url     := 'https://exp.host/--/api/v2/push/getReceipts',
      body    := jsonb_build_object('ids', to_jsonb(v_ids)),
      headers := '{"Content-Type": "application/json", "Accept": "application/json"}'::jsonb
    ) into v_req;
    update public.push_tickets set receipt_request = v_req where ticket_id = any (v_ids);
  end if;

  -- 3. The receipts
  for r in execute $q$
    select distinct p.receipt_request as req, h.content, h.status_code
    from public.push_tickets p
    join net._http_response h on h.id = p.receipt_request
    where p.checked_at is null and p.receipt_request is not null
  $q$
  loop
    begin
      v_body := r.content::jsonb -> 'data';
    exception when others then
      v_body := null;
    end;
    for x in
      select p.ticket_id, p.token, p.notification_id, v_body -> p.ticket_id as receipt
      from public.push_tickets p where p.receipt_request = r.req and p.checked_at is null
    loop
      if x.receipt is null then
        -- not ready yet / lost: ask again next time (older than a day: give up)
        update public.push_tickets
           set receipt_request = null,
               checked_at = case when created_at < now() - interval '1 day' then now() end,
               status = case when created_at < now() - interval '1 day' then 'unknown' end
         where ticket_id = x.ticket_id;
      elsif x.receipt ->> 'status' = 'ok' then
        update public.push_tickets set status = 'ok', checked_at = now() where ticket_id = x.ticket_id;
        perform public.push_mark_token(x.token, null);
        update public.notifications set push_status = 'delivered'
         where id = x.notification_id and push_status = 'accepted';
      else
        v_err := coalesce(x.receipt #>> '{details,error}', x.receipt ->> 'message', 'error');
        update public.push_tickets set status = 'error', error = left(v_err, 200), checked_at = now()
         where ticket_id = x.ticket_id;
        perform public.push_mark_token(x.token, v_err);
        update public.notifications set push_status = 'failed', push_error = left(v_err, 300)
         where id = x.notification_id and push_status in ('accepted', 'partly');
      end if;
    end loop;
  end loop;

  delete from public.push_tickets where created_at < now() - interval '14 days';
end;
$$;

revoke all on function public.push_followup() from public;
revoke all on function public.push_mark_token(text, text) from public;

-- Every minute, after the notifications
do $$
begin
  if to_regnamespace('cron') is not null then
    perform cron.schedule('push-followup', '* * * * *', 'select public.push_followup()');
  end if;
exception when others then
  null;
end;
$$;

-- ---------------------------------------------------------------------
-- 🔔 A test push to yourself (right now, also in quiet hours)
-- ---------------------------------------------------------------------
create or replace function public.send_test_push()
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_id     uuid;
  v_tokens int;
begin
  if auth.uid() is null then raise exception 'Please sign in.'; end if;
  select count(*) into v_tokens from public.push_tokens where user_id = auth.uid();
  insert into public.notifications (user_id, kind, title, body, data)
  values (auth.uid(), 'test', '🔔 Test notification', 'Notifications work on this phone. 👍', '{}')
  returning id into v_id;
  perform public.push_notification(v_id);
  return jsonb_build_object('id', v_id, 'phones', v_tokens);
end;
$$;

grant execute on function public.send_test_push() to authenticated;

-- My own phones and their last result (the Notification check screen)
create or replace function public.my_push_status()
returns jsonb
language sql
stable
security definer
set search_path = public
as $$
  select jsonb_build_object(
    'tokens', (select count(*) from public.push_tokens where user_id = auth.uid()),
    'last_ok_at', (select max(last_ok_at) from public.push_tokens where user_id = auth.uid()),
    'last_error', (select last_error from public.push_tokens where user_id = auth.uid()
                   order by last_error_at desc nulls last limit 1),
    'last_test', (select jsonb_build_object('status', push_status, 'error', push_error, 'at', created_at)
                  from public.notifications where user_id = auth.uid() and kind = 'test'
                  order by created_at desc limit 1)
  );
$$;

grant execute on function public.my_push_status() to authenticated;

-- ---------------------------------------------------------------------
-- 🩺 Admins: one line per person
-- ---------------------------------------------------------------------
create or replace function public.push_health()
returns table (
  user_id uuid, full_name text, role_name text,
  tokens int, devices jsonb,
  last_push_at timestamptz, last_status text, last_error text,
  sent_7d int, ok_7d int, failed_7d int, no_device_7d int,
  last_ok_at timestamptz, app_last_open timestamptz
)
language plpgsql
stable
security definer
set search_path = public
as $$
begin
  if not (public.has_permission('settings.manage') or public.has_permission('users.manage')) then
    raise exception 'Only an admin can see this.';
  end if;
  return query
  select p.id, p.full_name, r.name,
    (select count(*)::int from public.push_tokens t where t.user_id = p.id),
    coalesce((select jsonb_agg(jsonb_build_object(
                'device', d.device_label, 'platform', d.platform, 'app', d.app_version,
                'permission', d.permission, 'channel_on', d.channel_on, 'has_token', d.has_token,
                'token_error', d.token_error, 'checked_at', d.checked_at) order by d.checked_at desc)
              from public.push_devices d where d.user_id = p.id), '[]'::jsonb),
    ln.created_at, ln.push_status, coalesce(ln.push_error,
      (select t.last_error from public.push_tokens t where t.user_id = p.id order by t.last_error_at desc nulls last limit 1)),
    (select count(*)::int from public.notifications n where n.user_id = p.id and n.created_at > now() - interval '7 days'),
    (select count(*)::int from public.notifications n where n.user_id = p.id and n.created_at > now() - interval '7 days'
       and n.push_status in ('accepted', 'delivered', 'sent')),
    (select count(*)::int from public.notifications n where n.user_id = p.id and n.created_at > now() - interval '7 days'
       and n.push_status in ('failed', 'partly')),
    (select count(*)::int from public.notifications n where n.user_id = p.id and n.created_at > now() - interval '7 days'
       and n.push_status = 'no_device'),
    (select max(t.last_ok_at) from public.push_tokens t where t.user_id = p.id),
    (select max(s.last_seen_at) from public.app_sessions s where s.user_id = p.id)
  from public.profiles p
  left join public.roles r on r.key = p.role_key
  left join lateral (
    select n.created_at, n.push_status, n.push_error from public.notifications n
    where n.user_id = p.id order by n.created_at desc limit 1
  ) ln on true
  where p.is_active
  order by r.name nulls last, p.full_name;
end;
$$;

revoke all on function public.push_health() from public;
grant execute on function public.push_health() to authenticated;
