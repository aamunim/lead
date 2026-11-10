-- =====================================================================
-- 🧑‍💼🤖 Supervisor, steps 3–5 (AI: the AIs and budget of Settings → AI)
--   3. Note reader: new call notes and notes are read by the AI (20 at
--      a time, a daily limit): a promise ("will come Friday"), the
--      objections, interest going up / down, whether the note is useful.
--      → rules: a promise with nothing planned (one tap sets the
--      follow-up), interest falling, thin notes.
--   4. Reports and coach: the day's / week's report written by the AI
--      (admins: everyone · Team Leads: their team), a one-to-one page
--      for a person, today's tip; monthly admission targets per course
--      and the forecast; the playbook (answers to objections).
--   5. Ask the supervisor (questions in Bangla, answered from the numbers
--      the asker may see), before / after numbers, how often each rule
--      was right.
--   Nothing is changed by the AI: it only reads and suggests.
--   ⚡ The AI runs in the background (Edge Function ai-supervisor); the
--   app reads small stored answers.
-- =====================================================================

-- ---------------------------------------------------------------------
-- 3. What the AI read in a note
-- ---------------------------------------------------------------------
-- (the table itself is made in the supervisor migration before this one)

-- notes not read yet (newest first), within today's limit — for the AI job only
create or replace function public.sup_notes_todo(p_limit int default 20)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
set jit = off
as $$
declare
  c      jsonb := public.supervisor_setting();
  v_cap  int := coalesce((c -> 'ai' ->> 'notes_daily')::int, 200);
  v_done int;
  v_n    int;
begin
  if not coalesce((c -> 'ai' ->> 'enabled')::boolean, true) then return '[]'::jsonb; end if;
  select count(*) into v_done from public.note_insights where created_at >= public.sup_today_start();
  v_n := least(greatest(coalesce(p_limit, 20), 1), 40, greatest(v_cap - v_done, 0));
  if v_n = 0 then return '[]'::jsonb; end if;
  return coalesce((
    with n as (
      select 'call' as source, cl.id, cl.lead_id, cl.user_id, cl.called_at as written_at,
             left(trim(cl.notes), 1000) as text, cl.outcome as call_result
      from public.call_logs cl
      where cl.called_at > now() - interval '7 days' and cl.deleted_at is null
        and length(trim(coalesce(cl.notes, ''))) >= 8 and cl.lead_id is not null
        and not exists (select 1 from public.note_insights i where i.source = 'call' and i.source_id = cl.id)
      union all
      select 'note', a.id, a.lead_id, a.user_id, a.created_at, left(trim(a.details ->> 'note'), 1000), null
      from public.lead_activity a
      where a.action = 'note_added' and a.created_at > now() - interval '7 days'
        and length(trim(coalesce(a.details ->> 'note', ''))) >= 8
        and not exists (select 1 from public.note_insights i where i.source = 'note' and i.source_id = a.id)
        -- a note deleted later is not read
        and not exists (select 1 from public.lead_activity d where d.lead_id = a.lead_id and d.action = 'note_deleted'
                         and d.created_at >= a.created_at and d.details ->> 'note' = left(a.details ->> 'note', 300))
        -- the same note put on many leads at once: read once (its reading is copied to the others)
        and not exists (select 1 from public.lead_activity b where b.action = 'note_added' and b.user_id = a.user_id
                         and b.created_at = a.created_at and b.details ->> 'note' = a.details ->> 'note' and b.id < a.id)
    ),
    live as (
      select n.* from n where exists (select 1 from public.leads l where l.id = n.lead_id and l.deleted_at is null)
    ),
    -- one person's notes per batch (a note can't steer another person's reading)
    who as (select user_id from live order by written_at desc limit 1)
    select jsonb_agg(jsonb_build_object(
             'source', x.source, 'id', x.id, 'lead_id', x.lead_id, 'user_id', x.user_id, 'written_at', x.written_at,
             -- 📵 phone numbers never go to the AI
             'text', regexp_replace(regexp_replace(x.text,
                     '(?<![0-9০-৯])(\+?(88|৮৮)[ .–-]{0,2})?([0০][ .–-]{0,2})?[1১][3-9৩-৯]([ .–-]{0,2}[0-9০-৯]){8}(?![0-9০-৯])',
                     '[নম্বর]', 'g'),
                     -- any other long number (10+ digits)
                     '[0-9০-৯]{10,}', '[নম্বর]', 'g'),
             'call_result', x.call_result) order by x.written_at desc)
    from (select * from live where user_id is not distinct from (select user_id from who)
          order by written_at desc limit v_n) x), '[]'::jsonb);
end;
$$;
revoke all on function public.sup_notes_todo(int) from public, anon, authenticated;

