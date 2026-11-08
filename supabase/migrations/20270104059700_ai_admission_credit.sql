-- =====================================================================
-- 🤖 Admission credit by AI (Claude): who did how much for each admission
--   When a lead is marked Admitted, the AI reads its whole story - who
--   called, how many times, how many minutes, what each note says, when;
--   visits, fee talks, papers, payments, hand-overs - and shares the
--   admission out (percent per person, with a reason). Credits use these
--   shares for "Admitted" instead of giving it all to whoever pressed
--   Admitted (until the AI has worked a lead out, or with AI off: as before).
--   · The Claude API key is set in Settings → AI (any time; only the server
--     can read it - the app sees the last 4 characters)
--   · Works in the background (a queue + the ai-admission-credit Edge
--     Function); nothing waits for the AI
--   · Who sees it: admins, and the roles / people Settings → AI allows
--   (Dated before 20270104060000_lead_merge so both can go in any order.)
-- =====================================================================

-- ---------------------------------------------------------------------
-- ⚙️ Setting
-- ---------------------------------------------------------------------
insert into public.app_settings (key, value, description)
values ('ai_credit', jsonb_build_object(
  'enabled', true,
  'model', 'claude-sonnet-5-5',
  'effort', 'medium',
  'window_days', 180,
  'view', jsonb_build_object('all', false, 'roles', '[]'::jsonb, 'people', '[]'::jsonb),
  'guidance', ''
), 'AI admission credit: on/off, model, look-back days, who sees it, extra guidance')
on conflict (key) do nothing;

create or replace function public.ai_credit_on()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select coalesce((select (value ->> 'enabled')::boolean from public.app_settings where key = 'ai_credit'), false);
$$;
revoke all on function public.ai_credit_on() from public, anon;
grant execute on function public.ai_credit_on() to authenticated;

-- May I see admission credits? (admins always; then Settings → AI)
create or replace function public.ai_credit_can_view()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select public.is_active_user() and (
    public.has_permission('settings.manage')
    or exists (
      select 1
      from public.app_settings s, public.profiles p
      where s.key = 'ai_credit' and p.id = auth.uid()
        and (coalesce((s.value -> 'view' ->> 'all')::boolean, false)
             or (s.value -> 'view' -> 'roles') ? p.role_key
             or (s.value -> 'view' -> 'people') ? p.id::text)));
$$;
revoke all on function public.ai_credit_can_view() from public, anon;
grant execute on function public.ai_credit_can_view() to authenticated;

-- ---------------------------------------------------------------------
-- 🔑 Secrets (the Claude API key, the Edge Function address, the cron
--   password): only these functions and the server read them
-- ---------------------------------------------------------------------
create table if not exists public.ai_secrets (
  name        text primary key,
  value       text not null,
  updated_by  uuid references public.profiles (id) on delete set null,
  updated_at  timestamptz not null default now(),
  last_ok_at  timestamptz,
  last_error  text
);
alter table public.ai_secrets enable row level security;   -- no policies
revoke all on public.ai_secrets from anon, authenticated;

-- a password the night jobs show the Edge Function (made once, here)
insert into public.ai_secrets (name, value)
values ('cron_secret', replace(gen_random_uuid()::text || gen_random_uuid()::text, '-', ''))
on conflict (name) do nothing;

create or replace function public.ai_key_status()
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  k record;
begin
  if not public.has_permission('settings.manage') then raise exception 'Only an admin can see this.'; end if;
  select * into k from public.ai_secrets where name = 'anthropic';
  return jsonb_build_object(
    'set', k.name is not null,
    'hint', case when k.name is not null then left(k.value, 7) || '…' || right(k.value, 4) end,
    'updated_at', k.updated_at,
    'last_ok_at', k.last_ok_at,
    'last_error', k.last_error,
    'server_ready', exists (select 1 from public.ai_secrets where name = 'functions_url'));
end;
$$;
revoke all on function public.ai_key_status() from public, anon;
grant execute on function public.ai_key_status() to authenticated;

-- Save the key (any time; replaces the old one). p_functions_url: the
-- app tells the server where its Edge Functions are (for the night jobs)
create or replace function public.set_ai_key(p_key text, p_functions_url text default null)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_key text := trim(coalesce(p_key, ''));
begin
  if not public.has_permission('settings.manage') then raise exception 'Only an admin can do this.'; end if;
  if v_key !~ '^sk-ant-[A-Za-z0-9_\-]{20,}$' then
    raise exception 'This does not look like a Claude API key (it starts with sk-ant-).';
  end if;
  insert into public.ai_secrets (name, value, updated_by, updated_at, last_ok_at, last_error)
  values ('anthropic', v_key, auth.uid(), now(), null, null)
  on conflict (name) do update
    set value = excluded.value, updated_by = excluded.updated_by, updated_at = now(),
        last_ok_at = null, last_error = null;
  perform public.set_ai_functions_url(p_functions_url);
