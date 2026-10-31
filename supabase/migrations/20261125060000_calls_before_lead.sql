-- =====================================================================
-- 📞 Calls made before the number was saved as a lead
--   Call log sync used to drop calls with numbers that are not leads. Now
--   they wait on the server for a few days (Settings → Call log sync:
--   on/off, 15 days by default): only the number's hash, time, length,
--   direction, SIM, who called and from which phone. Nobody can see them.
--   When a lead is saved with that number (or a lead gets that phone / other
--   phone), the waiting calls go into its Calls & notes as history: they
--   set "last contacted", but don't close follow-ups, count attempts, make
--   "call back" reminders or send missed-call alerts.
--   1. Setting (call_sync: hold_calls, hold_days)
--   2. held_calls (server only) + hold_call()
--   3. sync_phone_calls(): keeps calls that are not leads yet
--   4. claim_held_calls() + trigger on leads
--   5. after_call_logged() / notify_missed_call(): "earlier" calls are history
--   6. Daily clean-up
-- =====================================================================

-- ---------------------------------------------------------------------
-- 1. Setting
-- ---------------------------------------------------------------------
create or replace function public.call_sync_setting()
returns jsonb
language sql
stable
security definer
set search_path = public
as $$
  select jsonb_build_object(
           'enabled', true, 'mode', 'all', 'roles', '[]'::jsonb, 'user_ids', '[]'::jsonb,
           'incoming', true, 'missed_follow_up', true, 'connected_min_sec', 5,
           'unreachable_after', 5, 'unreachable_retry_days', 7,
           'hold_calls', true, 'hold_days', 15
         )
         || coalesce((select value from public.app_settings where key = 'call_sync'), '{}'::jsonb);
$$;

-- ---------------------------------------------------------------------
-- 2. Calls waiting for their lead (server only: no row security policies)
-- ---------------------------------------------------------------------
create table if not exists public.held_calls (
  id             uuid primary key default gen_random_uuid(),
  user_id        uuid not null references public.profiles(id) on delete cascade,
  device_id      text not null,
  device_call_id text not null,
  phone_hash     text not null,
  direction      text not null,
  duration_sec   integer not null default 0,
  called_at      timestamptz not null,
  sim_label      text,
  created_at     timestamptz not null default now(),
  unique (user_id, device_id, device_call_id)
);
create index if not exists held_calls_hash_idx on public.held_calls (phone_hash);
create index if not exists held_calls_called_idx on public.held_calls (called_at);
alter table public.held_calls enable row level security;

create or replace function public.hold_call(
  p_device_id text, p_call_id text, p_hash text, p_direction text, p_duration int, p_at timestamptz, p_sim text
)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_cfg jsonb := public.call_sync_setting();
begin
  if auth.uid() is null or p_hash is null or p_call_id is null or p_at is null then return; end if;
  if not coalesce((v_cfg->>'hold_calls')::boolean, true) then return; end if;
  if p_at < now() - make_interval(days => greatest(coalesce((v_cfg->>'hold_days')::int, 15), 1)) then return; end if;

  insert into public.held_calls (user_id, device_id, device_call_id, phone_hash, direction, duration_sec, called_at, sim_label)
  values (auth.uid(), p_device_id, p_call_id, p_hash, coalesce(p_direction, 'outgoing'), greatest(coalesce(p_duration, 0), 0), p_at, p_sim)
  on conflict (user_id, device_id, device_call_id) do nothing;
end;
$$;

revoke execute on function public.hold_call(text, text, text, text, int, timestamptz, text) from public, anon;
grant execute on function public.hold_call(text, text, text, text, int, timestamptz, text) to authenticated;

