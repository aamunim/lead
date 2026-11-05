-- =====================================================================
-- 📞 Call log sync required (one person at a time, the Super Admin only)
--   When it is on for someone, their Android app does not open until call
--   log permission is given and Call log sync is on in that phone.
--   (The phone already reports its state: Sync health shows it.)
-- =====================================================================

alter table public.profiles
  add column if not exists call_sync_required boolean not null default false,
  add column if not exists call_sync_required_at timestamptz,
  add column if not exists call_sync_required_by uuid references public.profiles(id) on delete set null;

-- Nobody else can turn it on or off (not even for themselves)
create or replace function public.guard_call_sync_required()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if new.call_sync_required is distinct from old.call_sync_required
     and coalesce(current_setting('app.bypass_profile_guard', true), '') <> 'on'
     and public.current_role_key() is distinct from 'super_admin' then
    raise exception 'Only the Super Admin can change this.';
  end if;
  return new;
end;
$$;
drop trigger if exists profiles_guard_call_sync_required on public.profiles;
create trigger profiles_guard_call_sync_required before update on public.profiles
for each row execute function public.guard_call_sync_required();

create or replace function public.set_call_sync_required(p_user uuid, p_required boolean)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if public.current_role_key() is distinct from 'super_admin' then
    raise exception 'Only the Super Admin can change this.';
  end if;
  update public.profiles
     set call_sync_required = coalesce(p_required, false),
         call_sync_required_at = case when p_required then now() else null end,
         call_sync_required_by = case when p_required then auth.uid() else null end
   where id = p_user;
  if not found then raise exception 'User not found.'; end if;

  if p_required and p_user <> auth.uid() then
    perform public.notify(
      p_user, 'sync_nudge',
      '📞 Turn on Call log sync',
      'The Super Admin asked for Call log sync on your phone. Open the app to set it up.',
      jsonb_build_object('route', '/call-sync'),
      'sync-required:' || to_char(now(), 'YYYYMMDDHH24'), false);
  end if;
end;
$$;
grant execute on function public.set_call_sync_required(uuid, boolean) to authenticated;

notify pgrst, 'reload schema';
