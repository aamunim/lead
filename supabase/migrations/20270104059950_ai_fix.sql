-- =====================================================================
-- 🔧 AI chance: the lead card was empty for everyone
--   lead_ai_chance (runs as the person, so they only see leads they may)
--   called ai_chance_changed, which people may not call → "permission
--   denied" → the app showed nothing (lead page, quick view, the 🔮 sheet).
--   The "nothing new since" check is now inside it (the person's own
--   rights are enough: the lead and its last call / note).
--   (Dated before 20270104060000_lead_merge so both can go in any order.)
-- =====================================================================

create or replace function public.lead_ai_chance(p_lead uuid)
returns jsonb
language sql
stable
security invoker
set search_path = public
as $$
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
        'done_at', c.done_at, 'error', c.error,
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
