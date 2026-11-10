-- =====================================================================
-- 💬 AI Supervisor chat (super admins only)
--   A conversation with the AI supervisor: it picks the data it needs
--   from a fixed list of safe reads (run as the super admin), answers in
--   Bangla with the numbers it used, links the leads / people it names,
--   and may suggest actions (a follow-up, a hand over, a message) that
--   only happen when the super admin taps "হ্যাঁ".
--   Chats are kept 90 days. Phone numbers never go to the AI.
-- =====================================================================

-- 1. Settings: the chat on/off and its messages a day (Settings → Supervisor)
create or replace function public.supervisor_setting()
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  raw   jsonb := (select value from public.app_settings where key = 'supervisor');
  sv    jsonb;
  srul  jsonb;
  d     jsonb := jsonb_build_object(
          'new_lead', '{"on":true,"minutes":60}'::jsonb, 'followup_late', '{"on":true,"hours":2}'::jsonb,
          'hot_idle', '{"on":true,"days":3}'::jsonb, 'stuck', '{"on":true,"days":14}'::jsonb,
          'no_note', '{"on":true,"min":3}'::jsonb, 'short_calls', '{"on":true,"sec":10,"min":5}'::jsonb,
          'not_now_high', '{"on":true,"min":5}'::jsonb, 'no_calls', '{"on":true,"hour":12}'::jsonb,
          'workload', '{"on":true,"ratio":1.8,"min":30}'::jsonb, 'unassigned', '{"on":true,"hours":2}'::jsonb,
          'discount_wait', '{"on":true,"days":2}'::jsonb, 'fee_due', '{"on":true,"days":30}'::jsonb,
          'bank_return', '{"on":true,"days":60}'::jsonb, 'bank_pull', '{"on":true,"min_open":15}'::jsonb,
          -- from the notes the AI read (steps 3–5)
          'promise', '{"on":true,"days":14}'::jsonb, 'interest_down', '{"on":true,"min":2}'::jsonb,
          'thin_notes', '{"on":true,"min":5}'::jsonb);
  r     record;
  k     record;
  one   jsonb;
  mine  jsonb;
  rules jsonb := '{}'::jsonb;
  v_start int;
  v_end   int;
  sai     jsonb;
begin
  sv := case when jsonb_typeof(raw) = 'object' then raw else '{}'::jsonb end;
  sai := case when jsonb_typeof(sv -> 'ai') = 'object' then sv -> 'ai' else '{}'::jsonb end;
  srul := case when jsonb_typeof(sv -> 'rules') = 'object' then sv -> 'rules' else '{}'::jsonb end;
  for r in select key, value from jsonb_each(d) loop
    one := r.value;
    mine := case when jsonb_typeof(srul -> r.key) = 'object' then srul -> r.key else '{}'::jsonb end;
    for k in select key from jsonb_each(r.value) loop
      if k.key = 'on' then
        if jsonb_typeof(mine -> 'on') = 'boolean' then one := one || jsonb_build_object('on', mine -> 'on'); end if;
      elsif jsonb_typeof(mine -> k.key) = 'number' and (mine ->> k.key)::numeric between 0 and 100000 then
        one := one || jsonb_build_object(k.key, (mine ->> k.key)::numeric);
      elsif jsonb_typeof(mine -> k.key) = 'string' and trim(mine ->> k.key) ~ '^[0-9]{1,5}(\.[0-9]+)?$' then
        one := one || jsonb_build_object(k.key, trim(mine ->> k.key)::numeric);
      end if;
    end loop;
    rules := rules || jsonb_build_object(r.key, one);
  end loop;

  v_start := public.sup_i(sv, 'start_hour', 9, 0, 22);
  v_end := public.sup_i(sv, 'end_hour', 21, 1, 23);
  if v_end <= v_start then v_end := least(23, v_start + 1); end if;

  return jsonb_build_object(
    'enabled', public.sup_b(sv, 'enabled', true),
    'start_hour', v_start,
    'end_hour', v_end,
    -- 0 = Sunday … 6 = Saturday (none: every day)
    'off_days', coalesce((
       select jsonb_agg(distinct x::int)
       from jsonb_array_elements_text(case when jsonb_typeof(sv -> 'off_days') = 'array' then sv -> 'off_days'
                                           else '[]'::jsonb end) x
       where x ~ '^[0-6]$'), '[]'::jsonb),
    'brief', public.sup_b(sv, 'brief', true),
    'day_end', public.sup_b(sv, 'day_end', true),
    'day_end_team_lead', public.sup_b(sv, 'day_end_team_lead', true),
    'day_end_admins', public.sup_b(sv, 'day_end_admins', true),
    -- a high-score lead: from this score
    'golden_score', public.sup_i(sv, 'golden_score', 60, 1, 100),
    'rules', rules,
    -- 🤖 the AI part (the AIs and budget of Settings → AI)
    'ai', jsonb_build_object(
      'enabled', public.sup_b(sai, 'enabled', true),
      'notes_daily', public.sup_i(sai, 'notes_daily', 200, 0, 2000),
      'reports', public.sup_b(sai, 'reports', true),
      'weekly_day', public.sup_i(sai, 'weekly_day', 6, 0, 6),
      'coach', public.sup_b(sai, 'coach', true),
      'ask', public.sup_b(sai, 'ask', true),
      -- 💬 the chat with the AI supervisor (super admins only) and its messages a day
      'chat', public.sup_b(sai, 'chat', true),
      'chat_daily', public.sup_i(sai, 'chat_daily', 50, 1, 500)));
