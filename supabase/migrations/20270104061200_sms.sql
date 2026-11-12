-- =====================================================================
-- 📨 SMS: your own SMS company (API), sender IDs, bulk SMS to alumni
--   • Settings → SMS: one or more SMS companies (send address with
--     {api_key} {sender_id} {number} {message}, the API key, the balance
--     address); one is "in use". Sender IDs: masking / non-masking, each
--     on or off, one default of each.
--   • The API key never leaves the server (the app sees "abc…wxyz").
--   • Alumni: pick people (or "all that match"), write the SMS, send.
--     The messages wait in a queue; every minute up to N go out (pg_net),
--     and the company's answer marks each one Sent / Failed.
--   • Who got it / who didn't: per send, and on each alumnus (filters).
-- =====================================================================

-- ---------------------------------------------------------------------
-- 1. The SMS companies (only the server reads these rows)
-- ---------------------------------------------------------------------
create table if not exists public.sms_providers (
  id            uuid primary key default gen_random_uuid(),
  name          text not null,
  send_url      text not null,
  method        text not null default 'GET' check (method in ('GET', 'POST')),
  balance_url   text,
  api_key       text,
  -- how the number is written: 01XXXXXXXXX / 8801XXXXXXXXX / +8801XXXXXXXXX
  number_format text not null default '0' check (number_format in ('0', '880', '+880')),
  -- the answer means "sent" when it matches this (empty: any 2xx answer)
  success_match text,
  is_active     boolean not null default false,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  updated_by    uuid references public.profiles (id) on delete set null
);
create unique index if not exists sms_providers_one_active on public.sms_providers ((true)) where is_active;
alter table public.sms_providers enable row level security;   -- no policies
revoke all on public.sms_providers from anon, authenticated;

create table if not exists public.sms_senders (
  id          uuid primary key default gen_random_uuid(),
  provider_id uuid not null references public.sms_providers (id) on delete cascade,
  sender_id   text not null,
  kind        text not null check (kind in ('masking', 'non_masking')),
  label       text,
  is_active   boolean not null default true,
  is_default  boolean not null default false,
  created_at  timestamptz not null default now()
);
create unique index if not exists sms_senders_one_default
  on public.sms_senders (provider_id, kind) where is_default;
alter table public.sms_senders enable row level security;     -- read through the functions
revoke all on public.sms_senders from anon, authenticated;

-- Bulk SMS Dhaka, ready to fill in (off until a key is saved and it is put in use)
insert into public.sms_providers (name, send_url, method, balance_url, number_format)
select 'Bulk SMS Dhaka',
       'https://bulksmsdhaka.com/api/sendtext?apikey={api_key}&callerID={sender_id}&number={number}&message={message}',
       'GET',
       'https://bulksmsdhaka.com/api/getBalance?apikey={api_key}',
       '0'
where not exists (select 1 from public.sms_providers);

-- ---------------------------------------------------------------------
-- 2. A send (one message to many) and each SMS
-- ---------------------------------------------------------------------
create table if not exists public.sms_batches (
  id           uuid primary key default gen_random_uuid(),
  audience     text not null default 'alumni' check (audience in ('alumni', 'test')),
  name         text,
  message      text not null,
  sender_id    uuid references public.sms_senders (id) on delete set null,
  sender_text  text,
  sender_kind  text,
  provider_id  uuid references public.sms_providers (id) on delete set null,
  total        int not null default 0,
  status       text not null default 'sending' check (status in ('sending', 'done', 'cancelled')),
  created_by   uuid references public.profiles (id) on delete set null,
  created_at   timestamptz not null default now(),
  done_at      timestamptz
);
create index if not exists sms_batches_created_idx on public.sms_batches (created_at desc);
alter table public.sms_batches enable row level security;
revoke all on public.sms_batches from anon, authenticated;

create table if not exists public.sms_messages (
  id          uuid primary key default gen_random_uuid(),
  batch_id    uuid not null references public.sms_batches (id) on delete cascade,
  alumni_id   uuid references public.alumni (id) on delete set null,
  name        text,
  phone       text not null,
  body        text not null,
  parts       int not null default 1,
  status      text not null default 'queued'
              check (status in ('queued', 'sending', 'sent', 'failed', 'cancelled')),
  request_id  bigint,
  http_status int,
  response    text,
  error       text,
  tries       int not null default 0,
  created_at  timestamptz not null default now(),
  sent_at     timestamptz,
  done_at     timestamptz
);
create index if not exists sms_messages_queue_idx on public.sms_messages (created_at) where status = 'queued';
create index if not exists sms_messages_sending_idx on public.sms_messages (request_id) where status = 'sending';
create index if not exists sms_messages_batch_idx on public.sms_messages (batch_id, status);
create index if not exists sms_messages_alumni_idx on public.sms_messages (alumni_id, created_at desc);
alter table public.sms_messages enable row level security;
revoke all on public.sms_messages from anon, authenticated;

