-- =====================================================================
-- 📤 One person's work for a period, for Excel / text files
--   Who may export: the person themself, and whoever may see their team
--   activity (admins everyone, Team Leads their team: can_see_activity).
--   Days are Dhaka days, like Team activity.
-- =====================================================================

create or replace function public.user_export(p_user uuid, p_from date, p_to date)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  lim constant int := 5000;
  person record;
  res jsonb;
begin
  if not public.is_active_user() then raise exception 'Not allowed.'; end if;
  if p_user is distinct from auth.uid() and not public.can_see_activity(p_user) then
    raise exception 'You may not export this person''s work.';
  end if;
  if p_to < p_from or p_to - p_from > 400 then
    raise exception 'Choose a period of at most 400 days.';
  end if;

  select id, full_name, role_key, email into person from public.profiles where id = p_user;
  if not found then raise exception 'Person not found.'; end if;

  with
  calls as (
    select c.called_at, c.direction, c.outcome, c.duration_sec, c.channel, c.media, c.sim_label, c.source,
           c.notes, l.id as lead_id, l.name as lead_name, l.phone as lead_phone, st.name as stage
    from public.call_logs c
    join public.leads l on l.id = c.lead_id
    left join public.pipeline_stages st on st.id = l.stage_id
    where c.user_id = p_user and c.deleted_at is null
      and (c.called_at at time zone 'Asia/Dhaka')::date between p_from and p_to
    order by c.called_at
    limit lim
  ),
  notes as (
    select a.created_at, a.details->>'note' as note, l.name as lead_name, l.phone as lead_phone
    from public.lead_activity a
    join public.leads l on l.id = a.lead_id
    where a.user_id = p_user and a.action = 'note_added'
      and (a.created_at at time zone 'Asia/Dhaka')::date between p_from and p_to
    order by a.created_at
    limit lim
  ),
  changes as (
    select a.created_at, a.action, a.details, l.name as lead_name, l.phone as lead_phone
    from public.lead_activity a
    join public.leads l on l.id = a.lead_id
    where a.user_id = p_user and a.action not in ('call_logged', 'note_added')
      and (a.created_at at time zone 'Asia/Dhaka')::date between p_from and p_to
    order by a.created_at
    limit lim
  ),
  added as (
    select l.created_at, l.name, l.phone, src.name as source, st.name as stage,
           (l.import_batch_id is not null) as imported
    from public.leads l
    left join public.lead_sources src on src.id = l.source_id
    left join public.pipeline_stages st on st.id = l.stage_id
    where l.created_by = p_user and l.deleted_at is null
      and (l.created_at at time zone 'Asia/Dhaka')::date between p_from and p_to
    order by l.created_at
    limit lim
  ),
  ses as (
    select coalesce(sum(s.active_sec), 0)::int as app_sec, count(*)::int as sessions,
           min(s.started_at) as first_at, max(s.last_seen_at) as last_at
    from public.app_sessions s
    where s.user_id = p_user and (s.started_at at time zone 'Asia/Dhaka')::date between p_from and p_to
  ),
  cl as (
    select
      count(*) filter (where c.channel = 'phone')::int as calls,
      count(*) filter (where c.channel = 'phone' and c.outcome = 'connected')::int as connected,
      coalesce(sum(c.duration_sec) filter (where c.channel = 'phone' and c.outcome = 'connected'), 0)::int as talk_sec,
      count(*) filter (where c.channel = 'phone' and c.direction = 'outgoing')::int as outgoing,
      count(*) filter (where c.channel = 'phone' and c.direction = 'incoming')::int as incoming,
      count(*) filter (where c.channel = 'phone' and c.direction in ('missed', 'rejected'))::int as missed,
      count(*) filter (where c.channel = 'whatsapp' and c.outcome <> 'message')::int as wa_calls,
      count(*) filter (where c.channel = 'whatsapp' and c.outcome = 'message')::int as wa_messages,
      count(distinct c.lead_id)::int as leads_called,
      min(c.called_at) as first_at, max(c.called_at) as last_at
    from public.call_logs c
    where c.user_id = p_user and c.deleted_at is null
      and (c.called_at at time zone 'Asia/Dhaka')::date between p_from and p_to
  )
  select jsonb_build_object(
    'person', jsonb_build_object('id', person.id, 'name', person.full_name, 'role', person.role_key, 'email', person.email),
    'from', p_from, 'to', p_to,
    'summary', jsonb_build_object(
      'calls', cl.calls, 'connected', cl.connected, 'talk_sec', cl.talk_sec,
      'outgoing', cl.outgoing, 'incoming', cl.incoming, 'missed', cl.missed,
      'wa_calls', cl.wa_calls, 'wa_messages', cl.wa_messages, 'leads_called', cl.leads_called,
      'notes', (select count(*) from public.lead_activity a where a.user_id = p_user and a.action = 'note_added'
                  and (a.created_at at time zone 'Asia/Dhaka')::date between p_from and p_to),
      'follow_ups', (select count(*) from public.lead_activity a where a.user_id = p_user and a.action = 'follow_up_set'
                  and (a.created_at at time zone 'Asia/Dhaka')::date between p_from and p_to),
      'stage_changes', (select count(*) from public.lead_activity a where a.user_id = p_user and a.action = 'stage_changed'
                  and (a.created_at at time zone 'Asia/Dhaka')::date between p_from and p_to),
      'leads_added', (select count(*) from public.leads l where l.created_by = p_user and l.deleted_at is null
                  and (l.created_at at time zone 'Asia/Dhaka')::date between p_from and p_to),
      'admitted', (select count(*) from public.leads l where l.admitted_by = p_user and l.deleted_at is null
                  and (l.admitted_at at time zone 'Asia/Dhaka')::date between p_from and p_to),
      'app_sec', ses.app_sec, 'sessions', ses.sessions,
      'first_at', least(ses.first_at, cl.first_at), 'last_at', greatest(ses.last_at, cl.last_at)
    ),
    'calls', coalesce((select jsonb_agg(to_jsonb(x)) from calls x), '[]'::jsonb),
    'notes', coalesce((select jsonb_agg(to_jsonb(x)) from notes x), '[]'::jsonb),
    'changes', coalesce((select jsonb_agg(to_jsonb(x)) from changes x), '[]'::jsonb),
    'leads_added', coalesce((select jsonb_agg(to_jsonb(x)) from added x), '[]'::jsonb),
    'capped', lim
  ) into res
  from ses, cl;

  return res;
end;
$$;

revoke all on function public.user_export(uuid, date, date) from public, anon;
grant execute on function public.user_export(uuid, date, date) to authenticated;
