-- =====================================================================
-- Team activity (More → Team activity, More → Change log)
--   1. Setting (Settings → Team activity)
--   2. Who may see whose activity: admins everyone, Team Leads their team
--      (setting); callers no one (not even themselves)
--   3. App time: sessions of THIS app only, reported by the phone
--      (counting stops after N idle minutes, see the app)
--   4. New timeline lines: tags, courses, notes edited on the edit screen,
--      and the other lead details
--   5. Reading: team_activity(), activity_feed(), user_activity_days()
--   The timeline itself (lead_activity) is never deleted or changed.
-- =====================================================================

-- ---------------------------------------------------------------------
-- 1. Setting
-- ---------------------------------------------------------------------
insert into public.app_settings (key, value)
values ('activity', '{"enabled": true, "team_leads": true, "idle_minutes": 10, "alert_minutes": 60, "keep_days": 90}'::jsonb)
on conflict (key) do nothing;

create or replace function public.activity_setting()
returns jsonb
language sql
stable
security definer
set search_path = public
as $$
  select jsonb_build_object('enabled', true, 'team_leads', true, 'idle_minutes', 10,
                            'alert_minutes', 60, 'keep_days', 90)
         || coalesce((select value from public.app_settings where key = 'activity'), '{}'::jsonb);
$$;

grant execute on function public.activity_setting() to authenticated;