end;
$$;
revoke all on function public.supervisor_setting() from public, anon;
grant execute on function public.supervisor_setting() to authenticated;

-- 2. The chats and their messages (read and written only through the functions below)
create table if not exists public.supervisor_chats (
  id         uuid primary key default gen_random_uuid(),
  user_id    uuid not null references public.profiles (id) on delete cascade,
  title      text not null default 'নতুন চ্যাট',
  pinned     boolean not null default false,
  -- what the AI keeps in mind from the earlier part of a long chat
  memory     text not null default '',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists supervisor_chats_user_idx on public.supervisor_chats (user_id, updated_at desc);
alter table public.supervisor_chats enable row level security;
revoke all on public.supervisor_chats from anon, authenticated;

create table if not exists public.supervisor_chat_messages (
  id         uuid primary key default gen_random_uuid(),
  chat_id    uuid not null references public.supervisor_chats (id) on delete cascade,
  role       text not null check (role in ('user', 'assistant')),
  body       text not null,
  -- assistant: { sources: [..], links: [..], actions: [..] }
  data       jsonb not null default '{}'::jsonb,
  provider   text,
  created_at timestamptz not null default now()
);
create index if not exists supervisor_chat_messages_chat_idx on public.supervisor_chat_messages (chat_id, created_at);
alter table public.supervisor_chat_messages enable row level security;
revoke all on public.supervisor_chat_messages from anon, authenticated;

-- 📵 phone numbers and e-mails out of a text: a Bangladesh mobile however it is written
--   (Bangla or English digits, +88, spaces / dots / dashes / slashes / brackets between),
--   a land line, a foreign number, any 10+ digit run
create or replace function public.sup_mask(p text)
returns text
language sql
immutable
as $$
  select regexp_replace(regexp_replace(regexp_replace(regexp_replace(regexp_replace(coalesce(p, ''),
           '[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}', '[ইমেইল]', 'g'),
           '(?<![0-9০-৯])(\+?(88|৮৮)[\s ()/,_*.‐-―-]{0,5})?[0০][\s ()/,_*.‐-―-]{0,5}[1১][\s ()/,_*.‐-―-]{0,5}[3-9৩-৯]([\s ()/,_*.‐-―-]{0,5}[0-9০-৯]){8}(?![0-9০-৯])',
           '[নম্বর]', 'g'),
           '\+[1-9]([\s ()/,_*.‐-―-]{0,2}[0-9]){7,14}(?![0-9])', '[নম্বর]', 'g'),
           '(?<![0-9০-৯])[0০][2-9২-৯][0-9০-৯]{0,2}[ -]?[0-9০-৯]{6,8}(?![0-9০-৯])', '[নম্বর]', 'g'),
         '[0-9০-৯]{10,}', '[নম্বর]', 'g');
$$;

-- the AI's note reading uses the same mask
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
             'text', public.sup_mask(x.text),
             'call_result', x.call_result) order by x.written_at desc)
    from (select * from live where user_id is not distinct from (select user_id from who)
          order by written_at desc limit v_n) x), '[]'::jsonb);
end;
$$;
revoke all on function public.sup_notes_todo(int) from public, anon, authenticated;