end;
$$;
revoke all on function public.set_ai_key(text, text) from public, anon;
grant execute on function public.set_ai_key(text, text) to authenticated;

create or replace function public.set_ai_functions_url(p_url text)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_url text := rtrim(trim(coalesce(p_url, '')), '/');
begin
  if not public.has_permission('settings.manage') then raise exception 'Only an admin can do this.'; end if;
  if v_url ~ '^https://[a-z0-9.-]+(:[0-9]+)?/functions/v1$' then
    insert into public.ai_secrets (name, value, updated_by) values ('functions_url', v_url, auth.uid())
    on conflict (name) do update set value = excluded.value, updated_by = excluded.updated_by, updated_at = now();
  end if;
end;
$$;
revoke all on function public.set_ai_functions_url(text) from public, anon;
grant execute on function public.set_ai_functions_url(text) to authenticated;

create or replace function public.remove_ai_key()
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if not public.has_permission('settings.manage') then raise exception 'Only an admin can do this.'; end if;
  delete from public.ai_secrets where name = 'anthropic';
end;
$$;
revoke all on function public.remove_ai_key() from public, anon;
grant execute on function public.remove_ai_key() to authenticated;

-- ---------------------------------------------------------------------
-- 🤝 The shares, one row per admitted lead
--   shares: [{user_id, share (0-100), reason}]
--   status: pending → working → done (or failed after 3 tries)
-- ---------------------------------------------------------------------
create table if not exists public.admission_credits (
  lead_id      uuid primary key references public.leads (id) on delete cascade,
  status       text not null default 'pending' check (status in ('pending', 'working', 'done', 'failed')),
  shares       jsonb not null default '[]'::jsonb,
  decisive     text,
  confidence   text check (confidence is null or confidence in ('high', 'medium', 'low')),
  stats        jsonb not null default '[]'::jsonb,
  model        text,
  usage        jsonb,
  error        text,
  attempts     int not null default 0,
  manual       boolean not null default false,
  edited_by    uuid references public.profiles (id) on delete set null,
  edit_reason  text,
  requested_at timestamptz not null default now(),
  started_at   timestamptz,
  done_at      timestamptz
);
create index if not exists admission_credits_queue_idx on public.admission_credits (requested_at) where status in ('pending', 'working');
alter table public.admission_credits enable row level security;
drop policy if exists "admission credits: read" on public.admission_credits;
create policy "admission credits: read" on public.admission_credits
  for select to authenticated using ((select public.ai_credit_can_view()));
revoke insert, update, delete on public.admission_credits from anon, authenticated;

-- Marked Admitted (again): into the queue - one small insert, nothing waits
create or replace function public.admission_credit_queue()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if new.admitted_at is not null
     and new.admitted_at is distinct from old.admitted_at
     and exists (select 1 from public.pipeline_stages s where s.id = new.stage_id and s.kind = 'won') then
    insert into public.admission_credits (lead_id, status, requested_at, attempts, error)
    values (new.id, 'pending', now(), 0, null)
    on conflict (lead_id) do update
      set status = 'pending', requested_at = now(), attempts = 0, error = null, manual = false
      where admission_credits.status <> 'working';
  end if;
  return null;
end;
$$;
drop trigger if exists leads_admission_credit on public.leads;
create trigger leads_admission_credit after update of admitted_at, stage_id on public.leads
  for each row when (new.admitted_at is not null and new.admitted_at is distinct from old.admitted_at)
  execute function public.admission_credit_queue();

-- ---------------------------------------------------------------------
-- 📜 One lead's story for the AI (the server only)
--   people are codes (P1, P2…): no names, no phone numbers leave here;
--   numbers inside notes are blanked. Newest 250 events in the window.
-- ---------------------------------------------------------------------
create or replace function public.admission_credit_input(p_lead uuid)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  l        record;
  v_days   int := coalesce((select (value ->> 'window_days')::int from public.app_settings where key = 'ai_credit'), 180);
  v_from   timestamptz;
  v_to     timestamptz;
  v_events jsonb;
  v_people jsonb;
  v_stats  jsonb;