-- the AI's reading → stored (bad values are dropped, not trusted)
create or replace function public.sup_notes_save(p_rows jsonb, p_provider text default null)
returns int
language plpgsql
security definer
set search_path = public
as $$
declare
  r      jsonb;
  v_n    int := 0;
  v_at   timestamptz;
  v_when timestamptz;
  v_lead uuid;
  v_user uuid;
  v_kind text;
begin
  if jsonb_typeof(p_rows) <> 'array' then return 0; end if;
  for r in select * from jsonb_array_elements(p_rows) loop
    if coalesce(r ->> 'source', '') not in ('call', 'note') or coalesce(r ->> 'id', '') !~ '^[0-9a-f-]{36}$' then
      continue;
    end if;
    -- the note itself says whose and when (never taken from the AI)
    if r ->> 'source' = 'call' then
      select cl.lead_id, cl.user_id, cl.called_at into v_lead, v_user, v_when
        from public.call_logs cl where cl.id = (r ->> 'id')::uuid;
    else
      select a.lead_id, a.user_id, a.created_at into v_lead, v_user, v_when
        from public.lead_activity a where a.id = (r ->> 'id')::uuid and a.action = 'note_added';
    end if;
    if v_lead is null then continue; end if;
    -- a promise: a real date, not before the note, at most 60 days after
    v_at := null;
    begin
      if coalesce(r ->> 'promise_at', '') ~ '^\d{4}-\d{2}-\d{2}' then
        v_at := case when length(r ->> 'promise_at') = 10
                     then ((r ->> 'promise_at') || ' 10:00')::timestamp at time zone 'Asia/Dhaka'
                     else (r ->> 'promise_at')::timestamp at time zone 'Asia/Dhaka' end;
        if v_at < v_when - interval '1 day' or v_at > v_when + interval '60 days' then v_at := null; end if;
      end if;
    exception when others then
      v_at := null;
    end;
    v_kind := case when r ->> 'promise_kind' in ('call', 'visit', 'admit', 'pay', 'papers', 'decide', 'other')
                   then r ->> 'promise_kind' end;
    insert into public.note_insights (source, source_id, lead_id, user_id, written_at, promise_kind, promise_text,
                                      promise_at, objections, interest, quality, tip, provider)
    values (
      r ->> 'source', (r ->> 'id')::uuid, v_lead, v_user, v_when,
      case when v_at is not null then v_kind end,
      case when v_at is not null then left(nullif(trim(r ->> 'promise_text'), ''), 160) end,
      v_at,
      coalesce((select array_agg(distinct o) from jsonb_array_elements_text(
                  case when jsonb_typeof(r -> 'objections') = 'array' then r -> 'objections' else '[]'::jsonb end) o
                where o in ('fee', 'family', 'distance', 'time', 'other_college', 'job', 'doubt', 'documents', 'other')),
               '{}'),
      case when r ->> 'interest' in ('-1', '0', '1') then (r ->> 'interest')::smallint end,
      case when r ->> 'quality' in ('good', 'thin', 'skip') then r ->> 'quality' end,
      left(nullif(trim(r ->> 'tip'), ''), 200),
      left(p_provider, 20))
    on conflict (source, source_id) do nothing;
    if found then
      v_n := v_n + 1;
      if r ->> 'source' = 'note' then
        insert into public.note_insights (source, source_id, lead_id, user_id, written_at, promise_kind, promise_text,
                                          promise_at, objections, interest, quality, tip, provider)
        select 'note', b.id, b.lead_id, b.user_id, b.created_at, i.promise_kind, i.promise_text, i.promise_at,
               i.objections, i.interest, i.quality, i.tip, i.provider
        from public.note_insights i
        join public.lead_activity a on a.id = i.source_id
        join public.lead_activity b on b.action = 'note_added' and b.user_id = a.user_id and b.created_at = a.created_at
                                    and b.details ->> 'note' = a.details ->> 'note' and b.id <> a.id
        where i.source = 'note' and i.source_id = (r ->> 'id')::uuid
        on conflict (source, source_id) do nothing;
      end if;
    end if;
  end loop;
  return v_n;
end;
$$;
revoke all on function public.sup_notes_save(jsonb, text) from public, anon, authenticated;

-- ---------------------------------------------------------------------
-- 4. Monthly admission targets (per course) and the forecast
-- ---------------------------------------------------------------------
create table if not exists public.admission_targets (
  course_id  uuid not null references public.courses (id) on delete cascade,
  -- the first day of the month
  month      date not null check (extract(day from month) = 1),
  target     integer not null check (target between 0 and 100000),
  updated_by uuid references public.profiles (id) on delete set null default auth.uid(),
  updated_at timestamptz not null default now(),
  primary key (course_id, month)
);
alter table public.admission_targets enable row level security;
drop policy if exists "targets: read" on public.admission_targets;
create policy "targets: read" on public.admission_targets for select to authenticated
  using ((select public.is_active_user()));
