-- =====================================================================
-- 📵 Call lock: while someone talks with a lead, others can't call it.
--   - a call from the app marks the lead "on call" before dialing; a
--     second person then sees "🚫 Rahim is on a call with this lead"
--   - 2.8.0 phones also mark an answered incoming lead call, and clear
--     the mark the moment any call ends (a key per phone, see below)
--   - the mark ends by itself after N minutes (Settings → Call lock)
--   - block or only warn; who may call anyway; WhatsApp calls too or not
-- =====================================================================

insert into public.app_settings (key, value, description)
values ('call_lock',
        '{"enabled": true, "mode": "block", "minutes": 15, "override": "admin", "whatsapp": false, "cards": true}',
        'Call lock: one person on a call with a lead at a time')
on conflict (key) do nothing;

create table if not exists public.call_locks (
  lead_id    uuid primary key references public.leads(id) on delete cascade,
  user_id    uuid not null references public.profiles(id) on delete cascade,
  channel    text not null default 'phone',     -- phone | whatsapp
  source     text not null default 'app',       -- app | incoming
  started_at timestamptz not null default now(),
  expires_at timestamptz not null
);
create index if not exists call_locks_user_idx on public.call_locks (user_id);
alter table public.call_locks enable row level security;
-- read and written only through the functions below

-- Who may call anyway (setting "override": none | admin | admin_tl)
create or replace function public.call_lock_can_override()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select case coalesce((select value->>'override' from public.app_settings where key = 'call_lock'), 'admin')
           when 'none' then false
           when 'admin_tl' then public.current_role_key() in ('super_admin', 'admin', 'team_lead')
           else public.current_role_key() in ('super_admin', 'admin')
         end;
$$;

-- ---------------------------------------------------------------------
-- Before a call from the app
--   {ok: true} → call; {ok: false, mode, by_name, minutes, can_override} → don't (or ask)
-- ---------------------------------------------------------------------
create or replace function public.start_call_lock(p_lead uuid, p_channel text default 'phone', p_force boolean default false)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  s     jsonb;
  l     record;
  cur   public.call_locks;
  v_min int;
begin
  select value into s from public.app_settings where key = 'call_lock';
  if s is null or not coalesce((s->>'enabled')::boolean, true) then return jsonb_build_object('ok', true); end if;
  if p_channel = 'whatsapp' and not coalesce((s->>'whatsapp')::boolean, false) then
    return jsonb_build_object('ok', true);
  end if;
  if auth.uid() is null then return jsonb_build_object('ok', true); end if;

  select id, assigned_to, created_by into l from public.leads where id = p_lead and deleted_at is null;
  if not found
     or not (public.can_view_lead(l.assigned_to) or public.leads_shared_mode() or l.created_by = auth.uid()) then
    return jsonb_build_object('ok', true); -- not ours to judge: the call goes as before
  end if;

  v_min := greatest(3, least(60, coalesce((s->>'minutes')::int, 15)));

  delete from public.call_locks where lead_id = p_lead and expires_at < now();
  select * into cur from public.call_locks where lead_id = p_lead for update;

  if found and cur.user_id <> auth.uid() then
    if not p_force or (coalesce(s->>'mode', 'block') = 'block' and not public.call_lock_can_override()) then
      return jsonb_build_object(
        'ok', false,
        'mode', coalesce(s->>'mode', 'block'),
        'by', cur.user_id,
        'by_name', (select full_name from public.profiles where id = cur.user_id),
        'minutes', floor(extract(epoch from now() - cur.started_at) / 60)::int,
        'channel', cur.channel,
        'can_override', coalesce(s->>'mode', 'block') = 'warn' or public.call_lock_can_override());
    end if;
    -- "Call anyway": into the change log
    insert into public.lead_activity (lead_id, user_id, action, details)
    values (p_lead, auth.uid(), 'call_lock_override',
            jsonb_build_object('other_user', cur.user_id,
                               'other_name', (select full_name from public.profiles where id = cur.user_id)));
  end if;

  -- One person on a call at a time: their older marks go
  delete from public.call_locks where user_id = auth.uid() and lead_id <> p_lead;
  insert into public.call_locks (lead_id, user_id, channel, source, started_at, expires_at)
  values (p_lead, auth.uid(), coalesce(p_channel, 'phone'), 'app', now(), now() + make_interval(mins => v_min))
  on conflict (lead_id) do update
    set user_id = excluded.user_id, channel = excluded.channel, source = excluded.source,
        started_at = excluded.started_at, expires_at = excluded.expires_at;
  return jsonb_build_object('ok', true);
