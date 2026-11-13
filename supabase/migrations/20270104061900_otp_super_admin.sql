-- =====================================================================
-- 🔐 Sign in with an SMS code: the Super Admin too
--   Until now a Super Admin always had to use email and password, because
--   other admins could change where SMS go and so catch the code.
--   Now only a Super Admin may change where SMS go (the SMS company's
--   address, method, number format, API key, which company is in use,
--   adding or removing one) and which app codes are allowed on the code
--   SMS, so everyone, the Super Admin too, may sign in with a code.
--   The server itself (no signed-in user) may still change these.
-- =====================================================================

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

  -- a number that is on no single account: limited per network (trying many numbers);
  -- a real user's number is not, so junk from a shared network never blocks them
  if coalesce(array_length(v_users, 1), 0) <> 1
     and v_ip is not null
     and (select count(*) from public.login_otps
          where ip = v_ip and user_id is null and created_at > now() - interval '1 hour') >= 30 then
    return jsonb_build_object('error', 'Too many tries from this network. Try again later.');
  end if;

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

create or replace function public.sms_providers_guard()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if auth.uid() is null or public.current_role_key() = 'super_admin' then
    return coalesce(new, old);
  end if;
  if tg_op = 'INSERT' or tg_op = 'DELETE'
     or new.send_url is distinct from old.send_url
     or new.method is distinct from old.method
     or new.number_format is distinct from old.number_format
     or new.is_active is distinct from old.is_active
     -- another account's key would show the codes in that account's SMS log
     or new.api_key is distinct from old.api_key then
    raise exception 'Only a Super Admin can change where SMS are sent (the SMS company, its address, its API key or which one is in use), because sign-in codes go this way too.';
  end if;
  return new;
end;
$$;

drop trigger if exists sms_providers_guard on public.sms_providers;
create trigger sms_providers_guard
  before insert or update or delete on public.sms_providers
  for each row execute function public.sms_providers_guard();

create or replace function public.sms_setting_guard()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if new.key = 'sms'
     and auth.uid() is not null
     and public.current_role_key() is distinct from 'super_admin'
     and coalesce(new.value -> 'otp_app_hashes', '[]'::jsonb) is distinct from coalesce(old.value -> 'otp_app_hashes', '[]'::jsonb) then
    raise exception 'Only a Super Admin can allow app codes for the sign-in SMS.';
  end if;
  return new;
end;
$$;

drop trigger if exists sms_setting_guard on public.app_settings;
create trigger sms_setting_guard
  before update on public.app_settings
  for each row execute function public.sms_setting_guard();

