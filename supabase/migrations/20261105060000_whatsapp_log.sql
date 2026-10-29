-- =====================================================================
-- WhatsApp calls and messages in the same call log
--   1. call_logs.channel: 'phone' (as before) or 'whatsapp'
--      call_logs.media:   'voice' | 'video' | 'message' (WhatsApp only)
--      outcome 'message': a WhatsApp message sent (outgoing) or received (incoming)
--   2. The timeline line says which channel
--   3. Team activity counts phone calls and WhatsApp apart
--   4. Phone call reports (call_report, call_heatmap) stay phone only
--   5. whatsapp_report(): the separate WhatsApp part of Reports
-- =====================================================================

-- ---------------------------------------------------------------------
-- 1. Columns
-- ---------------------------------------------------------------------
alter table public.call_logs
  add column if not exists channel text not null default 'phone',
  add column if not exists media   text;

alter table public.call_logs drop constraint if exists call_logs_channel_check;
alter table public.call_logs add constraint call_logs_channel_check
  check (channel in ('phone', 'whatsapp'));

alter table public.call_logs drop constraint if exists call_logs_media_check;
alter table public.call_logs add constraint call_logs_media_check
  check (
    (channel = 'phone' and media is null)
    or (channel = 'whatsapp' and media is not null and media in ('voice', 'video', 'message'))
  );

alter table public.call_logs drop constraint if exists call_logs_outcome_check;
alter table public.call_logs add constraint call_logs_outcome_check
  check (outcome in (
    'connected', 'no_answer', 'busy', 'switched_off', 'wrong_number', 'call_back',
    'missed', 'rejected', 'message'
  ));

-- A message is a message; a call is never 'message'
alter table public.call_logs drop constraint if exists call_logs_message_check;
alter table public.call_logs add constraint call_logs_message_check
  check ((outcome = 'message') = (media is not distinct from 'message'));

create index if not exists call_logs_whatsapp_idx
  on public.call_logs (called_at desc) where channel = 'whatsapp';

-- ---------------------------------------------------------------------
-- 2. After a call is saved (replaces the version in 20261025041859):
--    same rules; the timeline line also says the channel and media.
--    A WhatsApp message we sent counts as contact, like an outgoing call.
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
begin
  select s.kind into v_kind
  from public.leads l
  join public.pipeline_stages s on s.id = l.stage_id
  where l.id = new.lead_id;

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

  -- Attempts only count while the lead is open (messages never count)
  if coalesce(v_kind, 'open') = 'open' then
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
  );

  -- Missed call from the lead → call back (only if nothing is planned yet)
  if new.direction in ('missed', 'rejected')
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

-- ---------------------------------------------------------------------
-- 3. Team activity: phone calls and WhatsApp apart
--    (the return columns change, so drop and create again)
-- ---------------------------------------------------------------------
drop function if exists public.team_activity(date, date);