-- ---------------------------------------------------------------------
-- 2. May the signed-in user see this person's activity?
-- ---------------------------------------------------------------------
create or replace function public.can_see_activity(p_user uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select public.is_active_user() and (
    public.has_permission('settings.manage')
    or public.has_permission('leads.view_all')
    or (
      public.has_permission('leads.view_team')
      and coalesce((public.activity_setting() ->> 'team_leads')::boolean, true)
      and (p_user = auth.uid()
           or exists (select 1 from public.profiles p where p.id = p_user and p.team_lead_id = auth.uid()))
    )
  );
$$;

grant execute on function public.can_see_activity(uuid) to authenticated;

-- ---------------------------------------------------------------------
-- 3. App sessions (this app only)
-- ---------------------------------------------------------------------
create table if not exists public.app_sessions (
  id           uuid primary key,                          -- made by the phone
  user_id      uuid not null references public.profiles(id) on delete cascade,
  device_id    text,
  device_label text,                                      -- e.g. "Samsung SM-A155F"
  app_version  text,
  started_at   timestamptz not null,
  last_seen_at timestamptz not null,
  active_sec   integer not null default 0 check (active_sec >= 0),
  ended        boolean not null default false
);

create index if not exists app_sessions_user_idx on public.app_sessions (user_id, started_at desc);
create index if not exists app_sessions_started_idx on public.app_sessions (started_at);

alter table public.app_sessions enable row level security;

-- Read only through the activity rule; written only by report_app_session()
create policy "app_sessions: view by activity rule"
  on public.app_sessions for select
  to authenticated
  using (public.can_see_activity(user_id));

create or replace function public.report_app_session(
  p_id           uuid,
  p_started_at   timestamptz,
  p_last_seen_at timestamptz,
  p_active_sec   integer,
  p_ended        boolean default false,
  p_device_id    text default null,
  p_device_label text default null,
  p_app_version  text default null
)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_setting jsonb := public.activity_setting();
  v_last    timestamptz := least(p_last_seen_at, now() + interval '5 minutes');
  v_active  integer;
begin
  if auth.uid() is null or not public.is_active_user() then return; end if;
  if not coalesce((v_setting ->> 'enabled')::boolean, true) then return; end if;
  if p_id is null or p_started_at is null or v_last < p_started_at then return; end if;

  -- Never more active time than the session lasted
  v_active := least(greatest(coalesce(p_active_sec, 0), 0),
                    extract(epoch from (v_last - p_started_at))::int + 60);

  insert into public.app_sessions (id, user_id, device_id, device_label, app_version,
                                   started_at, last_seen_at, active_sec, ended)
  values (p_id, auth.uid(), p_device_id, left(p_device_label, 80), left(p_app_version, 40),
          p_started_at, v_last, v_active, coalesce(p_ended, false))
  on conflict (id) do update
     set last_seen_at = greatest(app_sessions.last_seen_at, excluded.last_seen_at),
         active_sec   = greatest(app_sessions.active_sec, excluded.active_sec),
         ended        = app_sessions.ended or excluded.ended,
         device_id    = coalesce(excluded.device_id, app_sessions.device_id),
         device_label = coalesce(excluded.device_label, app_sessions.device_label),
         app_version  = coalesce(excluded.app_version, app_sessions.app_version)
   where app_sessions.user_id = auth.uid();

  -- Old sessions go after the kept days
  delete from public.app_sessions
   where user_id = auth.uid()
     and started_at < now() - make_interval(days => coalesce((v_setting ->> 'keep_days')::int, 90));
end;
$$;

grant execute on function public.report_app_session(uuid, timestamptz, timestamptz, integer, boolean, text, text, text) to authenticated;

-- ---------------------------------------------------------------------
-- 4. New timeline lines
-- ---------------------------------------------------------------------
-- A lead added a moment ago gets its first tags / courses with it:
-- those are part of "Lead created", not separate changes
create or replace function public.lead_just_created(p_lead_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (select 1 from public.leads where id = p_lead_id and created_at > now() - interval '15 seconds');
$$;

-- 4a. Tags
create or replace function public.log_lead_tag_change()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_lead uuid := coalesce(new.lead_id, old.lead_id);
  v_tag  uuid := coalesce(new.tag_id, old.tag_id);
begin
  if tg_op = 'INSERT' and public.lead_just_created(v_lead) then return null; end if;
  if not exists (select 1 from public.leads where id = v_lead) then return null; end if; -- lead being removed

  insert into public.lead_activity (lead_id, user_id, action, details)
  values (v_lead, auth.uid(),
          case tg_op when 'INSERT' then 'tag_added' else 'tag_removed' end,
          jsonb_build_object('tag', (select name from public.tags where id = v_tag)));
  return null;
end;
$$;

drop trigger if exists lead_tags_log_activity on public.lead_tags;
create trigger lead_tags_log_activity
  after insert or delete on public.lead_tags
  for each row execute function public.log_lead_tag_change();

-- 4b. Interested courses
create or replace function public.log_lead_course_change()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_lead   uuid := coalesce(new.lead_id, old.lead_id);
  v_course uuid := coalesce(new.course_id, old.course_id);
begin
  if tg_op = 'INSERT' and public.lead_just_created(v_lead) then return null; end if;
  if not exists (select 1 from public.leads where id = v_lead) then return null; end if;

  insert into public.lead_activity (lead_id, user_id, action, details)
  values (v_lead, auth.uid(),
          case tg_op when 'INSERT' then 'course_added' else 'course_removed' end,
          jsonb_build_object('course', (select name from public.courses where id = v_course)));
  return null;
end;
$$;

drop trigger if exists lead_courses_log_activity on public.lead_courses;
create trigger lead_courses_log_activity
  after insert or delete on public.lead_courses
  for each row execute function public.log_lead_course_change();

-- 4c. Notes edited by hand, and the other details
--     (name / phone, stage, rating, assignment already have their own lines;
--      the Note option writes its own "note_added" line)
create or replace function public.log_lead_field_changes()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_changes jsonb := '[]'::jsonb;
begin
  if new.notes is distinct from old.notes
     and coalesce(current_setting('app.note_added', true), '') = '' then
    insert into public.lead_activity (lead_id, user_id, action, details)
    values (new.id, auth.uid(), 'note_edited',
            jsonb_build_object('from', left(old.notes, 150), 'to', left(new.notes, 150)));
  end if;

  if new.email is distinct from old.email then
    v_changes := v_changes || jsonb_build_object('field', 'Email', 'from', old.email, 'to', new.email);
  end if;
  if new.alt_phone is distinct from old.alt_phone then
    v_changes := v_changes || jsonb_build_object('field', 'Alternative phone', 'from', old.alt_phone, 'to', new.alt_phone);
  end if;
  if new.area is distinct from old.area then
    v_changes := v_changes || jsonb_build_object('field', 'Area', 'from', old.area, 'to', new.area);
  end if;
  if new.guardian_name is distinct from old.guardian_name then
    v_changes := v_changes || jsonb_build_object('field', 'Guardian', 'from', old.guardian_name, 'to', new.guardian_name);
  end if;
  if new.guardian_phone is distinct from old.guardian_phone then
    v_changes := v_changes || jsonb_build_object('field', 'Guardian phone', 'from', old.guardian_phone, 'to', new.guardian_phone);
  end if;
  if new.guardian_relation is distinct from old.guardian_relation then
    v_changes := v_changes || jsonb_build_object('field', 'Guardian relation', 'from', old.guardian_relation, 'to', new.guardian_relation);
  end if;
  if new.referred_by is distinct from old.referred_by then
    v_changes := v_changes || jsonb_build_object('field', 'Referred by', 'from', old.referred_by, 'to', new.referred_by);
  end if;
  if new.source_id is distinct from old.source_id then
    v_changes := v_changes || jsonb_build_object('field', 'Source',
      'from', (select name from public.lead_sources where id = old.source_id),
      'to',   (select name from public.lead_sources where id = new.source_id));
  end if;
  if new.campaign_id is distinct from old.campaign_id then
    v_changes := v_changes || jsonb_build_object('field', 'Campaign',
      'from', (select name from public.campaigns where id = old.campaign_id),
      'to',   (select name from public.campaigns where id = new.campaign_id));
  end if;
  if new.lead_type_id is distinct from old.lead_type_id then
    v_changes := v_changes || jsonb_build_object('field', 'Lead type',
      'from', (select name from public.lead_types where id = old.lead_type_id),
      'to',   (select name from public.lead_types where id = new.lead_type_id));
  end if;

  if jsonb_array_length(v_changes) > 0 then
    insert into public.lead_activity (lead_id, user_id, action, details)
    values (new.id, auth.uid(), 'fields_changed', jsonb_build_object('changes', v_changes));
  end if;
  return null;
end;
$$;

drop trigger if exists leads_log_field_changes on public.leads;
create trigger leads_log_field_changes
  after update on public.leads
  for each row execute function public.log_lead_field_changes();

-- Faster "by person" and "by time" reads
create index if not exists lead_activity_user_idx on public.lead_activity (user_id, created_at desc);
create index if not exists lead_activity_created_idx on public.lead_activity (created_at desc);

-- ---------------------------------------------------------------------
-- 5. Reading
-- ---------------------------------------------------------------------
-- 5a. Everyone I may see, for the days p_from..p_to (Bangladesh time)
create or replace function public.team_activity(p_from date, p_to date)
returns table (
  user_id uuid, name text, role_key text, last_seen_at timestamptz,
  app_sec int, sessions int, calls int, connected int, talk_sec int,
  actions int, admitted int, first_at timestamptz, last_at timestamptz
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
    select c.user_id, count(*)::int as calls,
           count(*) filter (where c.outcome = 'connected')::int as connected,
           coalesce(sum(c.duration_sec) filter (where c.outcome = 'connected'), 0)::int as talk_sec,
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
         greatest(ses.last_at, cl.last_at, act.last_at)
  from people p
  left join ses on ses.user_id = p.id
  left join cl  on cl.user_id  = p.id
  left join act on act.user_id = p.id
  left join adm on adm.user_id = p.id
  order by p.full_name;
$$;

grant execute on function public.team_activity(date, date) to authenticated;

-- 5b. Change log: who changed what on which lead, newest first
--     p_before: load older lines (paging)
create or replace function public.activity_feed(
  p_from    date,
  p_to      date,
  p_user_id uuid default null,
  p_actions text[] default null,
  p_search  text default null,
  p_before  timestamptz default null,
  p_limit   int default 100
)
returns table (
  id uuid, created_at timestamptz, action text, details jsonb,
  lead_id uuid, lead_name text, lead_phone text, user_id uuid, user_name text
)
language sql
stable
security definer
set search_path = public
as $$
  select a.id, a.created_at, a.action, a.details,
         l.id, l.name, l.phone, a.user_id, p.full_name
  from public.lead_activity a
  join public.leads l on l.id = a.lead_id
  left join public.profiles p on p.id = a.user_id
  where a.user_id is not null
    and public.can_see_activity(a.user_id)
    and (a.created_at at time zone 'Asia/Dhaka')::date between p_from and p_to
    and (p_user_id is null or a.user_id = p_user_id)
    and (p_actions is null or a.action = any (p_actions))
    and (p_before is null or a.created_at < p_before)
    and (nullif(trim(coalesce(p_search, '')), '') is null
         or l.name ilike '%' || trim(p_search) || '%'
         or l.phone like '%' || regexp_replace(p_search, '\D', '', 'g') || '%')
  order by a.created_at desc, a.id
  limit least(greatest(coalesce(p_limit, 100), 1), 200);
$$;

grant execute on function public.activity_feed(date, date, uuid, text[], text, timestamptz, int) to authenticated;

-- 5b2. How many changes of each kind (for the chips above the change log)
create or replace function public.activity_counts(
  p_from    date,
  p_to      date,
  p_user_id uuid default null,
  p_search  text default null
)
returns table (action text, n int)
language sql
stable
security definer
set search_path = public
as $$
  select a.action, count(*)::int
  from public.lead_activity a
  join public.leads l on l.id = a.lead_id
  where a.user_id is not null
    and public.can_see_activity(a.user_id)
    and (a.created_at at time zone 'Asia/Dhaka')::date between p_from and p_to
    and (p_user_id is null or a.user_id = p_user_id)
    and (nullif(trim(coalesce(p_search, '')), '') is null
         or l.name ilike '%' || trim(p_search) || '%'
         or l.phone like '%' || regexp_replace(p_search, '\D', '', 'g') || '%')
  group by a.action;
$$;

grant execute on function public.activity_counts(date, date, uuid, text) to authenticated;

-- 5c. One person, day by day (the last p_days days)
create or replace function public.user_activity_days(p_user_id uuid, p_days int default 14)
returns table (day date, app_sec int, actions int, calls int)
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
           where c.user_id = p_user_id and (c.called_at at time zone 'Asia/Dhaka')::date = d.day)::int
  from days d
  where public.can_see_activity(p_user_id)
  order by d.day;
$$;

grant execute on function public.user_activity_days(uuid, int) to authenticated;

notify pgrst, 'reload schema';