drop policy if exists "targets: admins" on public.admission_targets;
create policy "targets: admins" on public.admission_targets for all to authenticated
  using ((select public.has_permission('settings.manage')))
  with check ((select public.has_permission('settings.manage')));
grant select, insert, update, delete on public.admission_targets to authenticated;

-- 📈 the month per course: target, admitted, the pace, what is needed, the pipeline
create or replace function public.supervisor_forecast(p_month date default null)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
set jit = off
as $$
declare
  v_m0    date := date_trunc('month', coalesce(p_month, (now() at time zone 'Asia/Dhaka')::date))::date;
  v_m1    date := (date_trunc('month', coalesce(p_month, (now() at time zone 'Asia/Dhaka')::date)) + interval '1 month')::date;
  v_from  timestamptz := v_m0::timestamp at time zone 'Asia/Dhaka';
  v_to    timestamptz := v_m1::timestamp at time zone 'Asia/Dhaka';
  v_days  int := v_m1 - v_m0;
  v_today date := (now() at time zone 'Asia/Dhaka')::date;
  v_past  int;
  v_gold  int := coalesce((public.supervisor_setting() ->> 'golden_score')::int, 60);
begin
  if auth.uid() is not null and not (public.sup_is_admin() or public.has_permission('leads.view_team')) then
    raise exception 'Only Team Leads and admins can see this.';
  end if;
  v_past := case when v_today >= v_m1 then v_days when v_today < v_m0 then 0 else v_today - v_m0 + 1 end;
  return (
    with per as (
      select c.id, c.name,
             (select t.target from public.admission_targets t where t.course_id = c.id and t.month = v_m0) as target,
             (select count(*) from public.leads l
               where l.admitted_course_id = c.id and l.deleted_at is null and l.cancelled_at is null
                 and l.admitted_at >= v_from and l.admitted_at < v_to)::int as admitted,
             (select count(*) from public.leads l
               join public.pipeline_stages s on s.id = l.stage_id and s.kind = 'open'
               left join public.lead_chances lc on lc.lead_id = l.id
               where l.deleted_at is null and l.pipeline_course_id = c.id
                 and (coalesce(l.score, 0) >= v_gold or lc.level = 'hot'))::int as hot_open,
             (select round(coalesce(sum(lc.chance), 0) / 100.0, 1) from public.leads l
               join public.pipeline_stages s on s.id = l.stage_id and s.kind = 'open'
               join public.lead_chances lc on lc.lead_id = l.id and lc.chance is not null
               where l.deleted_at is null and l.pipeline_course_id = c.id
                 and coalesce(l.last_contacted_at, l.created_at) > now() - interval '30 days') as ai_expected
      from public.courses c
      where c.is_active
    )
    select jsonb_build_object(
      'month', v_m0, 'days', v_days, 'days_past', v_past,
      'courses', coalesce(jsonb_agg(jsonb_build_object(
        'course_id', per.id, 'name', per.name, 'target', per.target, 'admitted', per.admitted,
        -- at this pace, by the month's end
        'pace', case when v_past > 0 then round(per.admitted::numeric / v_past * v_days) end,
        'need_per_day', case when per.target is not null and v_days - v_past > 0
                             then round(greatest(per.target - per.admitted, 0)::numeric / (v_days - v_past), 1) end,
        'hot_open', per.hot_open, 'ai_expected', per.ai_expected) order by per.name), '[]'::jsonb),
      'total', jsonb_build_object(
        'target', sum(per.target), 'admitted', coalesce(sum(per.admitted), 0),
        'pace', case when v_past > 0 then round(sum(per.admitted)::numeric / v_past * v_days) end,
        'hot_open', sum(per.hot_open), 'ai_expected', sum(per.ai_expected)))
    from per);
end;
$$;
revoke all on function public.supervisor_forecast(date) from public, anon;
grant execute on function public.supervisor_forecast(date) to authenticated;

-- 📚 The playbook: the college's own answers to objections (Settings)
insert into public.app_settings (key, value) values ('supervisor_playbook', '{"items": []}'::jsonb)
on conflict (key) do nothing;

-- 💬 Objections: how often each came up (notes read by the AI, and the
--   "Chance of admission" answers), in the leads the asker may see
create or replace function public.supervisor_objections(p_days int default 30)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
set jit = off
as $$
declare
  v_me    uuid := auth.uid();
  v_admin boolean := public.sup_is_admin();
  v_tl    boolean := public.has_permission('leads.view_team');
  v_from  timestamptz := now() - make_interval(days => greatest(1, least(coalesce(p_days, 30), 365)));
