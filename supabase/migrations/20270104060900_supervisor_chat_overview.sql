-- =====================================================================
-- 💬 AI Supervisor chat: the whole picture ("overview")
--   For questions such as "how many numbers do we have, how often do we
--   call them, how many minutes do we talk, how many of us, how well
--   does it work" — the leads (their numbers), calls, talk minutes, the
--   team, admissions, month by month and person by person.
--   For the whole time (from the first lead) and for a period (default:
--   the last 30 days). Super admins only (through the chat).
-- =====================================================================

create or replace function public.supervisor_chat_overview(p_from date default null, p_to date default null)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
set jit = off
as $$
declare
  v_to    date := coalesce(p_to, (now() at time zone 'Asia/Dhaka')::date);
  v_from  date := coalesce(p_from, v_to - 29);
  v_t0    timestamptz;
  v_t1    timestamptz;
  v_first date;
begin
  perform public.sup_chat_check();
  if v_from > v_to then
    v_first := v_from; v_from := v_to; v_to := v_first;
  end if;
  v_t0 := v_from::timestamp at time zone 'Asia/Dhaka';
  v_t1 := (v_to + 1)::timestamp at time zone 'Asia/Dhaka';
  select (min(created_at) at time zone 'Asia/Dhaka')::date into v_first from public.leads where deleted_at is null;

  return jsonb_build_object(
    'period', jsonb_build_object('from', v_from, 'to', v_to),
    'since', v_first,

    -- 📱 the numbers we have (leads only)
    'numbers', (
      select jsonb_build_object(
        'leads', count(*),
        'unique_numbers', count(distinct coalesce(l.phone_hash, l.phone)) filter (where l.phone is not null),
        'with_second_number', count(*) filter (where l.alt_phone is not null),
        'whatsapp_only', count(*) filter (where l.phone is null and l.whatsapp_number is not null),
        'new_in_period', count(*) filter (where l.created_at >= v_t0 and l.created_at < v_t1),
        'by_stage', (select jsonb_object_agg(x.kind, x.n) from (
                       select coalesce(s.kind, 'none') as kind, count(*) as n
                       from public.leads l2 left join public.pipeline_stages s on s.id = l2.stage_id
                       where l2.deleted_at is null group by 1) x),
        'never_called', count(*) filter (where l.last_contacted_at is null
                                           and not exists (select 1 from public.call_logs c
                                                           where c.lead_id = l.id and c.deleted_at is null)),
        'unassigned', count(*) filter (where l.assigned_to is null))
      from public.leads l where l.deleted_at is null),

    -- 📞 contact: all time and in the period
    'calls_all_time', (
      select jsonb_build_object(
        'calls', count(*),
        'connected', count(*) filter (where c.outcome = 'connected'),
        'talk_minutes', round(coalesce(sum(c.duration_sec) filter (where c.outcome = 'connected'), 0) / 60.0),
        'avg_minutes_per_talk', round(avg(c.duration_sec) filter (where c.outcome = 'connected' and c.duration_sec > 0) / 60.0, 1),
        'leads_called', count(distinct c.lead_id),
        'calls_per_called_lead', round(count(*)::numeric / nullif(count(distinct c.lead_id), 0), 1),
        'by_channel', (select jsonb_object_agg(x.ch, x.n) from (
                         select coalesce(c2.channel, 'phone') as ch, count(*) as n from public.call_logs c2
                         where c2.deleted_at is null and c2.lead_id is not null group by 1) x))
      from public.call_logs c where c.deleted_at is null and c.lead_id is not null),
    'calls_in_period', (
      select jsonb_build_object(
        'calls', count(*),
        'connected', count(*) filter (where c.outcome = 'connected'),
        'talk_minutes', round(coalesce(sum(c.duration_sec) filter (where c.outcome = 'connected'), 0) / 60.0),
        'leads_called', count(distinct c.lead_id),
        'calls_per_day', round(count(*)::numeric / greatest(v_to - v_from + 1, 1), 1),
        'callers', count(distinct c.user_id))
      from public.call_logs c
      where c.deleted_at is null and c.lead_id is not null and c.called_at >= v_t0 and c.called_at < v_t1),
    -- how many tries until the first real talk (leads first called in the last 365 days)
    'tries_to_first_talk', (
      with firsts as (
        select c.lead_id,
               count(*) filter (where c.called_at <= coalesce(t.first_talk, c.called_at)) as tries,
               bool_or(t.first_talk is not null) as talked
        from public.call_logs c
        left join lateral (select min(c3.called_at) as first_talk from public.call_logs c3
                           where c3.lead_id = c.lead_id and c3.deleted_at is null and c3.outcome = 'connected') t on true
        where c.deleted_at is null and c.lead_id is not null
          and c.lead_id in (select c4.lead_id from public.call_logs c4 where c4.deleted_at is null
                            group by c4.lead_id having min(c4.called_at) > now() - interval '365 days')
        group by c.lead_id)
      select jsonb_build_object(
        'leads', count(*),
        'reached', count(*) filter (where talked),
        'reached_pct', round(100.0 * count(*) filter (where talked) / nullif(count(*), 0)),
        'avg_tries', round(avg(tries) filter (where talked), 1),
        'one_try_pct', round(100.0 * count(*) filter (where talked and tries = 1) / nullif(count(*) filter (where talked), 0)))
      from firsts),

    -- 👥 the team
    'team', (
      select jsonb_build_object(
        'active_people', count(*),
        'by_role', (select jsonb_object_agg(x.r, x.n) from (
                      select public.role_base(p2.role_key) as r, count(*) as n from public.profiles p2
                      where p2.is_active and p2.deleted_at is null group by 1) x),
        'calling_in_period', (select count(distinct c.user_id) from public.call_logs c
                              where c.deleted_at is null and c.called_at >= v_t0 and c.called_at < v_t1))
      from public.profiles p where p.is_active and p.deleted_at is null),

    -- 🎓 results
    'results', (
      select jsonb_build_object(
        'admitted_all_time', count(*) filter (where l.admitted_at is not null),
        'admitted_in_period', count(*) filter (where l.admitted_at >= v_t0 and l.admitted_at < v_t1),
        'admitted_pct_of_leads', round(100.0 * count(*) filter (where l.admitted_at is not null) / nullif(count(*), 0), 1),
        'not_now_all_time', count(*) filter (where l.lost_at is not null),
        'not_now_in_period', count(*) filter (where l.lost_at >= v_t0 and l.lost_at < v_t1),
        'fee_collected_all_time', round(coalesce(sum(l.fee_paid_total), 0)),
        'fee_due_now', round(coalesce(sum(l.fee_due) filter (where l.admitted_at is not null), 0)),
        -- leads made in the period: how many joined already
        'cohort', jsonb_build_object(
          'leads', count(*) filter (where l.created_at >= v_t0 and l.created_at < v_t1),
          'admitted', count(*) filter (where l.created_at >= v_t0 and l.created_at < v_t1 and l.admitted_at is not null)))
      from public.leads l where l.deleted_at is null),

    -- 📅 the last 12 months
    'months', (
      select jsonb_agg(jsonb_build_object('month', to_char(m.m, 'YYYY-MM'), 'new_leads', m.new_leads, 'calls', m.calls,
                                          'talk_minutes', m.talk_min, 'admitted', m.admitted) order by m.m)
      from (
        select mm.m,
               (select count(*) from public.leads l where l.deleted_at is null
                  and l.created_at >= mm.m and l.created_at < mm.m + interval '1 month') as new_leads,
               (select count(*) from public.call_logs c where c.deleted_at is null and c.lead_id is not null
                  and c.called_at >= mm.m and c.called_at < mm.m + interval '1 month') as calls,
               (select round(coalesce(sum(c.duration_sec), 0) / 60.0) from public.call_logs c
                  where c.deleted_at is null and c.outcome = 'connected'
                    and c.called_at >= mm.m and c.called_at < mm.m + interval '1 month') as talk_min,
               (select count(*) from public.leads l where l.deleted_at is null
                  and l.admitted_at >= mm.m and l.admitted_at < mm.m + interval '1 month') as admitted
        from (select (date_trunc('month', now() at time zone 'Asia/Dhaka') - make_interval(months => g))
                       at time zone 'Asia/Dhaka' as m
              from generate_series(0, 11) g) mm) m),

    -- 🧑‍💼 each person in the period (the 25 busiest)
    'people', (
      select jsonb_agg(x order by x.calls desc) from (
        select p.full_name as name, public.role_base(p.role_key) as role,
               count(c.id) as calls,
               count(c.id) filter (where c.outcome = 'connected') as connected,
               round(coalesce(sum(c.duration_sec) filter (where c.outcome = 'connected'), 0) / 60.0) as talk_minutes,
               (select count(*) from public.leads l where l.deleted_at is null and l.assigned_to = p.id
                  and l.admitted_at >= v_t0 and l.admitted_at < v_t1) as admitted,
               (select count(*) from public.leads l join public.pipeline_stages s on s.id = l.stage_id and s.kind = 'open'
                  where l.deleted_at is null and l.assigned_to = p.id) as open_leads
        from public.profiles p
        left join public.call_logs c on c.user_id = p.id and c.deleted_at is null and c.lead_id is not null
                                     and c.called_at >= v_t0 and c.called_at < v_t1
        where p.is_active and p.deleted_at is null
        group by p.id, p.full_name, p.role_key
        order by count(c.id) desc
        limit 25) x));
