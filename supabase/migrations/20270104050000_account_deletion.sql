-- =====================================================================
-- 🗑 Delete my account (Google Play: in the app and on the web)
--   The person's own data is removed and the login can never be used
--   again. The institute's records (leads, calls, notes, payments,
--   history) stay, shown as "Deleted user" (they belong to the institute).
--   Removing the login row itself would also remove the profile that
--   those records point to, so the login is closed instead:
--   e-mail and phone removed, password removed, banned for ever.
--   * delete_my_account(): from the app / website, signed in
--   * request_account_deletion(): the public web page, without signing in
--   * admin_delete_account(): admins, for a request (Users → Deletion requests)
-- =====================================================================

alter table public.profiles add column if not exists deleted_at timestamptz;

create table if not exists public.account_deletion_requests (
  id          uuid primary key default gen_random_uuid(),
  name        text,
  contact     text not null,           -- e-mail or phone, as typed
  note        text,
  user_id     uuid references public.profiles (id) on delete set null,  -- the account it matches
  created_at  timestamptz not null default now(),
  done_at     timestamptz,
  done_by     uuid references public.profiles (id) on delete set null,
  result      text                     -- deleted / not_found / rejected
);
alter table public.account_deletion_requests enable row level security;

drop policy if exists "deletion requests: admins read" on public.account_deletion_requests;
create policy "deletion requests: admins read" on public.account_deletion_requests
  for select to authenticated
  using ((select public.has_permission('users.manage')));

-- ---------------------------------------------------------------------
-- The work itself (only called by the functions below)
-- ---------------------------------------------------------------------
create or replace function public.close_account(p_user uuid, p_by uuid, p_reason text)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  p public.profiles;
  v_leads int;
