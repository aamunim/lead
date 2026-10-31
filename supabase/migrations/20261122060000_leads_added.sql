-- =====================================================================
-- ➕ Who added how many leads, and when
--   (Leads tab: user + date chips; Team activity; Reports; Home)
--   1. can_see_added(user): admins / "see all leads" everyone, Team Leads
--      their team and themselves, everyone else only themselves
--   2. lead_creators(): the people the signed-in user may pick
--   3. leads_added(from, to): leads added per person (typed / imported);
--      deleted leads are not counted
--   4. team_activity(): + leads_added, leads_imported
-- =====================================================================

-- ---------------------------------------------------------------------
-- 1. Whose added leads may the signed-in user see?
-- ---------------------------------------------------------------------
create or replace function public.can_see_added(p_user uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select public.is_active_user() and (
    p_user = auth.uid()
    or public.has_permission('settings.manage')
    or public.has_permission('leads.view_all')
    or (
      public.has_permission('leads.view_team')
      and exists (select 1 from public.profiles p where p.id = p_user and p.team_lead_id = auth.uid())
    )
  );
$$;

grant execute on function public.can_see_added(uuid) to authenticated;

-- ---------------------------------------------------------------------
-- 2. The people in the "👤 User" picker (myself first)
-- ---------------------------------------------------------------------
create or replace function public.lead_creators()
returns table (id uuid, name text, is_active boolean)
language sql
stable
security definer
set search_path = public
as $$
  select p.id, p.full_name, p.is_active
  from public.profiles p
  where public.can_see_added(p.id)
  order by (p.id = auth.uid()) desc, p.is_active desc, p.full_name;
$$;

grant execute on function public.lead_creators() to authenticated;

-- ---------------------------------------------------------------------
-- 3. Leads added per person in a period (days in Bangladesh time)
-- ---------------------------------------------------------------------
create or replace function public.leads_added(p_from date, p_to date)
returns table (user_id uuid, name text, total int, imported int)
language sql
stable
security definer
set search_path = public
as $$
  select l.created_by, p.full_name,
         count(*)::int,
         count(*) filter (where l.import_batch_id is not null)::int
  from public.leads l
  left join public.profiles p on p.id = l.created_by
  where l.deleted_at is null
    and l.created_by is not null
    and (l.created_at at time zone 'Asia/Dhaka')::date between p_from and p_to
    and public.can_see_added(l.created_by)
  group by l.created_by, p.full_name
  order by count(*) desc, p.full_name;
$$;

grant execute on function public.leads_added(date, date) to authenticated;

-- ---------------------------------------------------------------------
-- 4. Team activity: + leads added (new columns, so drop and make again)
-- ---------------------------------------------------------------------
drop function if exists public.team_activity(date, date);

create function public.team_activity(p_from date, p_to date)
returns table (
  user_id uuid, name text, role_key text, last_seen_at timestamptz,
  app_sec int, sessions int, calls int, connected int, talk_sec int,
  actions int, admitted int, first_at timestamptz, last_at timestamptz,
  wa_calls int, wa_connected int, wa_messages int,
  leads_added int, leads_imported int
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
    where c.deleted_at is null
      and (c.called_at at time zone 'Asia/Dhaka')::date between p_from and p_to
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
  ),
  added as (
    select l.created_by as user_id, count(*)::int as n,
           count(*) filter (where l.import_batch_id is not null)::int as imported
    from public.leads l
    where l.deleted_at is null
      and (l.created_at at time zone 'Asia/Dhaka')::date between p_from and p_to
    group by l.created_by
  )
  select p.id, p.full_name, p.role_key,
         (select max(s.last_seen_at) from public.app_sessions s where s.user_id = p.id),
         coalesce(ses.app_sec, 0), coalesce(ses.n, 0),
         coalesce(cl.calls, 0), coalesce(cl.connected, 0), coalesce(cl.talk_sec, 0),
         coalesce(act.actions, 0), coalesce(adm.admitted, 0),
         least(ses.first_at, cl.first_at, act.first_at),
         greatest(ses.last_at, cl.last_at, act.last_at),
         coalesce(cl.wa_calls, 0), coalesce(cl.wa_connected, 0), coalesce(cl.wa_messages, 0),
         coalesce(added.n, 0), coalesce(added.imported, 0)
  from people p
  left join ses on ses.user_id = p.id
  left join cl  on cl.user_id  = p.id
  left join act on act.user_id = p.id
  left join adm on adm.user_id = p.id
  left join added on added.user_id = p.id
  order by p.full_name;
$$;

grant execute on function public.team_activity(date, date) to authenticated;

notify pgrst, 'reload schema';