begin
  select ld.*, src.name as source_name, c.name as course_name
  into l
  from public.leads ld
  left join public.lead_sources src on src.id = ld.source_id
  left join public.courses c on c.id = ld.admitted_course_id
  where ld.id = p_lead;
  if l.id is null or l.admitted_at is null then return null; end if;
  v_from := l.admitted_at - make_interval(days => greatest(v_days, 7));
  v_to := l.admitted_at + interval '1 day';

  create temporary table if not exists _ac_ev (t timestamptz, who uuid, kind text, data jsonb) on commit drop;
  truncate _ac_ev;

  -- ➕ who brought the lead
  insert into _ac_ev select l.created_at, l.created_by, 'lead_added',
    jsonb_strip_nulls(jsonb_build_object('source', l.source_name, 'imported', l.import_batch_id is not null))
  where l.created_by is not null;

  -- 📞 calls and 💬 WhatsApp
  insert into _ac_ev
  select c.called_at, c.user_id,
         case when c.channel = 'sms' then 'sms'
              when c.channel = 'whatsapp' and (c.media = 'message' or c.outcome = 'message') then 'whatsapp_message'
              when c.channel = 'whatsapp' then 'whatsapp_call' else 'call' end,
         jsonb_strip_nulls(jsonb_build_object(
           'direction', c.direction, 'outcome', c.outcome,
           'minutes', case when c.duration_sec > 0 then round(c.duration_sec / 60.0, 1) end,
           'note', left(regexp_replace(nullif(trim(c.notes), ''), '\+?(88)?0?1[3-9]([ \-]?[0-9]){8}', '[number]', 'g'), 400)))
  from public.call_logs c
  where c.lead_id = p_lead and c.deleted_at is null and c.user_id is not null
    and c.called_at between v_from and v_to;

  -- 📝 notes, visits, papers, hand-overs, stage moves (the activity log)
  insert into _ac_ev
  select a.created_at, a.user_id, a.action,
         jsonb_strip_nulls(case a.action
           when 'note_added' then jsonb_build_object('text',
             left(regexp_replace(a.details ->> 'note', '\+?(88)?0?1[3-9]([ \-]?[0-9]){8}', '[number]', 'g'), 600))
           when 'assigned' then jsonb_build_object('to_user', a.details ->> 'to', 'note', left(a.details ->> 'note', 200))
           when 'stage_changed' then jsonb_build_object('to_stage', (select s.name from public.pipeline_stages s where s.id::text = a.details ->> 'to'))
           else '{}'::jsonb end)
  from public.lead_activity a
  where a.lead_id = p_lead and a.user_id is not null
    and a.action in ('note_added', 'visit_planned', 'visit_done', 'paper_received', 'assigned', 'stage_changed',
                     'follow_up_set', 'template_sent', 'fee_offer', 'fee_discount')
    and a.created_at between v_from and v_to;

  -- 💰 fee talks and payments
  insert into _ac_ev
  select e.created_at, e.created_by, 'fee_' || e.kind,
         jsonb_strip_nulls(jsonb_build_object('amount', e.amount, 'note', left(e.note, 300)))
  from public.negotiation_events e
  where e.lead_id = p_lead and e.created_by is not null and e.created_at between v_from and v_to;
  insert into _ac_ev
  select p.paid_at, p.received_by, case when p.kind = 'refund' then 'refund' else 'payment' end,
         jsonb_build_object('amount', p.amount)
  from public.fee_payments p
  where p.lead_id = p_lead and p.voided_at is null and p.received_by is not null and p.paid_at between v_from and v_to;

  -- 🎓 the click itself
  insert into _ac_ev select l.admitted_at, l.admitted_by, 'marked_admitted', '{}'::jsonb where l.admitted_by is not null;

  -- people → codes, by first appearance (hand-over targets too)
  with ids as (
    select who as id, min(t) as first_t from _ac_ev group by who
    union all
    select (data ->> 'to_user')::uuid, min(t) from _ac_ev
    where kind = 'assigned' and data ->> 'to_user' ~ '^[0-9a-f-]{36}$' group by 1
  ), firsts as (
    select id, min(first_t) as first_t from ids where id is not null group by id
  )
  select jsonb_agg(jsonb_build_object('code', 'P' || rn, 'user_id', id) order by rn)
  into v_people
  from (select id, row_number() over (order by first_t, id) as rn from firsts) x;

  -- per person: the numbers
  select jsonb_agg(jsonb_build_object(
           'person', pp ->> 'code',
           'calls', (select count(*) from _ac_ev e where e.who::text = pp ->> 'user_id' and e.kind = 'call'),
           'answered_calls', (select count(*) from _ac_ev e where e.who::text = pp ->> 'user_id' and e.kind = 'call' and e.data ->> 'outcome' = 'connected'),
           'talk_minutes', (select coalesce(round(sum((e.data ->> 'minutes')::numeric), 1), 0) from _ac_ev e where e.who::text = pp ->> 'user_id' and e.kind in ('call', 'whatsapp_call')),
           'whatsapp', (select count(*) from _ac_ev e where e.who::text = pp ->> 'user_id' and e.kind in ('whatsapp_call', 'whatsapp_message')),
           'notes', (select count(*) from _ac_ev e where e.who::text = pp ->> 'user_id' and (e.kind = 'note_added' or e.data ? 'note')),
           'visits', (select count(*) from _ac_ev e where e.who::text = pp ->> 'user_id' and e.kind in ('visit_planned', 'visit_done')),
           'fee_actions', (select count(*) from _ac_ev e where e.who::text = pp ->> 'user_id' and e.kind like 'fee\_%'),
           'payments', (select count(*) from _ac_ev e where e.who::text = pp ->> 'user_id' and e.kind = 'payment'),
           'papers', (select count(*) from _ac_ev e where e.who::text = pp ->> 'user_id' and e.kind = 'paper_received'),
           'first', (select to_char(min(e.t) at time zone 'Asia/Dhaka', 'YYYY-MM-DD') from _ac_ev e where e.who::text = pp ->> 'user_id'),
           'last', (select to_char(max(e.t) at time zone 'Asia/Dhaka', 'YYYY-MM-DD') from _ac_ev e where e.who::text = pp ->> 'user_id')))
  into v_stats
  from jsonb_array_elements(coalesce(v_people, '[]'::jsonb)) pp;

  -- the events, oldest first (the newest 250), people as codes
  select jsonb_agg(ev order by ev ->> 'at')
  into v_events
  from (
    select jsonb_build_object(
             'at', to_char(e.t at time zone 'Asia/Dhaka', 'YYYY-MM-DD HH24:MI'),
             'by', (select pp ->> 'code' from jsonb_array_elements(v_people) pp where pp ->> 'user_id' = e.who::text),
             'what', e.kind)
           || (case when e.kind = 'assigned' then
                 (e.data - 'to_user') || jsonb_strip_nulls(jsonb_build_object('to',
                   (select pp ->> 'code' from jsonb_array_elements(v_people) pp where pp ->> 'user_id' = e.data ->> 'to_user')))
               else e.data end) as ev
    from _ac_ev e
    order by e.t desc
    limit 250
  ) z;

  return jsonb_build_object(
    'lead', jsonb_strip_nulls(jsonb_build_object(
      'added', to_char(l.created_at at time zone 'Asia/Dhaka', 'YYYY-MM-DD'),
      'admitted', to_char(l.admitted_at at time zone 'Asia/Dhaka', 'YYYY-MM-DD HH24:MI'),
      'days_to_admit', round(extract(epoch from (l.admitted_at - l.created_at)) / 86400),
      'source', l.source_name,
      'course', l.course_name,
      'referred_by_alumnus', l.referred_by_alumni_id is not null,
      'window_days', v_days)),
    'people', coalesce(v_people, '[]'::jsonb),
    'stats', coalesce(v_stats, '[]'::jsonb),
    'events', coalesce(v_events, '[]'::jsonb));