end;
$$;
grant execute on function public.start_call_lock(uuid, text, boolean) to authenticated;

-- Back in the app after the call (or the call result saved): free again
create or replace function public.end_call_lock(p_lead uuid default null)
returns void
language sql
security definer
set search_path = public
as $$
  delete from public.call_locks
  where user_id = auth.uid() and (p_lead is null or lead_id = p_lead);
$$;
grant execute on function public.end_call_lock(uuid) to authenticated;

-- Who is on a call with these leads now (for the cards; not yourself)
create or replace function public.active_call_locks(p_leads uuid[])
returns table (lead_id uuid, user_id uuid, user_name text, started_at timestamptz, channel text)
language sql
stable
security definer
set search_path = public
as $$
  select c.lead_id, c.user_id, p.full_name, c.started_at, c.channel
  from public.call_locks c
  join public.profiles p on p.id = c.user_id
  where c.lead_id = any(p_leads)
    and c.expires_at > now()
    and c.user_id <> auth.uid()
    and public.is_active_user()
    and coalesce((select (value->>'enabled')::boolean and coalesce((value->>'cards')::boolean, true)
                  from public.app_settings where key = 'call_lock'), true);
$$;
grant execute on function public.active_call_locks(uuid[]) to authenticated;

-- ---------------------------------------------------------------------
-- 📲 The phone's part (2.8.0): a key per phone, kept hashed here
-- ---------------------------------------------------------------------
create table if not exists public.call_lock_devices (
  key_hash   text primary key,
  user_id    uuid not null references public.profiles(id) on delete cascade,
  created_at timestamptz not null default now(),
  last_at    timestamptz
);
alter table public.call_lock_devices enable row level security;

create or replace function public.register_call_lock_device(p_key text)
returns void
language plpgsql
security definer
set search_path = public, extensions
as $$
begin
  if auth.uid() is null or not public.is_active_user() then raise exception 'Please sign in again.'; end if;
  if length(coalesce(p_key, '')) < 24 then raise exception 'Bad key.'; end if;
  insert into public.call_lock_devices (key_hash, user_id)
  values (encode(digest(p_key, 'sha256'), 'hex'), auth.uid())
  on conflict (key_hash) do update set user_id = excluded.user_id, created_at = now();
end;
$$;
grant execute on function public.register_call_lock_device(text) to authenticated;

-- Called by the phone itself (no sign-in there): the key says whose marks
create or replace function public.call_lock_device(p_key text, p_lead uuid default null, p_state text default 'end')
returns void
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  v_user uuid;
  s      jsonb;
  v_min  int;
begin
  select d.user_id into v_user
  from public.call_lock_devices d
  join public.profiles p on p.id = d.user_id and p.is_active
  where d.key_hash = encode(digest(coalesce(p_key, ''), 'sha256'), 'hex');
  if v_user is null then return; end if;
  update public.call_lock_devices set last_at = now()
   where key_hash = encode(digest(p_key, 'sha256'), 'hex');

  if p_state = 'end' then
    delete from public.call_locks where user_id = v_user;
    return;
  end if;

  select value into s from public.app_settings where key = 'call_lock';
  if s is null or not coalesce((s->>'enabled')::boolean, true) or p_lead is null then return; end if;
  if not exists (select 1 from public.leads where id = p_lead and deleted_at is null) then return; end if;
  v_min := greatest(3, least(60, coalesce((s->>'minutes')::int, 15)));
  delete from public.call_locks where lead_id = p_lead and expires_at < now();
  -- an incoming call: marked only when nobody else is on a call with the lead
  insert into public.call_locks (lead_id, user_id, channel, source, started_at, expires_at)
  values (p_lead, v_user, 'phone', 'incoming', now(), now() + make_interval(mins => v_min))
  on conflict (lead_id) do nothing;
end;
$$;
revoke all on function public.call_lock_device(text, uuid, text) from public;
grant execute on function public.call_lock_device(text, uuid, text) to anon, authenticated;

-- Old marks are cleaned up now and then (they already count as over)
do $$
begin
  if exists (select 1 from pg_extension where extname = 'pg_cron') then
    perform cron.unschedule('call-lock-clean') where exists (select 1 from cron.job where jobname = 'call-lock-clean');
    perform cron.schedule('call-lock-clean', '*/30 * * * *', 'delete from public.call_locks where expires_at < now()');
  end if;
end $$;

notify pgrst, 'reload schema';
