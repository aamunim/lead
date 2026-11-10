-- =====================================================================
-- 🧑‍💼 Supervisor (steps 1 and 2: rules, no AI)
--   Every 15 minutes the rules look at the team's work and write what
--   needs attention ("findings"). A finding closes by itself when the
--   problem is gone; people can also mark it done, wrong, or "later".
--   · Callers see their own · Team Leads their team · admins everyone
--   · 🌅 9 AM: each person's brief (today's calls, who first)
--   · 🌙 9 PM: the day's summary to Team Leads and admins
--   · Today's list: follow-ups, new leads, high-score leads gone quiet,
--     visits, with the hour the lead usually answers
--   Working hours 9 AM – 9 PM (Dhaka), every day; set in Settings.
--   New leads not called already have their own alerts (speed to lead);
--   the supervisor shows them but sends nothing extra for them.
--   ⚡ All the work is on the server; the app reads small answers.
-- =====================================================================

-- ---------------------------------------------------------------------
-- Settings (Settings → Supervisor)
-- ---------------------------------------------------------------------
insert into public.app_settings (key, value)
values ('supervisor', '{}'::jsonb)
on conflict (key) do nothing;

create or replace function public.supervisor_setting()
returns jsonb
language sql
stable
security definer
set search_path = public
as $$
  select jsonb_build_object(
    'enabled', true,
    'start_hour', 9,
    'end_hour', 21,
    -- 0 = Sunday … 6 = Saturday (none: every day)
    'off_days', '[]'::jsonb,
    'brief', true,
    'day_end', true,
    'day_end_team_lead', true,
    'day_end_admins', true,
    -- a high-score lead: from this score
    'golden_score', 60
  )
  -- the saved setting wins; its rules are merged one by one
  || (coalesce((select value from public.app_settings where key = 'supervisor'), '{}'::jsonb) - 'rules')
  || jsonb_build_object('rules',
       (select coalesce(jsonb_object_agg(d.key, d.value || coalesce(s.value, '{}'::jsonb)), '{}'::jsonb)
          from jsonb_each(jsonb_build_object(
                 'new_lead', '{"on":true,"minutes":60}'::jsonb, 'followup_late', '{"on":true,"hours":2}'::jsonb,
                 'hot_idle', '{"on":true,"days":3}'::jsonb, 'stuck', '{"on":true,"days":14}'::jsonb,
                 'no_note', '{"on":true,"min":3}'::jsonb, 'short_calls', '{"on":true,"sec":10,"min":5}'::jsonb,
                 'not_now_high', '{"on":true,"min":5}'::jsonb, 'no_calls', '{"on":true,"hour":12}'::jsonb,
                 'workload', '{"on":true,"ratio":1.8,"min":30}'::jsonb, 'unassigned', '{"on":true,"hours":2}'::jsonb,
                 'discount_wait', '{"on":true,"days":2}'::jsonb, 'fee_due', '{"on":true,"days":30}'::jsonb,
                 'bank_return', '{"on":true,"days":60}'::jsonb, 'bank_pull', '{"on":true,"min_open":15}'::jsonb)) d
          left join jsonb_each(coalesce((select value -> 'rules' from public.app_settings where key = 'supervisor'),
                                        '{}'::jsonb)) s on s.key = d.key));
$$;
grant execute on function public.supervisor_setting() to authenticated;

-- a rule's number (or its default)
create or replace function public.sup_num(p_cfg jsonb, p_rule text, p_key text, p_default numeric)
returns numeric
language sql
immutable
as $$
  select coalesce(nullif(p_cfg -> 'rules' -> p_rule ->> p_key, '')::numeric, p_default);
$$;

create or replace function public.sup_on(p_cfg jsonb, p_rule text)
returns boolean
language sql
immutable
as $$
  select coalesce((p_cfg -> 'rules' -> p_rule ->> 'on')::boolean, true);
$$;

-- Dhaka time now
create or replace function public.sup_local()
returns timestamp
language sql
stable
as $$
  select now() at time zone 'Asia/Dhaka';
$$;

-- today (Dhaka) as a time range
create or replace function public.sup_today_start()
returns timestamptz
language sql
stable
as $$
  select (date_trunc('day', now() at time zone 'Asia/Dhaka')) at time zone 'Asia/Dhaka';
$$;

-- ---------------------------------------------------------------------
-- Who sees whom
-- ---------------------------------------------------------------------
create or replace function public.sup_is_admin()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select public.has_permission('leads.view_all') or public.has_permission('settings.manage');
$$;

