-- =====================================================================
-- Team activity → one person: everything for the new details page
--   user_activity_detail(user, from, to) → one jsonb:
--     calls       phone calls: in / out / missed, answered, talk time,
--                 longest, very short, with a note
--     wa          WhatsApp calls and messages
--     follow_ups  next calls due in the period: on time / late, overdue now
--     speed       leads they were given: how fast the first call came
--     leads       open now, given, admitted, lost, by stage, lost reasons
--     hours       per hour of the day (Bangladesh time): calls, changes, app minutes
--     gaps        one day only: 60+ minutes with no work between 9 AM and 7 PM
--   Same "who may see whom" as Team activity.
-- =====================================================================

create or replace function public.user_activity_detail(p_user_id uuid, p_from date, p_to date)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_tz      text := 'Asia/Dhaka';
  v_start   timestamptz := (p_from::timestamp) at time zone 'Asia/Dhaka';
  v_end     timestamptz := ((p_to + 1)::timestamp) at time zone 'Asia/Dhaka';
  v_calls   jsonb;
  v_wa      jsonb;
  v_fu      jsonb;
  v_speed   jsonb;
  v_leads   jsonb;
  v_hours   jsonb;
  v_gaps    jsonb := '[]'::jsonb;
  -- gaps
  v_win_from timestamptz;
  v_win_to   timestamptz;
  v_cursor   timestamptz;
  r          record;