-- ---------------------------------------------------------------------
-- 3. Sync: same as before, but calls that are not leads yet are held
-- ---------------------------------------------------------------------
create or replace function public.sync_phone_calls(p_device_id text, p_calls jsonb)
returns jsonb
language plpgsql
security invoker
set search_path = public, extensions
as $$
declare
  v_cfg      jsonb := public.call_sync_setting();
  v_min      int := coalesce((v_cfg->>'connected_min_sec')::int, 5);
  v_incoming boolean := coalesce((v_cfg->>'incoming')::boolean, true);
  v_call     jsonb;
  v_hash     text;
  v_lead     uuid;
  v_dir      text;
  v_dur      int;
  v_at       timestamptz;
  v_outcome  text;
  v_match    uuid;
  v_added    int := 0;
  v_matched  int := 0;
  v_ignored  int := 0;
begin
  if not public.can_sync_calls() then
    raise exception 'Call log sync is not turned on for you.';
  end if;

  for v_call in select * from jsonb_array_elements(coalesce(p_calls, '[]'::jsonb))
  loop
    v_dir  := coalesce(v_call->>'direction', 'outgoing');
    v_dur  := greatest(coalesce((v_call->>'duration_sec')::int, 0), 0);
    v_at   := (v_call->>'called_at')::timestamptz;
    v_hash := v_call->>'hash';

    -- Incoming / missed calls switched off in Settings
    if v_dir <> 'outgoing' and not v_incoming then
      v_ignored := v_ignored + 1;
      continue;
    end if;

    -- Already synced from this phone
    if exists (
      select 1 from public.call_logs
      where user_id = auth.uid() and device_id = p_device_id and device_call_id = v_call->>'id'
    ) then
      continue;
    end if;

    -- A lead this user can see, with this number (row security decides what "can see" means)
    select x.id into v_lead
    from (
      select l.id, l.created_at from public.leads l
      where l.phone_hash = v_hash and l.deleted_at is null
      union all
      select l.id, l.created_at from public.leads l
      where l.alt_phone_hash = v_hash and l.deleted_at is null
    ) x
    order by x.created_at desc
    limit 1;

    if v_lead is null then
      -- Not a lead (yet): kept for a few days in case it is saved as a lead
      -- (only the number's hash, time and length; see hold_call)
      perform public.hold_call(p_device_id, v_call->>'id', v_hash, v_dir, v_dur, v_at, v_call->>'sim');
      v_ignored := v_ignored + 1;
      continue;
    end if;

    -- A call saved from the app popup a few minutes around this time? Match it instead.
    select c.id into v_match
    from public.call_logs c
    where c.user_id = auth.uid()
      and c.lead_id = v_lead
      and c.device_call_id is null
      and c.called_at between v_at - interval '10 minutes' and v_at + interval '10 minutes'
    order by abs(extract(epoch from (c.called_at - v_at)))
    limit 1;

    if v_match is not null then
      update public.call_logs
         set device_id = p_device_id,
             device_call_id = v_call->>'id',
             duration_sec = v_dur,
             direction = v_dir,
             sim_label = v_call->>'sim',
             phone_verified = true
       where id = v_match;
      v_matched := v_matched + 1;
      continue;
    end if;

    v_outcome := case
      when v_dir = 'outgoing' then case when v_dur >= v_min then 'connected' else 'no_answer' end
      when v_dir = 'incoming' then case when v_dur > 0 then 'connected' else 'missed' end
      else v_dir   -- missed / rejected
    end;

    insert into public.call_logs (
      lead_id, user_id, called_at, outcome, duration_sec, notes,
      direction, source, device_id, device_call_id, sim_label, phone_verified
    )
    values (
      v_lead, auth.uid(), v_at, v_outcome, v_dur, null,
      v_dir, 'phone', p_device_id, v_call->>'id', v_call->>'sim', true
    )
    on conflict do nothing;

    v_added := v_added + 1;
  end loop;

  return jsonb_build_object('added', v_added, 'matched', v_matched, 'ignored', v_ignored);
end;
$$;

grant execute on function public.sync_phone_calls(text, jsonb) to authenticated;

-- ---------------------------------------------------------------------
-- 4. A lead with this number: the waiting calls become its history
-- ---------------------------------------------------------------------
create or replace function public.claim_held_calls(p_lead_id uuid)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  v_lead  public.leads;
  v_cfg   jsonb := public.call_sync_setting();
  v_min   int := coalesce((v_cfg->>'connected_min_sec')::int, 5);
  v_in    boolean := coalesce((v_cfg->>'incoming')::boolean, true);
  h       public.held_calls;
  n       integer := 0;
begin
  select * into v_lead from public.leads where id = p_lead_id and deleted_at is null;
  if v_lead.id is null or (v_lead.phone_hash is null and v_lead.alt_phone_hash is null) then return 0; end if;

  perform set_config('app.earlier_calls', 'on', true);
  for h in
    delete from public.held_calls
     where phone_hash in (v_lead.phone_hash, v_lead.alt_phone_hash)
    returning *
  loop
    if h.direction <> 'outgoing' and not v_in then continue; end if;
    insert into public.call_logs (
      lead_id, user_id, called_at, outcome, duration_sec, notes,
      direction, source, device_id, device_call_id, sim_label, phone_verified
    )
    values (
      v_lead.id, h.user_id, h.called_at,
      case
        when h.direction = 'outgoing' then case when h.duration_sec >= v_min then 'connected' else 'no_answer' end
        when h.direction = 'incoming' then case when h.duration_sec > 0 then 'connected' else 'missed' end
        else h.direction
      end,
      h.duration_sec, null, h.direction, 'phone', h.device_id, h.device_call_id, h.sim_label, true
    )
    on conflict do nothing;
    n := n + 1;
  end loop;
  perform set_config('app.earlier_calls', 'off', true);
  return n;
end;
$$;

revoke execute on function public.claim_held_calls(uuid) from public, anon, authenticated;

create or replace function public.leads_claim_held_calls()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if new.deleted_at is null and (new.phone_hash is not null or new.alt_phone_hash is not null) then
    perform public.claim_held_calls(new.id);
  end if;
  return null;
end;
$$;

drop trigger if exists leads_claim_held_calls on public.leads;
create trigger leads_claim_held_calls
  after insert or update of phone_hash, alt_phone_hash on public.leads
  for each row execute function public.leads_claim_held_calls();

-- ---------------------------------------------------------------------
-- 5. After a call is saved (replaces the version in 20261105060000):
--    an "earlier" call only sets last contacted and the timeline line
-- ---------------------------------------------------------------------
create or replace function public.after_call_logged()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_cfg      jsonb := public.call_sync_setting();
  v_reached  boolean := new.direction = 'outgoing' or new.outcome = 'connected';
  v_after    int := coalesce((v_cfg->>'unreachable_after')::int, 5);
  v_retry    int := coalesce((v_cfg->>'unreachable_retry_days')::int, 7);
  v_attempts int;
  v_kind     text;
  -- A call made before the number was a lead (held_calls): history only
  v_earlier  boolean := coalesce(current_setting('app.earlier_calls', true), '') = 'on';
begin
  select s.kind into v_kind
  from public.leads l
  join public.pipeline_stages s on s.id = l.stage_id
  where l.id = new.lead_id;

  if v_reached then
    update public.leads
       set last_contacted_at = greatest(coalesce(last_contacted_at, new.called_at), new.called_at)
     where id = new.lead_id;

    if not v_earlier then
    update public.follow_ups
       set status = 'done',
           completed_at = new.called_at,
           completed_by = new.user_id,
           call_id = new.id
     where lead_id = new.lead_id
       and status = 'pending'
       and due_at < date_trunc('day', now() at time zone 'Asia/Dhaka') at time zone 'Asia/Dhaka' + interval '1 day';
    end if;
  end if;

  -- Attempts only count while the lead is open (messages never count)
  if coalesce(v_kind, 'open') = 'open' and not v_earlier then
    if new.outcome = 'connected' then
      update public.leads set call_attempts = 0, unreachable_at = null where id = new.lead_id;
    elsif new.direction = 'outgoing' and new.outcome in ('no_answer', 'busy', 'switched_off') then
      update public.leads
         set call_attempts = call_attempts + 1
       where id = new.lead_id
       returning call_attempts into v_attempts;

      if v_attempts >= v_after then
        update public.leads
           set unreachable_at = coalesce(unreachable_at, now())
         where id = new.lead_id;

        if not exists (select 1 from public.follow_ups f where f.lead_id = new.lead_id and f.status = 'pending') then
          insert into public.follow_ups (lead_id, due_at, note, created_by)
          values (
            new.lead_id,
            now() + make_interval(days => v_retry),
            format('🔕 No answer %s times in a row. Try again.', v_attempts),
            new.user_id
          );
        end if;
      end if;
    end if;
  end if;

  insert into public.lead_activity (lead_id, user_id, action, details)
  values (
    new.lead_id,
    new.user_id,
    'call_logged',
    jsonb_build_object('outcome', new.outcome, 'call_id', new.id, 'direction', new.direction,
                       'source', new.source, 'channel', new.channel, 'media', new.media)
      || case when v_earlier then jsonb_build_object('earlier', true) else '{}'::jsonb end
  );

  -- Missed call from the lead → call back (only if nothing is planned yet)
  if new.direction in ('missed', 'rejected')
     and not v_earlier
     and coalesce((v_cfg->>'missed_follow_up')::boolean, true)
     and not exists (select 1 from public.follow_ups f where f.lead_id = new.lead_id and f.status = 'pending') then
    if coalesce(v_kind, 'open') = 'open' then
      insert into public.follow_ups (lead_id, due_at, note, created_by)
      values (new.lead_id, new.called_at,
              case when new.channel = 'whatsapp' then '📵 Missed WhatsApp call from this lead. Call back.'
                   else '📵 Missed call from this lead. Call back.' end,
              new.user_id);
    elsif v_kind = 'lost' then
      insert into public.follow_ups (lead_id, due_at, note, created_by, purpose)
      values (new.lead_id, new.called_at, '♻️ This lost lead called you. Call back, they may be interested again.', new.user_id, 'revive');
    end if;
    -- Admitted / Cancelled: no follow-up, the call is on the timeline
  end if;

  return new;
end;
$$;

create or replace function public.notify_missed_call()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_lead public.leads;
  v_wa   boolean := new.channel = 'whatsapp';
begin
  if new.direction not in ('missed', 'rejected') then return null; end if;
  -- A call from before the number was a lead: no alert now
  if coalesce(current_setting('app.earlier_calls', true), '') = 'on' then return null; end if;
  select * into v_lead from public.leads where id = new.lead_id and deleted_at is null;
  -- The phone that missed it already shows its own alert
  if v_lead.assigned_to is null or v_lead.assigned_to = new.user_id then return null; end if;
  perform public.notify(
    v_lead.assigned_to, 'missed_call',
    case when v_wa then '📵 Missed WhatsApp call from ' else '📵 Missed call from ' end || v_lead.name,
    concat_ws(' ',
      public.lead_contact_label(v_lead.phone, v_lead.whatsapp_number, v_lead.whatsapp_username),
      'called ' || public.person_name(new.user_id) || case when v_wa then ' on WhatsApp' else '' end || '. Call back?'),
    jsonb_build_object('lead_id', v_lead.id), 'missed:' || new.id);
  return null;
end;
$$;

-- ---------------------------------------------------------------------
-- 6. Waiting calls are kept for the set number of days only
-- ---------------------------------------------------------------------
create or replace function public.held_calls_cleanup()
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  v_cfg  jsonb := public.call_sync_setting();
  v_days int := greatest(coalesce((v_cfg->>'hold_days')::int, 15), 1);
  n      integer;
begin
  if not coalesce((v_cfg->>'hold_calls')::boolean, true) then
    delete from public.held_calls;
  else
    delete from public.held_calls where called_at < now() - make_interval(days => v_days);
  end if;
  get diagnostics n = row_count;
  return n;
end;
$$;

revoke execute on function public.held_calls_cleanup() from public, anon, authenticated;

do $$
begin
  perform cron.schedule('held-calls-cleanup', '23 21 * * *', 'select public.held_calls_cleanup()');
exception when others then
  raise notice 'pg_cron is not available: run held_calls_cleanup() daily';
end;
$$;

notify pgrst, 'reload schema';