begin
  if v_me is null or not public.is_active_user() then raise exception 'Please sign in.'; end if;
  return (
    with mine as (
      select l.id, l.assigned_to from public.leads l
      left join public.profiles p on p.id = l.assigned_to
      where l.deleted_at is null
        and (v_admin or l.assigned_to = v_me or (v_tl and p.team_lead_id = v_me))
    ),
    raw as (
      select i.lead_id, unnest(i.objections) as kind from public.note_insights i
      join mine m on m.id = i.lead_id
      where i.written_at >= v_from
      union all
      select lc.lead_id, o ->> 'kind' from public.lead_chances lc
      join mine m on m.id = lc.lead_id
      cross join lateral jsonb_array_elements(case when jsonb_typeof(lc.objections) = 'array' then lc.objections
                                                   else '[]'::jsonb end) o
      where lc.done_at >= v_from
    )
    select jsonb_build_object('days', greatest(1, least(coalesce(p_days, 30), 365)),
      'kinds', coalesce(jsonb_agg(jsonb_build_object('kind', k.kind, 'leads', k.leads) order by k.leads desc), '[]'::jsonb))
    from (select kind, count(distinct lead_id)::int as leads from raw
          where kind in ('fee', 'family', 'distance', 'time', 'other_college', 'job', 'doubt', 'documents', 'other')
          group by kind) k);
end;
$$;
revoke all on function public.supervisor_objections(int) from public, anon;
grant execute on function public.supervisor_objections(int) to authenticated;

-- ---------------------------------------------------------------------
-- 4. Reports (the day's, the week's), one-to-one pages, today's tips
-- ---------------------------------------------------------------------
create table if not exists public.supervisor_reports (
  id         uuid primary key default gen_random_uuid(),
  -- daily · weekly (reader: null = admins, else that Team Lead) · coach (about subject) · tip (for subject)
  kind       text not null check (kind in ('daily', 'weekly', 'coach', 'tip')),
  reader     uuid references public.profiles (id) on delete cascade,
  subject    uuid references public.profiles (id) on delete cascade,
  day        date not null,
  data       jsonb not null default '{}'::jsonb,
  body       jsonb not null default '{}'::jsonb,
  provider   text,
  created_at timestamptz not null default now()
);
create unique index if not exists supervisor_reports_key on public.supervisor_reports
  (kind, day, coalesce(reader, '00000000-0000-0000-0000-000000000000'::uuid),
   coalesce(subject, '00000000-0000-0000-0000-000000000000'::uuid));
create index if not exists supervisor_reports_reader_idx on public.supervisor_reports (kind, reader, day desc);
alter table public.supervisor_reports enable row level security;
revoke all on public.supervisor_reports from anon, authenticated;

-- the numbers for a report / a one-to-one page / a tip (the AI gets these, no phone numbers)
--   p_reader null: everyone · a Team Lead: their team · p_subject: one person
drop function if exists public.sup_report_input(uuid, uuid, int);
create or replace function public.sup_report_input(p_reader uuid, p_subject uuid, p_days int,
                                                   p_hide_managers_of uuid default null)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
set jit = off
as $$
declare
  v_to    timestamptz := now();
  v_from  timestamptz := now() - make_interval(days => greatest(1, least(p_days, 31)));
  v_prev  timestamptz := now() - make_interval(days => 2 * greatest(1, least(p_days, 31)));