end;
$$;
revoke all on function public.admission_credit_input(uuid) from public, anon, authenticated;
grant execute on function public.admission_credit_input(uuid) to service_role;

-- ---------------------------------------------------------------------
-- ⚙️ The queue (the server only)
-- ---------------------------------------------------------------------
-- Take up to p_limit leads to work on (a stuck "working" one comes back
-- after 10 minutes; failed ones are not taken again by themselves)
create or replace function public.ai_credit_claim(p_limit int default 3)
returns setof uuid
language sql
security definer
set search_path = public
as $$
  update public.admission_credits ac
     set status = 'working', started_at = now(), attempts = ac.attempts + 1
   where ac.lead_id in (
     select lead_id from public.admission_credits
     where status = 'pending' or (status = 'working' and started_at < now() - interval '10 minutes')
     order by requested_at
     limit greatest(1, least(p_limit, 10))
     for update skip locked)
  returning ac.lead_id;
$$;
revoke all on function public.ai_credit_claim(int) from public, anon, authenticated;
grant execute on function public.ai_credit_claim(int) to service_role;

-- The AI's answer: user ids already put back in place of the codes
create or replace function public.ai_credit_save(p_lead uuid, p_shares jsonb, p_decisive text, p_confidence text,
                                                 p_stats jsonb, p_model text, p_usage jsonb)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_total  numeric;
  v_shares jsonb;
begin
  -- only real people, positive shares, and they add up to 100
  select coalesce(sum((s ->> 'share')::numeric), 0) into v_total
  from jsonb_array_elements(coalesce(p_shares, '[]'::jsonb)) s
  where (s ->> 'share')::numeric > 0 and exists (select 1 from public.profiles p where p.id::text = s ->> 'user_id');
  if v_total <= 0 then raise exception 'No shares in the answer.'; end if;
  select jsonb_agg(jsonb_build_object('user_id', s ->> 'user_id',
                                      'share', round((s ->> 'share')::numeric * 100 / v_total, 1),
                                      'reason', left(s ->> 'reason', 500))
                   order by (s ->> 'share')::numeric desc)
  into v_shares
  from jsonb_array_elements(p_shares) s
  where (s ->> 'share')::numeric > 0 and exists (select 1 from public.profiles p where p.id::text = s ->> 'user_id');

  update public.admission_credits
     set status = 'done', shares = v_shares, decisive = left(p_decisive, 600),
         confidence = case when p_confidence in ('high', 'medium', 'low') then p_confidence end,
         stats = coalesce(p_stats, '[]'::jsonb), model = p_model, usage = p_usage,
         error = null, done_at = now(), manual = false
   where lead_id = p_lead and not manual;
end;
$$;
revoke all on function public.ai_credit_save(uuid, jsonb, text, text, jsonb, text, jsonb) from public, anon, authenticated;
grant execute on function public.ai_credit_save(uuid, jsonb, text, text, jsonb, text, jsonb) to service_role;

