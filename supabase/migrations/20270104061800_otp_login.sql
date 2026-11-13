-- =====================================================================
-- 🔐 Sign in with a mobile number and a one-time code (OTP)
--   The login page: write your mobile → a 6-digit code comes by SMS from
--   the non-masking sender of the SMS company in use → the code signs you
--   in. Email + password sign-in stays as it is.
--   • The number must be on exactly one active user's profile (Phone).
--   • A code works for 5 minutes, once, with 5 tries.
--   • Limits (an SMS costs money and the page is open to anyone):
--     one code per number per 30 seconds, 3 per 10 minutes, 10 a day;
--     20 an hour from one internet address; 300 an hour in all.
--   • Only the server (the otp-login Edge Function, service role) calls
--     these functions; the app only asks whether the option is on.
--   • The SMS goes out the same way as all other SMS (pg_net from the
--     database), so the SMS company sees the same server; the API key and
--     the code never leave the database.
--   • Settings → SMS → "Sign in with OTP" turns it on or off.
--   • Android: the SMS's last line can carry the app's 11-letter code so
--     the phone reads the code by itself. Only codes an admin allowed in
--     Settings → SMS are used (another app's code would let that app read
--     the SMS).
--   • A profile's mobile number now belongs to one active person only, and
--     only a Super Admin may change a Super Admin's number (the number is a
--     way in now).
-- =====================================================================

create table if not exists public.login_otps (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid references public.profiles (id) on delete cascade,
  phone       text not null,
  code_hash   text,
  ip          text,
  created_at  timestamptz not null default now(),
  expires_at  timestamptz not null default now() + interval '5 minutes',
  tries       int not null default 0,
  used_at     timestamptz,
  sent        boolean not null default false,
  req_id      bigint,
  error       text
);
create index if not exists login_otps_phone_idx on public.login_otps (phone, created_at desc);
create index if not exists login_otps_ip_idx on public.login_otps (ip, created_at desc) where ip is not null;
create index if not exists login_otps_time_idx on public.login_otps (created_at);
alter table public.login_otps enable row level security;   -- no policies: server only
revoke all on public.login_otps from anon, authenticated;

-- ---------------------------------------------------------------------
-- Is sign-in with OTP on? (the login page asks; anyone may)
-- ---------------------------------------------------------------------
create or replace function public.otp_login_ready()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select coalesce((public.sms_setting() ->> 'otp_login')::boolean, true)
     and exists (
       select 1
       from public.sms_providers p
       join public.sms_senders s on s.provider_id = p.id
       where p.is_active and coalesce(p.api_key, '') <> ''
         and s.is_active and s.kind = 'non_masking');
$$;
revoke all on function public.otp_login_ready() from public;
grant execute on function public.otp_login_ready() to anon, authenticated;

-- ---------------------------------------------------------------------
-- 1. Make a code and the SMS company's address that sends it
--    → {id, url, method, success_match, hint} or {error}
-- ---------------------------------------------------------------------
create or replace function public.otp_login_start(p_phone text, p_ip text, p_app_hash text)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_phone text := public.bd_mobile(p_phone);
  v_ip    text := nullif(left(trim(coalesce(p_ip, '')), 64), '');
  -- only an app code an admin allowed (Settings → SMS)
  v_hash  text := case when p_app_hash ~ '^[A-Za-z0-9+/]{11}$'
                        and p_app_hash in (select jsonb_array_elements_text(coalesce(public.sms_setting() -> 'otp_app_hashes', '[]')))
                       then p_app_hash end;
  v_req   bigint;
  v_last  timestamptz;
  v_users uuid[];
  v_id    uuid := gen_random_uuid();
  v_code  text;
  v_msg   text;
  pr      record;
  v_send  text;