begin
  return (
    with people as (
      select p.id, p.full_name from public.profiles p
      where p.is_active and p.deleted_at is null and public.role_base(p.role_key) in ('caller', 'team_lead')
        and (case when p_subject is not null then p.id = p_subject
                  when p_reader is null then true
                  else p.team_lead_id = p_reader or p.id = p_reader end)
    ),
    stats as (
      select pe.id, pe.full_name as name, w.k as period,
             (select count(*) from public.call_logs c where c.user_id = pe.id and c.deleted_at is null
                and c.called_at >= w.f and c.called_at < w.t)::int as calls,
             (select count(*) from public.call_logs c where c.user_id = pe.id and c.deleted_at is null
                and c.outcome = 'connected' and c.called_at >= w.f and c.called_at < w.t)::int as talked,
             (select coalesce(sum(c.duration_sec), 0) / 60 from public.call_logs c where c.user_id = pe.id
                and c.deleted_at is null and c.outcome = 'connected' and c.called_at >= w.f and c.called_at < w.t)::int
               as talk_min,
             (select count(*) from public.leads l where l.assigned_to = pe.id and l.created_at >= w.f
                and l.created_at < w.t)::int as new_leads,
             (select round(percentile_cont(0.5) within group (order by extract(epoch from fc.first - l.created_at) / 60))
                from public.leads l
                cross join lateral (select min(c.called_at) as first from public.call_logs c
                                     where c.lead_id = l.id and c.deleted_at is null) fc
                where l.assigned_to = pe.id and l.created_at >= w.f and l.created_at < w.t
                  and fc.first is not null and fc.first >= l.created_at)
               as first_call_min,
             (select count(*) from public.follow_ups f join public.leads l on l.id = f.lead_id
                where l.assigned_to = pe.id and f.due_at >= w.f and f.due_at < least(w.t, now())
                  and f.status <> 'cancelled')::int as followups_due,
             (select count(*) from public.follow_ups f join public.leads l on l.id = f.lead_id
                where l.assigned_to = pe.id and f.due_at >= w.f and f.due_at < least(w.t, now())
                  and f.status = 'done' and f.completed_at <= f.due_at + interval '2 hours')::int as followups_on_time,
             (select count(*) from public.leads l where l.admitted_by = pe.id and l.admitted_at >= w.f
                and l.admitted_at < w.t and l.deleted_at is null)::int as admitted,
             (select count(*) from public.lead_stage_history h join public.pipeline_stages s on s.id = h.to_stage_id
                where h.changed_by = pe.id and s.kind = 'lost' and h.changed_at >= w.f and h.changed_at < w.t)::int
               as not_now
      from people pe
      cross join (values ('now', v_from, v_to), ('before', v_prev, v_from)) as w(k, f, t)
    )
    select jsonb_build_object(
      'period_days', greatest(1, least(p_days, 31)),
      'people', coalesce((select jsonb_agg(jsonb_build_object(
          'name', split_part(coalesce(n.name, 'No name'), ' ', 1),
          'now', (select to_jsonb(s) - 'id' - 'name' - 'period' from stats s where s.id = n.id and s.period = 'now'),
          'before', (select to_jsonb(s) - 'id' - 'name' - 'period' from stats s where s.id = n.id and s.period = 'before'),
          'open_leads', (select count(*) from public.leads l join public.pipeline_stages st on st.id = l.stage_id
                          and st.kind = 'open' where l.assigned_to = n.id and l.deleted_at is null),
          'issues', (select coalesce(jsonb_object_agg(x.rule, x.n), '{}'::jsonb) from (
                      select f.rule, count(*) as n from public.supervisor_findings f
                      where f.user_id = n.id and f.status in ('open', 'snoozed')
                        -- (the Team Lead / admin-only ones are not shown to the person they are about)
                        and not (f.for_managers and coalesce(f.user_id = p_hide_managers_of, false))
                      group by f.rule) x),
          'thin_notes', (select count(*) from public.note_insights i where i.user_id = n.id and i.quality = 'thin'
                          and i.written_at >= v_from),
          'notes_read', (select count(*) from public.note_insights i where i.user_id = n.id and i.written_at >= v_from),
          'tips', (select coalesce(jsonb_agg(t.tip), '[]'::jsonb) from (
                     select i.tip from public.note_insights i where i.user_id = n.id and i.tip is not null
                       and i.written_at >= v_from order by i.written_at desc limit 3) t)))
        from (select distinct id, name from stats) n), '[]'::jsonb),
      'objections', (select coalesce(jsonb_object_agg(o.kind, o.n), '{}'::jsonb) from (
                       select unnest(i.objections) as kind, count(*) as n from public.note_insights i
                       join people pe on pe.id = i.user_id
                       where i.written_at >= v_from group by 1) o),
      'unassigned_open', case when p_reader is null and p_subject is null then
                           (select count(*) from public.leads l join public.pipeline_stages st on st.id = l.stage_id
                             and st.kind = 'open' where l.assigned_to is null and l.deleted_at is null) end,
      'forecast', case when p_subject is null then public.supervisor_forecast(null) end
    ));
end;
$$;
revoke all on function public.sup_report_input(uuid, uuid, int, uuid) from public, anon, authenticated;

-- who gets the day's / week's report: admins (null) and each Team Lead with a team
create or replace function public.sup_report_readers()
returns jsonb
language sql
stable
security definer
set search_path = public
as $$
  select jsonb_build_array(null::uuid) || coalesce((
    select jsonb_agg(distinct p.team_lead_id) from public.profiles p
    join public.profiles t on t.id = p.team_lead_id and t.is_active and t.deleted_at is null
    join public.roles r on r.key = t.role_key
    where p.team_lead_id is not null and p.is_active
      -- a Team Lead (admins read the everyone report)
      and 'leads.view_team' = any (r.permissions)
      and not ('*' = any (r.permissions) or 'leads.view_all' = any (r.permissions)
               or 'settings.manage' = any (r.permissions))), '[]'::jsonb);
$$;
revoke all on function public.sup_report_readers() from public, anon, authenticated;

create or replace function public.sup_report_save(p_kind text, p_reader uuid, p_subject uuid, p_data jsonb,
                                                  p_body jsonb, p_provider text)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_id  uuid;
  v_day date := (now() at time zone 'Asia/Dhaka')::date;