end;
$$;
revoke all on function public.supervisor_chat_overview(date, date) from public, anon;
grant execute on function public.supervisor_chat_overview(date, date) to authenticated;

-- a full report is longer than a chat answer: up to 12,000 letters kept
create or replace function public.sup_chat_save(p_user uuid, p_chat uuid, p_body text, p_data jsonb,
                                                p_memory text, p_provider text)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  a        jsonb;
  v_links  jsonb := '[]'::jsonb;
  v_acts   jsonb := '[]'::jsonb;
  v_ids    uuid[];
  v_names  text[];
  v_name   text;
  v_due    timestamptz;
  v_id     uuid;
begin
  if not exists (select 1 from public.supervisor_chats where id = p_chat and user_id = p_user) then
    raise exception 'Chat not found.';
  end if;

  -- links: real leads / people only
  for a in select * from jsonb_array_elements(case when jsonb_typeof(p_data -> 'links') = 'array'
                                                   then p_data -> 'links' else '[]'::jsonb end) limit 12 loop
    if coalesce(a ->> 'id', '') !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then continue; end if;
    if a ->> 'type' = 'lead' then
      select name into v_name from public.leads where id = (a ->> 'id')::uuid and deleted_at is null;
    elsif a ->> 'type' = 'person' then
      select full_name into v_name from public.profiles where id = (a ->> 'id')::uuid;
    else continue;
    end if;
    if v_name is not null and not v_links @> jsonb_build_array(jsonb_build_object('id', a ->> 'id')) then
      v_links := v_links || jsonb_build_array(jsonb_build_object('type', a ->> 'type', 'id', a ->> 'id', 'label', v_name));
    end if;
    v_name := null;
  end loop;

  -- actions: only these three, each about real leads / people, shown with the names from the database
  for a in select * from jsonb_array_elements(case when jsonb_typeof(p_data -> 'actions') = 'array'
                                                   then p_data -> 'actions' else '[]'::jsonb end) limit 5 loop
    begin
      v_ids := array(select x::uuid from jsonb_array_elements_text(
                       case when jsonb_typeof(a -> 'lead_ids') = 'array' then a -> 'lead_ids' else '[]'::jsonb end) x
                     where x ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' limit 50);
      select array_agg(l.id), array_agg(l.name) into v_ids, v_names
        from public.leads l where l.id = any (v_ids) and l.deleted_at is null;
      if a ->> 'type' = 'follow_up' then
        -- a time written without its zone is Bangladesh time
        v_due := case when a ->> 'due_at' ~ '(Z|z|[+-][0-9]{2}(:?[0-9]{2})?)$' then (a ->> 'due_at')::timestamptz
                      else ((a ->> 'due_at')::timestamp at time zone 'Asia/Dhaka') end;
        if coalesce(cardinality(v_ids), 0) <> 1 or v_due is null or v_due < now() - interval '1 hour'
           or v_due > now() + interval '60 days' then continue; end if;
        v_acts := v_acts || jsonb_build_array(jsonb_build_object(
          'type', 'follow_up', 'status', 'pending', 'lead_ids', to_jsonb(v_ids), 'lead_names', to_jsonb(v_names),
          'due_at', v_due, 'note', left(trim(coalesce(a ->> 'note', '')), 300)));
      elsif a ->> 'type' = 'hand_over' then
        v_id := case when coalesce(a ->> 'user_id', '') ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then (a ->> 'user_id')::uuid end;
        select full_name into v_name from public.profiles where id = v_id and is_active and deleted_at is null;
        if coalesce(cardinality(v_ids), 0) = 0 or v_name is null then continue; end if;
        v_acts := v_acts || jsonb_build_array(jsonb_build_object(
          'type', 'hand_over', 'status', 'pending', 'lead_ids', to_jsonb(v_ids), 'lead_names', to_jsonb(v_names),
          'user_id', v_id, 'user_name', v_name, 'note', left(trim(coalesce(a ->> 'note', '')), 300)));
      elsif a ->> 'type' = 'message' then
        v_id := case when coalesce(a ->> 'user_id', '') ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then (a ->> 'user_id')::uuid end;
        select full_name into v_name from public.profiles where id = v_id and is_active and deleted_at is null;
        if v_name is null or length(trim(coalesce(a ->> 'text', ''))) < 2 then continue; end if;
        v_acts := v_acts || jsonb_build_array(jsonb_build_object(
          'type', 'message', 'status', 'pending', 'user_id', v_id, 'user_name', v_name,
          'text', left(trim(a ->> 'text'), 400)));
      end if;
    exception when others then
      continue; -- a broken suggestion is left out
    end;
    v_name := null;
  end loop;

  insert into public.supervisor_chat_messages (chat_id, role, body, data, provider)
  values (p_chat, 'assistant', left(coalesce(nullif(trim(p_body), ''), '—'), 12000),
          jsonb_build_object('sources', case when jsonb_typeof(p_data -> 'sources') = 'array'
                                             then p_data -> 'sources' else '[]'::jsonb end,
                             'links', v_links, 'actions', v_acts),
          left(p_provider, 20))
  returning id into v_id;
  update public.supervisor_chats
     set updated_at = now(), memory = coalesce(left(nullif(trim(p_memory), ''), 1200), memory)
   where id = p_chat;
  return (select to_jsonb(m) from public.supervisor_chat_messages m where m.id = v_id);
end;
$$;
revoke all on function public.sup_chat_save(uuid, uuid, text, jsonb, text, text) from public, anon, authenticated;