-- each alumnus: how many SMS reached them, the last one, and which sends
alter table public.alumni
  add column if not exists sms_count int not null default 0,
  add column if not exists last_sms_at timestamptz,
  add column if not exists sms_batch_ids uuid[] not null default '{}';

-- ---------------------------------------------------------------------
-- 3. Settings (app_settings 'sms'): on/off, who may send, speed
-- ---------------------------------------------------------------------
insert into public.app_settings (key, value)
values ('sms', jsonb_build_object(
  'enabled', false,
  'send', jsonb_build_object('all', false, 'roles', jsonb_build_array('admin'), 'user_ids', '[]'::jsonb),
  'per_minute', 60,
  'max_per_send', 5000))
on conflict (key) do nothing;

create or replace function public.sms_setting()
returns jsonb
language sql
stable
security definer
set search_path = public
as $$
  select coalesce((select value from public.app_settings where key = 'sms'), '{}'::jsonb);
$$;
revoke all on function public.sms_setting() from public, anon, authenticated;

-- may I send SMS? (SMS on, a company in use, and I am allowed)
create or replace function public.sms_can_send()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  with me as (
    select p.id, p.role_key, r.permissions
    from public.profiles p join public.roles r on r.key = p.role_key
    where p.id = auth.uid() and p.is_active and p.deleted_at is null
  ),
  s as (select public.sms_setting() as v)
  select exists (select 1 from me)
    and coalesce(((select v from s) ->> 'enabled')::boolean, false)
    and exists (select 1 from public.sms_providers where is_active and coalesce(api_key, '') <> '')
    and (
      (select '*' = any (permissions) or 'settings.manage' = any (permissions) from me)
      or coalesce(((select v from s) #>> '{send,all}')::boolean, false)
      or (select role_key from me) in (select jsonb_array_elements_text(coalesce((select v from s) #> '{send,roles}', '[]')))
      or (select id::text from me) in (select jsonb_array_elements_text(coalesce((select v from s) #> '{send,user_ids}', '[]')))
    );
$$;
revoke all on function public.sms_can_send() from public, anon;
grant execute on function public.sms_can_send() to authenticated;

-- ---------------------------------------------------------------------
-- 4. Helpers: the number, the address, the length
-- ---------------------------------------------------------------------
-- a Bangladesh mobile number in the company's format, or null
create or replace function public.sms_number(p_phone text, p_format text default '0')
returns text
language sql
immutable
as $$
  select case
    when d ~ '^01[3-9][0-9]{8}$' then
      case p_format when '880' then '88' || d when '+880' then '+88' || d else d end
  end
  from (select case
                 when x ~ '^8801[0-9]{9}$' then substr(x, 3)
                 when x ~ '^1[3-9][0-9]{8}$' then '0' || x
                 else x end as d
        from (select regexp_replace(coalesce(p_phone, ''), '\D', '', 'g') as x) y) z;
$$;
grant execute on function public.sms_number(text, text) to authenticated;

create or replace function public.sms_urlencode(p text)
returns text
language sql
immutable
as $$
  select coalesce(string_agg(
           case when b between 48 and 57 or b between 65 and 90 or b between 97 and 122 or b in (45, 46, 95, 126)
                then chr(b) else '%' || upper(lpad(to_hex(b), 2, '0')) end, '' order by i), '')
  from (select i, get_byte(t, i) as b
        from (select convert_to(coalesce(p, ''), 'UTF8') as t) s,
             generate_series(0, octet_length(convert_to(coalesce(p, ''), 'UTF8')) - 1) i) x;
$$;

-- how many SMS a text takes (English: 160 / 153 each; Bangla or emoji: 70 / 67 each)
create or replace function public.sms_parts(p text)
returns int
language sql
immutable
as $$
  select case
    when n = 0 then 1
    when uni then case when n <= 70 then 1 else ceil(n / 67.0)::int end
    else case when n7 <= 160 then 1 else ceil(n7 / 153.0)::int end
  end
  from (select coalesce(p, '') ~ '[^\x01-\x7E]' as uni,
               char_length(coalesce(p, '')) as n,
               char_length(coalesce(p, '')) + char_length(regexp_replace(coalesce(p, ''), '[^\^{}\\\[\]~|]', '', 'g')) as n7) x;
$$;
grant execute on function public.sms_parts(text) to authenticated;

-- {name}, {first_name} for this person
create or replace function public.sms_fill(p_text text, p_name text)
returns text
language sql
immutable
as $$
  select replace(replace(coalesce(p_text, ''), '{name}', coalesce(nullif(trim(p_name), ''), '')),
                 '{first_name}', coalesce(split_part(nullif(trim(p_name), ''), ' ', 1), ''));
$$;

-- the company's address with the values filled in
create or replace function public.sms_url(p_template text, p_key text, p_sender text, p_number text, p_message text)
returns text
language sql
immutable
as $$
  select replace(replace(replace(replace(p_template,
           '{api_key}', public.sms_urlencode(p_key)),
           '{sender_id}', public.sms_urlencode(p_sender)),
           '{number}', public.sms_urlencode(p_number)),
           '{message}', public.sms_urlencode(p_message));
$$;
revoke all on function public.sms_url(text, text, text, text, text) from public, anon, authenticated;

-- send one request (GET or POST); null when this database can't make web requests
create or replace function public.sms_request(p_method text, p_url text)
returns bigint
language plpgsql
security definer
set search_path = public
as $$
declare
  v_req bigint;
begin
  if p_method = 'POST' and to_regproc('net.http_post') is not null then
    execute 'select net.http_post(url := $1, body := ''{}''::jsonb, headers := ''{"Accept": "application/json"}''::jsonb)'
      into v_req using p_url;
  elsif to_regproc('net.http_get') is not null then
    execute 'select net.http_get(url := $1, headers := ''{"Accept": "application/json"}''::jsonb)'
      into v_req using p_url;
  end if;
  return v_req;
end;
$$;
revoke all on function public.sms_request(text, text) from public, anon, authenticated;

-- ---------------------------------------------------------------------
-- 5. Settings → SMS (admins)
-- ---------------------------------------------------------------------
create or replace function public.sms_admin_get()
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
begin
  if not public.has_permission('settings.manage') then raise exception 'Only an admin can see this.'; end if;
  return jsonb_build_object(
    'settings', public.sms_setting(),
    'providers', coalesce((
      select jsonb_agg(jsonb_build_object(
               'id', p.id, 'name', p.name, 'send_url', p.send_url, 'method', p.method,
               'balance_url', p.balance_url, 'number_format', p.number_format,
               'success_match', p.success_match, 'is_active', p.is_active,
               'key_set', coalesce(p.api_key, '') <> '',
               'key_hint', case when coalesce(p.api_key, '') = '' then null
                                when length(p.api_key) <= 8 then '••••'
                                else left(p.api_key, 3) || '…' || right(p.api_key, 4) end,
               'updated_at', p.updated_at,
               'senders', coalesce((
                 select jsonb_agg(jsonb_build_object(
                          'id', s.id, 'sender_id', s.sender_id, 'kind', s.kind, 'label', s.label,
                          'is_active', s.is_active, 'is_default', s.is_default) order by s.kind, s.created_at)
                 from public.sms_senders s where s.provider_id = p.id), '[]'::jsonb))
             order by p.is_active desc, p.created_at)
      from public.sms_providers p), '[]'::jsonb),
    'pg_net', to_regproc('net.http_get') is not null or to_regproc('net.http_post') is not null);
end;
$$;
revoke all on function public.sms_admin_get() from public, anon;
grant execute on function public.sms_admin_get() to authenticated;

-- add / change a company. p: {name, send_url, method, balance_url, number_format,
--   success_match, is_active, api_key (only when changed; '' leaves it)}
create or replace function public.sms_provider_save(p_id uuid, p jsonb)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_id   uuid := p_id;
  v_url  text := trim(coalesce(p ->> 'send_url', ''));
  v_bal  text := nullif(trim(coalesce(p ->> 'balance_url', '')), '');
  v_key  text := trim(coalesce(p ->> 'api_key', ''));
  v_on   boolean := coalesce((p ->> 'is_active')::boolean, false);
  v_rx   text := nullif(trim(coalesce(p ->> 'success_match', '')), '');
begin
  if not public.has_permission('settings.manage') then raise exception 'Only an admin can do this.'; end if;
  if nullif(trim(coalesce(p ->> 'name', '')), '') is null then raise exception 'Give the SMS company a name.'; end if;
  if v_url !~* '^https?://[^\s]+$' then raise exception 'The send address must start with https://'; end if;
  if position('{number}' in v_url) = 0 or position('{message}' in v_url) = 0 then
    raise exception 'The send address needs {number} and {message} (and usually {api_key} and {sender_id}).';
  end if;
  if v_bal is not null and v_bal !~* '^https?://[^\s]+$' then raise exception 'The balance address must start with https://'; end if;
  if v_rx is not null then
    begin
      perform '' ~* v_rx;
    exception when others then
      raise exception 'The "sent" pattern is not a valid pattern.';
    end;
  end if;

  if v_on then update public.sms_providers set is_active = false where is_active and id is distinct from v_id; end if;

  if v_id is null then
    insert into public.sms_providers (name, send_url, method, balance_url, api_key, number_format, success_match,
                                      is_active, updated_by)
    values (trim(p ->> 'name'), v_url, coalesce(nullif(p ->> 'method', ''), 'GET'), v_bal, nullif(v_key, ''),
            coalesce(nullif(p ->> 'number_format', ''), '0'), v_rx, v_on, auth.uid())
    returning id into v_id;
  else
    update public.sms_providers
       set name = trim(p ->> 'name'), send_url = v_url, method = coalesce(nullif(p ->> 'method', ''), 'GET'),
           balance_url = v_bal, number_format = coalesce(nullif(p ->> 'number_format', ''), '0'),
           success_match = v_rx, is_active = v_on,
           api_key = case when p ? 'api_key' and v_key <> '' then v_key else api_key end,
           updated_at = now(), updated_by = auth.uid()
     where id = v_id;
    if not found then raise exception 'This SMS company is not there any more.'; end if;
  end if;
  return v_id;
end;
$$;
revoke all on function public.sms_provider_save(uuid, jsonb) from public, anon;
grant execute on function public.sms_provider_save(uuid, jsonb) to authenticated;

create or replace function public.sms_provider_remove_key(p_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if not public.has_permission('settings.manage') then raise exception 'Only an admin can do this.'; end if;
  update public.sms_providers set api_key = null, is_active = false, updated_at = now(), updated_by = auth.uid()
   where id = p_id;
end;
$$;
revoke all on function public.sms_provider_remove_key(uuid) from public, anon;
grant execute on function public.sms_provider_remove_key(uuid) to authenticated;

create or replace function public.sms_provider_delete(p_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if not public.has_permission('settings.manage') then raise exception 'Only an admin can do this.'; end if;
  if exists (select 1 from public.sms_messages m join public.sms_batches b on b.id = m.batch_id
             where b.provider_id = p_id and m.status in ('queued', 'sending')) then
    raise exception 'SMS are still going out through this company. Wait, or stop that send first.';
  end if;
  delete from public.sms_providers where id = p_id;
end;
$$;
revoke all on function public.sms_provider_delete(uuid) from public, anon;
grant execute on function public.sms_provider_delete(uuid) to authenticated;

-- a sender ID. p: {provider_id, sender_id, kind, label, is_active, is_default}
create or replace function public.sms_sender_save(p_id uuid, p jsonb)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_id    uuid := p_id;
  v_prov  uuid := (p ->> 'provider_id')::uuid;
  v_kind  text := p ->> 'kind';
  v_sid   text := trim(coalesce(p ->> 'sender_id', ''));
  v_on    boolean := coalesce((p ->> 'is_active')::boolean, true);
  v_def   boolean := coalesce((p ->> 'is_default')::boolean, false);
begin
  if not public.has_permission('settings.manage') then raise exception 'Only an admin can do this.'; end if;
  if v_kind not in ('masking', 'non_masking') then raise exception 'Choose masking or non-masking.'; end if;
  if v_sid = '' then raise exception 'Write the sender ID.'; end if;
  if v_kind = 'masking' and char_length(v_sid) > 11 then
    raise exception 'A masking sender ID is at most 11 letters.';
  end if;
  if v_id is not null then
    select provider_id into v_prov from public.sms_senders where id = v_id;
    if v_prov is null then raise exception 'This sender ID is not there any more.'; end if;
  elsif not exists (select 1 from public.sms_providers where id = v_prov) then
    raise exception 'Choose the SMS company first.';
  end if;
  if not v_on then v_def := false; end if;
  if v_def then
    update public.sms_senders set is_default = false
     where provider_id = v_prov and kind = v_kind and is_default and id is distinct from v_id;
  end if;

  if v_id is null then
    insert into public.sms_senders (provider_id, sender_id, kind, label, is_active, is_default)
    values (v_prov, v_sid, v_kind, nullif(trim(coalesce(p ->> 'label', '')), ''), v_on, v_def)
    returning id into v_id;
  else
    update public.sms_senders
       set sender_id = v_sid, kind = v_kind, label = nullif(trim(coalesce(p ->> 'label', '')), ''),
           is_active = v_on, is_default = v_def
     where id = v_id;
  end if;
  return v_id;
end;
$$;
revoke all on function public.sms_sender_save(uuid, jsonb) from public, anon;
grant execute on function public.sms_sender_save(uuid, jsonb) to authenticated;

create or replace function public.sms_sender_delete(p_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if not public.has_permission('settings.manage') then raise exception 'Only an admin can do this.'; end if;
  delete from public.sms_senders where id = p_id;
end;
$$;
revoke all on function public.sms_sender_delete(uuid) from public, anon;
grant execute on function public.sms_sender_delete(uuid) to authenticated;

-- 💰 ask the company for the balance; read the answer a moment later
create or replace function public.sms_balance_request()
returns bigint
language plpgsql
security definer
set search_path = public
as $$
declare
  p public.sms_providers;
begin
  if not public.has_permission('settings.manage') then raise exception 'Only an admin can do this.'; end if;
  select * into p from public.sms_providers where is_active;
  if p.id is null then raise exception 'No SMS company is in use.'; end if;
  if p.balance_url is null then raise exception 'This SMS company has no balance address.'; end if;
  if coalesce(p.api_key, '') = '' then raise exception 'Save the API key first.'; end if;
  return public.sms_request('GET', public.sms_url(p.balance_url, p.api_key, '', '', ''));
end;
$$;
revoke all on function public.sms_balance_request() from public, anon;
grant execute on function public.sms_balance_request() to authenticated;

create or replace function public.sms_balance_result(p_request bigint)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  r record;
begin
  if not public.has_permission('settings.manage') then raise exception 'Only an admin can do this.'; end if;
  if to_regclass('net._http_response') is null or p_request is null then return null; end if;
  execute 'select status_code, content, timed_out, error_msg from net._http_response where id = $1'
    into r using p_request;
  if r is null then return null; end if;   -- not back yet
  return jsonb_build_object('status', r.status_code, 'body', left(r.content, 1000),
                            'error', coalesce(r.error_msg, case when r.timed_out then 'timed out' end));
end;
$$;
revoke all on function public.sms_balance_result(bigint) from public, anon;
grant execute on function public.sms_balance_result(bigint) to authenticated;

-- ---------------------------------------------------------------------
-- 6. Sending
-- ---------------------------------------------------------------------
-- the sender IDs I can choose (active ones of the company in use)
create or replace function public.sms_senders_for_me()
returns table (id uuid, sender_id text, kind text, label text, is_default boolean)
language sql
stable
security definer
set search_path = public
as $$
  select s.id, s.sender_id, s.kind, s.label, s.is_default
  from public.sms_senders s
  join public.sms_providers p on p.id = s.provider_id and p.is_active
  where s.is_active and public.sms_can_send()
  order by s.is_default desc, s.kind, s.sender_id;
$$;
revoke all on function public.sms_senders_for_me() from public, anon;
grant execute on function public.sms_senders_for_me() to authenticated;

-- before sending: how many of these people can get it
create or replace function public.alumni_sms_preview(p_ids uuid[], p_batch uuid default null)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_res jsonb;
begin
  if not (public.sms_can_send() and public.alumni_can('view')) then
    raise exception 'You can''t send SMS. (Settings → SMS)';
  end if;
  select jsonb_build_object(
    'selected', count(*),
    'can_send', count(*) filter (where not a.do_not_contact and public.sms_number(a.phone) is not null),
    'no_number', count(*) filter (where public.sms_number(a.phone) is null),
    'do_not_contact', count(*) filter (where a.do_not_contact and public.sms_number(a.phone) is not null),
    'got_sms_before', count(*) filter (where a.sms_count > 0),
    'got_this_before', count(*) filter (where p_batch is not null and p_batch = any (a.sms_batch_ids)),
    -- different numbers that will get it (one SMS per number)
    'will_get', count(distinct public.sms_number(a.phone)) filter (
      where not a.do_not_contact and public.sms_number(a.phone) is not null
        and (p_batch is null or not (p_batch = any (a.sms_batch_ids)))))
  into v_res
  from public.alumni a
  where a.id = any (coalesce(p_ids, '{}')) and a.deleted_at is null;
  return v_res;
end;
$$;
revoke all on function public.alumni_sms_preview(uuid[], uuid) from public, anon;
grant execute on function public.alumni_sms_preview(uuid[], uuid) to authenticated;

-- send one message to these alumni (in the queue now; out within minutes).
-- {name} {first_name} are filled for each. Not to "do not contact", not without a
-- mobile number, one SMS per number. p_skip_batch: leave out who got that send.
create or replace function public.alumni_sms_send(
  p_ids uuid[], p_message text, p_sender uuid, p_name text default null, p_skip_batch uuid default null)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_set    jsonb := public.sms_setting();
  v_max    int := coalesce((v_set ->> 'max_per_send')::int, 5000);
  v_prov   public.sms_providers;
  v_sender public.sms_senders;
  v_msg    text := trim(coalesce(p_message, ''));
  v_batch  uuid;
  v_n      int;
begin
  if not (public.sms_can_send() and public.alumni_can('view')) then
    raise exception 'You can''t send SMS. (Settings → SMS)';
  end if;
  if v_msg = '' then raise exception 'Write the message.'; end if;
  if char_length(v_msg) > 1000 then raise exception 'The message is too long (at most 1,000 letters).'; end if;
  if coalesce(array_length(p_ids, 1), 0) = 0 then raise exception 'Choose who gets it.'; end if;
  if array_length(p_ids, 1) > v_max then
    raise exception 'At most % people in one send.', v_max;
  end if;
  select * into v_prov from public.sms_providers where is_active;
  select * into v_sender from public.sms_senders
   where id = p_sender and provider_id = v_prov.id and is_active;
  if v_sender.id is null then raise exception 'Choose a sender ID (Settings → SMS).'; end if;

  insert into public.sms_batches (audience, name, message, sender_id, sender_text, sender_kind, provider_id, created_by)
  values ('alumni', nullif(trim(coalesce(p_name, '')), ''), v_msg, v_sender.id, v_sender.sender_id, v_sender.kind,
          v_prov.id, auth.uid())
  returning id into v_batch;

  insert into public.sms_messages (batch_id, alumni_id, name, phone, body, parts)
  select v_batch, x.id, x.name, x.num, x.body, public.sms_parts(x.body)
  from (
    select distinct on (public.sms_number(a.phone)) a.id, a.name, public.sms_number(a.phone) as num,
           public.sms_fill(v_msg, a.name) as body
    from public.alumni a
    where a.id = any (p_ids) and a.deleted_at is null and not a.do_not_contact
      and public.sms_number(a.phone) is not null
      and (p_skip_batch is null or not (p_skip_batch = any (a.sms_batch_ids)))
    order by public.sms_number(a.phone), a.created_at
  ) x;
  get diagnostics v_n = row_count;

  if v_n = 0 then
    delete from public.sms_batches where id = v_batch;
    raise exception 'Nobody here can get an SMS (no mobile number, or "do not contact").';
  end if;
  update public.sms_batches set total = v_n where id = v_batch;
  return jsonb_build_object('batch_id', v_batch, 'queued', v_n,
                            'parts', (select sum(parts) from public.sms_messages where batch_id = v_batch));
end;
$$;
revoke all on function public.alumni_sms_send(uuid[], text, uuid, text, uuid) from public, anon;
grant execute on function public.alumni_sms_send(uuid[], text, uuid, text, uuid) to authenticated;

-- a test SMS from Settings (goes out on the next minute, or now with sms_tick)
create or replace function public.sms_send_test(p_phone text, p_message text, p_sender uuid)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_prov   public.sms_providers;
  v_sender public.sms_senders;
  v_num    text;
  v_batch  uuid;
  v_msg    text := coalesce(nullif(trim(p_message), ''), 'Test SMS');
begin
  if not public.has_permission('settings.manage') then raise exception 'Only an admin can do this.'; end if;
  select * into v_prov from public.sms_providers where is_active;
  if v_prov.id is null then raise exception 'Put an SMS company in use first.'; end if;
  if coalesce(v_prov.api_key, '') = '' then raise exception 'Save the API key first.'; end if;
  select * into v_sender from public.sms_senders where id = p_sender and provider_id = v_prov.id and is_active;
  if v_sender.id is null then raise exception 'Choose an active sender ID of the company in use.'; end if;
  v_num := public.sms_number(p_phone, '0');
  if v_num is null then raise exception 'Write a Bangladesh mobile number (01XXXXXXXXX).'; end if;

  insert into public.sms_batches (audience, name, message, sender_id, sender_text, sender_kind, provider_id, total, created_by)
  values ('test', 'Test', v_msg, v_sender.id, v_sender.sender_id, v_sender.kind, v_prov.id, 1, auth.uid())
  returning id into v_batch;
  insert into public.sms_messages (batch_id, name, phone, body, parts)
  values (v_batch, 'Test', v_num, v_msg, public.sms_parts(v_msg));
  perform public.sms_tick();
  return v_batch;
end;
$$;
revoke all on function public.sms_send_test(text, text, uuid) from public, anon;
grant execute on function public.sms_send_test(text, text, uuid) to authenticated;

-- a sent SMS: on the alumnus (count, last, which sends)
create or replace function public.sms_on_sent()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if new.status = 'sent' and old.status is distinct from 'sent' and new.alumni_id is not null then
    update public.alumni
       set sms_count = sms_count + 1,
           last_sms_at = greatest(coalesce(last_sms_at, '-infinity'::timestamptz), coalesce(new.sent_at, now())),
           sms_batch_ids = case when new.batch_id = any (sms_batch_ids) then sms_batch_ids
                                else sms_batch_ids || new.batch_id end
     where id = new.alumni_id;
  end if;
  return null;
end;
$$;
drop trigger if exists sms_messages_on_sent on public.sms_messages;
create trigger sms_messages_on_sent after update of status on public.sms_messages
  for each row execute function public.sms_on_sent();

-- the company's answers → Sent / Failed
create or replace function public.sms_read_answers()
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  r    record;
  v_ok boolean;
begin
  if to_regclass('net._http_response') is not null then
    for r in execute $q$
      select m.id, h.status_code, h.content, h.timed_out, h.error_msg, p.success_match
      from public.sms_messages m
      join net._http_response h on h.id = m.request_id
      left join public.sms_batches b on b.id = m.batch_id
      left join public.sms_providers p on p.id = b.provider_id
      where m.status = 'sending'
      limit 2000
    $q$
    loop
      v_ok := not coalesce(r.timed_out, false) and r.status_code between 200 and 299
              and (r.success_match is null or coalesce(r.content, '') ~* r.success_match);
      update public.sms_messages
         set status = case when v_ok then 'sent' else 'failed' end,
             http_status = r.status_code,
             response = left(r.content, 500),
             error = case when v_ok then null
                          else left(coalesce(r.error_msg, case when r.timed_out then 'No answer (timed out)' end,
                                             'HTTP ' || coalesce(r.status_code::text, '?') || ': ' || left(coalesce(r.content, ''), 200)), 300) end,
             done_at = now()
       where id = r.id;
    end loop;
  end if;
  -- no answer in 15 minutes (the answer was lost): failed, can be sent again
  update public.sms_messages
     set status = 'failed', error = 'No answer from the SMS company', done_at = now()
   where status = 'sending' and sent_at < now() - interval '15 minutes';

end;
$$;
revoke all on function public.sms_read_answers() from public, anon, authenticated;

-- "check now" (the Sent / Failed marks without waiting for the minute)
create or replace function public.sms_check_now()
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if not (public.has_permission('settings.manage') or public.sms_can_send()) then
    raise exception 'You can''t send SMS. (Settings → SMS)';
  end if;
  perform public.sms_read_answers();
end;
$$;
revoke all on function public.sms_check_now() from public, anon;
grant execute on function public.sms_check_now() to authenticated;

-- ⏱ every minute: read the answers, then send the next ones
create or replace function public.sms_tick()
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_set  jsonb := public.sms_setting();
  v_rate int := greatest(1, least(coalesce((v_set ->> 'per_minute')::int, 60), 500));
  v_prov public.sms_providers;
  r      record;
  v_req  bigint;
begin
  -- 1. the company's answers
  perform public.sms_read_answers();

  -- 2. the next ones
  if coalesce((v_set ->> 'enabled')::boolean, false) then
    select * into v_prov from public.sms_providers where is_active and coalesce(api_key, '') <> '';
    if v_prov.id is not null then
      for r in
        select m.id, m.phone, m.body, b.sender_text
        from public.sms_messages m
        join public.sms_batches b on b.id = m.batch_id
        where m.status = 'queued'
        order by m.created_at
        limit v_rate
        for update of m skip locked
      loop
        v_req := public.sms_request(
          v_prov.method,
          public.sms_url(v_prov.send_url, v_prov.api_key, coalesce(r.sender_text, ''),
                         public.sms_number(r.phone, v_prov.number_format), r.body));
        if v_req is null then
          update public.sms_messages
             set status = 'failed', error = 'This server can''t make web requests (pg_net is off)', done_at = now(),
                 tries = tries + 1
           where id = r.id;
        else
          update public.sms_messages
             set status = 'sending', request_id = v_req, sent_at = now(), tries = tries + 1
           where id = r.id;
        end if;
      end loop;
    end if;
  end if;

  -- 3. sends with nothing left to do
  update public.sms_batches b
     set status = 'done', done_at = now()
   where b.status = 'sending'
     and not exists (select 1 from public.sms_messages m where m.batch_id = b.id and m.status in ('queued', 'sending'));
end;
$$;
revoke all on function public.sms_tick() from public, anon, authenticated;

do $$
begin
  if exists (select 1 from pg_extension where extname = 'pg_cron') then
    perform cron.unschedule('sms-tick') where exists (select 1 from cron.job where jobname = 'sms-tick');
    perform cron.schedule('sms-tick', '* * * * *', 'select public.sms_tick()');
  end if;
end $$;

-- ---------------------------------------------------------------------
-- 7. The sends: list, one send (who got it / who didn't), stop, send again
-- ---------------------------------------------------------------------
create or replace function public.sms_can_see_batch(p_created_by uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select public.has_permission('settings.manage') or (p_created_by = auth.uid() and public.sms_can_send());
$$;
revoke all on function public.sms_can_see_batch(uuid) from public, anon;
grant execute on function public.sms_can_see_batch(uuid) to authenticated;

create or replace function public.sms_batches_list(p_limit int default 50, p_before timestamptz default null)
returns jsonb
language sql
stable
security definer
set search_path = public
as $$
  select coalesce(jsonb_agg(x order by x.created_at desc), '[]'::jsonb)
  from (
    select b.id, b.audience, b.name, b.message, b.sender_text, b.sender_kind, b.total, b.status, b.created_at,
           b.done_at, pr.full_name as by_name,
           count(*) filter (where m.status = 'sent') as sent,
           count(*) filter (where m.status = 'failed') as failed,
           count(*) filter (where m.status in ('queued', 'sending')) as waiting,
           count(*) filter (where m.status = 'cancelled') as cancelled,
           coalesce(sum(m.parts) filter (where m.status = 'sent'), 0) as parts_sent
    from public.sms_batches b
    left join public.sms_messages m on m.batch_id = b.id
    left join public.profiles pr on pr.id = b.created_by
    where public.sms_can_see_batch(b.created_by)
      and (p_before is null or b.created_at < p_before)
    group by b.id, pr.full_name
    order by b.created_at desc
    limit greatest(1, least(coalesce(p_limit, 50), 200))
  ) x;
$$;
revoke all on function public.sms_batches_list(int, timestamptz) from public, anon;
grant execute on function public.sms_batches_list(int, timestamptz) to authenticated;

-- one send; p_status: null (all) / sent / failed / waiting / cancelled
create or replace function public.sms_batch_detail(p_batch uuid, p_status text default null)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  b public.sms_batches;
begin
  select * into b from public.sms_batches where id = p_batch;
  if b.id is null or not public.sms_can_see_batch(b.created_by) then raise exception 'This send is not there.'; end if;
  return jsonb_build_object(
    'batch', (select x from (select b.id, b.audience, b.name, b.message, b.sender_text, b.sender_kind, b.total,
                                    b.status, b.created_at, b.done_at,
                                    (select full_name from public.profiles where id = b.created_by) as by_name) x),
    'counts', (select jsonb_build_object(
                 'sent', count(*) filter (where status = 'sent'),
                 'failed', count(*) filter (where status = 'failed'),
                 'waiting', count(*) filter (where status in ('queued', 'sending')),
                 'cancelled', count(*) filter (where status = 'cancelled'),
                 'parts', coalesce(sum(parts) filter (where status = 'sent'), 0))
               from public.sms_messages where batch_id = b.id),
    'messages', coalesce((
      select jsonb_agg(jsonb_build_object(
               'id', m.id, 'alumni_id', m.alumni_id, 'name', m.name, 'phone', m.phone, 'status', m.status,
               'parts', m.parts, 'error', m.error, 'response', m.response, 'sent_at', m.sent_at,
               'done_at', m.done_at) order by m.status, m.name)
      from (select * from public.sms_messages m
            where m.batch_id = b.id
              and (p_status is null
                   or (p_status = 'waiting' and m.status in ('queued', 'sending'))
                   or m.status = p_status)
            order by m.name
            limit 5000) m), '[]'::jsonb));
end;
$$;
revoke all on function public.sms_batch_detail(uuid, text) from public, anon;
grant execute on function public.sms_batch_detail(uuid, text) to authenticated;

-- stop: the ones not gone yet are not sent
create or replace function public.sms_batch_cancel(p_batch uuid)
returns int
language plpgsql
security definer
set search_path = public
as $$
declare
  b   public.sms_batches;
  v_n int;
begin
  select * into b from public.sms_batches where id = p_batch;
  if b.id is null or not public.sms_can_see_batch(b.created_by) then raise exception 'This send is not there.'; end if;
  update public.sms_messages set status = 'cancelled', done_at = now() where batch_id = b.id and status = 'queued';
  get diagnostics v_n = row_count;
  update public.sms_batches set status = case when exists (select 1 from public.sms_messages
                                                            where batch_id = b.id and status = 'sending')
                                              then 'sending' else 'cancelled' end,
                                done_at = now()
   where id = b.id;
  return v_n;
end;
$$;
revoke all on function public.sms_batch_cancel(uuid) from public, anon;
grant execute on function public.sms_batch_cancel(uuid) to authenticated;

-- send again to the ones that failed (or were stopped)
create or replace function public.sms_batch_retry(p_batch uuid)
returns int
language plpgsql
security definer
set search_path = public
as $$
declare
  b   public.sms_batches;
  v_n int;
begin
  select * into b from public.sms_batches where id = p_batch;
  if b.id is null or not public.sms_can_see_batch(b.created_by) then raise exception 'This send is not there.'; end if;
  if not public.sms_can_send() then raise exception 'You can''t send SMS. (Settings → SMS)'; end if;
  update public.sms_messages
     set status = 'queued', error = null, response = null, http_status = null, request_id = null,
         sent_at = null, done_at = null
   where batch_id = b.id and status in ('failed', 'cancelled');
  get diagnostics v_n = row_count;
  if v_n > 0 then update public.sms_batches set status = 'sending', done_at = null where id = b.id; end if;
  return v_n;
end;
$$;
revoke all on function public.sms_batch_retry(uuid) from public, anon;
grant execute on function public.sms_batch_retry(uuid) to authenticated;

-- one alumnus: the SMS sent to them
create or replace function public.alumni_sms_list(p_alumni uuid)
returns jsonb
language sql
stable
security definer
set search_path = public
as $$
  select coalesce(jsonb_agg(jsonb_build_object(
           'id', m.id, 'batch_id', m.batch_id, 'body', m.body, 'status', m.status, 'error', m.error,
           'sender', b.sender_text, 'at', coalesce(m.sent_at, m.created_at)) order by m.created_at desc), '[]'::jsonb)
  from public.sms_messages m
  join public.sms_batches b on b.id = m.batch_id
  where m.alumni_id = p_alumni and public.alumni_can('view');
$$;
revoke all on function public.alumni_sms_list(uuid) from public, anon;
grant execute on function public.alumni_sms_list(uuid) to authenticated;

-- ---------------------------------------------------------------------
-- 8. The alumni list: + SMS count, last SMS, which sends (new columns at the end)
-- ---------------------------------------------------------------------
drop view if exists public.alumni_overview;
create view public.alumni_overview with (security_invoker = true) as
select a.*,
  c.name as course_name,
  b.name as batch_name,
  o.full_name as owner_name,
  a.cnt_referrals as referrals,
  a.cnt_waiting   as referrals_waiting,
  a.cnt_leads     as referred_leads,
  a.cnt_admitted  as referred_admitted,
  coalesce((select sum(rw.amount) from public.alumni_rewards rw
            where rw.alumni_id = a.id and rw.status = 'due'), 0) as reward_due
from public.alumni a
left join public.courses c on c.id = a.course_id
left join public.batches b on b.id = a.batch_id
left join public.profiles o on o.id = a.owner_id
where a.deleted_at is null;
grant select on public.alumni_overview to authenticated;

notify pgrst, 'reload schema';