begin
  if p_kind not in ('daily', 'weekly', 'coach', 'tip') or jsonb_typeof(p_body) <> 'object' then
    raise exception 'Bad report.';
  end if;
  insert into public.supervisor_reports (kind, reader, subject, day, data, body, provider)
  values (p_kind, p_reader, p_subject, v_day, coalesce(p_data, '{}'::jsonb), p_body, left(p_provider, 20))
  on conflict (kind, day, coalesce(reader, '00000000-0000-0000-0000-000000000000'::uuid),
               coalesce(subject, '00000000-0000-0000-0000-000000000000'::uuid))
  do update set data = excluded.data, body = excluded.body, provider = excluded.provider, created_at = now()
  returning id into v_id;
  -- 90 days are kept
  delete from public.supervisor_reports where day < v_day - 90;
  return v_id;
end;
$$;
revoke all on function public.sup_report_save(text, uuid, uuid, jsonb, jsonb, text) from public, anon, authenticated;

-- 📊 the latest reports I may read (admins: everyone's · Team Leads: their team's)
create or replace function public.supervisor_reports_latest()
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_me    uuid := auth.uid();
  v_admin boolean := public.sup_is_admin();
begin
  if v_me is null or not (v_admin or public.has_permission('leads.view_team')) then
    raise exception 'Only Team Leads and admins can see this.';
  end if;
  return jsonb_build_object(
    'daily', (select to_jsonb(r) - 'data' from public.supervisor_reports r
              where r.kind = 'daily' and (case when v_admin then r.reader is null else r.reader = v_me end)
              order by r.day desc limit 1),
    'weekly', (select to_jsonb(r) - 'data' from public.supervisor_reports r
               where r.kind = 'weekly' and (case when v_admin then r.reader is null else r.reader = v_me end)
               order by r.day desc limit 1));
end;
$$;
revoke all on function public.supervisor_reports_latest() from public, anon;
grant execute on function public.supervisor_reports_latest() to authenticated;

-- today's one-to-one page / tip, if made already (the app asks the AI only when there is none)
create or replace function public.supervisor_report_get(p_kind text, p_subject uuid default null)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_subject uuid := coalesce(p_subject, auth.uid());
begin
  if auth.uid() is null or p_kind not in ('coach', 'tip') or not public.sup_can_see(v_subject) then
    raise exception 'You can''t see this.';
  end if;
  -- a one-to-one page is for Team Leads / admins (not about oneself)
  if p_kind = 'coach' and (v_subject = auth.uid() or not (public.sup_is_admin() or public.has_permission('leads.view_team'))) then
    raise exception 'You can''t see this.';
  end if;
  if p_kind = 'tip' and v_subject <> auth.uid() then raise exception 'You can''t see this.'; end if;
  return (select to_jsonb(r) - 'data' from public.supervisor_reports r
          where r.kind = p_kind and r.subject = v_subject and r.day = (now() at time zone 'Asia/Dhaka')::date
          limit 1);
end;
$$;
revoke all on function public.supervisor_report_get(text, uuid) from public, anon;
grant execute on function public.supervisor_report_get(text, uuid) to authenticated;

-- ---------------------------------------------------------------------
-- 5. Ask the supervisor: the numbers the asker may see (last 30 days)
-- ---------------------------------------------------------------------
create table if not exists public.supervisor_asks (
  user_id uuid not null references public.profiles (id) on delete cascade,
  day     date not null,
  n       integer not null default 0,
  primary key (user_id, day)
);
alter table public.supervisor_asks enable row level security;
revoke all on public.supervisor_asks from anon, authenticated;

create table if not exists public.supervisor_ai_uses (
  user_id uuid not null references public.profiles (id) on delete cascade,
  day     date not null,
  kind    text not null,
  n       integer not null default 0,
  primary key (user_id, day, kind)
);
alter table public.supervisor_ai_uses enable row level security;
revoke all on public.supervisor_ai_uses from anon, authenticated;

-- one AI use (tip: 3 a day · coach: 15 a day per person); false when used up
create or replace function public.supervisor_ai_take(p_kind text)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  v_day date := (now() at time zone 'Asia/Dhaka')::date;
  v_n   int;
begin
  if auth.uid() is null or not public.is_active_user() or p_kind not in ('tip', 'coach') then return false; end if;
  insert into public.supervisor_ai_uses (user_id, day, kind, n) values (auth.uid(), v_day, p_kind, 1)
  on conflict (user_id, day, kind) do update set n = supervisor_ai_uses.n + 1
  returning n into v_n;
  delete from public.supervisor_ai_uses where day < v_day - 7;
  return v_n <= case p_kind when 'tip' then 3 else 15 end;
end;
$$;
revoke all on function public.supervisor_ai_take(text) from public, anon;
grant execute on function public.supervisor_ai_take(text) to authenticated;

