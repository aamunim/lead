-- =====================================================================
-- 🤖 Gemini: see why it did not answer
--   · every AI problem is remembered (ai_secrets.last_problem): Settings
--     → AI shows the last one for Claude and for Gemini, even when the
--     other AI answered in its place (compare / Gemini then Claude)
--   · a note on the lead when one of two AIs could not answer (admins)
-- =====================================================================

alter table public.ai_secrets add column if not exists last_problem text;
alter table public.ai_secrets add column if not exists last_problem_at timestamptz;
alter table public.lead_chances add column if not exists side_note text;
alter table public.admission_credits add column if not exists side_note text;

-- The server notes a problem with one AI ('claude' | 'gemini')
create or replace function public.ai_provider_problem(p_provider text, p_error text)
returns void
language sql
security definer
set search_path = public
as $$
  update public.ai_secrets
     set last_problem = left(p_error, 500), last_problem_at = now()
   where name = case p_provider when 'gemini' then 'gemini' else 'anthropic' end;
$$;
revoke all on function public.ai_provider_problem(text, text) from public, anon, authenticated;
grant execute on function public.ai_provider_problem(text, text) to service_role;

-- The server's note on a lead: the other AI could not answer (null: all went well)
create or replace function public.ai_side_note(p_feature text, p_lead uuid, p_error text)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if p_feature = 'credit' then
    update public.admission_credits set side_note = left(p_error, 500) where lead_id = p_lead;
  else
    update public.lead_chances set side_note = left(p_error, 500) where lead_id = p_lead;
  end if;
end;
$$;
revoke all on function public.ai_side_note(text, uuid, text) from public, anon, authenticated;
grant execute on function public.ai_side_note(text, uuid, text) to service_role;

-- Settings → AI: the keys, with the last problem
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
    'last_problem', k.last_problem,
    'last_problem_at', k.last_problem_at,
    'server_ready', exists (select 1 from public.ai_secrets where name = 'functions_url'));
end;
$$;
revoke all on function public.ai_key_status() from public, anon;
grant execute on function public.ai_key_status() to authenticated;

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
    'last_problem', k.last_problem,
    'last_problem_at', k.last_problem_at,
    'paused_until', case when k.paused_until > now() then k.paused_until end);
end;
$$;
revoke all on function public.gemini_key_status() from public, anon;
grant execute on function public.gemini_key_status() to authenticated;

-- The lead page: + the note when one AI could not answer (admins)
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
        -- the other AI could not answer this time (admins)
        'side_note', case when public.has_permission('settings.manage') then c.side_note end,
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
    'side_note', case when public.has_permission('settings.manage') then ac.side_note end,
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