-- may I use the chat? (a super admin, the supervisor's AI and the chat on)
create or replace function public.sup_chat_check()
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  c jsonb := public.supervisor_setting();
begin
  if not public.is_super_admin() then raise exception 'শুধু সুপার অ্যাডমিন এই চ্যাট ব্যবহার করতে পারেন।'; end if;
  if not coalesce((c ->> 'enabled')::boolean, true) or not coalesce((c -> 'ai' ->> 'enabled')::boolean, true)
     or not coalesce((c -> 'ai' ->> 'chat')::boolean, true) then
    raise exception 'সুপারভাইজার চ্যাট বন্ধ আছে (Settings → Supervisor)।';
  end if;
  return c;
end;
$$;
revoke all on function public.sup_chat_check() from public, anon, authenticated;

-- 3. A new message: checked, counted (the day's cap), saved; and what the AI needs to start
create or replace function public.supervisor_chat_start(p_chat uuid, p_text text)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  c       jsonb := public.sup_chat_check();
  v_me    uuid := auth.uid();
  v_text  text := left(trim(coalesce(p_text, '')), 1500);
  v_day   date := (now() at time zone 'Asia/Dhaka')::date;
  v_cap   int := coalesce((c -> 'ai' ->> 'chat_daily')::int, 50);
  v_n     int;
  v_chat  public.supervisor_chats;
  v_last  public.supervisor_chat_messages;
  v_msg   uuid;
begin
  if length(v_text) < 2 then raise exception 'কিছু লিখুন।'; end if;
  if p_chat is not null then
    select * into v_chat from public.supervisor_chats where id = p_chat and user_id = v_me for update;
    if not found then raise exception 'চ্যাটটা পাওয়া যায়নি।'; end if;
  end if;

  -- every answer asked for counts (a retry too): the AI is paid for each
  insert into public.supervisor_ai_uses (user_id, day, kind, n) values (v_me, v_day, 'chat', 1)
  on conflict (user_id, day, kind) do update set n = supervisor_ai_uses.n + 1
  returning n into v_n;
  if v_n > v_cap then
    raise exception 'আজকের % টা message শেষ। কাল আবার লিখুন (Settings → Supervisor-এ সংখ্যা বদলানো যায়)।', v_cap;
  end if;

  -- chats are kept 90 days
  delete from public.supervisor_chats
   where updated_at < now() - interval '90 days' and id is distinct from p_chat;

  if v_chat.id is null then
    insert into public.supervisor_chats (user_id, title)
    values (v_me, left(regexp_replace(v_text, '\s+', ' ', 'g'), 60))
    returning * into v_chat;
  end if;

  -- the same question again right after it failed: not a second copy
  select * into v_last from public.supervisor_chat_messages
   where chat_id = v_chat.id order by created_at desc limit 1;
  if v_last.id is not null and v_last.role = 'user' and v_last.body = v_text then
    v_msg := v_last.id;
  else
    insert into public.supervisor_chat_messages (chat_id, role, body) values (v_chat.id, 'user', v_text)
    returning id into v_msg;
  end if;
  update public.supervisor_chats set updated_at = now() where id = v_chat.id;

  return jsonb_build_object(
    'chat_id', v_chat.id,
    'message_id', v_msg,
    'used', v_n,
    'daily', v_cap,
    'memory', v_chat.memory,
    -- the last 12 messages before this one
    'history', coalesce((
      select jsonb_agg(jsonb_build_object('role', m.role, 'text', public.sup_mask(left(m.body, 1500)),
                                          'at', m.created_at) order by m.created_at)
      from (select * from public.supervisor_chat_messages
            where chat_id = v_chat.id and id <> v_msg
            order by created_at desc limit 12) m), '[]'::jsonb),
    -- who is who (first names for the AI; ids to look someone up and to link them)
    'people', coalesce((
      select jsonb_agg(jsonb_build_object('id', p.id, 'name', p.full_name, 'role', p.role_key,
                                          'team_lead', tl.full_name) order by p.full_name)
      from public.profiles p
      left join public.profiles tl on tl.id = p.team_lead_id
      where p.is_active and p.deleted_at is null), '[]'::jsonb),
    'courses', coalesce((
      select jsonb_agg(jsonb_build_object('id', co.id, 'name', co.name) order by co.sort_order, co.name)
      from public.courses co where co.is_active), '[]'::jsonb),
    'stages', coalesce((
      select jsonb_agg(jsonb_build_object('id', s.id, 'name', s.name, 'kind', s.kind) order by s.sort_order)
      from public.pipeline_stages s where s.is_active), '[]'::jsonb));
end;
$$;
revoke all on function public.supervisor_chat_start(uuid, text) from public, anon;
grant execute on function public.supervisor_chat_start(uuid, text) to authenticated;

-- 4. The AI's reads (as the super admin)
-- the numbers of the team (p_subject null) or of one person, for 1–90 days, against the days before
create or replace function public.supervisor_chat_numbers(p_subject uuid, p_days int)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
begin
  perform public.sup_chat_check();
  return public.sup_report_input(null, p_subject, greatest(1, least(coalesce(p_days, 7), 90)), null);
end;
$$;
revoke all on function public.supervisor_chat_numbers(uuid, int) from public, anon;
grant execute on function public.supervisor_chat_numbers(uuid, int) to authenticated;

-- a lead by its name, student ID or id: up to 5 matches; the first one in detail (no phone numbers)
create or replace function public.supervisor_chat_lead(p_query text)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
set jit = off
as $$
declare
  q     text := left(trim(coalesce(p_query, '')), 80);
  v_ids uuid[];
  v_one uuid;
begin
  perform public.sup_chat_check();
  if length(q) < 2 then return jsonb_build_object('found', 0, 'leads', '[]'::jsonb); end if;
  select array_agg(id) into v_ids from (
    select l.id from public.leads l
    where l.deleted_at is null
      and (l.id::text = q or l.student_ref = q or l.nu_admission_id = q
           or l.name ilike '%' || replace(replace(q, '%', ''), '_', '') || '%')
    order by (l.id::text = q or l.student_ref = q) desc, (lower(l.name) = lower(q)) desc,
             l.updated_at desc
    limit 5) x;
  if v_ids is null then return jsonb_build_object('found', 0, 'leads', '[]'::jsonb); end if;
  v_one := v_ids[1];
  return jsonb_build_object(
    'found', cardinality(v_ids),
    'leads', (
      select jsonb_agg(jsonb_build_object('id', l.id, 'name', l.name, 'stage', s.name, 'assigned_to', p.full_name)
                       order by array_position(v_ids, l.id))
      from public.leads l
      left join public.pipeline_stages s on s.id = l.stage_id
      left join public.profiles p on p.id = l.assigned_to
      where l.id = any (v_ids)),
    'detail', (
      select jsonb_build_object(
        'id', l.id, 'name', l.name, 'area', l.area, 'workplace', l.workplace,
        'stage', s.name, 'stage_kind', s.kind, 'assigned_to', p.full_name, 'assigned_id', l.assigned_to,
        'courses', (select jsonb_agg(co.name) from public.courses co where co.id = any (l.course_ids)),
        'score', l.score, 'rating', l.rating, 'call_attempts', l.call_attempts,
        'created_at', l.created_at, 'last_contacted_at', l.last_contacted_at,
        'next_follow_up_at', l.next_follow_up_at,
        'not_now_reason', lr.name, 'not_now_note', public.sup_mask(left(l.lost_note, 300)), 'not_now_at', l.lost_at,
        'admitted_at', l.admitted_at, 'student_ref', l.student_ref,
        'fee', jsonb_build_object('status', l.fee_status, 'full', l.fee_full, 'discount', l.fee_discount,
                                  'final', l.fee_final, 'paid', l.fee_paid_total, 'due', l.fee_due,
                                  'next_due', l.fee_next_due),
        'visit', jsonb_build_object('status', l.visit_status, 'at', l.visit_at),
        'ai_chance', (select jsonb_build_object('chance', ch.chance, 'level', ch.level,
                                                'summary', public.sup_mask(left(ch.summary, 500)))
                      from public.lead_chances ch where ch.lead_id = l.id and ch.chance is not null),
        'pending_follow_up', (select jsonb_build_object('due_at', f.due_at, 'note', public.sup_mask(left(f.note, 200)))
                              from public.follow_ups f where f.lead_id = l.id and f.status = 'pending'
                              order by f.due_at limit 1),
        -- the last 12 calls and notes, newest first
        'history', (select jsonb_agg(h order by h.at desc) from (
            (select 'call' as kind, cl.called_at as at, cl.outcome, cl.duration_sec, u.full_name as by,
                    public.sup_mask(left(cl.notes, 400)) as text
             from public.call_logs cl left join public.profiles u on u.id = cl.user_id
             where cl.lead_id = l.id and cl.deleted_at is null
             order by cl.called_at desc limit 12)
            union all
            (select 'note', a.created_at, null, null, u.full_name, public.sup_mask(left(a.details ->> 'note', 400))
             from public.lead_activity a left join public.profiles u on u.id = a.user_id
             where a.lead_id = l.id and a.action = 'note_added'
             order by a.created_at desc limit 12)
            order by at desc limit 12) h),
        'ai_notes', (select jsonb_agg(jsonb_build_object('at', i.written_at, 'promise', i.promise_text,
                                                         'promise_at', i.promise_at, 'objections', i.objections,
                                                         'interest', i.interest) order by i.written_at desc)
                     from (select * from public.note_insights where lead_id = l.id
                           order by written_at desc limit 6) i))
      from public.leads l
      left join public.pipeline_stages s on s.id = l.stage_id
      left join public.profiles p on p.id = l.assigned_to
      left join public.lost_reasons lr on lr.id = l.lost_reason_id
      where l.id = v_one));
end;
$$;
revoke all on function public.supervisor_chat_lead(text) from public, anon;
grant execute on function public.supervisor_chat_lead(text) to authenticated;

-- 5. The answer saved (by the AI job): its links and suggested actions checked against the database
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
    if coalesce(a ->> 'id', '') !~* '^[0-9a-f-]{36}$' then continue; end if;
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
                     where x ~* '^[0-9a-f-]{36}$' limit 50);
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
        v_id := case when coalesce(a ->> 'user_id', '') ~* '^[0-9a-f-]{36}$' then (a ->> 'user_id')::uuid end;
        select full_name into v_name from public.profiles where id = v_id and is_active and deleted_at is null;
        if coalesce(cardinality(v_ids), 0) = 0 or v_name is null then continue; end if;
        v_acts := v_acts || jsonb_build_array(jsonb_build_object(
          'type', 'hand_over', 'status', 'pending', 'lead_ids', to_jsonb(v_ids), 'lead_names', to_jsonb(v_names),
          'user_id', v_id, 'user_name', v_name, 'note', left(trim(coalesce(a ->> 'note', '')), 300)));
      elsif a ->> 'type' = 'message' then
        v_id := case when coalesce(a ->> 'user_id', '') ~* '^[0-9a-f-]{36}$' then (a ->> 'user_id')::uuid end;
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
  values (p_chat, 'assistant', left(coalesce(nullif(trim(p_body), ''), '—'), 4000),
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

-- 6. My chats; one chat; rename / pin / delete
create or replace function public.supervisor_chat_list()
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  c jsonb := public.sup_chat_check();
begin
  return jsonb_build_object(
    'daily', coalesce((c -> 'ai' ->> 'chat_daily')::int, 50),
    'used', coalesce((select n from public.supervisor_ai_uses
                      where user_id = auth.uid() and kind = 'chat'
                        and day = (now() at time zone 'Asia/Dhaka')::date), 0),
    'chats', coalesce((
      select jsonb_agg(jsonb_build_object('id', ch.id, 'title', ch.title, 'pinned', ch.pinned,
                                          'updated_at', ch.updated_at,
                                          'last', (select left(m.body, 120) from public.supervisor_chat_messages m
                                                   where m.chat_id = ch.id order by m.created_at desc limit 1))
                       order by ch.pinned desc, ch.updated_at desc)
      from (select * from public.supervisor_chats where user_id = auth.uid()
            order by pinned desc, updated_at desc limit 100) ch), '[]'::jsonb));
end;
$$;
revoke all on function public.supervisor_chat_list() from public, anon;
grant execute on function public.supervisor_chat_list() to authenticated;

create or replace function public.supervisor_chat_get(p_chat uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
begin
  perform public.sup_chat_check();
  if not exists (select 1 from public.supervisor_chats where id = p_chat and user_id = auth.uid()) then
    raise exception 'চ্যাটটা পাওয়া যায়নি।';
  end if;
  return coalesce((
    select jsonb_agg(jsonb_build_object('id', m.id, 'role', m.role, 'body', m.body, 'data', m.data,
                                        'provider', m.provider, 'created_at', m.created_at) order by m.created_at)
    from (select * from public.supervisor_chat_messages where chat_id = p_chat
          order by created_at desc limit 200) m), '[]'::jsonb);
end;
$$;
revoke all on function public.supervisor_chat_get(uuid) from public, anon;
grant execute on function public.supervisor_chat_get(uuid) to authenticated;

create or replace function public.supervisor_chat_edit(p_chat uuid, p_title text default null,
                                                       p_pinned boolean default null, p_delete boolean default false)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  perform public.sup_chat_check();
  if p_delete then
    delete from public.supervisor_chats where id = p_chat and user_id = auth.uid();
    return;
  end if;
  update public.supervisor_chats
     set title = coalesce(nullif(left(trim(p_title), 60), ''), title),
         pinned = coalesce(p_pinned, pinned)
   where id = p_chat and user_id = auth.uid();
  if not found then raise exception 'চ্যাটটা পাওয়া যায়নি।'; end if;
end;
$$;
revoke all on function public.supervisor_chat_edit(uuid, text, boolean, boolean) from public, anon;
grant execute on function public.supervisor_chat_edit(uuid, text, boolean, boolean) to authenticated;

-- 7. A suggested action: done when the super admin says yes (once), or put aside
create or replace function public.supervisor_chat_act(p_message uuid, p_index int, p_do boolean)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_msg  public.supervisor_chat_messages;
  a      jsonb;
  v_ids  uuid[];
  v_me   text;
  v_res  text;
  v_out  jsonb;
begin
  perform public.sup_chat_check();
  select m.* into v_msg from public.supervisor_chat_messages m
    join public.supervisor_chats ch on ch.id = m.chat_id and ch.user_id = auth.uid()
   where m.id = p_message and m.role = 'assistant'
   for update of m;
  if not found then raise exception 'এই message পাওয়া যায়নি।'; end if;
  a := v_msg.data -> 'actions' -> p_index;
  if a is null then raise exception 'এই কাজটা পাওয়া যায়নি।'; end if;
  if a ->> 'status' <> 'pending' then return a; end if;

  if not p_do then
    a := a || jsonb_build_object('status', 'dismissed', 'at', now());
  else
    v_ids := array(select x::uuid from jsonb_array_elements_text(coalesce(a -> 'lead_ids', '[]'::jsonb)) x);
    if a ->> 'type' = 'follow_up' then
      if (a ->> 'due_at')::timestamptz < now() - interval '1 hour' then
        raise exception 'সময়টা পেরিয়ে গেছে। AI-কে নতুন সময় দিতে বলুন।';
      end if;
      if not exists (select 1 from public.leads where id = v_ids[1] and deleted_at is null) then
        raise exception 'এই lead আর নেই (মুছে ফেলা হয়েছে)।';
      end if;
      perform public.schedule_follow_up(v_ids[1], (a ->> 'due_at')::timestamptz, nullif(a ->> 'note', ''));
      v_res := 'Follow-up রাখা হয়েছে';
    elsif a ->> 'type' = 'hand_over' then
      v_out := public.hand_over_leads(v_ids, (a ->> 'user_id')::uuid, nullif(a ->> 'note', ''));
      if coalesce((v_out ->> 'done')::int, 0) = 0 then
        raise exception 'কোনো lead দেওয়া যায়নি (আগেই %-এর কাছে আছে, বা মুছে ফেলা হয়েছে)।', a ->> 'user_name';
      end if;
      v_res := format('%s টা lead %s-কে দেওয়া হয়েছে', v_out ->> 'done', a ->> 'user_name')
               || case when coalesce((v_out ->> 'skipped')::int, 0) > 0
                       then format(' (%s টা আগেই ছিল বা নেই)', v_out ->> 'skipped') else '' end;
    elsif a ->> 'type' = 'message' then
      select full_name into v_me from public.profiles where id = auth.uid();
      if public.notify((a ->> 'user_id')::uuid, 'supervisor', '💬 ' || coalesce(v_me, 'সুপার অ্যাডমিন'),
                       a ->> 'text', '{}'::jsonb, null, true) is null then
        v_res := 'পাঠানো যায়নি (নোটিফিকেশন বন্ধ বা অ্যাকাউন্ট বন্ধ)';
      else
        v_res := 'পাঠানো হয়েছে';
      end if;
    else
      raise exception 'Unknown action.';
    end if;
    a := a || jsonb_build_object('status', 'done', 'at', now(), 'result', v_res);
  end if;

  update public.supervisor_chat_messages
     set data = jsonb_set(data, array['actions', p_index::text], a)
   where id = p_message;
  return a;
end;
$$;
revoke all on function public.supervisor_chat_act(uuid, int, boolean) from public, anon;
grant execute on function public.supervisor_chat_act(uuid, int, boolean) to authenticated;