-- It went wrong: try again later (after 3 tries: failed, an admin can retry)
create or replace function public.ai_credit_fail(p_lead uuid, p_error text, p_retry boolean default true)
returns void
language sql
security definer
set search_path = public
as $$
  update public.admission_credits
     set status = case when p_retry and attempts < 3 then 'pending' else 'failed' end,
         error = left(p_error, 500)
   where lead_id = p_lead and status = 'working';
$$;
revoke all on function public.ai_credit_fail(uuid, text, boolean) from public, anon, authenticated;
grant execute on function public.ai_credit_fail(uuid, text, boolean) to service_role;

-- Busy / key refused: back to the queue, this try does not count
create or replace function public.ai_credit_release(p_lead uuid)
returns void
language sql
security definer
set search_path = public
as $$
  update public.admission_credits
     set status = 'pending', attempts = greatest(attempts - 1, 0)
   where lead_id = p_lead and status = 'working';
$$;
revoke all on function public.ai_credit_release(uuid) from public, anon, authenticated;
grant execute on function public.ai_credit_release(uuid) to service_role;

-- The server notes whether the key works
create or replace function public.ai_key_result(p_ok boolean, p_error text default null)
returns void
language sql
security definer
set search_path = public
as $$
  update public.ai_secrets
     set last_ok_at = case when p_ok then now() else last_ok_at end,
         last_error = case when p_ok then null else left(p_error, 300) end
   where name = 'anthropic';
$$;
revoke all on function public.ai_key_result(boolean, text) from public, anon, authenticated;
grant execute on function public.ai_key_result(boolean, text) to service_role;

-- What the Edge Function needs, in one go (the server only)
create or replace function public.ai_credit_server_config()
returns jsonb
language sql
stable
security definer
set search_path = public
as $$
  select jsonb_build_object(
    'key', (select value from public.ai_secrets where name = 'anthropic'),
    'cron_secret', (select value from public.ai_secrets where name = 'cron_secret'),
    'settings', coalesce((select value from public.app_settings where key = 'ai_credit'), '{}'::jsonb));
$$;
revoke all on function public.ai_credit_server_config() from public, anon, authenticated;
grant execute on function public.ai_credit_server_config() to service_role;

-- ⏱ Every 2 minutes: if something waits and the key is set, wake the
--   Edge Function (nothing happens when the queue is empty)
create or replace function public.ai_credit_kick()
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_url    text := (select value from public.ai_secrets where name = 'functions_url');
  v_secret text := (select value from public.ai_secrets where name = 'cron_secret');
begin
  if to_regproc('net.http_post') is null or v_url is null or v_secret is null then return; end if;
  -- no key, or the key was refused (saving a new one clears that): wait
  if not public.ai_credit_on()
     or not exists (select 1 from public.ai_secrets where name = 'anthropic' and last_error is null) then
    return;
  end if;
  if not exists (select 1 from public.admission_credits
                 where status = 'pending' or (status = 'working' and started_at < now() - interval '10 minutes')) then
    return;
  end if;
  perform net.http_post(
    url := v_url || '/ai-admission-credit',
    body := '{}'::jsonb,
    headers := jsonb_build_object('Content-Type', 'application/json', 'x-cron-secret', v_secret),
    timeout_milliseconds := 5000);
end;
$$;
revoke all on function public.ai_credit_kick() from public, anon, authenticated;

do $$
begin
  if exists (select 1 from pg_namespace where nspname = 'cron') then
    begin perform cron.unschedule('ai-admission-credit'); exception when others then null; end;
    perform cron.schedule('ai-admission-credit', '*/2 * * * *', 'select public.ai_credit_kick()');
  end if;
end $$;

-- ---------------------------------------------------------------------
-- 👤 Admins (Settings → AI, the lead page)
-- ---------------------------------------------------------------------
-- Every admitted lead not worked out yet → the queue (the past, once)
create or replace function public.ai_credit_queue_all()
returns int
language plpgsql
security definer
set search_path = public
as $$
declare
  n int;
begin
  if not public.has_permission('settings.manage') then raise exception 'Only an admin can do this.'; end if;
  insert into public.admission_credits (lead_id, status, requested_at)
  select l.id, 'pending', now()
  from public.leads l
  join public.pipeline_stages s on s.id = l.stage_id and s.kind = 'won'
  where l.deleted_at is null and l.admitted_at is not null
  on conflict (lead_id) do update
    set status = 'pending', requested_at = now(), attempts = 0, error = null
    where admission_credits.status = 'failed';
  get diagnostics n = row_count;
  return n;
end;
$$;
revoke all on function public.ai_credit_queue_all() from public, anon;
grant execute on function public.ai_credit_queue_all() to authenticated;