-- one question used (20 a day per person); false when today's are used up
create or replace function public.supervisor_ask_take()
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  v_day date := (now() at time zone 'Asia/Dhaka')::date;
  v_n   int;
begin
  if auth.uid() is null or not public.is_active_user() then return false; end if;
  insert into public.supervisor_asks (user_id, day, n) values (auth.uid(), v_day, 1)
  on conflict (user_id, day) do update set n = supervisor_asks.n + 1
  returning n into v_n;
  delete from public.supervisor_asks where day < v_day - 7;
  return v_n <= 20;
end;
$$;
revoke all on function public.supervisor_ask_take() from public, anon;
grant execute on function public.supervisor_ask_take() to authenticated;

create or replace function public.supervisor_ai_context()
returns jsonb
language plpgsql
stable
security definer
set search_path = public
set jit = off
as $$
declare
  v_me    uuid := auth.uid();
  v_admin boolean := public.sup_is_admin();
  v_tl    boolean := public.has_permission('leads.view_team');
begin
  if v_me is null or not public.is_active_user() then raise exception 'Please sign in.'; end if;
  return jsonb_build_object(
    'asker_role', case when v_admin then 'admin' when v_tl then 'team_lead' else 'caller' end,
    'today', to_char(now() at time zone 'Asia/Dhaka', 'YYYY-MM-DD Dy'),
    'numbers', case when v_admin then public.sup_report_input(null, null, 30)
                    when v_tl then public.sup_report_input(v_me, null, 30, v_me)
                    else public.sup_report_input(null, v_me, 30, v_me) end,
    'objections', public.supervisor_objections(30),
    'forecast', case when v_admin or v_tl then public.supervisor_forecast(null) end);
end;
$$;
revoke all on function public.supervisor_ai_context() from public, anon;
grant execute on function public.supervisor_ai_context() to authenticated;

-- ---------------------------------------------------------------------
-- 5. Before / after, and how often each rule was right
-- ---------------------------------------------------------------------
insert into public.supervisor_state (key, value) values ('started_at', now()::text)
on conflict (key) do nothing;

create or replace function public.supervisor_impact()
returns jsonb
language plpgsql
stable
security definer
set search_path = public
set jit = off
as $$
declare
  v_start timestamptz := coalesce((select value from public.supervisor_state where key = 'started_at')::timestamptz, now());
  v_days  int;
begin
  if not public.sup_is_admin() then raise exception 'Only admins can see this.'; end if;
  v_days := greatest(1, least(30, ceil(extract(epoch from now() - v_start) / 86400)::int));
  return (
    with w(k, f, t) as (
      values ('before', v_start - interval '30 days', v_start), ('after', v_start, now())
    ),
    m as (
      select w.k,
             (select round(percentile_cont(0.5) within group (order by extract(epoch from fc.first - l.created_at) / 60))
                from public.leads l
                cross join lateral (select min(c.called_at) as first from public.call_logs c
                                     where c.lead_id = l.id and c.deleted_at is null) fc
                where l.created_at >= w.f and l.created_at < w.t and fc.first is not null and fc.first >= l.created_at
                  and l.assigned_to is not null)
               as first_call_min,
             (select round(100.0 * count(*) filter (where f.status = 'done' and f.completed_at <= f.due_at + interval '2 hours')
                     / nullif(count(*), 0))
                from public.follow_ups f where f.due_at >= w.f and f.due_at < least(w.t, now() - interval '2 hours')
                  and f.status <> 'cancelled') as followups_on_time_pct,
             (select round(count(*)::numeric / greatest(1, extract(epoch from (w.t - w.f)) / 86400 / 7), 1)
                from public.leads l where l.admitted_at >= w.f and l.admitted_at < w.t and l.deleted_at is null
                  and l.cancelled_at is null) as admitted_per_week,
             (select round(count(*)::numeric / greatest(1, extract(epoch from (w.t - w.f)) / 86400), 1)
                from public.call_logs c where c.called_at >= w.f and c.called_at < w.t and c.deleted_at is null)
               as calls_per_day
      from w
    )
    select jsonb_build_object('started_at', v_start, 'days_after', v_days,
                              'before', (select to_jsonb(m) - 'k' from m where k = 'before'),
                              'after', (select to_jsonb(m) - 'k' from m where k = 'after')));
end;
$$;
revoke all on function public.supervisor_impact() from public, anon;
grant execute on function public.supervisor_impact() to authenticated;

