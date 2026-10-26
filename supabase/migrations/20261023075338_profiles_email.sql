-- =====================================================================
-- 0002 · Email sign-up: store email on profiles, phone is contact only
-- =====================================================================

-- Email on the profile (copied from the login account)
alter table public.profiles
  add column email text;

create unique index profiles_email_key
  on public.profiles (lower(email));

-- Phone is now only a contact number, so it no longer has to be unique
alter table public.profiles
  drop constraint if exists profiles_phone_key;

create index profiles_phone_idx on public.profiles (phone);

-- New login user → profile with email, name and phone from the sign-up form
create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.profiles (id, email, phone, full_name)
  values (
    new.id,
    new.email,
    nullif(trim(new.raw_user_meta_data ->> 'phone'), ''),
    nullif(trim(new.raw_user_meta_data ->> 'full_name'), '')
  )
  on conflict (id) do nothing;
  return new;
end;
$$;

-- Keep the profile email in sync if the login email changes
create or replace function public.handle_user_email_change()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  update public.profiles
  set email = new.email
  where id = new.id;
  return new;
end;
$$;

create trigger on_auth_user_email_changed
after update of email on auth.users
for each row
when (old.email is distinct from new.email)
execute function public.handle_user_email_change();