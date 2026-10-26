-- =====================================================================
-- Call log upgrades:
--   #7  sync health per phone
--   #1/#2 lead directory for on-phone notifications
--   #5  attempt counter + "unreachable"
--   #1  add a note to a synced call later
--   #6  talk-time report
--   #11 best-time heatmap
-- =====================================================================

-- ---------------------------------------------------------------------
-- 0. New settings for #5 (merged into call_sync)
-- ---------------------------------------------------------------------
update public.app_settings
   set value = jsonb_build_object('unreachable_after', 5, 'unreachable_retry_days', 7) || value
 where key = 'call_sync';

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
           'unreachable_after', 5, 'unreachable_retry_days', 7
         )
         || coalesce((select value from public.app_settings where key = 'call_sync'), '{}'::jsonb);
$$;

-- ---------------------------------------------------------------------
-- 1. Sync health (#7): one row per user + phone
-- ---------------------------------------------------------------------
create table if not exists public.call_sync_devices (
  user_id        uuid not null default auth.uid() references public.profiles(id) on delete cascade,
  device_id      text not null,
  device_label   text,
  app_version    text,
  permission_ok  boolean,
  sync_on        boolean,
  sim_label      text,
  pending_count  integer,
  last_sync_at   timestamptz,
  last_error     text,
  updated_at     timestamptz not null default now(),
  primary key (user_id, device_id)
);

alter table public.call_sync_devices enable row level security;

-- Own phones; Team Leads see their team's; user managers see everyone
create policy "call_sync_devices: view"
  on public.call_sync_devices for select
  to authenticated
  using (
    public.is_active_user()
    and (
      user_id = auth.uid()
      or public.has_permission('users.manage')
      or exists (select 1 from public.profiles p where p.id = call_sync_devices.user_id and p.team_lead_id = auth.uid())
    )
  );

create policy "call_sync_devices: add own"
  on public.call_sync_devices for insert
  to authenticated
  with check (public.is_active_user() and user_id = auth.uid());

create policy "call_sync_devices: update own"
  on public.call_sync_devices for update
  to authenticated
  using (user_id = auth.uid())
  with check (user_id = auth.uid());

-- The app reports its state after every sync (or failed sync)
create or replace function public.report_sync_status(p_device_id text, p_info jsonb)
returns void
language sql
security invoker
set search_path = public
as $$
  insert into public.call_sync_devices (
    user_id, device_id, device_label, app_version, permission_ok, sync_on,
    sim_label, pending_count, last_sync_at, last_error, updated_at
  )
  values (
    auth.uid(), p_device_id,
    p_info->>'device_label', p_info->>'app_version',
    (p_info->>'permission_ok')::boolean, (p_info->>'sync_on')::boolean,
    p_info->>'sim_label', (p_info->>'pending_count')::int,
    case when coalesce(p_info->>'error', '') = '' then now() else null end,
    nullif(p_info->>'error', ''),
    now()
  )
  on conflict (user_id, device_id) do update set
    device_label  = excluded.device_label,
    app_version   = excluded.app_version,
    permission_ok = excluded.permission_ok,
    sync_on       = excluded.sync_on,
    sim_label     = excluded.sim_label,
    pending_count = excluded.pending_count,
    last_sync_at  = coalesce(excluded.last_sync_at, call_sync_devices.last_sync_at),
    last_error    = excluded.last_error,
    updated_at    = now();
$$;

grant execute on function public.report_sync_status(text, jsonb) to authenticated;

-- ---------------------------------------------------------------------
-- 2. Lead directory for the phone (#1, #2)
--    Hash of each lead number + a few details, only for leads this user
--    can see. Lets the phone recognise a lead call with no internet.
-- ---------------------------------------------------------------------
create or replace function public.my_lead_directory()
returns table (hash text, lead_id uuid, name text, rating text, stage text, course text, last_note text)
language sql
stable
security invoker
set search_path = public, extensions
as $$
  with visible as (
    select l.id, l.name, l.rating, l.phone, l.alt_phone, s.name as stage,
           (select c.name from public.lead_courses lc join public.courses c on c.id = lc.course_id
             where lc.lead_id = l.id limit 1) as course,
           (select cl.notes from public.call_logs cl
             where cl.lead_id = l.id and cl.notes is not null
             order by cl.called_at desc limit 1) as last_note
    from public.leads l
    left join public.pipeline_stages s on s.id = l.stage_id
    where l.deleted_at is null
    order by l.updated_at desc nulls last
    limit 10000
  )
  select encode(digest(v.phone, 'sha256'), 'hex'), v.id, v.name, v.rating, v.stage, v.course, left(v.last_note, 120)
  from visible v
  union all
  select encode(digest(v.alt_phone, 'sha256'), 'hex'), v.id, v.name, v.rating, v.stage, v.course, left(v.last_note, 120)
  from visible v
  where v.alt_phone is not null;
$$;

grant execute on function public.my_lead_directory() to authenticated;

-- ---------------------------------------------------------------------
-- 3. Attempts / unreachable (#5)
-- ---------------------------------------------------------------------
alter table public.leads
  add column if not exists call_attempts integer not null default 0,  -- unanswered calls in a row
  add column if not exists unreachable_at timestamptz;

create index if not exists leads_unreachable_idx on public.leads (unreachable_at) where unreachable_at is not null;

-- ---------------------------------------------------------------------
-- 4. A note can be added to your own call later (once, within 24 hours) (#1)
-- ---------------------------------------------------------------------
create or replace function public.guard_call_log_update()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  if auth.uid() is null then return new; end if;   -- database tools

  -- Never changes
  if new.lead_id    is distinct from old.lead_id
     or new.user_id    is distinct from old.user_id
     or new.outcome    is distinct from old.outcome
     or new.called_at  is distinct from old.called_at
     or new.created_at is distinct from old.created_at then
    raise exception 'Call history cannot be changed.';
  end if;

  -- Note: may be added once, within 24 hours of the call
  if new.notes is distinct from old.notes
     and (old.notes is not null or old.called_at < now() - interval '24 hours') then
    raise exception 'A note can only be added once, within 24 hours of the call.';
  end if;

  -- Phone details: only while the call isn't matched to the phone yet
  if old.device_call_id is not null and (
       new.device_id      is distinct from old.device_id
       or new.device_call_id is distinct from old.device_call_id
       or new.duration_sec   is distinct from old.duration_sec
       or new.direction      is distinct from old.direction
       or new.sim_label      is distinct from old.sim_label
       or new.phone_verified is distinct from old.phone_verified) then
    raise exception 'Call history cannot be changed.';
  end if;

  return new;
end;
$$;

-- ---------------------------------------------------------------------
-- 5. After a call is saved (replaces the earlier version)
--    + attempt counter and "unreachable"
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
begin
  if v_reached then
    update public.leads
       set last_contacted_at = greatest(coalesce(last_contacted_at, new.called_at), new.called_at)
     where id = new.lead_id;

    update public.follow_ups
       set status = 'done',
           completed_at = new.called_at,
           completed_by = new.user_id,
           call_id = new.id
     where lead_id = new.lead_id
       and status = 'pending'
       and due_at < date_trunc('day', now() at time zone 'Asia/Dhaka') at time zone 'Asia/Dhaka' + interval '1 day';
  end if;

  -- Attempts: talking resets; an unanswered call we made adds one
  if new.outcome = 'connected' then
    update public.leads set call_attempts = 0, unreachable_at = null where id = new.lead_id;
  elsif new.direction = 'outgoing' and new.outcome in ('no_answer', 'busy', 'switched_off') then
    update public.leads
       set call_attempts = call_attempts + 1
     where id = new.lead_id
     returning call_attempts into v_attempts;

    -- Too many tries in a row: mark unreachable and try again later
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

  insert into public.lead_activity (lead_id, user_id, action, details)
  values (
    new.lead_id,
    new.user_id,
    'call_logged',
    jsonb_build_object('outcome', new.outcome, 'call_id', new.id, 'direction', new.direction, 'source', new.source)
  );

  -- Missed call from the lead → "call back" (only if nothing is planned yet)
  if new.direction in ('missed', 'rejected')
     and coalesce((v_cfg->>'missed_follow_up')::boolean, true)
     and not exists (select 1 from public.follow_ups f where f.lead_id = new.lead_id and f.status = 'pending') then
    insert into public.follow_ups (lead_id, due_at, note, created_by)
    values (new.lead_id, new.called_at, '📵 Missed call from this lead. Call back.', new.user_id);
  end if;

  return new;
end;
$$;

-- ---------------------------------------------------------------------
-- 6. Talk-time report (#6): per person, per day (Bangladesh time)
--    Callers see their own; Team Leads their team; admins everyone.
-- ---------------------------------------------------------------------
create or replace function public.call_report(p_from date, p_to date, p_user_id uuid default null)
returns table (
  user_id uuid, user_name text, day date,
  calls int, outgoing int, connected int, missed int,
  talk_sec int, avg_talk_sec int, short_connected int,
  first_call timestamptz, last_call timestamptz
)
language sql
stable
security invoker
set search_path = public
as $$
  select c.user_id, p.full_name,
         (c.called_at at time zone 'Asia/Dhaka')::date as day,
         count(*)::int,
         count(*) filter (where c.direction = 'outgoing')::int,
         count(*) filter (where c.outcome = 'connected')::int,
         count(*) filter (where c.direction in ('missed', 'rejected'))::int,
         coalesce(sum(c.duration_sec) filter (where c.outcome = 'connected'), 0)::int,
         coalesce(avg(c.duration_sec) filter (where c.outcome = 'connected'), 0)::int,
         count(*) filter (where c.outcome = 'connected' and coalesce(c.duration_sec, 0) between 1 and 10)::int,
         min(c.called_at), max(c.called_at)
  from public.call_logs c
  join public.profiles p on p.id = c.user_id
  where (c.called_at at time zone 'Asia/Dhaka')::date between p_from and p_to
    and (p_user_id is null or c.user_id = p_user_id)
    and (
      public.has_permission('leads.view_all')
      or c.user_id = auth.uid()
      or (public.has_permission('leads.view_team') and p.team_lead_id = auth.uid())
    )
  group by c.user_id, p.full_name, (c.called_at at time zone 'Asia/Dhaka')::date
  order by day desc, p.full_name;
$$;

grant execute on function public.call_report(date, date, uuid) to authenticated;

-- ---------------------------------------------------------------------
-- 7. Best-time heatmap (#11): our calls by weekday × hour
--    dow: 0 = Sunday … 6 = Saturday (Bangladesh time)
-- ---------------------------------------------------------------------
create or replace function public.call_heatmap(p_from date, p_to date, p_user_id uuid default null)
returns table (dow int, hour int, attempts int, connected int)
language sql
stable
security invoker
set search_path = public
as $$
  select extract(dow  from c.called_at at time zone 'Asia/Dhaka')::int,
         extract(hour from c.called_at at time zone 'Asia/Dhaka')::int,
         count(*)::int,
         count(*) filter (where c.outcome = 'connected')::int
  from public.call_logs c
  join public.profiles p on p.id = c.user_id
  where c.direction = 'outgoing'
    and (c.called_at at time zone 'Asia/Dhaka')::date between p_from and p_to
    and (p_user_id is null or c.user_id = p_user_id)
    and (
      public.has_permission('leads.view_all')
      or c.user_id = auth.uid()
      or (public.has_permission('leads.view_team') and p.team_lead_id = auth.uid())
    )
  group by 1, 2;
$$;

grant execute on function public.call_heatmap(date, date, uuid) to authenticated;

notify pgrst, 'reload schema';