-- One lead again (e.g. after notes were added)
create or replace function public.ai_credit_redo(p_lead uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if not public.has_permission('settings.manage') then raise exception 'Only an admin can do this.'; end if;
  if not exists (select 1 from public.leads l join public.pipeline_stages s on s.id = l.stage_id
                 where l.id = p_lead and s.kind = 'won' and l.admitted_at is not null) then
    raise exception 'This lead is not admitted.';
  end if;
  insert into public.admission_credits (lead_id, status, requested_at)
  values (p_lead, 'pending', now())
  on conflict (lead_id) do update
    set status = 'pending', requested_at = now(), attempts = 0, error = null, manual = false;
end;
$$;
revoke all on function public.ai_credit_redo(uuid) from public, anon;
grant execute on function public.ai_credit_redo(uuid) to authenticated;

-- The admin sets the shares by hand (kept until "work out again")
create or replace function public.ai_credit_set_manual(p_lead uuid, p_shares jsonb, p_reason text)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_total numeric;
begin
  if not public.has_permission('settings.manage') then raise exception 'Only an admin can do this.'; end if;
  if nullif(trim(coalesce(p_reason, '')), '') is null then raise exception 'Please write why.'; end if;
  select coalesce(sum((s ->> 'share')::numeric), 0) into v_total
  from jsonb_array_elements(coalesce(p_shares, '[]'::jsonb)) s where (s ->> 'share')::numeric > 0;
  if round(v_total) <> 100 then raise exception 'The shares must add up to 100 (now %).', round(v_total); end if;
  insert into public.admission_credits (lead_id, status, shares, manual, edited_by, edit_reason, done_at, requested_at)
  values (p_lead, 'done', '[]'::jsonb, true, auth.uid(), trim(p_reason), now(), now())
  on conflict (lead_id) do nothing;
  update public.admission_credits
     set status = 'done', manual = true, edited_by = auth.uid(), edit_reason = left(trim(p_reason), 300), done_at = now(),
         shares = (select jsonb_agg(jsonb_build_object(
                     'user_id', s ->> 'user_id', 'share', round((s ->> 'share')::numeric, 1),
                     'reason', coalesce(nullif(s ->> 'reason', ''),
                                        (select o ->> 'reason' from jsonb_array_elements(admission_credits.shares) o
                                         where o ->> 'user_id' = s ->> 'user_id'))))
                   from jsonb_array_elements(p_shares) s
                   where (s ->> 'share')::numeric > 0
                     and exists (select 1 from public.profiles p where p.id::text = s ->> 'user_id'))
   where lead_id = p_lead;
end;
$$;
revoke all on function public.ai_credit_set_manual(uuid, jsonb, text) from public, anon;
grant execute on function public.ai_credit_set_manual(uuid, jsonb, text) to authenticated;

-- Settings → AI: how far the work is
create or replace function public.ai_credit_overview()
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
begin
  if not public.has_permission('settings.manage') then raise exception 'Only an admin can see this.'; end if;
  return jsonb_build_object(
    'pending', (select count(*) from public.admission_credits where status in ('pending', 'working')),
    'done', (select count(*) from public.admission_credits where status = 'done'),
    'failed', (select count(*) from public.admission_credits where status = 'failed'),
    'manual', (select count(*) from public.admission_credits where manual),
    'not_queued', (select count(*) from public.leads l join public.pipeline_stages s on s.id = l.stage_id and s.kind = 'won'
                   where l.deleted_at is null and l.admitted_at is not null
                     and not exists (select 1 from public.admission_credits ac where ac.lead_id = l.id)),
    'last_error', (select error from public.admission_credits where error is not null order by requested_at desc limit 1),
    'tokens_in', (select coalesce(sum((usage ->> 'input_tokens')::bigint), 0) from public.admission_credits where usage is not null),
    'tokens_out', (select coalesce(sum((usage ->> 'output_tokens')::bigint), 0) from public.admission_credits where usage is not null));
end;
$$;
revoke all on function public.ai_credit_overview() from public, anon;
grant execute on function public.ai_credit_overview() to authenticated;

-- ---------------------------------------------------------------------
-- 👀 Reading (people allowed in Settings → AI)
-- ---------------------------------------------------------------------
-- The lead page card: names in place of ids
create or replace function public.lead_admission_credit(p_lead uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  ac record;
begin
  if not public.ai_credit_can_view() then return null; end if;
  select * into ac from public.admission_credits where lead_id = p_lead;
  if ac.lead_id is null then return jsonb_build_object('status', 'none'); end if;
  return jsonb_build_object(
    'status', ac.status,
    'shares', coalesce((select jsonb_agg(s || jsonb_build_object('name', p.full_name) order by (s ->> 'share')::numeric desc)
                        from jsonb_array_elements(ac.shares) s
                        left join public.profiles p on p.id::text = s ->> 'user_id'), '[]'::jsonb),
    'stats', ac.stats,
    'decisive', ac.decisive,
    'confidence', ac.confidence,
    'manual', ac.manual,
    'edit_reason', ac.edit_reason,
    'edited_by', (select full_name from public.profiles where id = ac.edited_by),
    'error', case when public.has_permission('settings.manage') then ac.error end,
    'done_at', ac.done_at,
    'model', ac.model);
end;
$$;
revoke all on function public.lead_admission_credit(uuid) from public, anon;
grant execute on function public.lead_admission_credit(uuid) to authenticated;

-- Each person's admission credit in a period (shares of 1 per admission)
create or replace function public.ai_credit_people(p_from date, p_to date)
returns table (user_id uuid, name text, credit numeric, admissions int)
language sql
stable
security definer
set search_path = public
as $$
  select (s ->> 'user_id')::uuid, p.full_name, round(sum((s ->> 'share')::numeric) / 100, 2), count(*)::int
  from public.admission_credits ac
  join public.leads l on l.id = ac.lead_id and l.deleted_at is null
  join public.pipeline_stages st on st.id = l.stage_id and st.kind = 'won'
  cross join lateral jsonb_array_elements(ac.shares) s
  left join public.profiles p on p.id::text = s ->> 'user_id'
  where public.ai_credit_can_view() and ac.status = 'done'
    and (l.admitted_at at time zone 'Asia/Dhaka')::date between p_from and p_to
  group by 1, 2
  order by 3 desc;
$$;
revoke all on function public.ai_credit_people(date, date) from public, anon;
grant execute on function public.ai_credit_people(date, date) to authenticated;

-- ---------------------------------------------------------------------
-- 🏆 Credits: "Admitted" now follows the AI's shares
-- ---------------------------------------------------------------------
create or replace function public.credit_work(p_from date, p_to date)
returns table (user_id uuid, day date, kind text, qty numeric)
language sql
stable
security definer
set search_path = public
as $$
  with
  latest as (select rules from public.credit_rule_sets order by effective_from desc, created_at desc limit 1),
  r as (select rules from latest),
  calls as (
    select c.*, (c.called_at at time zone 'Asia/Dhaka')::date as d
    from public.call_logs c
    where c.deleted_at is null
      and (c.called_at at time zone 'Asia/Dhaka')::date between p_from and p_to
  )
  -- 📞 calls tried (outgoing; the same lead within 5 minutes once)
  select user_id, d, 'call_any', count(distinct (lead_id, floor(extract(epoch from called_at) / 300)))::numeric
  from calls where channel = 'phone' and direction = 'outgoing' group by 1, 2
  union all
  -- ✅ talked (outgoing, long enough)
  select user_id, d, 'call_connected', count(*)::numeric
  from calls, r
  where channel = 'phone' and direction = 'outgoing' and outcome = 'connected'
    and coalesce(duration_sec, 0) >= coalesce((r.rules->'call_connected'->>'min_sec')::int, 10)
  group by 1, 2
  union all
  -- ⏱ talk minutes (each call up to a limit)
  select user_id, d, 'talk_minute',
         sum(least(floor(coalesce(duration_sec, 0) / 60.0),
                   coalesce(nullif((r.rules->'talk_minute'->>'per_call')::int, 0), 100000)))::numeric
  from calls, r
  where channel = 'phone' and outcome = 'connected'
  group by 1, 2
  union all
  -- 📲 incoming answered
  select user_id, d, 'incoming', count(*)::numeric
  from calls where channel = 'phone' and direction = 'incoming' and outcome = 'connected' group by 1, 2
  union all
  -- 💬 WhatsApp
  select user_id, d, 'wa_message', count(*)::numeric
  from calls where channel = 'whatsapp' and outcome = 'message' and template_id is null group by 1, 2
  union all
  select user_id, d, 'wa_call', count(*)::numeric
  from calls where channel = 'whatsapp' and outcome = 'connected' group by 1, 2
  union all
  -- ✉️ a ready-made message sent
  select user_id, d, 'template', count(*)::numeric
  from calls where template_id is not null group by 1, 2
  union all
  -- 📝 notes (long enough) and 🎙 voice notes
  select a.user_id, (a.created_at at time zone 'Asia/Dhaka')::date, 'note', count(*)::numeric
  from public.lead_activity a, r
  where a.action = 'note_added'
    and (a.created_at at time zone 'Asia/Dhaka')::date between p_from and p_to
    and length(trim(coalesce(a.details->>'note', ''))) >= coalesce((r.rules->'note'->>'min_chars')::int, 15)
  group by 1, 2
  union all
  select f.uploaded_by, (f.created_at at time zone 'Asia/Dhaka')::date, 'voice', count(*)::numeric
  from public.lead_files f
  where f.kind = 'voice' and f.deleted_at is null and f.uploaded_by is not null
    and (f.created_at at time zone 'Asia/Dhaka')::date between p_from and p_to
  group by 1, 2
  union all
  -- ⏰ next call set / done on time
  select a.user_id, (a.created_at at time zone 'Asia/Dhaka')::date, 'follow_up_set', count(*)::numeric
  from public.lead_activity a
  where a.action = 'follow_up_set' and (a.created_at at time zone 'Asia/Dhaka')::date between p_from and p_to
  group by 1, 2
  union all
  select f.completed_by, (f.completed_at at time zone 'Asia/Dhaka')::date, 'follow_up_on_time', count(*)::numeric
  from public.follow_ups f
  where f.status = 'done' and f.completed_by is not null
    and (f.completed_at at time zone 'Asia/Dhaka')::date between p_from and p_to
    and (f.completed_at at time zone 'Asia/Dhaka')::date <= (f.due_at at time zone 'Asia/Dhaka')::date
  group by 1, 2
  union all
  -- ⚠️ a next call left undone past its day (the lead's owner)
  select coalesce(l.assigned_to, f.created_by), (f.due_at at time zone 'Asia/Dhaka')::date, 'overdue', count(*)::numeric
  from public.follow_ups f
  join public.leads l on l.id = f.lead_id and l.deleted_at is null
  where (f.due_at at time zone 'Asia/Dhaka')::date between p_from and p_to
    and (f.due_at at time zone 'Asia/Dhaka')::date < (now() at time zone 'Asia/Dhaka')::date
    and (f.status = 'pending'
         or (f.status = 'done' and (f.completed_at at time zone 'Asia/Dhaka')::date > (f.due_at at time zone 'Asia/Dhaka')::date))
  group by 1, 2
  union all
  -- ➕ leads added (typed / imported)
  select l.created_by, (l.created_at at time zone 'Asia/Dhaka')::date,
         case when l.import_batch_id is null then 'lead_added' else 'lead_imported' end, count(*)::numeric
  from public.leads l
  where l.deleted_at is null and l.created_by is not null
    and (l.created_at at time zone 'Asia/Dhaka')::date between p_from and p_to
  group by 1, 2, 3
  union all
  -- 🚩 a stage further on
  select a.user_id, (a.created_at at time zone 'Asia/Dhaka')::date, 'stage_forward', count(*)::numeric
  from public.lead_activity a
  join public.pipeline_stages s1 on s1.id::text = a.details->>'from'
  join public.pipeline_stages s2 on s2.id::text = a.details->>'to'
  where a.action = 'stage_changed' and s2.sort_order > s1.sort_order and s2.kind = 'open'
    and (a.created_at at time zone 'Asia/Dhaka')::date between p_from and p_to
  group by 1, 2
  union all
  -- 🏫 campus visits and 📄 papers
  select a.user_id, (a.created_at at time zone 'Asia/Dhaka')::date,
         case a.action when 'visit_planned' then 'visit_planned' when 'visit_done' then 'visit_done' else 'paper' end,
         count(*)::numeric
  from public.lead_activity a
  where a.action in ('visit_planned', 'visit_done', 'paper_received')
    and (a.created_at at time zone 'Asia/Dhaka')::date between p_from and p_to
  group by 1, 2, 3
  union all
  -- 🎓 admitted (still admitted): 🤖 shared out by the AI's admission credit
  --   (each person's share of 1); not worked out yet / AI off → the one
  --   who marked it Admitted, as before
  select x.user_id, x.d, 'admitted', sum(x.part)
  from (
    select (s ->> 'user_id')::uuid as user_id, (l.admitted_at at time zone 'Asia/Dhaka')::date as d,
           (s ->> 'share')::numeric / 100 as part
    from public.leads l
    join public.pipeline_stages st on st.id = l.stage_id and st.kind = 'won'
    join public.admission_credits ac on ac.lead_id = l.id and ac.status = 'done'
    cross join lateral jsonb_array_elements(ac.shares) s
    where l.deleted_at is null
      and public.ai_credit_on()
      and (l.admitted_at at time zone 'Asia/Dhaka')::date between p_from and p_to
    union all
    select l.admitted_by, (l.admitted_at at time zone 'Asia/Dhaka')::date, 1::numeric
    from public.leads l
    join public.pipeline_stages st on st.id = l.stage_id and st.kind = 'won'
    where l.deleted_at is null and l.admitted_by is not null
      and (l.admitted_at at time zone 'Asia/Dhaka')::date between p_from and p_to
      and not (public.ai_credit_on()
               and exists (select 1 from public.admission_credits ac where ac.lead_id = l.id and ac.status = 'done'))
  ) x
  where x.user_id is not null
  group by 1, 2
  union all
  -- 💵 money taken (refunds take it back; voided ones don't count)
  select p.received_by, (p.paid_at at time zone 'Asia/Dhaka')::date, 'payment',
         sum(case when p.kind = 'refund' then -p.amount else p.amount end)
  from public.fee_payments p
  where p.voided_at is null and p.received_by is not null
    and (p.paid_at at time zone 'Asia/Dhaka')::date between p_from and p_to
  group by 1, 2
  union all
  -- 📱 time working in the app (seconds)
  select s.user_id, (s.started_at at time zone 'Asia/Dhaka')::date, 'app_time', sum(s.active_sec)::numeric
  from public.app_sessions s
  where (s.started_at at time zone 'Asia/Dhaka')::date between p_from and p_to
  group by 1, 2;
$$;

revoke all on function public.credit_work(date, date) from public, anon, authenticated;