create function public.team_activity(p_from date, p_to date)
returns table (
  user_id uuid, name text, role_key text, last_seen_at timestamptz,
  app_sec int, sessions int, calls int, connected int, talk_sec int,
  actions int, admitted int, first_at timestamptz, last_at timestamptz,
  wa_calls int, wa_connected int, wa_messages int
)
language sql
stable
security definer
set search_path = public
as $$
  with people as (
    select p.id, p.full_name, p.role_key
    from public.profiles p
    where p.is_active and public.can_see_activity(p.id)
  ),
  ses as (
    select s.user_id, sum(s.active_sec)::int as app_sec, count(*)::int as n,
           min(s.started_at) as first_at, max(s.last_seen_at) as last_at
    from public.app_sessions s
    where (s.started_at at time zone 'Asia/Dhaka')::date between p_from and p_to
    group by s.user_id
  ),
  cl as (
    select c.user_id,
           count(*) filter (where c.channel = 'phone')::int as calls,
           count(*) filter (where c.channel = 'phone' and c.outcome = 'connected')::int as connected,
           coalesce(sum(c.duration_sec) filter (where c.channel = 'phone' and c.outcome = 'connected'), 0)::int as talk_sec,
           count(*) filter (where c.channel = 'whatsapp' and c.outcome <> 'message')::int as wa_calls,
           count(*) filter (where c.channel = 'whatsapp' and c.outcome = 'connected')::int as wa_connected,
           count(*) filter (where c.channel = 'whatsapp' and c.outcome = 'message')::int as wa_messages,
           min(c.called_at) as first_at, max(c.called_at) as last_at
    from public.call_logs c
    where (c.called_at at time zone 'Asia/Dhaka')::date between p_from and p_to
    group by c.user_id
  ),
  act as (
    select a.user_id, count(*)::int as actions, min(a.created_at) as first_at, max(a.created_at) as last_at
    from public.lead_activity a
    where a.action <> 'call_logged'
      and (a.created_at at time zone 'Asia/Dhaka')::date between p_from and p_to
    group by a.user_id
  ),
  adm as (
    select l.admitted_by as user_id, count(*)::int as admitted
    from public.leads l
    join public.pipeline_stages st on st.id = l.stage_id and st.kind = 'won'
    where l.deleted_at is null
      and (l.admitted_at at time zone 'Asia/Dhaka')::date between p_from and p_to
    group by l.admitted_by
  )
  select p.id, p.full_name, p.role_key,
         (select max(s.last_seen_at) from public.app_sessions s where s.user_id = p.id),
         coalesce(ses.app_sec, 0), coalesce(ses.n, 0),
         coalesce(cl.calls, 0), coalesce(cl.connected, 0), coalesce(cl.talk_sec, 0),
         coalesce(act.actions, 0), coalesce(adm.admitted, 0),
         least(ses.first_at, cl.first_at, act.first_at),
         greatest(ses.last_at, cl.last_at, act.last_at),
         coalesce(cl.wa_calls, 0), coalesce(cl.wa_connected, 0), coalesce(cl.wa_messages, 0)
  from people p
  left join ses on ses.user_id = p.id
  left join cl  on cl.user_id  = p.id
  left join act on act.user_id = p.id
  left join adm on adm.user_id = p.id
  order by p.full_name;
$$;

grant execute on function public.team_activity(date, date) to authenticated;

-- One person, day by day: phone calls and WhatsApp apart
drop function if exists public.user_activity_days(uuid, int);

create function public.user_activity_days(p_user_id uuid, p_days int default 14)
returns table (day date, app_sec int, actions int, calls int, wa int)
language sql
stable
security definer
set search_path = public
as $$
  with days as (
    select generate_series((now() at time zone 'Asia/Dhaka')::date - (least(greatest(p_days, 1), 90) - 1),
                           (now() at time zone 'Asia/Dhaka')::date, interval '1 day')::date as day
  )
  select d.day,
         coalesce((select sum(s.active_sec) from public.app_sessions s
                    where s.user_id = p_user_id and (s.started_at at time zone 'Asia/Dhaka')::date = d.day), 0)::int,
         (select count(*) from public.lead_activity a
           where a.user_id = p_user_id and a.action <> 'call_logged'
             and (a.created_at at time zone 'Asia/Dhaka')::date = d.day)::int,
         (select count(*) from public.call_logs c
           where c.user_id = p_user_id and c.channel = 'phone'
             and (c.called_at at time zone 'Asia/Dhaka')::date = d.day)::int,
         (select count(*) from public.call_logs c
           where c.user_id = p_user_id and c.channel = 'whatsapp'
             and (c.called_at at time zone 'Asia/Dhaka')::date = d.day)::int
  from days d
  where public.can_see_activity(p_user_id)
  order by d.day;
$$;

grant execute on function public.user_activity_days(uuid, int) to authenticated;