begin
  if v_phone is null then
    return jsonb_build_object('error', 'Write a Bangladesh mobile number, like 01711-000000.');
  end if;
  if not public.otp_login_ready() then
    return jsonb_build_object('error', 'Sign in with a code is off. Sign in with email and password.');
  end if;

  -- one at a time per number (two taps at once count as one)
  perform pg_advisory_xact_lock(hashtext('otp:' || v_phone));

  -- limits
  select max(created_at) into v_last from public.login_otps where phone = v_phone;
  if v_last > now() - interval '30 seconds' then
    return jsonb_build_object('error', format('Wait %s seconds before asking for a new code.',
      greatest(1, ceil(extract(epoch from v_last + interval '30 seconds' - now()))::int)),
      'wait', greatest(1, ceil(extract(epoch from v_last + interval '30 seconds' - now()))::int));
  end if;
  if (select count(*) from public.login_otps where phone = v_phone and created_at > now() - interval '10 minutes') >= 3
     or (select count(*) from public.login_otps where phone = v_phone and created_at > now() - interval '1 day') >= 10 then
    return jsonb_build_object('error', 'Too many codes for this number. Try again later, or sign in with email.');
  end if;
  if v_ip is not null
     and (select count(*) from public.login_otps where ip = v_ip and created_at > now() - interval '1 hour') >= 30 then
    return jsonb_build_object('error', 'Too many codes from this network. Try again later.');
  end if;
  -- all SMS sent in the last hour (unknown numbers send nothing, so they don't count)
  if (select count(*) from public.login_otps where user_id is not null and created_at > now() - interval '1 hour') >= 300 then
    return jsonb_build_object('error', 'Too many codes right now. Try again later, or sign in with email.');
  end if;

  -- whose number is it? (the profile's Phone, written any way)
  select array_agg(p.id) into v_users
  from public.profiles p
  join auth.users u on u.id = p.id
  where p.is_active and p.deleted_at is null
    and p.phone is not null
    and public.bd_mobile(p.phone) = v_phone;

  if coalesce(array_length(v_users, 1), 0) <> 1 then
    -- counted too, so nobody can try numbers without limit
    insert into public.login_otps (id, phone, ip, sent, error)
    values (v_id, v_phone, v_ip, false, case when v_users is null then 'no account' else 'more than one account' end);
    return jsonb_build_object('error', case when v_users is null
      then 'No account has this mobile number. Sign in with email, or ask an admin to put this number on your profile.'
      else 'This number is on more than one account. Sign in with email, or ask an admin.' end);
  end if;

  -- the company in use and its non-masking sender
  select p.send_url, p.method, p.api_key, p.number_format, p.success_match, s.sender_id
    into pr
  from public.sms_providers p
  join public.sms_senders s on s.provider_id = p.id
  where p.is_active and coalesce(p.api_key, '') <> '' and s.is_active and s.kind = 'non_masking'
  order by s.is_default desc, s.created_at
  limit 1;

  -- a random 6-digit code (gen_random_uuid uses the system's strong random)
  v_code := lpad(((('x' || left(replace(gen_random_uuid()::text, '-', ''), 8))::bit(32)::bigint) % 1000000)::text, 6, '0');
  v_msg := v_code || ' is your ITTC sign-in code. It works for 5 minutes. Do not share it with anyone.'
           || coalesce(E'\n' || v_hash, '');

  -- out through pg_net, like every other SMS (it leaves when this call ends)
  v_send := public.sms_url(pr.send_url, pr.api_key, pr.sender_id, public.sms_number(v_phone, pr.number_format), v_msg);
  v_req := public.sms_request(pr.method, v_send);
  if v_req is null then
    return jsonb_build_object('error', 'The server cannot send SMS right now (pg_net is off). Sign in with email.');
  end if;

  -- an older code for this number stops working
  update public.login_otps set used_at = now()
  where phone = v_phone and used_at is null and expires_at > now();

  insert into public.login_otps (id, user_id, phone, code_hash, ip, sent, req_id)
  values (v_id, v_users[1], v_phone, encode(sha256(convert_to(v_id::text || ':' || v_code, 'UTF8')), 'hex'), v_ip, true, v_req);

  return jsonb_build_object('id', v_id, 'hint', left(v_phone, 3) || '•••••' || right(v_phone, 3));
end;
$$;
revoke all on function public.otp_login_start(text, text, text) from public, anon, authenticated;
grant execute on function public.otp_login_start(text, text, text) to service_role;

-- ---------------------------------------------------------------------
-- 2. Has the SMS company answered? → {done: false} | {done: true, problem}
--    (a failed SMS: its code stops working; no answer yet: it may still come)
-- ---------------------------------------------------------------------
create or replace function public.otp_login_status(p_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  o       record;
  r       record;
  v_match text;
  v_prob  text;
begin
  select id, req_id, sent, error into o from public.login_otps where id = p_id;
  if o.id is null then return jsonb_build_object('done', true, 'problem', 'Unknown code.'); end if;
  if not o.sent then return jsonb_build_object('done', true, 'problem', coalesce(o.error, 'Not sent.')); end if;
  if o.req_id is null or to_regclass('net._http_response') is null then
    return jsonb_build_object('done', false);
  end if;

  execute 'select status_code, content, timed_out, error_msg from net._http_response where id = $1'
    into r using o.req_id;
  if r is null then return jsonb_build_object('done', false); end if;

  select p.success_match into v_match from public.sms_providers p where p.is_active limit 1;
  v_prob := public.sms_answer_problem(r.status_code, r.content, r.timed_out, r.error_msg);
  if v_prob is null and v_match is not null and coalesce(r.content, '') !~* v_match then
    v_prob := 'The SMS company said: ' || public.sms_answer_text(r.content, 200);
  end if;
  if v_prob is not null then
    update public.login_otps set sent = false, error = left(v_prob, 300), used_at = now() where id = p_id;
  end if;
  return jsonb_build_object('done', true, 'problem', v_prob);
end;
$$;
revoke all on function public.otp_login_status(uuid) from public, anon, authenticated;
grant execute on function public.otp_login_status(uuid) to service_role;

-- ---------------------------------------------------------------------
-- 3. Check a code → {user_id, email} or {error}
-- ---------------------------------------------------------------------
create or replace function public.otp_login_check(p_phone text, p_code text)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_phone text := public.bd_mobile(p_phone);
  v_code  text := regexp_replace(coalesce(p_code, ''), '\D', '', 'g');
  r       record;
  v_email text;
begin
  if v_phone is null then return jsonb_build_object('error', 'Write your mobile number again.'); end if;

  select * into r
  from public.login_otps
  where phone = v_phone and user_id is not null and sent and used_at is null
  order by created_at desc
  limit 1
  for update;

  if r.id is null or r.expires_at <= now() then
    return jsonb_build_object('error', 'This code has expired. Ask for a new one.');
  end if;
  if r.tries >= 5 then
    return jsonb_build_object('error', 'Too many wrong tries. Ask for a new code.');
  end if;
  if length(v_code) <> 6
     or encode(sha256(convert_to(r.id::text || ':' || v_code, 'UTF8')), 'hex') <> r.code_hash then
    update public.login_otps
       set tries = tries + 1,
           used_at = case when tries + 1 >= 5 then now() else used_at end
     where id = r.id;
    return jsonb_build_object('error', case when r.tries + 1 >= 5
      then 'Wrong code. Too many tries: ask for a new code.'
      else format('Wrong code. %s more %s.', 4 - r.tries, case when 4 - r.tries = 1 then 'try' else 'tries' end) end);
  end if;

  update public.login_otps set used_at = now() where id = r.id;

  select u.email into v_email
  from auth.users u join public.profiles p on p.id = u.id
  where u.id = r.user_id and p.is_active and p.deleted_at is null;
  if v_email is null then
    return jsonb_build_object('error', 'This account cannot sign in. Ask an admin.');
  end if;
  return jsonb_build_object('user_id', r.user_id, 'email', v_email);
end;
$$;
revoke all on function public.otp_login_check(text, text) from public, anon, authenticated;
grant execute on function public.otp_login_check(text, text) to service_role;

-- ---------------------------------------------------------------------
-- 4. The mobile number is a way in now:
--    · only a Super Admin changes a Super Admin's number
--    · one active person per number (else nobody could sign in with it)
--    · a changed number ends the codes already sent to the old one
-- ---------------------------------------------------------------------
create or replace function public.profiles_phone_guard()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_mob   text;
  v_other text;
begin
  if coalesce(current_setting('app.bypass_profile_guard', true), '') = 'on' then
    return new;
  end if;

  if new.phone is distinct from old.phone then
    if new.id is distinct from auth.uid()
       and old.role_key = 'super_admin'
       and public.current_role_key() is distinct from 'super_admin' then
      raise exception 'Only a Super Admin can change a Super Admin''s mobile number';
    end if;
    update public.login_otps set used_at = now() where user_id = new.id and used_at is null;
  end if;

  -- the number is new, or the person becomes active
  if new.is_active and new.deleted_at is null
     and (new.phone is distinct from old.phone or not old.is_active or old.deleted_at is not null) then
    v_mob := public.bd_mobile(new.phone);
    if v_mob is not null then
      select coalesce(nullif(trim(p.full_name), ''), 'another user') into v_other
      from public.profiles p
      where p.id <> new.id and p.is_active and p.deleted_at is null
        and p.phone is not null and public.bd_mobile(p.phone) = v_mob
      limit 1;
      if v_other is not null then
        raise exception 'The mobile number % is already on %''s profile. Each person needs their own number (it is used to sign in with an SMS code).', v_mob, v_other;
      end if;
    end if;
  end if;
  return new;
end;
$$;

drop trigger if exists profiles_phone_guard on public.profiles;
create trigger profiles_phone_guard
  before update of phone, is_active, deleted_at on public.profiles
  for each row execute function public.profiles_phone_guard();

-- old codes are not kept (a week is enough for the limits and for checking)
create or replace function public.otp_login_purge()
returns void
language sql
security definer
set search_path = public
as $$
  delete from public.login_otps where created_at < now() - interval '7 days';
$$;
revoke all on function public.otp_login_purge() from public, anon, authenticated;

do $$
begin
  if to_regnamespace('cron') is not null then
    perform cron.unschedule(jobid) from cron.job where jobname = 'otp-login-purge';
    perform cron.schedule('otp-login-purge', '17 3 * * *', 'select public.otp_login_purge()');
  end if;
end;
$$;