create or replace function public.supervisor_rule_stats(p_days int default 30)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
begin
  if not public.sup_is_admin() then raise exception 'Only admins can see this.'; end if;
  return coalesce((
    select jsonb_agg(jsonb_build_object(
             'rule', rule, 'raised', n, 'done', done, 'wrong', wrong, 'fixed', fixed, 'expired', expired, 'open', open,
             'wrong_pct', round(100.0 * wrong / nullif(n, 0))) order by n desc)
    from (
      select rule, count(*)::int as n,
             count(*) filter (where status = 'done')::int as done,
             count(*) filter (where status = 'wrong')::int as wrong,
             count(*) filter (where status = 'fixed')::int as fixed,
             count(*) filter (where status = 'expired')::int as expired,
             count(*) filter (where status in ('open', 'snoozed'))::int as open
      from public.supervisor_findings
      where created_at > now() - make_interval(days => greatest(1, least(coalesce(p_days, 30), 60)))
      group by rule) x), '[]'::jsonb);
end;
$$;
revoke all on function public.supervisor_rule_stats(int) from public, anon;
grant execute on function public.supervisor_rule_stats(int) to authenticated;

-- ---------------------------------------------------------------------
-- Waking the AI job (Edge Function ai-supervisor) from the 15-minute tick
-- ---------------------------------------------------------------------
-- the AI job says the day's reports are made (the tick stops asking)
drop function if exists public.sup_reports_done();
create or replace function public.sup_reports_done(p_day text default null)
returns void
language sql
security definer
set search_path = public
as $$
  insert into public.supervisor_state (key, value)
  values ('ai_report_done', coalesce(p_day, to_char(now() at time zone 'Asia/Dhaka', 'YYYY-MM-DD')))
  on conflict (key) do update set value = excluded.value, updated_at = now();
$$;
revoke all on function public.sup_reports_done(text) from public, anon, authenticated;

-- 7. a batch the AI failed on (not a refusal): its notes are tried at most 3 times
create table if not exists public.note_insight_tries (
  source    text not null,
  source_id uuid not null,
  n         integer not null default 0,
  primary key (source, source_id)
);
alter table public.note_insight_tries enable row level security;
revoke all on public.note_insight_tries from anon, authenticated;

create or replace function public.sup_notes_failed(p_rows jsonb)
returns int
language plpgsql
security definer
set search_path = public
as $$
declare
  r   jsonb;
  v_n int := 0;
  v_t int;
begin
  if jsonb_typeof(p_rows) <> 'array' then return 0; end if;
  for r in select * from jsonb_array_elements(p_rows) loop
    if coalesce(r ->> 'source', '') not in ('call', 'note') or coalesce(r ->> 'id', '') !~ '^[0-9a-f-]{36}$' then
      continue;
    end if;
    insert into public.note_insight_tries (source, source_id, n) values (r ->> 'source', (r ->> 'id')::uuid, 1)
    on conflict (source, source_id) do update set n = note_insight_tries.n + 1
    returning n into v_t;
    -- the third failure: read, nothing kept (it is not paid for again and again)
    if v_t >= 3 then
      perform public.sup_notes_save(jsonb_build_array(jsonb_build_object('source', r ->> 'source', 'id', r ->> 'id')), null);
      v_n := v_n + 1;
    end if;
  end loop;
  delete from public.note_insight_tries t
   where exists (select 1 from public.note_insights i where i.source = t.source and i.source_id = t.source_id);
  return v_n;
end;
$$;
revoke all on function public.sup_notes_failed(jsonb) from public, anon, authenticated;

drop function if exists public.sup_ai_kick(text, boolean);
drop function if exists public.sup_ai_kick(text, boolean, boolean);
create or replace function public.sup_ai_kick(p_job text, p_weekly boolean default false, p_daily boolean default true,
                                              p_day text default null)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  v_url    text := (select value from public.ai_secrets where name = 'functions_url');
  v_secret text := (select value from public.ai_secrets where name = 'cron_secret');
begin
  if to_regproc('net.http_post') is null or v_url is null or v_secret is null then return false; end if;
  if jsonb_array_length(coalesce(public.ai_feature_plan('chance') -> 'providers', '[]'::jsonb)) = 0 then return false; end if;
  -- notes: not while a run (about a minute) may still be going
  if p_job = 'notes' then
    if coalesce((select value::timestamptz from public.supervisor_state where key = 'notes_kick_at'),
                '-infinity'::timestamptz) > now() - interval '3 minutes' then
      return false;
    end if;
    insert into public.supervisor_state (key, value) values ('notes_kick_at', now()::text)
    on conflict (key) do update set value = excluded.value, updated_at = now();
  end if;
  perform net.http_post(
    url := v_url || '/ai-supervisor',
    body := jsonb_build_object('job', p_job, 'weekly', p_weekly, 'daily', p_daily, 'day', p_day),
    headers := jsonb_build_object('Content-Type', 'application/json', 'x-cron-secret', v_secret),
    timeout_milliseconds := 5000);
  return true;
end;
$$;
revoke all on function public.sup_ai_kick(text, boolean, boolean, text) from public, anon, authenticated;

notify pgrst, 'reload schema';