-- ---------------------------------------------------------------------
-- 4. Reports: phone call numbers stay phone only
--    (replace the versions in 20261024150515; same columns)
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
  where c.channel = 'phone'
    and (c.called_at at time zone 'Asia/Dhaka')::date between p_from and p_to
    and (p_user_id is null or c.user_id = p_user_id)
    and (
      public.has_permission('leads.view_all')
      or c.user_id = auth.uid()
      or (public.has_permission('leads.view_team') and p.team_lead_id = auth.uid())
    )
  group by c.user_id, p.full_name, (c.called_at at time zone 'Asia/Dhaka')::date
  order by day desc, p.full_name;
$$;

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
  where c.channel = 'phone'
    and c.direction = 'outgoing'
    and (c.called_at at time zone 'Asia/Dhaka')::date between p_from and p_to
    and (p_user_id is null or c.user_id = p_user_id)
    and (
      public.has_permission('leads.view_all')
      or c.user_id = auth.uid()
      or (public.has_permission('leads.view_team') and p.team_lead_id = auth.uid())
    )
  group by 1, 2;
$$;

-- ---------------------------------------------------------------------
-- 5. Reports → 💬 WhatsApp (its own part, never mixed with phone calls)
--    Same "who sees whom" as call_report: callers their own,
--    Team Leads their team, admins everyone.
--    p_user_id: one person, or null for everyone I may see
-- ---------------------------------------------------------------------
create or replace function public.whatsapp_report(p_from date, p_to date, p_user_id uuid default null)
returns jsonb
language sql
stable
security invoker
set search_path = public
as $$
  with w as (
    select c.*
    from public.call_logs c
    join public.profiles p on p.id = c.user_id
    where c.channel = 'whatsapp'
      and (c.called_at at time zone 'Asia/Dhaka')::date between p_from and p_to
      and (p_user_id is null or c.user_id = p_user_id)
      and (
        public.has_permission('leads.view_all')
        or c.user_id = auth.uid()
        or (public.has_permission('leads.view_team') and p.team_lead_id = auth.uid())
      )
  ),
  totals as (
    select
      count(*) filter (where outcome <> 'message')                               as calls,
      count(*) filter (where outcome <> 'message' and direction = 'outgoing')    as outgoing,
      count(*) filter (where outcome <> 'message' and direction = 'incoming')    as incoming,
      count(*) filter (where direction in ('missed', 'rejected'))                as missed,
      count(*) filter (where outcome = 'connected')                              as connected,
      coalesce(sum(duration_sec) filter (where outcome = 'connected'), 0)        as talk_sec,
      count(*) filter (where media = 'video')                                    as video,
      count(*) filter (where outcome = 'message' and direction = 'outgoing')     as messages_sent,
      count(*) filter (where outcome = 'message' and direction = 'incoming')     as messages_received,
      count(distinct lead_id)                                                    as leads
    from w
  ),
  people as (
    select w.user_id, p.full_name,
           count(*) filter (where w.outcome <> 'message')                         as calls,
           count(*) filter (where w.outcome = 'connected')                        as connected,
           coalesce(sum(w.duration_sec) filter (where w.outcome = 'connected'), 0) as talk_sec,
           count(*) filter (where w.outcome = 'message')                          as messages,
           count(distinct w.lead_id)                                              as leads
    from w
    left join public.profiles p on p.id = w.user_id
    group by w.user_id, p.full_name
  ),
  days as (
    select (called_at at time zone 'Asia/Dhaka')::date as day,
           count(*) filter (where outcome <> 'message') as calls,
           count(*) filter (where outcome = 'message')  as messages
    from w
    group by 1
  )
  select jsonb_build_object(
    'totals', (select to_jsonb(t) from totals t),
    'people', coalesce((select jsonb_agg(to_jsonb(p) order by p.calls + p.messages desc) from people p), '[]'::jsonb),
    'days',   coalesce((select jsonb_agg(to_jsonb(d) order by d.day) from days d), '[]'::jsonb)
  );
$$;

grant execute on function public.whatsapp_report(date, date, uuid) to authenticated;

notify pgrst, 'reload schema';
