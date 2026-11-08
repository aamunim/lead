-- =====================================================================
-- 🤖 Two AIs: Claude and Gemini (free), each can be switched off
--   · Settings → AI: an on/off switch for each AI (off = never used, its
--     key is never sent); a key for each; the Gemini model to use
--   · for each feature (chance of admission, admission credit) which AI:
--     claude | gemini | gemini_then_claude (Gemini first, Claude if it
--     can't) | compare (both, side by side)
--   · every answer is kept per AI: an answer by Claude stays when Gemini
--     answers later (and the other way round); the lists / Credits use the
--     latest one, the lead page shows both
--   · the monthly budget is for Claude only (Gemini's free tier costs $0)
--   (Dated before 20270104060000_lead_merge so both can go in any order.)
-- =====================================================================

-- ---------------------------------------------------------------------
-- ⚙️ Settings
-- ---------------------------------------------------------------------
insert into public.app_settings (key, value, description)
values ('ai_providers', jsonb_build_object(
  'claude', jsonb_build_object('on', true),
  'gemini', jsonb_build_object('on', false, 'model', null)
), 'AI providers: Claude and Gemini on/off, the Gemini model')
on conflict (key) do nothing;

update public.app_settings set value = jsonb_build_object('provider', 'claude') || value where key in ('ai_chance', 'ai_credit');

-- a stop for a while (e.g. Gemini's free quota used up)
alter table public.ai_secrets add column if not exists paused_until timestamptz;

-- Is this AI on, with a working key? ('claude' | 'gemini')
create or replace function public.ai_provider_ready(p_provider text)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select coalesce((select (value -> p_provider ->> 'on')::boolean from public.app_settings where key = 'ai_providers'),
                  p_provider = 'claude')
     and exists (select 1 from public.ai_secrets s
                 where s.name = case p_provider when 'claude' then 'anthropic' else 'gemini' end
                   and s.last_error is null
                   and coalesce(s.paused_until, '-infinity'::timestamptz) < now())
     and (p_provider <> 'gemini'
          or nullif((select value -> 'gemini' ->> 'model' from public.app_settings where key = 'ai_providers'), '') is not null);
$$;
revoke all on function public.ai_provider_ready(text) from public, anon, authenticated;

-- For a feature ('chance' | 'credit'): the mode and the AIs to try, in order
create or replace function public.ai_feature_plan(p_feature text)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_mode text := coalesce((select value ->> 'provider' from public.app_settings
                           where key = case p_feature when 'credit' then 'ai_credit' else 'ai_chance' end), 'claude');
  c boolean := public.ai_provider_ready('claude');
  g boolean := public.ai_provider_ready('gemini');
  v_list text[] := '{}'::text[];
begin
  if v_mode = 'claude' then
    if c then v_list := array['claude']; end if;
  elsif v_mode = 'gemini' then
    if g then v_list := array['gemini']; end if;
  else -- gemini_then_claude, compare
    if g then v_list := array_append(v_list, 'gemini'); end if;
    if c then v_list := array_append(v_list, 'claude'); end if;
  end if;
  return jsonb_build_object('mode', v_mode, 'providers', to_jsonb(v_list), 'budget_ok', public.ai_budget_ok());
end;
$$;
revoke all on function public.ai_feature_plan(text) from public, anon, authenticated;

create or replace function public.ai_feature_ready(p_feature text)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select jsonb_array_length(public.ai_feature_plan(p_feature) -> 'providers') > 0;
$$;
revoke all on function public.ai_feature_ready(text) from public, anon, authenticated;

-- Gemini is one of them (free: the Claude budget does not stop the queue)
create or replace function public.ai_feature_free(p_feature text)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select (public.ai_feature_plan(p_feature) -> 'providers') ? 'gemini';
$$;
revoke all on function public.ai_feature_free(text) from public, anon, authenticated;

-- ---------------------------------------------------------------------
-- 💵 The Claude budget counts Claude only (Gemini usage: 'gemini:<feature>')
-- ---------------------------------------------------------------------
create or replace function public.ai_month_spent()
returns numeric
language sql
stable
security definer
set search_path = public
as $$
  select coalesce(sum(public.ai_cost_usd(input_tokens, output_tokens)), 0)
  from public.ai_usage_daily
  where day >= date_trunc('month', now() at time zone 'Asia/Dhaka')::date
    and feature not like 'gemini:%';
$$;
revoke all on function public.ai_month_spent() from public, anon, authenticated;

-- ---------------------------------------------------------------------
-- 🔑 Keys
-- ---------------------------------------------------------------------
-- The server notes whether a key works (p_provider: 'claude' | 'gemini')
drop function if exists public.ai_key_result(boolean, text);
create or replace function public.ai_key_result(p_ok boolean, p_error text default null, p_provider text default 'claude')
returns void
language sql
security definer
set search_path = public
as $$
  update public.ai_secrets
     set last_ok_at = case when p_ok then now() else last_ok_at end,
         last_error = case when p_ok then null else left(p_error, 300) end,
         paused_until = case when p_ok then null else paused_until end
   where name = case p_provider when 'gemini' then 'gemini' else 'anthropic' end;
$$;
revoke all on function public.ai_key_result(boolean, text, text) from public, anon, authenticated;
grant execute on function public.ai_key_result(boolean, text, text) to service_role;

-- Gemini's free quota is used up: rest it for a while
create or replace function public.ai_provider_pause(p_provider text, p_minutes int, p_note text default null)
returns void
language sql
security definer
set search_path = public
as $$
  update public.ai_secrets
     set paused_until = now() + make_interval(mins => greatest(1, least(p_minutes, 24 * 60)))
   where name = case p_provider when 'gemini' then 'gemini' else 'anthropic' end;
$$;
revoke all on function public.ai_provider_pause(text, int, text) from public, anon, authenticated;
grant execute on function public.ai_provider_pause(text, int, text) to service_role;

create or replace function public.gemini_key_status()
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
  select * into k from public.ai_secrets where name = 'gemini';
  return jsonb_build_object(
    'set', k.name is not null,
    'hint', case when k.name is not null then left(k.value, 4) || '…' || right(k.value, 4) end,
    'updated_at', k.updated_at,
    'last_ok_at', k.last_ok_at,
    'last_error', k.last_error,
    'paused_until', case when k.paused_until > now() then k.paused_until end);
end;
$$;
revoke all on function public.gemini_key_status() from public, anon;
grant execute on function public.gemini_key_status() to authenticated;

create or replace function public.set_gemini_key(p_key text, p_functions_url text default null)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_key text := trim(coalesce(p_key, ''));
begin
  if not public.has_permission('settings.manage') then raise exception 'Only an admin can do this.'; end if;
  if v_key ~ '\s' or length(v_key) < 20 or length(v_key) > 200 then
    raise exception 'This does not look like a Gemini API key (from aistudio.google.com → Get API key).';
  end if;
  if v_key ~ '^sk-ant-' then raise exception 'This is a Claude key. Paste it in the Claude key box.'; end if;
  insert into public.ai_secrets (name, value, updated_by, updated_at, last_ok_at, last_error, paused_until)
  values ('gemini', v_key, auth.uid(), now(), null, null, null)
  on conflict (name) do update
    set value = excluded.value, updated_by = excluded.updated_by, updated_at = now(),
        last_ok_at = null, last_error = null, paused_until = null;
  perform public.set_ai_functions_url(p_functions_url);
end;
$$;
revoke all on function public.set_gemini_key(text, text) from public, anon;
grant execute on function public.set_gemini_key(text, text) to authenticated;

create or replace function public.remove_gemini_key()
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if not public.has_permission('settings.manage') then raise exception 'Only an admin can do this.'; end if;
  delete from public.ai_secrets where name = 'gemini';
end;
$$;
revoke all on function public.remove_gemini_key() from public, anon;
grant execute on function public.remove_gemini_key() to authenticated;

-- What an AI Edge Function needs, in one go (the server only)
create or replace function public.ai_server_config(p_setting text)
returns jsonb
language sql
stable
security definer
set search_path = public
as $$
  select jsonb_build_object(
    'key', (select value from public.ai_secrets where name = 'anthropic'),
    'gemini_key', (select value from public.ai_secrets where name = 'gemini'),
    'gemini_model', (select value -> 'gemini' ->> 'model' from public.app_settings where key = 'ai_providers'),
    'cron_secret', (select value from public.ai_secrets where name = 'cron_secret'),
    'settings', coalesce((select value from public.app_settings where key = p_setting), '{}'::jsonb),
    'plan', public.ai_feature_plan(case p_setting when 'ai_credit' then 'credit' else 'chance' end));
$$;
revoke all on function public.ai_server_config(text) from public, anon, authenticated;
grant execute on function public.ai_server_config(text) to service_role;

-- ---------------------------------------------------------------------
-- 🗂 Every answer, kept per AI (never overwritten by the other AI)
-- ---------------------------------------------------------------------
create table if not exists public.lead_chance_answers (
  lead_id        uuid not null references public.leads (id) on delete cascade,
  provider       text not null check (provider in ('claude', 'gemini')),
  chance         smallint,
  level          text,
  summary        text,
  good           jsonb not null default '[]'::jsonb,
  risks          jsonb not null default '[]'::jsonb,
  objections     jsonb not null default '[]'::jsonb,
  actions        jsonb not null default '[]'::jsonb,
  script         jsonb not null default '[]'::jsonb,
  best_time      text,
  next_call_days smallint,
  next_call_why  text,
  model          text,
  usage          jsonb,
  done_at        timestamptz not null default now(),
  primary key (lead_id, provider)
);
alter table public.lead_chance_answers enable row level security;
drop policy if exists "lead chance answers: read" on public.lead_chance_answers;
create policy "lead chance answers: read" on public.lead_chance_answers
  for select to authenticated
  using ((select public.ai_chance_can_view()) and exists (select 1 from public.leads l where l.id = lead_chance_answers.lead_id));
grant select on public.lead_chance_answers to authenticated;
revoke insert, update, delete on public.lead_chance_answers from anon, authenticated;

alter table public.lead_chances add column if not exists provider text;
update public.lead_chances set provider = 'claude' where provider is null and chance is not null;

-- the answers so far were all Claude's
insert into public.lead_chance_answers (lead_id, provider, chance, level, summary, good, risks, objections, actions,
                                        script, best_time, next_call_days, next_call_why, model, usage, done_at)
select lead_id, 'claude', chance, level, summary, good, risks, objections, actions, script, best_time,
       next_call_days, next_call_why, model, usage, coalesce(done_at, now())
from public.lead_chances where chance is not null
on conflict (lead_id, provider) do nothing;

create table if not exists public.admission_credit_answers (
  lead_id    uuid not null references public.leads (id) on delete cascade,
  provider   text not null check (provider in ('claude', 'gemini')),
  shares     jsonb not null default '[]'::jsonb,
  decisive   text,
  confidence text,
  stats      jsonb not null default '[]'::jsonb,
  model      text,
  usage      jsonb,
  done_at    timestamptz not null default now(),
  primary key (lead_id, provider)
);
alter table public.admission_credit_answers enable row level security;
drop policy if exists "admission credit answers: read" on public.admission_credit_answers;
create policy "admission credit answers: read" on public.admission_credit_answers
  for select to authenticated using ((select public.ai_credit_can_view()));
grant select on public.admission_credit_answers to authenticated;
revoke insert, update, delete on public.admission_credit_answers from anon, authenticated;

alter table public.admission_credits add column if not exists provider text;
update public.admission_credits set provider = 'claude' where provider is null and status = 'done' and not manual;

insert into public.admission_credit_answers (lead_id, provider, shares, decisive, confidence, stats, model, usage, done_at)
select lead_id, 'claude', shares, decisive, confidence, stats, model, usage, coalesce(done_at, now())
from public.admission_credits where status = 'done' and not manual and jsonb_array_length(shares) > 0
on conflict (lead_id, provider) do nothing;

-- ---------------------------------------------------------------------
-- 💾 Saving: into the per-AI store; the shown answer only when final
-- ---------------------------------------------------------------------
drop function if exists public.ai_chance_save(uuid, jsonb, text, jsonb);
create or replace function public.ai_chance_save(p_lead uuid, p_r jsonb, p_model text, p_usage jsonb,
                                                 p_provider text default 'claude', p_final boolean default true)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $$
declare
  v_chance int := greatest(0, least(100, round(coalesce((p_r ->> 'chance')::numeric, 0))));
  v_stale  boolean;
  v_now_again boolean;
  v_next   timestamptz := public.ai_chance_next_run();
begin
  -- 🗂 kept per AI (the other AI's answer stays)
  insert into public.lead_chance_answers as a (lead_id, provider, chance, level, summary, good, risks, objections,
                                               actions, script, best_time, next_call_days, next_call_why, model, usage, done_at)
  values (p_lead, coalesce(p_provider, 'claude'), v_chance,
          case when v_chance >= 60 then 'hot' when v_chance >= 30 then 'warm' else 'cold' end,
          left(p_r ->> 'summary', 600), coalesce(p_r -> 'good', '[]'::jsonb), coalesce(p_r -> 'risks', '[]'::jsonb),
          coalesce(p_r -> 'objections', '[]'::jsonb), coalesce(p_r -> 'actions', '[]'::jsonb),
          coalesce(p_r -> 'script', '[]'::jsonb), left(p_r ->> 'best_time', 200),
          greatest(0, least(60, coalesce((p_r ->> 'next_call_days')::int, 1))), left(p_r ->> 'next_call_why', 300),
          p_model, p_usage, now())
  on conflict (lead_id, provider) do update
    set chance = excluded.chance, level = excluded.level, summary = excluded.summary, good = excluded.good,
        risks = excluded.risks, objections = excluded.objections, actions = excluded.actions, script = excluded.script,
        best_time = excluded.best_time, next_call_days = excluded.next_call_days, next_call_why = excluded.next_call_why,
        model = excluded.model, usage = excluded.usage, done_at = now();
  -- compare mode: the first of two answers only goes into the store above
  if not coalesce(p_final, true) then return; end if;

  select stale, stale_manual into v_stale, v_now_again from public.lead_chances where lead_id = p_lead;
  update public.lead_chances
     set status = case when coalesce(v_stale, false) then 'pending' else 'done' end,
         -- something new came while working: again (at once if someone pressed "Check")
         due_at = case when coalesce(v_stale, false) then
                    case when coalesce(v_now_again, false) then now() else v_next end
                  else due_at end,
         stale = false,
         stale_manual = false,
         manual = coalesce(v_stale, false) and coalesce(v_now_again, false),
         bulk = false,
         prev_chance = chance,
         chance = v_chance,
         level = case when v_chance >= 60 then 'hot' when v_chance >= 30 then 'warm' else 'cold' end,
         summary = left(p_r ->> 'summary', 600),
         good = coalesce(p_r -> 'good', '[]'::jsonb),
         risks = coalesce(p_r -> 'risks', '[]'::jsonb),
         objections = coalesce(p_r -> 'objections', '[]'::jsonb),
         actions = coalesce(p_r -> 'actions', '[]'::jsonb),
         script = coalesce(p_r -> 'script', '[]'::jsonb),
         best_time = left(p_r ->> 'best_time', 200),
         next_call_days = greatest(0, least(60, coalesce((p_r ->> 'next_call_days')::int, 1))),
         next_call_why = left(p_r ->> 'next_call_why', 300),
         model = p_model, usage = p_usage, error = null, done_at = now(), attempts = 0,
         provider = coalesce(p_provider, 'claude'),
         stage_at_done = 'open'
   where lead_id = p_lead;
end;
$$;
revoke all on function public.ai_chance_save(uuid, jsonb, text, jsonb, text, boolean) from public, anon, authenticated;
grant execute on function public.ai_chance_save(uuid, jsonb, text, jsonb, text, boolean) to service_role;

drop function if exists public.ai_credit_save(uuid, jsonb, text, text, jsonb, text, jsonb);
create or replace function public.ai_credit_save(p_lead uuid, p_shares jsonb, p_decisive text, p_confidence text,
                                                 p_stats jsonb, p_model text, p_usage jsonb,
                                                 p_provider text default 'claude', p_final boolean default true)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $$
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

  -- 🗂 kept per AI (the other AI's answer stays)
  insert into public.admission_credit_answers as a (lead_id, provider, shares, decisive, confidence, stats, model, usage, done_at)
  values (p_lead, coalesce(p_provider, 'claude'), v_shares, left(p_decisive, 600),
          case when p_confidence in ('high', 'medium', 'low') then p_confidence end,
          coalesce(p_stats, '[]'::jsonb), p_model, p_usage, now())
  on conflict (lead_id, provider) do update
    set shares = excluded.shares, decisive = excluded.decisive, confidence = excluded.confidence,
        stats = excluded.stats, model = excluded.model, usage = excluded.usage, done_at = now();
  -- compare mode: the first of two answers only goes into the store above
  if not coalesce(p_final, true) then return; end if;

  update public.admission_credits
     set status = 'done', shares = v_shares, decisive = left(p_decisive, 600), provider = coalesce(p_provider, 'claude'),
         confidence = case when p_confidence in ('high', 'medium', 'low') then p_confidence end,
         stats = coalesce(p_stats, '[]'::jsonb), model = p_model, usage = p_usage,
         error = null, done_at = now(), manual = false
   where lead_id = p_lead and not manual;
end;
$$;
revoke all on function public.ai_credit_save(uuid, jsonb, text, text, jsonb, text, jsonb, text, boolean) from public, anon, authenticated;
grant execute on function public.ai_credit_save(uuid, jsonb, text, text, jsonb, text, jsonb, text, boolean) to service_role;

-- ---------------------------------------------------------------------
-- ⚙️ The queues: only when an AI is on; Gemini goes on past the Claude budget
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.ai_chance_claim(p_limit integer DEFAULT 3)
 RETURNS SETOF uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $$
declare
  v_cap    int := greatest(0, coalesce((public.ai_chance_setting() ->> 'daily_auto_limit')::int, 100));
  v_today  date := (now() at time zone 'Asia/Dhaka')::date;
  v_used   int;
  -- the Claude budget: Gemini (free) keeps going when Claude's is used up
  v_budget boolean := public.ai_budget_ok() or public.ai_feature_free('chance');
begin
  -- no AI on for this: nothing is taken (the leads wait)
  if not public.ai_feature_ready('chance') then return; end if;
  select count(*) into v_used from public.lead_chances
  where last_kind = 'auto' and done_at is not null and (done_at at time zone 'Asia/Dhaka')::date = v_today;

  -- tried 3 times and the server was stopped each time (too slow): give up
  update public.lead_chances
     set status = 'failed', error = 'The AI took too long (3 tries).', manual = false, bulk = false
   where status = 'working' and started_at < now() - interval '10 minutes' and attempts >= 3;

  return query
  update public.lead_chances lc
     set status = 'working', started_at = now(), attempts = lc.attempts + 1, stale = false, stale_manual = false,
         last_kind = case when lc.manual then 'manual' when lc.bulk then 'bulk' else 'auto' end
   where lc.lead_id in (
     select x.lead_id from public.lead_chances x
     where (x.status = 'pending' and x.due_at <= now()
            and (x.manual or (v_budget and (x.bulk or v_used < v_cap))))
        or (x.status = 'working' and x.started_at < now() - interval '10 minutes')
     order by x.manual desc, x.bulk desc, x.due_at
     limit greatest(1, least(p_limit, 10))
     for update skip locked)
  returning lc.lead_id;
end;
$$;
revoke all on function public.ai_chance_claim(int) from public, anon, authenticated;
grant execute on function public.ai_chance_claim(int) to service_role;

CREATE OR REPLACE FUNCTION public.ai_credit_claim(p_limit integer DEFAULT 3)
 RETURNS SETOF uuid
 LANGUAGE sql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $$
  -- tried 3 times and the server was stopped each time (too slow): give up
  update public.admission_credits
     set status = 'failed', error = 'The AI took too long (3 tries).'
   where status = 'working' and started_at < now() - interval '10 minutes' and attempts >= 3;
  update public.admission_credits ac
     set status = 'working', started_at = now(), attempts = ac.attempts + 1
   where ac.lead_id in (
     select lead_id from public.admission_credits
     where (status = 'pending' and requested_at <= now() and public.ai_feature_ready('credit')
            and (public.ai_budget_ok() or public.ai_feature_free('credit')))
        or (status = 'working' and started_at < now() - interval '10 minutes' and attempts < 3)
     order by requested_at
     limit greatest(1, least(p_limit, 10))
     for update skip locked)
  returning ac.lead_id;
$$;
revoke all on function public.ai_credit_claim(int) from public, anon, authenticated;
grant execute on function public.ai_credit_claim(int) to service_role;

CREATE OR REPLACE FUNCTION public.ai_chance_kick()
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $$
declare
  v_url    text := (select value from public.ai_secrets where name = 'functions_url');
  v_secret text := (select value from public.ai_secrets where name = 'cron_secret');
  v_cap    int := greatest(0, coalesce((public.ai_chance_setting() ->> 'daily_auto_limit')::int, 100));
  v_today  date := (now() at time zone 'Asia/Dhaka')::date;
  v_used   int;
  v_budget boolean;
begin
  if to_regproc('net.http_post') is null or v_url is null or v_secret is null then return; end if;
  if not coalesce((public.ai_chance_setting() ->> 'enabled')::boolean, false)
     or not public.ai_feature_ready('chance') then
    return;
  end if;
  v_budget := public.ai_budget_ok() or public.ai_feature_free('chance');
  select count(*) into v_used from public.lead_chances
  where last_kind = 'auto' and done_at is not null and (done_at at time zone 'Asia/Dhaka')::date = v_today;
  if not exists (select 1 from public.lead_chances
                 where (status = 'pending' and due_at <= now() and (manual or (v_budget and (bulk or v_used < v_cap))))
                    or (status = 'working' and started_at < now() - interval '10 minutes')) then
    return;
  end if;
  perform net.http_post(
    url := v_url || '/ai-lead-chance',
    body := '{}'::jsonb,
    headers := jsonb_build_object('Content-Type', 'application/json', 'x-cron-secret', v_secret),
    timeout_milliseconds := 5000);
end;
$$;
revoke all on function public.ai_chance_kick() from public, anon, authenticated;

CREATE OR REPLACE FUNCTION public.ai_credit_kick()
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $$
declare
  v_url    text := (select value from public.ai_secrets where name = 'functions_url');
  v_secret text := (select value from public.ai_secrets where name = 'cron_secret');
begin
  if to_regproc('net.http_post') is null or v_url is null or v_secret is null then return; end if;
  -- no key, or the key was refused (saving a new one clears that): wait
  if not public.ai_credit_on() or not public.ai_feature_ready('credit') then
    return;
  end if;
  if not exists (select 1 from public.admission_credits
                 where (status = 'pending' and requested_at <= now())
                    or (status = 'working' and started_at < now() - interval '10 minutes')) then
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

CREATE OR REPLACE FUNCTION public.ai_chance_request(p_lead uuid)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $$
begin
  if not public.ai_chance_can_view() then raise exception 'AI chance is not on for you.'; end if;
  if not exists (select 1 from public.leads l where l.id = p_lead and l.deleted_at is null
                 and public.can_view_lead(l.assigned_to)) then
    raise exception 'Lead not found.';
  end if;
  if not exists (select 1 from public.leads l join public.pipeline_stages s on s.id = l.stage_id
                 where l.id = p_lead and s.kind = 'open') then
    raise exception 'Only open leads (not admitted or lost).';
  end if;
  if (select count(*) from public.lead_chances where requested_by = auth.uid() and (manual or last_kind = 'manual')
        and requested_at > now() - interval '1 hour') >= 40 then
    raise exception 'Too many checks this hour. Please wait a little.';
  end if;
  if not public.ai_feature_ready('chance') then
    raise exception 'No AI is on for this right now (Settings → AI: switch an AI on, check its key).';
  end if;
  perform public.ai_chance_mark(array[p_lead], true);
end;
$$;
revoke all on function public.ai_chance_request(uuid) from public, anon;
grant execute on function public.ai_chance_request(uuid) to authenticated;

CREATE OR REPLACE FUNCTION public.ai_chance_request_many(p_leads uuid[], p_force boolean DEFAULT false)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $$
declare
  v_today date := (now() at time zone 'Asia/Dhaka')::date;
  v_ids   uuid[];
  v_fresh int;
  v_n     int;
begin
  if not public.ai_chance_can_view() then raise exception 'AI chance is not on for you.'; end if;
  if not public.ai_feature_ready('chance') then
    raise exception 'No AI is on for this right now (Settings → AI: switch an AI on, check its key).';
  end if;
  if coalesce(array_length(p_leads, 1), 0) > 50 then raise exception 'Mark at most 50 leads for AI at a time.'; end if;
  if not public.has_permission('settings.manage')
     and (select count(*) from public.lead_chances where requested_by = auth.uid()
            and (manual or last_kind = 'manual')
            and requested_at > now() - interval '1 hour') + coalesce(array_length(p_leads, 1), 0) > 100 then
    raise exception 'Too many AI checks this hour. Please wait a little.';
  end if;

  -- the open leads they can see
  select array_agg(l.id) into v_ids
  from public.leads l
  join public.pipeline_stages s on s.id = l.stage_id and s.kind = 'open'
  where l.id = any (p_leads) and l.deleted_at is null and public.can_view_lead(l.assigned_to);

  -- looked at today, nothing new since
  select count(*) into v_fresh
  from public.lead_chances c
  where c.lead_id = any (coalesce(v_ids, '{}')) and c.chance is not null and c.status = 'done'
    and (c.done_at at time zone 'Asia/Dhaka')::date = v_today and not public.ai_chance_changed(c.lead_id, c.done_at);
  if not p_force then
    select array_agg(x) into v_ids
    from unnest(coalesce(v_ids, '{}')) x
    where not exists (select 1 from public.lead_chances c
                      where c.lead_id = x and c.chance is not null and c.status = 'done'
                        and (c.done_at at time zone 'Asia/Dhaka')::date = v_today
                        and not public.ai_chance_changed(c.lead_id, c.done_at));
  end if;

  v_n := public.ai_chance_mark(coalesce(v_ids, '{}'), true);
  return jsonb_build_object('queued', v_n, 'fresh_today', v_fresh,
                            'skipped', coalesce(array_length(p_leads, 1), 0) - v_n);
end;
$$;
revoke all on function public.ai_chance_request_many(uuid[], boolean) from public, anon;
grant execute on function public.ai_chance_request_many(uuid[], boolean) to authenticated;

-- ---------------------------------------------------------------------
-- 👀 Reading: the shown answer + every AI's answer
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.lead_ai_chance(p_lead uuid)
 RETURNS jsonb
 LANGUAGE sql
 STABLE
 SET search_path TO 'public'
AS $$
  select case
    when not public.ai_chance_can_view() then null
    when not exists (select 1 from public.leads l where l.id = p_lead) then null
    else coalesce((
      select jsonb_build_object(
        'status', c.status, 'due_at', c.due_at, 'manual', c.manual,
        'chance', c.chance, 'level', c.level, 'prev_chance', c.prev_chance,
        'summary', c.summary, 'good', c.good, 'risks', c.risks, 'objections', c.objections,
        'actions', c.actions, 'script', c.script, 'best_time', c.best_time,
        'next_call_days', c.next_call_days, 'next_call_why', c.next_call_why,
        'done_at', c.done_at, 'error', c.error, 'provider', c.provider,
        -- 🗂 every AI's latest answer (Claude's stays when Gemini answers, and the other way round)
        'answers', coalesce((select jsonb_agg(jsonb_build_object(
                     'provider', a.provider, 'chance', a.chance, 'level', a.level, 'summary', a.summary,
                     'good', a.good, 'risks', a.risks, 'objections', a.objections, 'actions', a.actions,
                     'script', a.script, 'best_time', a.best_time, 'next_call_days', a.next_call_days,
                     'next_call_why', a.next_call_why, 'done_at', a.done_at) order by a.done_at desc)
                   from public.lead_chance_answers a where a.lead_id = p_lead), '[]'::jsonb),
        -- looked at today and nothing new since (the app warns before asking again)
        'fresh_today', c.chance is not null
                       and (c.done_at at time zone 'Asia/Dhaka')::date = (now() at time zone 'Asia/Dhaka')::date
                       and not exists (
                         select 1 from public.leads l
                         left join public.lead_last ll on ll.lead_id = l.id
                         where l.id = p_lead
                           and greatest(l.last_contacted_at, ll.call_at, ll.note_at) > c.done_at))
      from public.lead_chances c where c.lead_id = p_lead), jsonb_build_object('status', 'none'))
  end;
$$;
revoke all on function public.lead_ai_chance(uuid) from public, anon;
grant execute on function public.lead_ai_chance(uuid) to authenticated;

CREATE OR REPLACE FUNCTION public.lead_admission_credit(p_lead uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $$
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
    'model', ac.model,
    'provider', ac.provider,
    -- 🗂 every AI's latest answer
    'answers', coalesce((select jsonb_agg(jsonb_build_object(
                 'provider', a.provider, 'decisive', a.decisive, 'confidence', a.confidence, 'done_at', a.done_at,
                 'shares', coalesce((select jsonb_agg(s || jsonb_build_object('name', p.full_name)
                                                      order by (s ->> 'share')::numeric desc)
                                     from jsonb_array_elements(a.shares) s
                                     left join public.profiles p on p.id::text = s ->> 'user_id'), '[]'::jsonb))
                 order by a.done_at desc)
               from public.admission_credit_answers a where a.lead_id = p_lead), '[]'::jsonb));
end;
$$;
revoke all on function public.lead_admission_credit(uuid) from public, anon;
grant execute on function public.lead_admission_credit(uuid) to authenticated;

-- ---------------------------------------------------------------------
-- 📊 Settings → AI: each AI's numbers (admins)
-- ---------------------------------------------------------------------
create or replace function public.ai_provider_stats()
returns jsonb
language plpgsql
stable
security definer
set search_path = public
set jit = off
as $$
declare
  v_today date := (now() at time zone 'Asia/Dhaka')::date;
  v_month date := date_trunc('month', now() at time zone 'Asia/Dhaka')::date;
begin
  if not public.has_permission('settings.manage') then raise exception 'Only an admin can see this.'; end if;
  return jsonb_build_object(
    'ready', jsonb_build_object('claude', public.ai_provider_ready('claude'), 'gemini', public.ai_provider_ready('gemini')),
    'plan', jsonb_build_object('chance', public.ai_feature_plan('chance'), 'credit', public.ai_feature_plan('credit')),
    'providers', (
      select jsonb_object_agg(p, jsonb_build_object(
        'chance_answers', (select count(*) from public.lead_chance_answers a where a.provider = p),
        'credit_answers', (select count(*) from public.admission_credit_answers a where a.provider = p),
        'runs_today', (select coalesce(sum(runs), 0) from public.ai_usage_daily u
                       where u.day = v_today and (case when p = 'gemini' then u.feature like 'gemini:%'
                                                       else u.feature not like 'gemini:%' end)),
        'runs_month', (select coalesce(sum(runs), 0) from public.ai_usage_daily u
                       where u.day >= v_month and (case when p = 'gemini' then u.feature like 'gemini:%'
                                                        else u.feature not like 'gemini:%' end)),
        -- how right: of the leads closed since, how many were admitted, by that AI's last level
        'accuracy', coalesce((select jsonb_object_agg(level, jsonb_build_object('admitted', ad, 'lost', lo))
                              from (select a.level,
                                           count(*) filter (where s.kind = 'won') as ad,
                                           count(*) filter (where s.kind = 'lost') as lo
                                    from public.lead_chance_answers a
                                    join public.leads l on l.id = a.lead_id and l.deleted_at is null
                                    join public.pipeline_stages s on s.id = l.stage_id and s.kind in ('won', 'lost')
                                    where a.provider = p and a.level is not null
                                    group by a.level) x), '{}'::jsonb)))
      from unnest(array['claude', 'gemini']) p));
end;
$$;
revoke all on function public.ai_provider_stats() from public, anon;
grant execute on function public.ai_provider_stats() to authenticated;

-- How a claimed look was asked ('manual' = "Check": may use Claude past the budget)
create or replace function public.ai_chance_kind(p_lead uuid)
returns text
language sql
stable
security definer
set search_path = public
as $$
  select last_kind from public.lead_chances where lead_id = p_lead;
$$;
revoke all on function public.ai_chance_kind(uuid) from public, anon, authenticated;
grant execute on function public.ai_chance_kind(uuid) to service_role;
