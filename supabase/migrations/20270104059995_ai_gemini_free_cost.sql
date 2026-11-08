-- =====================================================================
-- 💵 Costs: Gemini is free
--   · "Run a group": when the chance uses Gemini first (Gemini / Gemini
--     then Claude) the cost shown is $0 ("free"), not Claude's price
--   · "Used so far": Claude's answers only (Gemini's tokens cost nothing)
-- =====================================================================

create or replace function public.ai_chance_counts(p_older_days int default 15)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
set jit = off
as $$
declare
  v_today date := (now() at time zone 'Asia/Dhaka')::date;
  v_out   jsonb;
  v_plan  jsonb := public.ai_feature_plan('chance');
  v_free  boolean;
begin
  if not public.has_permission('settings.manage') then raise exception 'Only an admin can see this.'; end if;
  v_free := jsonb_array_length(v_plan -> 'providers') > 0
            and (v_plan -> 'providers' ->> 0) = 'gemini'
            and (v_plan ->> 'mode') <> 'compare';
  with o as (
    select l.id, c.status, c.chance, c.done_at, c.manual, c.bulk, c.due_at,
           (c.chance is not null and public.ai_chance_changed(l.id, c.done_at)) as changed
    from public.leads l
    join public.pipeline_stages s on s.id = l.stage_id and s.kind = 'open'
    left join public.lead_chances c on c.lead_id = l.id
    where l.deleted_at is null
  ), u as (
    select coalesce(sum(runs), 0) as runs, coalesce(sum(public.ai_cost_usd(input_tokens, output_tokens)), 0) as cost
    from public.ai_usage_daily where feature = 'chance'
  )
  select jsonb_build_object(
    'open', (select count(*) from o),
    'never', (select count(*) from o where chance is null and coalesce(status, '') not in ('pending', 'working')),
    'changed', (select count(*) from o where changed and status not in ('pending', 'working')),
    'older', (select count(*) from o where chance is not null and status not in ('pending', 'working')
                and done_at < now() - make_interval(days => greatest(1, coalesce(p_older_days, 15)))),
    'today', (select count(*) from o where chance is not null and status not in ('pending', 'working')
                and (done_at at time zone 'Asia/Dhaka')::date = v_today),
    'today_changed', (select count(*) from o where changed and status not in ('pending', 'working')
                and (done_at at time zone 'Asia/Dhaka')::date = v_today),
    'waiting_now', (select count(*) from public.lead_chances where status = 'pending' and due_at <= now()),
    'waiting_later', (select count(*) from public.lead_chances where status = 'pending' and due_at > now()),
    'working', (select count(*) from public.lead_chances where status = 'working'),
    'done_today', (select count(*) from public.lead_chances where done_at is not null
                     and (done_at at time zone 'Asia/Dhaka')::date = v_today),
    'auto_today', (select count(*) from public.lead_chances where last_kind = 'auto' and done_at is not null
                     and (done_at at time zone 'Asia/Dhaka')::date = v_today),
    -- Gemini first (Gemini / Gemini then Claude): free; Claude only steps in when Gemini can't
    'free', v_free,
    'avg_cost', case when v_free then 0 else (select case when runs >= 5 then round(cost / runs, 4) else 0.03 end from u) end,
    'spent_month', public.ai_month_spent(),
    'budget_ok', public.ai_budget_ok(),
    'last_daily_run', (select last_day from public.ai_jobs where name = 'chance_daily'))
  into v_out;
  return v_out;
end;
$$;
revoke all on function public.ai_chance_counts(int) from public, anon;
grant execute on function public.ai_chance_counts(int) to authenticated;

create or replace function public.ai_chance_overview()
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_today date := (now() at time zone 'Asia/Dhaka')::date;
begin
  if not public.has_permission('settings.manage') then raise exception 'Only an admin can see this.'; end if;
  return jsonb_build_object(
    'pending', (select count(*) from public.lead_chances where status in ('pending', 'working')),
    'done', (select count(*) from public.lead_chances where chance is not null),
    'failed', (select count(*) from public.lead_chances where status = 'failed'),
    'today', (select count(*) from public.lead_chances where done_at is not null and (done_at at time zone 'Asia/Dhaka')::date = v_today),
    'open_without', (select count(*) from public.leads l join public.pipeline_stages s on s.id = l.stage_id and s.kind = 'open'
                     where l.deleted_at is null and not exists (select 1 from public.lead_chances c where c.lead_id = l.id)),
    'last_error', (select error from public.lead_chances where error is not null order by requested_at desc limit 1),
    'tokens_in', (select coalesce(sum((usage ->> 'input_tokens')::bigint), 0) from public.lead_chances where usage is not null and coalesce(provider, 'claude') = 'claude'),
    'tokens_out', (select coalesce(sum((usage ->> 'output_tokens')::bigint), 0) from public.lead_chances where usage is not null and coalesce(provider, 'claude') = 'claude'),
    -- how right: of the leads closed after a look, how many were admitted, by the last level
    'accuracy', coalesce((select jsonb_object_agg(level, jsonb_build_object('admitted', a, 'lost', n))
                          from (select level, count(*) filter (where stage_at_done = 'won') as a,
                                       count(*) filter (where stage_at_done = 'lost') as n
                                from public.lead_chances where level is not null and stage_at_done in ('won', 'lost')
                                group by level) x), '{}'::jsonb));
end;
$$;
revoke all on function public.ai_chance_overview() from public, anon;
grant execute on function public.ai_chance_overview() to authenticated;

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
    'tokens_in', (select coalesce(sum((usage ->> 'input_tokens')::bigint), 0) from public.admission_credits where usage is not null and coalesce(provider, 'claude') = 'claude'),
    'tokens_out', (select coalesce(sum((usage ->> 'output_tokens')::bigint), 0) from public.admission_credits where usage is not null and coalesce(provider, 'claude') = 'claude'));
end;
$$;
revoke all on function public.ai_credit_overview() from public, anon;
grant execute on function public.ai_credit_overview() to authenticated;
