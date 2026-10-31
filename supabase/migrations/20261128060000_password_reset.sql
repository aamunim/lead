-- =====================================================================
-- 🔑 Admins reset a user's password (Users → a user → Reset password)
--   The reset itself is done by the Edge Function admin-reset-password
--   (it needs the server key); the database keeps:
--   1. profiles.must_change_password: the user sets a new password of
--      their own before using the app
--   2. user_events: who reset whose password, when (admins can read)
--   3. revoke_user_sessions(): signs the user out everywhere (server only)
--   4. password_changed(): the user has set their own password
-- =====================================================================

alter table public.profiles add column if not exists must_change_password boolean not null default false;

create table if not exists public.user_events (
  id         uuid primary key default gen_random_uuid(),
  user_id    uuid not null references public.profiles(id) on delete cascade,
  by_user    uuid references public.profiles(id) on delete set null,
  action     text not null,               -- 'password_reset' | 'password_changed'
  details    jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);
create index if not exists user_events_user_idx on public.user_events (user_id, created_at desc);
alter table public.user_events enable row level security;

drop policy if exists "user_events: admins read" on public.user_events;
create policy "user_events: admins read" on public.user_events for select to authenticated
  using (public.has_permission('users.manage') or user_id = auth.uid());

-- Signed out on every phone and browser (their saved logins stop working)
create or replace function public.revoke_user_sessions(p_user uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  delete from auth.sessions where user_id = p_user;
end;
$$;

revoke execute on function public.revoke_user_sessions(uuid) from public, anon, authenticated;

-- The signed-in user has just set a password of their own
create or replace function public.password_changed()
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if auth.uid() is null then raise exception 'Please sign in again.'; end if;
  update public.profiles set must_change_password = false where id = auth.uid();
  insert into public.user_events (user_id, by_user, action) values (auth.uid(), auth.uid(), 'password_changed');
end;
$$;

grant execute on function public.password_changed() to authenticated;

notify pgrst, 'reload schema';