begin
  if not public.can_see_activity(p_user_id) then
    raise exception 'You can''t see this person''s activity.';
  end if;

  -- Phone calls
  select jsonb_build_object(
           'total',      count(*),
           'outgoing',   count(*) filter (where direction = 'outgoing'),
           'incoming',   count(*) filter (where direction = 'incoming'),
           'missed',     count(*) filter (where direction in ('missed', 'rejected')),
           'connected',  count(*) filter (where outcome = 'connected'),
           'no_answer',  count(*) filter (where outcome in ('no_answer', 'busy', 'switched_off')),
           'talk_sec',   coalesce(sum(duration_sec) filter (where outcome = 'connected'), 0),
           'avg_sec',    coalesce(round(avg(duration_sec) filter (where outcome = 'connected')), 0),
           'longest_sec', coalesce(max(duration_sec) filter (where outcome = 'connected'), 0),
           'short',      count(*) filter (where outcome = 'connected' and coalesce(duration_sec, 0) between 1 and 10),
           'with_note',  count(*) filter (where notes is not null and trim(notes) <> '')
         )
    into v_calls
  from public.call_logs
  where user_id = p_user_id and channel = 'phone' and deleted_at is null
    and called_at >= v_start and called_at < v_end;

  -- WhatsApp
  select jsonb_build_object(
           'calls',     count(*) filter (where outcome <> 'message'),
           'connected', count(*) filter (where outcome = 'connected'),
           'missed',    count(*) filter (where direction in ('missed', 'rejected')),
           'talk_sec',  coalesce(sum(duration_sec) filter (where outcome = 'connected'), 0),
           'video',     count(*) filter (where media = 'video'),
           'sent',      count(*) filter (where outcome = 'message' and direction = 'outgoing'),
           'received',  count(*) filter (where outcome = 'message' and direction = 'incoming')
         )
    into v_wa
  from public.call_logs
  where user_id = p_user_id and channel = 'whatsapp' and deleted_at is null
    and called_at >= v_start and called_at < v_end;

  -- Next calls of their leads, due in the period (30 minutes' grace = on time)
  select jsonb_build_object(
           'due',        count(*),
           'on_time',    count(*) filter (where f.status = 'done' and f.completed_at <= f.due_at + interval '30 minutes'),
           'late',       count(*) filter (where f.status = 'done' and f.completed_at >  f.due_at + interval '30 minutes'),
           'missed',     count(*) filter (where f.status = 'pending' and f.due_at < now()),
           'avg_late_min', coalesce(round(avg(extract(epoch from (f.completed_at - f.due_at)) / 60)
                             filter (where f.status = 'done' and f.completed_at > f.due_at + interval '30 minutes')), 0),
           'overdue_now', (select count(*) from public.follow_ups f2
                            join public.leads l2 on l2.id = f2.lead_id and l2.deleted_at is null
                            where l2.assigned_to = p_user_id and f2.status = 'pending' and f2.due_at < now())
         )
    into v_fu
  from public.follow_ups f
  join public.leads l on l.id = f.lead_id and l.deleted_at is null
  where l.assigned_to = p_user_id
    and f.status in ('pending', 'done')
    and f.due_at >= v_start and f.due_at < v_end;

  -- Speed to lead: leads given to them in the period → their first call or WhatsApp after that
  with given as (
    select distinct on (a.lead_id) a.lead_id, a.created_at as at
    from public.lead_activity a
    join public.leads l on l.id = a.lead_id and l.deleted_at is null
    where a.created_at >= v_start and a.created_at < v_end
      and (
        (a.action = 'assigned' and a.details->>'to' = p_user_id::text)
        or (a.action = 'created' and a.details->>'assigned_to' = p_user_id::text)
      )
    order by a.lead_id, a.created_at
  ),
  firsts as (
    select g.lead_id, g.at,
           (select min(c.called_at) from public.call_logs c
             where c.lead_id = g.lead_id and c.user_id = p_user_id and c.deleted_at is null
               and c.direction = 'outgoing' and c.called_at >= g.at) as first_call
    from given g
  )
  select jsonb_build_object(
           'given',      count(*),
           'called',     count(first_call),
           'within_15',  count(*) filter (where first_call <= at + interval '15 minutes'),
           'within_60',  count(*) filter (where first_call <= at + interval '60 minutes'),
           'avg_min',    coalesce(round(avg(extract(epoch from (first_call - at)) / 60)), 0),
           'median_min', coalesce(round((percentile_cont(0.5) within group (order by extract(epoch from (first_call - at)) / 60))::numeric), 0),
           'not_called', count(*) filter (where first_call is null)
         )
    into v_speed
  from firsts;

  -- Leads and results
  select jsonb_build_object(
           'open_now', (select count(*) from public.leads l join public.pipeline_stages s on s.id = l.stage_id
                         where l.assigned_to = p_user_id and l.deleted_at is null and s.kind = 'open'),
           'given', (v_speed->>'given')::int,
           'admitted', (select count(*) from public.leads l join public.pipeline_stages s on s.id = l.stage_id and s.kind = 'won'
                         where l.admitted_by = p_user_id and l.deleted_at is null
                           and l.admitted_at >= v_start and l.admitted_at < v_end),
           'lost', (select count(*) from public.leads l join public.pipeline_stages s on s.id = l.stage_id and s.kind = 'lost'
                     where l.lost_by = p_user_id and l.deleted_at is null
                       and l.lost_at >= v_start and l.lost_at < v_end),
           'stages', coalesce((
             select jsonb_agg(jsonb_build_object('name', x.name, 'color', x.color, 'n', x.n) order by x.sort_order)
             from (
               select s.name, s.color, s.sort_order, count(*) as n
               from public.leads l join public.pipeline_stages s on s.id = l.stage_id
               where l.assigned_to = p_user_id and l.deleted_at is null and s.kind = 'open'
               group by s.name, s.color, s.sort_order
             ) x), '[]'::jsonb),
           'lost_reasons', coalesce((
             select jsonb_agg(jsonb_build_object('name', x.name, 'n', x.n) order by x.n desc)
             from (
               select coalesce(lr.name, 'No reason') as name, count(*) as n
               from public.leads l
               join public.pipeline_stages s on s.id = l.stage_id and s.kind = 'lost'
               left join public.lost_reasons lr on lr.id = l.lost_reason_id
               where l.lost_by = p_user_id and l.deleted_at is null
                 and l.lost_at >= v_start and l.lost_at < v_end
               group by 1
               order by 2 desc
               limit 5
             ) x), '[]'::jsonb)
         )
    into v_leads;

  -- Per hour of the day
  with h as (select generate_series(0, 23) as hour),
  c as (
    select extract(hour from called_at at time zone v_tz)::int as hour, count(*) as n
    from public.call_logs
    where user_id = p_user_id and deleted_at is null and called_at >= v_start and called_at < v_end
    group by 1
  ),
  a as (
    select extract(hour from created_at at time zone v_tz)::int as hour, count(*) as n
    from public.lead_activity
    where user_id = p_user_id and action <> 'call_logged' and created_at >= v_start and created_at < v_end
    group by 1
  ),
  s as (
    -- app minutes, spread by the hour each session started in (good enough for a picture)
    select extract(hour from started_at at time zone v_tz)::int as hour, sum(active_sec) / 60 as n
    from public.app_sessions
    where user_id = p_user_id and started_at >= v_start and started_at < v_end
    group by 1
  )
  select jsonb_agg(jsonb_build_object(
           'hour', h.hour, 'calls', coalesce(c.n, 0), 'actions', coalesce(a.n, 0), 'app_min', coalesce(s.n, 0)
         ) order by h.hour)
    into v_hours
  from h
  left join c on c.hour = h.hour
  left join a on a.hour = h.hour
  left join s on s.hour = h.hour;

  -- Gaps (one day only): 60+ minutes between 9 AM and 7 PM with no call, change or app use
  if p_from = p_to then
    v_win_from := (p_from::timestamp + interval '9 hours') at time zone v_tz;
    v_win_to   := least((p_from::timestamp + interval '19 hours') at time zone v_tz, now());
    v_cursor   := v_win_from;
    if v_win_to > v_win_from then
      for r in
        select t0, t1 from (
          select called_at as t0, called_at + make_interval(secs => coalesce(duration_sec, 0)) as t1
            from public.call_logs
           where user_id = p_user_id and deleted_at is null and called_at < v_win_to
             and called_at + make_interval(secs => coalesce(duration_sec, 0)) > v_win_from
          union all
          select created_at, created_at from public.lead_activity
           where user_id = p_user_id and created_at >= v_win_from and created_at < v_win_to
          union all
          select started_at, last_seen_at from public.app_sessions
           where user_id = p_user_id and started_at < v_win_to and last_seen_at > v_win_from
        ) e
        order by t0
      loop
        if r.t0 - v_cursor >= interval '60 minutes' then
          v_gaps := v_gaps || jsonb_build_object('from', v_cursor, 'to', r.t0);
        end if;
        v_cursor := greatest(v_cursor, r.t1);
      end loop;
      if v_win_to - v_cursor >= interval '60 minutes' then
        v_gaps := v_gaps || jsonb_build_object('from', v_cursor, 'to', v_win_to);
      end if;
    end if;
  end if;

  return jsonb_build_object(
    'calls', v_calls, 'wa', v_wa, 'follow_ups', v_fu, 'speed', v_speed,
    'leads', v_leads, 'hours', v_hours, 'gaps', v_gaps
  );
end;
$$;

grant execute on function public.user_activity_detail(uuid, date, date) to authenticated;

notify pgrst, 'reload schema';