create or replace function public.sup_can_see(p_user uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select auth.uid() is not null and (
    p_user = auth.uid()
    or public.sup_is_admin()
    or (p_user is not null and public.has_permission('leads.view_team')
        and exists (select 1 from public.profiles p where p.id = p_user and p.team_lead_id = auth.uid())));
$$;
grant execute on function public.sup_is_admin() to authenticated;
grant execute on function public.sup_can_see(uuid) to authenticated;

-- ---------------------------------------------------------------------
-- Findings
-- ---------------------------------------------------------------------
create table if not exists public.supervisor_findings (
  id            uuid primary key default gen_random_uuid(),
  rule          text not null,
  -- one open finding per key (e.g. "followup_late:<follow-up id>", "no_note:<user>:<day>")
  dkey          text not null,
  -- whose work it is (null: the whole team, e.g. leads given to nobody)
  user_id       uuid references public.profiles (id) on delete cascade,
  lead_id       uuid references public.leads (id) on delete cascade,
  -- urgent: now · today: today · improve: to get better
  severity      text not null check (severity in ('urgent', 'today', 'improve')),
  -- only Team Leads and admins see it (not the person it is about)
  for_managers  boolean not null default false,
  title         text not null,
  detail        text,
  data          jsonb not null default '{}'::jsonb,
  -- open · snoozed (later) · done (marked) · wrong (marked: not right) · fixed (gone by itself)
  status        text not null default 'open' check (status in ('open', 'snoozed', 'done', 'wrong', 'fixed')),
  snooze_until  timestamptz,
  resolved_at   timestamptz,
  resolved_by   uuid references public.profiles (id) on delete set null,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);
create unique index if not exists supervisor_findings_open_key on public.supervisor_findings (dkey)
  where status in ('open', 'snoozed');
create index if not exists supervisor_findings_user_idx on public.supervisor_findings (user_id, status, severity);
create index if not exists supervisor_findings_status_idx on public.supervisor_findings (status, severity, created_at desc);
create index if not exists supervisor_findings_lead_idx on public.supervisor_findings (lead_id) where lead_id is not null;
create index if not exists supervisor_findings_done_idx on public.supervisor_findings (dkey, resolved_at)
  where status in ('done', 'wrong');

-- read and changed only through the functions below
alter table public.supervisor_findings enable row level security;
revoke all on public.supervisor_findings from anon, authenticated;

-- small memory: when the brief / summary last went out
create table if not exists public.supervisor_state (
  key        text primary key,
  value      text,
  updated_at timestamptz not null default now()
);
alter table public.supervisor_state enable row level security;
revoke all on public.supervisor_state from anon, authenticated;

-- ---------------------------------------------------------------------
-- The rules → what needs attention now
--   p_heavy: also the slower team-wide rules (hourly)
-- ---------------------------------------------------------------------
create or replace function public.supervisor_run(p_heavy boolean default true)
returns jsonb
language plpgsql
security definer
set search_path = public
set jit = off
as $$
declare
  c        jsonb := public.supervisor_setting();
  v_local  timestamp := public.sup_local();
  v_day0   timestamptz := public.sup_today_start();
  v_day    text := to_char(public.sup_local(), 'YYYY-MM-DD');
  v_week   text := to_char(public.sup_local(), 'IYYY-IW');
  v_rules  text[] := array['new_lead', 'followup_late', 'hot_idle', 'no_note', 'no_calls'];
  v_new    int;
  v_fixed  int;
  v_gold   int := coalesce((c ->> 'golden_score')::int, 60);
  v_work   boolean := not (extract(dow from public.sup_local())::int in
                             (select (jsonb_array_elements_text(coalesce(c -> 'off_days', '[]'::jsonb)))::int));
begin
  if not coalesce((c ->> 'enabled')::boolean, true) then
    return jsonb_build_object('enabled', false);
  end if;
  if p_heavy then
    v_rules := v_rules || array['stuck', 'short_calls', 'not_now_high', 'workload', 'unassigned', 'discount_wait',
                                'fee_due', 'bank_return', 'bank_pull'];
  end if;

  if to_regclass('pg_temp._sup') is null then
  create temp table _sup (
    rule text, dkey text, user_id uuid, lead_id uuid, severity text, for_managers boolean,
    title text, detail text, data jsonb
  ) on commit drop;
  end if;
  truncate _sup;

  -- 🆕 a new lead not called yet (its alerts already go out: shown here only)
  if public.sup_on(c, 'new_lead') then
    insert into _sup
    select 'new_lead', 'new_lead:' || l.id, l.assigned_to, l.id, 'urgent', false,
           'নতুন lead-এ এখনো কল হয়নি',
           l.name || ' · ' || floor(extract(epoch from now() - l.created_at) / 60)::int || ' মিনিট আগে এসেছে',
           jsonb_build_object('minutes', floor(extract(epoch from now() - l.created_at) / 60)::int)
    from public.leads l
    join public.pipeline_stages s on s.id = l.stage_id and s.kind = 'open'
    where l.deleted_at is null and l.assigned_to is not null
      and l.created_at > now() - interval '3 days'
      and l.created_at <= now() - make_interval(mins => public.sup_num(c, 'new_lead', 'minutes', 60)::int)
      and l.last_contacted_at is null
      and not exists (select 1 from public.call_logs cl where cl.lead_id = l.id and cl.deleted_at is null);
  end if;

  -- ⏰ a follow-up left late
  if public.sup_on(c, 'followup_late') then
    insert into _sup
    select 'followup_late', 'followup_late:' || f.id, l.assigned_to, l.id, 'today', false,
           'Follow-up বাকি',
           l.name || ' · কথা ছিল ' || to_char(f.due_at at time zone 'Asia/Dhaka', 'DD Mon, HH12:MI AM')
             || coalesce(' · ' || left(nullif(trim(f.note), ''), 80), ''),
           jsonb_build_object('due_at', f.due_at)
    from public.follow_ups f
    join public.leads l on l.id = f.lead_id and l.deleted_at is null and l.assigned_to is not null
    join public.pipeline_stages s on s.id = l.stage_id and s.kind = 'open'
    where f.status = 'pending'
      and f.due_at < now() - make_interval(hours => public.sup_num(c, 'followup_late', 'hours', 2)::int)
      and f.due_at > now() - interval '14 days';
  end if;

  -- 🎯 a lead likely to join (high score, rated hot, or AI says hot) gone quiet
  if public.sup_on(c, 'hot_idle') then
    -- (the 10 best per person: a list to act on, not a flood)
    insert into _sup
    select h.rule, h.dkey, h.user_id, h.lead_id, h.severity, h.for_managers, h.title, h.detail, h.data
    from (
    select 'hot_idle' as rule, 'hot_idle:' || l.id as dkey, l.assigned_to as user_id, l.id as lead_id,
           'today' as severity, false as for_managers,
           'সম্ভাবনাময় lead চুপচাপ পড়ে আছে' as title,
           l.name || ' · score ' || coalesce(l.score, 0)
             || case when lc.level = 'hot' then ' · AI: hot' when l.rating = 'hot' then ' · 🔥 hot' else '' end
             || ' · ' || floor(extract(epoch from now() - coalesce(l.last_contacted_at, l.created_at)) / 86400)::int
             || ' দিন কথা হয়নি' as detail,
           jsonb_build_object('score', l.score,
                              'days', floor(extract(epoch from now() - coalesce(l.last_contacted_at, l.created_at)) / 86400)::int) as data,
           row_number() over (partition by l.assigned_to
                              order by coalesce(l.score, 0) desc, coalesce(l.last_contacted_at, l.created_at)) as rn
    from public.leads l
    join public.pipeline_stages s on s.id = l.stage_id and s.kind = 'open'
    left join public.lead_chances lc on lc.lead_id = l.id
    where l.deleted_at is null and l.assigned_to is not null
      and (coalesce(l.score, 0) >= v_gold or l.rating = 'hot' or lc.level = 'hot')
      and coalesce(l.last_contacted_at, l.created_at)
          < now() - make_interval(days => public.sup_num(c, 'hot_idle', 'days', 3)::int)
      -- a call planned for later: not forgotten
      and not exists (select 1 from public.follow_ups f
                      where f.lead_id = l.id and f.status = 'pending' and f.due_at > now())
    ) h
    where h.rn <= 10;
  end if;

  -- 📝 calls today with no note (from 3)
  if public.sup_on(c, 'no_note') then
    insert into _sup
    select 'no_note', 'no_note:' || x.user_id || ':' || v_day, x.user_id, null, 'improve', false,
           'Note ছাড়া কল',
           'আজ কথা হয়েছে এমন ' || x.n || 'টা কলে note নেই। পরের পদক্ষেপ লিখে রাখলে পরে কাজে লাগে।',
           jsonb_build_object('count', x.n, 'lead_ids', x.ids)
    from (
      select cl.user_id, count(*)::int as n, (array_agg(distinct cl.lead_id))[1:50] as ids
      from public.call_logs cl
      where cl.called_at >= v_day0 and cl.deleted_at is null and cl.outcome = 'connected'
        and coalesce(cl.channel, 'phone') = 'phone'
        and nullif(trim(coalesce(cl.notes, '')), '') is null
        and cl.lead_id is not null
        and cl.user_id is not null
      group by cl.user_id
    ) x
    where x.n >= public.sup_num(c, 'no_note', 'min', 3);
  end if;

  -- 📵 no calls yet today by midday (on a working day)
  if public.sup_on(c, 'no_calls') and v_work
     and extract(hour from v_local) >= public.sup_num(c, 'no_calls', 'hour', 12)
     and extract(hour from v_local) < coalesce((c ->> 'end_hour')::int, 21) then
    insert into _sup
    select 'no_calls', 'no_calls:' || p.id || ':' || v_day, p.id, null, 'today', true,
           'আজ এখনো কোনো কল নেই',
           p.full_name || ' · ' || x.open_leads || 'টা open lead আছে',
           jsonb_build_object('open_leads', x.open_leads)
    from public.profiles p
    join lateral (
      select count(*)::int as open_leads
      from public.leads l join public.pipeline_stages s on s.id = l.stage_id and s.kind = 'open'
      where l.assigned_to = p.id and l.deleted_at is null
    ) x on x.open_leads > 0
    where p.is_active and p.deleted_at is null
      and public.role_base(p.role_key) in ('caller', 'team_lead')
      and not exists (select 1 from public.call_logs cl where cl.user_id = p.id and cl.called_at >= v_day0);
  end if;

  if p_heavy then
    -- 🧊 many leads at the same stage for long
    if public.sup_on(c, 'stuck') then
      insert into _sup
      select 'stuck', 'stuck:' || x.user_id, x.user_id, null, 'improve', false,
             'অনেক দিন একই stage-এ',
             x.n || 'টা lead ' || public.sup_num(c, 'stuck', 'days', 14)::int
               || ' দিনের বেশি একই stage-এ। কথা বলে এগিয়ে নিন, বা Not Now / Lead Bank-এ দিন।',
             jsonb_build_object('count', x.n, 'lead_ids', x.ids)
      from (
        select l.assigned_to as user_id, count(*)::int as n, (array_agg(l.id order by l.score desc nulls last))[1:50] as ids
        from public.leads l
        join public.pipeline_stages s on s.id = l.stage_id and s.kind = 'open'
        where l.deleted_at is null and l.assigned_to is not null
          and l.created_at < now() - make_interval(days => public.sup_num(c, 'stuck', 'days', 14)::int)
          and coalesce((select max(h.changed_at) from public.lead_stage_history h where h.lead_id = l.id), l.created_at)
              < now() - make_interval(days => public.sup_num(c, 'stuck', 'days', 14)::int)
        group by l.assigned_to
      ) x
      where x.n >= 5;
    end if;

    -- ⏱ many very short "talked" calls today (to Team Leads / admins only)
    if public.sup_on(c, 'short_calls') then
      insert into _sup
      select 'short_calls', 'short_calls:' || x.user_id || ':' || v_day, x.user_id, null, 'improve', true,
             'খুব ছোট "কথা হয়েছে" কল',
             p.full_name || ' · আজ ' || x.n || 'টা কল ' || public.sup_num(c, 'short_calls', 'sec', 10)::int
               || ' সেকেন্ডের কম, অথচ "কথা হয়েছে" লেখা। একবার দেখে নিন (প্রমাণ না, শুধু ইঙ্গিত)।',
             jsonb_build_object('count', x.n, 'lead_ids', x.ids)
      from (
        select cl.user_id, count(*)::int as n, (array_agg(distinct cl.lead_id))[1:50] as ids
        from public.call_logs cl
        where cl.called_at >= v_day0 and cl.deleted_at is null and cl.outcome = 'connected'
          and coalesce(cl.channel, 'phone') = 'phone'
          and cl.duration_sec is not null and cl.duration_sec < public.sup_num(c, 'short_calls', 'sec', 10)
          and cl.user_id is not null
        group by cl.user_id
      ) x
      join public.profiles p on p.id = x.user_id
      where x.n >= public.sup_num(c, 'short_calls', 'min', 5);
    end if;

    -- ✕ many leads put to Not Now this week, twice the team's average (managers)
    if public.sup_on(c, 'not_now_high') then
      insert into _sup
      select 'not_now_high', 'not_now_high:' || x.user_id || ':' || v_week, x.user_id, null, 'improve', true,
             'বেশি Not Now',
             p.full_name || ' · গত ৭ দিনে ' || x.n || 'টা lead Not Now (টিমের গড় ' || round(x.avg_n, 1) || ')',
             jsonb_build_object('count', x.n, 'team_avg', round(x.avg_n, 1))
      from (
        select h.changed_by as user_id, count(*)::int as n, avg(count(*)) over () as avg_n
        from public.lead_stage_history h
        join public.pipeline_stages s on s.id = h.to_stage_id and s.kind = 'lost'
        where h.changed_at > now() - interval '7 days' and h.changed_by is not null
        group by h.changed_by
      ) x
      join public.profiles p on p.id = x.user_id and p.is_active
      where x.n >= public.sup_num(c, 'not_now_high', 'min', 5) and x.n >= 2 * x.avg_n
        and (select count(distinct h2.changed_by) from public.lead_stage_history h2
              where h2.changed_at > now() - interval '7 days') >= 2;
    end if;

    -- ⚖️ one person holds far more open leads than the others (managers)
    if public.sup_on(c, 'workload') then
      insert into _sup
      select 'workload', 'workload:' || x.user_id, x.user_id, null, 'improve', true,
             'কাজের ভার বেশি',
             x.name || '-এর হাতে ' || x.n || 'টা open lead (টিমের মাঝামাঝি ' || x.med::int || ')। কিছু lead অন্যকে দিন।',
             jsonb_build_object('count', x.n, 'median', x.med::int)
      from (
        with per as (
          select p.id as user_id, p.full_name as name, count(l.id)::int as n
          from public.profiles p
          left join public.leads l on l.assigned_to = p.id and l.deleted_at is null
               and exists (select 1 from public.pipeline_stages s where s.id = l.stage_id and s.kind = 'open')
          where p.is_active and p.deleted_at is null and public.role_base(p.role_key) in ('caller', 'team_lead')
          group by p.id, p.full_name
        )
        select per.*, (select percentile_cont(0.5) within group (order by n) from per) as med from per
      ) x
      where x.n >= public.sup_num(c, 'workload', 'min', 30)
        and x.med > 0 and x.n >= public.sup_num(c, 'workload', 'ratio', 1.8) * x.med;
    end if;

    -- 🙋 leads given to nobody (admins)
    if public.sup_on(c, 'unassigned') then
      insert into _sup
      select 'unassigned', 'unassigned', null, null, 'today', true,
             'কাউকে দেওয়া হয়নি এমন lead',
             x.n || 'টা open lead কারো নামে নেই। কাউকে দিন, নইলে কেউ কল করবে না।',
             jsonb_build_object('count', x.n, 'lead_ids', x.ids)
      from (
        select count(*)::int as n, (array_agg(l.id order by l.created_at desc))[1:50] as ids
        from public.leads l
        join public.pipeline_stages s on s.id = l.stage_id and s.kind = 'open'
        where l.deleted_at is null and l.assigned_to is null
          and l.created_at < now() - make_interval(hours => public.sup_num(c, 'unassigned', 'hours', 2)::int)
      ) x
      where x.n > 0;
    end if;

    -- 💸 discount requests waiting long (admins)
    if public.sup_on(c, 'discount_wait') then
      insert into _sup
      select 'discount_wait', 'discount_wait', null, null, 'today', true,
             'Discount অনুরোধ অপেক্ষায়',
             x.n || 'টা discount অনুরোধ ' || public.sup_num(c, 'discount_wait', 'days', 2)::int
               || ' দিনের বেশি ঝুলে আছে। Approvals-এ দেখুন।',
             jsonb_build_object('count', x.n, 'lead_ids', x.ids, 'route', '/approvals')
      from (
        select count(*)::int as n, (array_agg(distinct d.lead_id))[1:50] as ids
        from public.fee_discounts d
        where d.status = 'pending'
          and d.requested_at < now() - make_interval(days => public.sup_num(c, 'discount_wait', 'days', 2)::int)
      ) x
      where x.n > 0;
    end if;

    -- 💰 admitted students with fee due and no payment for long
    if public.sup_on(c, 'fee_due') then
      insert into _sup
      select 'fee_due', 'fee_due:' || x.user_id, x.user_id, null, 'improve', false,
             'ভর্তি হয়েছে, fee বাকি',
             x.n || ' জন ছাত্রের মোট ৳' || to_char(x.due, 'FM99,99,99,999') || ' বাকি, '
               || public.sup_num(c, 'fee_due', 'days', 30)::int || ' দিনে কোনো payment নেই।',
             jsonb_build_object('count', x.n, 'due', x.due, 'lead_ids', x.ids)
      from (
        select l.assigned_to as user_id, count(*)::int as n, sum(l.fee_due) as due,
               (array_agg(l.id order by l.fee_due desc))[1:50] as ids
        from public.leads l
        where l.deleted_at is null and l.assigned_to is not null
          and l.admitted_at is not null and l.cancelled_at is null
          and coalesce(l.fee_due, 0) > 0
          and coalesce(l.fee_last_paid_at, l.admitted_at)
              < now() - make_interval(days => public.sup_num(c, 'fee_due', 'days', 30)::int)
        group by l.assigned_to
      ) x;
    end if;

    -- 🏦 old leads with no progress: the Lead Bank is the better place (admins)
    if public.sup_on(c, 'bank_return') and to_regclass('public.lead_bank') is not null then
      insert into _sup
      select 'bank_return', 'bank_return:' || x.user_id, x.user_id, null, 'improve', true,
             'Lead Bank-এ ফেরত পাঠানোর মতো',
             x.name || '-এর ' || x.n || 'টা lead-এ ' || public.sup_num(c, 'bank_return', 'days', 60)::int
               || ' দিন কোনো অগ্রগতি নেই। Lead Bank-এ রাখলে তালিকা হালকা হবে, পরে আবার আনা যাবে।',
             jsonb_build_object('count', x.n, 'lead_ids', x.ids)
      from (
        select l.assigned_to as user_id, p.full_name as name, count(*)::int as n,
               (array_agg(l.id order by l.last_contacted_at nulls first))[1:50] as ids
        from public.leads l
        join public.pipeline_stages s on s.id = l.stage_id and s.kind = 'open'
        join public.profiles p on p.id = l.assigned_to
        where l.deleted_at is null and l.admitted_at is null
          and l.created_at < now() - make_interval(days => public.sup_num(c, 'bank_return', 'days', 60)::int)
          and coalesce(l.last_contacted_at, l.created_at)
              < now() - make_interval(days => (public.sup_num(c, 'bank_return', 'days', 60) / 2)::int)
          and coalesce((select max(h.changed_at) from public.lead_stage_history h where h.lead_id = l.id), l.created_at)
              < now() - make_interval(days => public.sup_num(c, 'bank_return', 'days', 60)::int)
          and coalesce(l.score, 0) < v_gold
        group by l.assigned_to, p.full_name
      ) x
      where x.n >= 10;
    end if;

    -- 🏦 someone has little to do while the bank has new numbers (admins)
    if public.sup_on(c, 'bank_pull') and to_regclass('public.lead_bank') is not null then
      insert into _sup
      select 'bank_pull', 'bank_pull:' || p.id || ':' || v_day, p.id, null, 'today', true,
             'হাতে কাজ কম',
             p.full_name || '-এর হাতে মাত্র ' || x.n || 'টা open lead। Lead Bank-এ ' || b.n
               || 'টা নতুন নম্বর অপেক্ষায়, কিছু দিন।',
             jsonb_build_object('open_leads', x.n, 'bank_new', b.n, 'route', '/bank')
      from public.profiles p
      join lateral (
        select count(*)::int as n
        from public.leads l join public.pipeline_stages s on s.id = l.stage_id and s.kind = 'open'
        where l.assigned_to = p.id and l.deleted_at is null
      ) x on true
      cross join lateral (
        select count(*)::int as n from public.lead_bank lb
        where lb.status = 'new' and not lb.do_not_call
      ) b
      where p.is_active and p.deleted_at is null and public.role_base(p.role_key) = 'caller'
        and x.n < public.sup_num(c, 'bank_pull', 'min_open', 15) and b.n > 0;
    end if;
  end if;

  -- ---- write: new ones, refresh the open ones, close what is gone ----
  insert into public.supervisor_findings (rule, dkey, user_id, lead_id, severity, for_managers, title, detail, data)
  select s.rule, s.dkey, s.user_id, s.lead_id, s.severity, s.for_managers, s.title, s.detail, s.data
  from (select distinct on (dkey) * from _sup order by dkey) s
  where not exists (
    select 1 from public.supervisor_findings f
    where f.dkey = s.dkey
      and (f.status in ('open', 'snoozed')
           -- marked "not right": quiet for 30 days · marked done: for the rest of the day
           or (f.status = 'wrong' and f.resolved_at > now() - interval '30 days')
           or (f.status = 'done' and f.resolved_at > now() - interval '20 hours')));
  get diagnostics v_new = row_count;

  update public.supervisor_findings f
     set title = s.title, detail = s.detail, data = s.data, severity = s.severity, updated_at = now()
    from (select distinct on (dkey) * from _sup order by dkey) s
   where f.dkey = s.dkey and f.status in ('open', 'snoozed')
     and (f.detail is distinct from s.detail or f.data is distinct from s.data or f.severity is distinct from s.severity);

  -- "later" is over
  update public.supervisor_findings
     set status = 'open', snooze_until = null, updated_at = now()
   where status = 'snoozed' and snooze_until <= now();

  -- the problem is gone (only for the rules looked at now)
  update public.supervisor_findings f
     set status = 'fixed', resolved_at = now(), updated_at = now()
   where f.status in ('open', 'snoozed') and f.rule = any (v_rules)
     and not exists (select 1 from _sup s where s.dkey = f.dkey);
  get diagnostics v_fixed = row_count;

  -- old closed ones go after 60 days
  if p_heavy then
    delete from public.supervisor_findings
     where status in ('done', 'wrong', 'fixed') and resolved_at < now() - interval '60 days';
  end if;

  return jsonb_build_object('new', v_new, 'fixed', v_fixed, 'open', (select count(*) from _sup));
end;
$$;
revoke all on function public.supervisor_run(boolean) from public, anon, authenticated;

-- ---------------------------------------------------------------------
-- 📋 Today's list for one person: who to call first, and why
-- ---------------------------------------------------------------------
create or replace function public.supervisor_tasks(p_user uuid default null, p_limit int default 15)
returns table(lead_id uuid, name text, phone text, kind text, reason text, priority int,
              due_at timestamptz, score int, best_hour int)
language plpgsql
stable
security definer
set search_path = public
set jit = off
as $$
declare
  v_user uuid := coalesce(p_user, auth.uid());
  v_gold int := coalesce((public.supervisor_setting() ->> 'golden_score')::int, 60);
  v_end  timestamptz := public.sup_today_start() + interval '1 day';
begin
  if v_user is null or (auth.uid() is not null and not public.sup_can_see(v_user)) then
    raise exception 'You can''t see this.';
  end if;
  return query
  with mine as (
    select l.id, l.name, coalesce(l.phone, l.whatsapp_number) as phone, l.score, l.created_at,
           l.last_contacted_at, l.visit_status, l.visit_at
    from public.leads l
    join public.pipeline_stages s on s.id = l.stage_id and s.kind = 'open'
    where l.assigned_to = v_user and l.deleted_at is null
  ),
  c as (
    -- ⏰ follow-ups due today or late
    select m.id, 'followup' as kind,
           case when f.due_at < now() then '⏰ Follow-up দেরি হয়েছে (' else '⏰ আজ follow-up (' end
             || to_char(f.due_at at time zone 'Asia/Dhaka', 'HH12:MI AM') || ')'
             || coalesce(' · ' || left(nullif(trim(f.note), ''), 60), '') as reason,
           100 + least(48, greatest(0, floor(extract(epoch from now() - f.due_at) / 3600)))::int as priority,
           f.due_at
    from mine m join public.follow_ups f on f.lead_id = m.id and f.status = 'pending'
    where f.due_at < v_end
    union all
    -- 🆕 new, not called yet
    select m.id, 'new', '🆕 নতুন lead, এখনো কল হয়নি', 95, null
    from mine m
    where m.last_contacted_at is null and m.created_at > now() - interval '3 days'
      and not exists (select 1 from public.call_logs cl where cl.lead_id = m.id and cl.deleted_at is null)
    union all
    -- 🏫 campus visit today
    select m.id, 'visit', '🏫 আজ campus visit', 90, m.visit_at
    from mine m
    where m.visit_status = 'planned' and m.visit_at >= public.sup_today_start() and m.visit_at < v_end
    union all
    -- 🎯 high score, quiet for 2+ days, nothing planned
    select m.id, 'golden',
           '🎯 সম্ভাবনা বেশি (score ' || m.score || ') · '
             || floor(extract(epoch from now() - coalesce(m.last_contacted_at, m.created_at)) / 86400)::int
             || ' দিন কথা হয়নি',
           60 + least(30, coalesce(m.score, 0) / 3), null
    from mine m
    where coalesce(m.score, 0) >= v_gold
      and coalesce(m.last_contacted_at, m.created_at) < now() - interval '2 days'
      and not exists (select 1 from public.follow_ups f where f.lead_id = m.id and f.status = 'pending' and f.due_at >= v_end)
  ),
  best as (
    select distinct on (c.id) c.* from c order by c.id, c.priority desc
  ),
  top as (
    select b.*, m.name, m.phone, m.score from best b join mine m on m.id = b.id
    order by b.priority desc, m.score desc nulls last
    limit greatest(1, least(p_limit, 50))
  )
  select t.id, t.name, t.phone, t.kind, t.reason, t.priority, t.due_at, t.score,
         -- 🕐 the hour this lead usually answers (from 2 talks)
         (select h.hr from (
            select extract(hour from cl.called_at at time zone 'Asia/Dhaka')::int as hr, count(*) as n
            from public.call_logs cl
            where cl.lead_id = t.id and cl.outcome = 'connected' and cl.deleted_at is null
            group by 1 having count(*) >= 2 order by count(*) desc, 1 limit 1) h)
  from top t
  order by t.priority desc, t.score desc nulls last;
end;
$$;
grant execute on function public.supervisor_tasks(uuid, int) to authenticated;

-- ---------------------------------------------------------------------
-- 🏠 The Home card: my counts, the first findings, today's first calls,
--   and (Team Leads / admins) the team's counts — one request
-- ---------------------------------------------------------------------
create or replace function public.supervisor_home()
returns jsonb
language plpgsql
stable
security definer
set search_path = public
set jit = off
as $$
declare
  c       jsonb := public.supervisor_setting();
  v_me    uuid := auth.uid();
  v_admin boolean := public.sup_is_admin();
  v_tl    boolean := public.has_permission('leads.view_team');
begin
  if v_me is null or not public.is_active_user() then return null; end if;
  if not coalesce((c ->> 'enabled')::boolean, true) then return jsonb_build_object('enabled', false); end if;
  return jsonb_build_object(
    'enabled', true,
    'manager', v_admin or v_tl,
    'me', (select jsonb_build_object(
              'urgent', count(*) filter (where severity = 'urgent'),
              'today', count(*) filter (where severity = 'today'),
              'improve', count(*) filter (where severity = 'improve'))
           from public.supervisor_findings
           where user_id = v_me and status = 'open' and not for_managers),
    'top', coalesce((select jsonb_agg(x) from (
              select f.id, f.rule, f.severity, f.title, f.detail, f.lead_id
              from public.supervisor_findings f
              where f.user_id = v_me and f.status = 'open' and not f.for_managers
              order by case f.severity when 'urgent' then 0 when 'today' then 1 else 2 end, f.created_at desc
              limit 3) x), '[]'::jsonb),
    'tasks', coalesce((select jsonb_agg(t) from public.supervisor_tasks(v_me, 5) t), '[]'::jsonb),
    'team', case when v_admin or v_tl then (
              select jsonb_build_object(
                'urgent', count(*) filter (where f.severity = 'urgent'),
                'today', count(*) filter (where f.severity = 'today'),
                'improve', count(*) filter (where f.severity = 'improve'),
                'people', count(distinct f.user_id))
              from public.supervisor_findings f
              left join public.profiles p on p.id = f.user_id
              where f.status = 'open' and (f.user_id is distinct from v_me or f.for_managers)
                and (v_admin or p.team_lead_id = v_me)) end
  );
end;
$$;
grant execute on function public.supervisor_home() to authenticated;

-- ---------------------------------------------------------------------
-- 🗂 The findings list
--   p_scope: 'me' (mine) · 'team' (the people I look after, and the
--   whole-team ones for admins)
-- ---------------------------------------------------------------------
create or replace function public.supervisor_list(
  p_scope    text default 'me',
  p_severity text default null,
  p_user     uuid default null,
  p_status   text default 'open',
  p_limit    int default 50,
  p_offset   int default 0
)
returns table(id uuid, rule text, severity text, title text, detail text, data jsonb, status text,
              lead_id uuid, lead_name text, user_id uuid, user_name text, for_managers boolean,
              created_at timestamptz, updated_at timestamptz, snooze_until timestamptz)
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
  return query
  select f.id, f.rule, f.severity, f.title, f.detail, f.data, f.status, f.lead_id, l.name, f.user_id, p.full_name,
         f.for_managers, f.created_at, f.updated_at, f.snooze_until
  from public.supervisor_findings f
  left join public.leads l on l.id = f.lead_id
  left join public.profiles p on p.id = f.user_id
  where (p_status = 'all' or (p_status = 'open' and f.status in ('open', 'snoozed')) or f.status = p_status)
    and (p_severity is null or f.severity = p_severity)
    and (p_user is null or f.user_id = p_user)
    and case
          when p_scope = 'team' then
            (v_admin or (v_tl and p.team_lead_id = v_me))
            and (f.user_id is distinct from v_me or f.for_managers)
          else f.user_id = v_me and not f.for_managers
        end
  order by case f.status when 'open' then 0 when 'snoozed' then 1 else 2 end,
           case f.severity when 'urgent' then 0 when 'today' then 1 else 2 end,
           f.updated_at desc
  limit greatest(1, least(p_limit, 200)) offset greatest(0, p_offset);
end;
$$;
grant execute on function public.supervisor_list(text, text, uuid, text, int, int) to authenticated;

-- ✅ done · ❌ not right · ⏳ later (1–7 days) · ↩ open again
create or replace function public.supervisor_mark(p_ids uuid[], p_status text, p_days int default 1)
returns int
language plpgsql
security definer
set search_path = public
as $$
declare
  v_me    uuid := auth.uid();
  v_admin boolean := public.sup_is_admin();
  v_n     int;
begin
  if v_me is null or not public.is_active_user() then raise exception 'Please sign in.'; end if;
  if p_status not in ('done', 'wrong', 'snoozed', 'open') then raise exception 'Unknown status.'; end if;
  if coalesce(array_length(p_ids, 1), 0) = 0 then return 0; end if;
  update public.supervisor_findings f
     set status = p_status,
         snooze_until = case when p_status = 'snoozed'
                             then now() + make_interval(days => greatest(1, least(coalesce(p_days, 1), 7))) end,
         resolved_at = case when p_status in ('done', 'wrong') then now() end,
         resolved_by = case when p_status in ('done', 'wrong') then v_me end,
         updated_at = now()
   where f.id = any (p_ids)
     and f.status <> 'fixed'
     and (
       (f.user_id = v_me and not f.for_managers)
       or v_admin
       or (f.user_id is not null and public.has_permission('leads.view_team')
           and exists (select 1 from public.profiles p where p.id = f.user_id and p.team_lead_id = v_me)));
  get diagnostics v_n = row_count;
  return v_n;
end;
$$;
grant execute on function public.supervisor_mark(uuid[], text, int) to authenticated;

-- ---------------------------------------------------------------------
-- 👥 The team today (Team Leads: their team · admins: everyone)
-- ---------------------------------------------------------------------
create or replace function public.supervisor_team()
returns table(user_id uuid, name text, role text, open_leads int, calls int, talked int, talk_min int,
              followups_late int, new_waiting int, golden_quiet int, urgent int, today int, improve int,
              last_call timestamptz)
language plpgsql
stable
security definer
set search_path = public
set jit = off
as $$
declare
  v_me    uuid := auth.uid();
  v_admin boolean := public.sup_is_admin();
  v_day0  timestamptz := public.sup_today_start();
  v_gold  int := coalesce((public.supervisor_setting() ->> 'golden_score')::int, 60);
begin
  if v_me is null or not (v_admin or public.has_permission('leads.view_team')) then
    raise exception 'Only Team Leads and admins can see this.';
  end if;
  return query
  with people as (
    select p.id, p.full_name, p.role_key
    from public.profiles p
    where p.is_active and p.deleted_at is null
      and public.role_base(p.role_key) in ('caller', 'team_lead')
      and (v_admin or p.team_lead_id = v_me or p.id = v_me)
  ),
  open_l as (
    select l.assigned_to, l.id, l.score, l.created_at, l.last_contacted_at
    from public.leads l
    join public.pipeline_stages s on s.id = l.stage_id and s.kind = 'open'
    where l.deleted_at is null and l.assigned_to in (select id from people)
  )
  select pe.id, pe.full_name, pe.role_key,
         (select count(*)::int from open_l o where o.assigned_to = pe.id),
         coalesce(cl.calls, 0), coalesce(cl.talked, 0), coalesce(cl.talk_min, 0),
         (select count(*)::int from public.follow_ups f join open_l o on o.id = f.lead_id
           where o.assigned_to = pe.id and f.status = 'pending' and f.due_at < now()),
         (select count(*)::int from open_l o where o.assigned_to = pe.id and o.last_contacted_at is null
             and o.created_at > now() - interval '3 days'),
         (select count(*)::int from open_l o where o.assigned_to = pe.id and coalesce(o.score, 0) >= v_gold
             and coalesce(o.last_contacted_at, o.created_at) < now() - interval '2 days'),
         coalesce(fs.urgent, 0), coalesce(fs.today, 0), coalesce(fs.improve, 0),
         cl.last_call
  from people pe
  left join lateral (
    select count(*)::int as calls,
           count(*) filter (where c.outcome = 'connected')::int as talked,
           (coalesce(sum(c.duration_sec) filter (where c.outcome = 'connected'), 0) / 60)::int as talk_min,
           max(c.called_at) as last_call
    from public.call_logs c
    where c.user_id = pe.id and c.called_at >= v_day0 and c.deleted_at is null
  ) cl on true
  left join lateral (
    select count(*) filter (where f.severity = 'urgent')::int as urgent,
           count(*) filter (where f.severity = 'today')::int as today,
           count(*) filter (where f.severity = 'improve')::int as improve
    from public.supervisor_findings f
    where f.user_id = pe.id and f.status = 'open'
  ) fs on true
  order by coalesce(fs.urgent, 0) desc, coalesce(fs.today, 0) desc, pe.full_name;
end;
$$;
grant execute on function public.supervisor_team() to authenticated;

-- ---------------------------------------------------------------------
-- 🌅 Morning brief (to each person with open leads)
-- ---------------------------------------------------------------------
create or replace function public.supervisor_send_briefs()
returns int
language plpgsql
security definer
set search_path = public
set jit = off
as $$
declare
  r     record;
  v_n   int := 0;
  v_day text := to_char(public.sup_local(), 'YYYY-MM-DD');
  v_fu  int;
  v_new int;
  v_gd  int;
  v_top text;
begin
  for r in
    select p.id, p.full_name
    from public.profiles p
    where p.is_active and p.deleted_at is null
      and exists (select 1 from public.leads l join public.pipeline_stages s on s.id = l.stage_id and s.kind = 'open'
                  where l.assigned_to = p.id and l.deleted_at is null)
  loop
    select count(*) filter (where t.kind = 'followup'),
           count(*) filter (where t.kind = 'new'),
           count(*) filter (where t.kind = 'golden'),
           string_agg(t.name, ', ' order by t.priority desc) filter (where t.rn <= 3)
      into v_fu, v_new, v_gd, v_top
      from (select x.*, row_number() over (order by x.priority desc) as rn
              from public.supervisor_tasks(r.id, 50) x) t;
    if coalesce(v_fu, 0) + coalesce(v_new, 0) + coalesce(v_gd, 0) = 0 then continue; end if;
    perform public.notify(
      r.id, 'supervisor', '🌅 আজকের কাজ',
      concat_ws(' · ',
        case when v_fu > 0 then v_fu || 'টা follow-up' end,
        case when v_new > 0 then v_new || 'টা নতুন lead' end,
        case when v_gd > 0 then v_gd || 'টা সম্ভাবনাময় lead চুপচাপ' end)
        || coalesce(E'\nশুরু করুন: ' || v_top, ''),
      jsonb_build_object('route', '/supervisor'),
      'sup-brief:' || v_day,
      true);
    v_n := v_n + 1;
  end loop;
  return v_n;
end;
$$;
revoke all on function public.supervisor_send_briefs() from public, anon, authenticated;

-- ---------------------------------------------------------------------
-- 🌙 The day's summary (to Team Leads for their team, to admins for all)
-- ---------------------------------------------------------------------
create or replace function public.supervisor_send_day_end()
returns int
language plpgsql
security definer
set search_path = public
set jit = off
as $$
declare
  c     jsonb := public.supervisor_setting();
  r     record;
  v_n   int := 0;
  v_day text := to_char(public.sup_local(), 'YYYY-MM-DD');
  v_d0  timestamptz := public.sup_today_start();
begin
  for r in
    -- who gets it, and whose numbers
    with readers0 as (
      select a.uid as reader, true as admin from (select public.admin_ids() as uid) a
      where coalesce((c ->> 'day_end_admins')::boolean, true)
      union all
      select distinct p.team_lead_id, false from public.profiles p
      where p.team_lead_id is not null and p.is_active and coalesce((c ->> 'day_end_team_lead')::boolean, true)
    ),
    -- an admin who also leads a team: once, with everyone
    readers as (select reader, bool_or(admin) as admin from readers0 group by reader),
    per as (
      select p.id, p.full_name, p.team_lead_id,
             (select count(*) from public.call_logs cl
               where cl.user_id = p.id and cl.called_at >= v_d0 and cl.deleted_at is null)::int as calls,
             (select count(*) from public.leads l
               where l.admitted_by = p.id and l.admitted_at >= v_d0 and l.deleted_at is null)::int as admitted,
             (select count(*) from public.follow_ups f
               join public.leads l on l.id = f.lead_id and l.deleted_at is null and l.assigned_to = p.id
               where f.status = 'pending' and f.due_at < now() and f.due_at >= v_d0 - interval '1 day')::int as missed
      from public.profiles p
      where p.is_active and p.deleted_at is null and public.role_base(p.role_key) in ('caller', 'team_lead')
    )
    select rd.reader,
           sum(pr.calls)::int as calls, sum(pr.admitted)::int as admitted, sum(pr.missed)::int as missed,
           string_agg(pr.full_name || ' ' || pr.missed, ', ' order by pr.missed desc)
             filter (where pr.missed > 0) as who_missed,
           string_agg(pr.full_name, ', ') filter (where pr.calls = 0) as no_calls
    from readers rd
    join per pr on rd.admin or pr.team_lead_id = rd.reader
    where rd.reader is not null
    group by rd.reader
  loop
    perform public.notify(
      r.reader, 'supervisor', '🌙 আজকের সারাংশ',
      r.calls || ' কল · ' || r.admitted || ' ভর্তি'
        || case when r.missed > 0 then ' · ' || r.missed || 'টা follow-up মিস (' || left(r.who_missed, 120) || ')' else '' end
        || case when r.no_calls is not null then E'\nআজ কল নেই: ' || left(r.no_calls, 120) else '' end,
      jsonb_build_object('route', '/supervisor?tab=team'),
      'sup-dayend:' || v_day,
      true);
    v_n := v_n + 1;
  end loop;
  return v_n;
end;
$$;
revoke all on function public.supervisor_send_day_end() from public, anon, authenticated;

-- ---------------------------------------------------------------------
-- ⏱ Every 15 minutes: the rules (team-wide ones once an hour), the
--   brief once after 9 AM, the summary once after 9 PM
-- ---------------------------------------------------------------------
create or replace function public.supervisor_tick()
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  c       jsonb := public.supervisor_setting();
  v_local timestamp := public.sup_local();
  v_day   text := to_char(public.sup_local(), 'YYYY-MM-DD');
  v_hour  int := extract(hour from public.sup_local())::int;
  v_work  boolean;
  v_heavy boolean;
  v_res   jsonb;
  v_last  text;
begin
  if not coalesce((c ->> 'enabled')::boolean, true) then return jsonb_build_object('enabled', false); end if;
  -- one at a time
  if not pg_try_advisory_xact_lock(hashtext('supervisor_tick')) then return jsonb_build_object('busy', true); end if;

  v_work := not (extract(dow from v_local)::int in
                 (select (jsonb_array_elements_text(coalesce(c -> 'off_days', '[]'::jsonb)))::int));
  select value into v_last from public.supervisor_state where key = 'heavy_at';
  v_heavy := v_last is null or v_last::timestamptz < now() - interval '55 minutes';

  v_res := public.supervisor_run(v_heavy);
  if v_heavy then
    insert into public.supervisor_state (key, value) values ('heavy_at', now()::text)
    on conflict (key) do update set value = excluded.value, updated_at = now();
  end if;

  -- 🌅 the brief, once, in working hours
  if v_work and coalesce((c ->> 'brief')::boolean, true)
     and v_hour >= coalesce((c ->> 'start_hour')::int, 9) and v_hour < coalesce((c ->> 'end_hour')::int, 21)
     and coalesce((select value from public.supervisor_state where key = 'brief_day'), '') <> v_day then
    insert into public.supervisor_state (key, value) values ('brief_day', v_day)
    on conflict (key) do update set value = excluded.value, updated_at = now();
    v_res := v_res || jsonb_build_object('briefs', public.supervisor_send_briefs());
  end if;

  -- 🌙 the summary, once, from the end of the day
  if v_work and coalesce((c ->> 'day_end')::boolean, true)
     and v_hour >= coalesce((c ->> 'end_hour')::int, 21)
     and coalesce((select value from public.supervisor_state where key = 'day_end_day'), '') <> v_day then
    insert into public.supervisor_state (key, value) values ('day_end_day', v_day)
    on conflict (key) do update set value = excluded.value, updated_at = now();
    v_res := v_res || jsonb_build_object('summaries', public.supervisor_send_day_end());
  end if;
  return v_res;
end;
$$;
revoke all on function public.supervisor_tick() from public, anon, authenticated;

-- an admin can run the rules now (Settings → Supervisor → "Check now")
create or replace function public.supervisor_check_now()
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
begin
  if not public.has_permission('settings.manage') then raise exception 'Only an admin can do this.'; end if;
  return public.supervisor_run(true);
end;
$$;
grant execute on function public.supervisor_check_now() to authenticated;

do $$
begin
  if exists (select 1 from pg_extension where extname = 'pg_cron') then
    perform cron.unschedule(jobid) from cron.job where jobname = 'supervisor-tick';
    perform cron.schedule('supervisor-tick', '*/15 * * * *', 'select public.supervisor_tick()');
  end if;
exception when others then
  raise notice 'Could not schedule supervisor_tick(): %', sqlerrm;
end $$;

notify pgrst, 'reload schema';