begin
  select * into p from public.profiles where id = p_user for update;
  if p.id is null then raise exception 'Account not found.'; end if;
  if p.deleted_at is not null then return; end if;

  -- The last Super Admin can't go (nobody could run the system)
  if p.role_key = 'super_admin'
     and not exists (select 1 from public.profiles x
                     where x.role_key = 'super_admin' and x.is_active and x.id <> p_user and x.deleted_at is null) then
    raise exception 'You are the only Super Admin. Make someone else Super Admin first.';
  end if;

  -- Their leads become Unassigned (an admin gives them to someone)
  perform set_config('app.handover', 'on', true);
  update public.leads set assigned_to = null where assigned_to = p_user and deleted_at is null;
  get diagnostics v_leads = row_count;
  perform set_config('app.handover', 'off', true);
  -- (the checks for role / team / status changes: this function made its own)
  perform set_config('app.bypass_profile_guard', 'on', true);
  update public.profiles set team_lead_id = null where team_lead_id = p_user;

  -- Their own things
  delete from public.push_tokens where user_id = p_user;
  delete from public.push_devices where user_id = p_user;
  delete from public.notifications where user_id = p_user;
  delete from public.notification_prefs where user_id = p_user;
  delete from public.app_devices where user_id = p_user;
  delete from public.app_sessions where user_id = p_user;
  delete from public.lead_stars where user_id = p_user;
  delete from public.lead_views where user_id = p_user;
  delete from public.saved_filters where owner_id = p_user and not coalesce(is_shared, false);
  delete from public.feedback_reads where reader = p_user or chat_user = p_user;
  delete from public.feedback_messages where chat_user = p_user;
  delete from public.call_sync_devices where user_id = p_user;
  delete from public.call_lock_devices where user_id = p_user;
  delete from public.app_nudges where user_id = p_user;

  -- The profile: no name, no contact, never active again
  update public.profiles set
    full_name = 'Deleted user',
    phone = null,
    email = null,
    avatar_url = null,
    is_active = false,
    deactivated_at = coalesce(deactivated_at, now()),
    deleted_at = now(),
    course_ids = null,
    call_sync_required = false
  where id = p_user;
  perform set_config('app.bypass_profile_guard', 'off', true);

  -- The login: no e-mail, no password, banned for ever, signed out everywhere
  update auth.users set
    email = 'deleted-' || replace(p_user::text, '-', '') || '@deleted.invalid',
    phone = null,
    raw_user_meta_data = '{}'::jsonb
  where id = p_user;
  if exists (select 1 from information_schema.columns
             where table_schema = 'auth' and table_name = 'users' and column_name = 'banned_until') then
    execute 'update auth.users set encrypted_password = '''', banned_until = ''infinity'',
               email_confirmed_at = null, phone_confirmed_at = null where id = $1' using p_user;
  end if;
  if to_regclass('auth.identities') is not null then
    execute 'delete from auth.identities where user_id = $1' using p_user;
  end if;
  if to_regclass('auth.sessions') is not null then
    execute 'delete from auth.sessions where user_id = $1' using p_user;
  end if;
  if to_regclass('auth.refresh_tokens') is not null then
    execute 'delete from auth.refresh_tokens where user_id = $1::text' using p_user;
  end if;

  insert into public.user_events (user_id, by_user, action, details)
  values (p_user, p_by, 'account_deleted',
          jsonb_strip_nulls(jsonb_build_object('reason', nullif(trim(coalesce(p_reason, '')), ''), 'leads_unassigned', v_leads)));
end;
$$;

revoke all on function public.close_account(uuid, uuid, text) from public, anon, authenticated;

-- ---------------------------------------------------------------------
-- 🗑 Me, signed in (app or website)
-- ---------------------------------------------------------------------
create or replace function public.delete_my_account(p_reason text default null)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if auth.uid() is null then raise exception 'Please sign in first.'; end if;
  perform public.close_account(auth.uid(), auth.uid(), p_reason);
  -- an open request for the same account is done too
  update public.account_deletion_requests set done_at = now(), done_by = auth.uid(), result = 'deleted'
   where user_id = auth.uid() and done_at is null;
end;
$$;

revoke all on function public.delete_my_account(text) from public, anon;
grant execute on function public.delete_my_account(text) to authenticated;

-- ---------------------------------------------------------------------
-- 🌐 The public page: "I can't sign in, please delete my account"
-- ---------------------------------------------------------------------
create or replace function public.request_account_deletion(p_name text, p_contact text, p_note text default null)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_contact text := nullif(trim(coalesce(p_contact, '')), '');
  v_phone   text := public.normalize_bd_phone(v_contact);
  v_user    uuid;
  v_id      uuid;
  a         uuid;
begin
  if v_contact is null or length(v_contact) < 5 then
    raise exception 'Please type the e-mail or phone number of the account.';
  end if;
  -- the same contact at most 3 times a day (no flooding)
  if (select count(*) from public.account_deletion_requests
      where lower(contact) = lower(v_contact) and created_at > now() - interval '1 day') >= 3 then
    raise exception 'We already have your request. An admin will handle it soon.';
  end if;

  select p.id into v_user from public.profiles p
  where p.deleted_at is null
    and (lower(p.email) = lower(v_contact) or (v_phone is not null and p.phone = v_phone))
  limit 1;

  insert into public.account_deletion_requests (name, contact, note, user_id)
  values (left(nullif(trim(coalesce(p_name, '')), ''), 120), left(v_contact, 120), left(nullif(trim(coalesce(p_note, '')), ''), 500), v_user)
  returning id into v_id;

  for a in select x.id from public.profiles x join public.roles r on r.key = x.role_key
           where x.is_active and x.deleted_at is null
             and ('*' = any (r.permissions) or 'users.manage' = any (r.permissions)) loop
    perform public.notify(a, 'signup', '🗑 Account deletion request',
      coalesce(nullif(trim(coalesce(p_name, '')), ''), v_contact) ||
        case when v_user is null then ' · no account found with this contact' else ' · Users → Deletion requests' end,
      jsonb_build_object('route', '/users/deletion-requests'), 'deletion:' || v_id, true);
  end loop;
end;
$$;

revoke all on function public.request_account_deletion(text, text, text) from public;
grant execute on function public.request_account_deletion(text, text, text) to anon, authenticated;

-- ---------------------------------------------------------------------
-- 🛠 Admins: handle a request
-- ---------------------------------------------------------------------
create or replace function public.admin_delete_account(p_request uuid, p_user uuid default null)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  r public.account_deletion_requests;
  v_user uuid;
begin
  if not public.has_permission('users.manage') then raise exception 'Only an admin can do this.'; end if;
  select * into r from public.account_deletion_requests where id = p_request for update;
  if r.id is null then raise exception 'Request not found.'; end if;
  if r.done_at is not null then raise exception 'This request is done already.'; end if;
  v_user := coalesce(p_user, r.user_id);
  if v_user is null then raise exception 'No account matches this request. Pick the person, or close it.'; end if;
  if v_user = auth.uid() then raise exception 'Use Delete my account for your own account.'; end if;
  perform public.close_account(v_user, auth.uid(), 'Request: ' || coalesce(r.note, r.contact));
  update public.account_deletion_requests set done_at = now(), done_by = auth.uid(), result = 'deleted', user_id = v_user
   where id = r.id;
end;
$$;

create or replace function public.close_deletion_request(p_request uuid, p_result text default 'rejected')
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if not public.has_permission('users.manage') then raise exception 'Only an admin can do this.'; end if;
  update public.account_deletion_requests set done_at = now(), done_by = auth.uid(),
         result = case when p_result in ('not_found', 'rejected') then p_result else 'rejected' end
   where id = p_request and done_at is null;
end;
$$;

revoke all on function public.admin_delete_account(uuid, uuid) from public, anon;
grant execute on function public.admin_delete_account(uuid, uuid) to authenticated;
revoke all on function public.close_deletion_request(uuid, text) from public, anon;
grant execute on function public.close_deletion_request(uuid, text) to authenticated;
