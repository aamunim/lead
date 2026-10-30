-- =====================================================================
-- 📝 Template report
--   template_report(from, to, user) → one jsonb:
--     totals     sent (WhatsApp / SMS), leads, edited before sending,
--                and what happened in the 7 days after a send:
--                replied (answered call / message from the lead),
--                moved (stage changed), admitted
--     templates  the same per template, most sent first
--     people     who sent how many, and their most used template
--     unused     templates in use that nobody sent in this period
--   Same "who may see whom" as the WhatsApp report.
-- =====================================================================

create or replace function public.template_report(p_from date, p_to date, p_user_id uuid default null)
returns jsonb
language sql
stable
security definer
set search_path = public
as $$
  with s as (
    select c.id, c.lead_id, c.user_id, c.channel, c.called_at, c.template_id,
           (c.notes like '%(edited)') as edited
    from public.call_logs c
    join public.profiles p on p.id = c.user_id
    join public.leads l on l.id = c.lead_id and l.deleted_at is null
    where public.is_active_user()
      and c.template_id is not null
      and c.deleted_at is null
      and (c.called_at at time zone 'Asia/Dhaka')::date between p_from and p_to
      and (p_user_id is null or c.user_id = p_user_id)
      and (
        public.has_permission('settings.manage')
        or public.has_permission('leads.view_all')
        or c.user_id = auth.uid()
        or (public.has_permission('leads.view_team') and p.team_lead_id = auth.uid())
      )
  ),
  -- What happened in the 7 days after each send
  r as (
    select s.*,
      exists (
        select 1 from public.call_logs x
        where x.lead_id = s.lead_id and x.deleted_at is null
          and x.called_at > s.called_at and x.called_at <= s.called_at + interval '7 days'
          and (x.outcome = 'connected' or (x.outcome = 'message' and x.direction = 'incoming'))
      ) as replied,
      exists (
        select 1 from public.lead_stage_history h
        where h.lead_id = s.lead_id
          and h.changed_at > s.called_at and h.changed_at <= s.called_at + interval '7 days'
      ) as moved,
      exists (
        select 1 from public.leads l
        where l.id = s.lead_id and l.admitted_at is not null
          and l.admitted_at > s.called_at and l.admitted_at <= s.called_at + interval '7 days'
      ) as admitted
    from s
  ),
  totals as (
    select count(*)                                          as sent,
           count(*) filter (where channel = 'whatsapp')      as whatsapp,
           count(*) filter (where channel = 'sms')           as sms,
           count(*) filter (where edited)                    as edited,
           count(distinct lead_id)                           as leads,
           count(distinct lead_id) filter (where replied)    as replied,
           count(distinct lead_id) filter (where moved)      as moved,
           count(distinct lead_id) filter (where admitted)   as admitted
    from r
  ),
  per_template as (
    select r.template_id as id, t.name, t.is_shared,
           count(*)                                            as sent,
           count(*) filter (where r.channel = 'whatsapp')      as whatsapp,
           count(*) filter (where r.channel = 'sms')           as sms,
           count(*) filter (where r.edited)                    as edited,
           count(distinct r.lead_id)                           as leads,
           count(distinct r.lead_id) filter (where r.replied)  as replied,
           count(distinct r.lead_id) filter (where r.moved)    as moved,
           count(distinct r.lead_id) filter (where r.admitted) as admitted,
           max(r.called_at)                                    as last_sent
    from r
    join public.message_templates t on t.id = r.template_id
    group by r.template_id, t.name, t.is_shared
  ),
  per_person as (
    select r.user_id, p.full_name,
           count(*)                                       as sent,
           count(*) filter (where r.channel = 'whatsapp') as whatsapp,
           count(*) filter (where r.channel = 'sms')      as sms,
           count(distinct r.lead_id)                      as leads,
           (select t.name from r r2 join public.message_templates t on t.id = r2.template_id
             where r2.user_id = r.user_id
             group by t.name order by count(*) desc, t.name limit 1) as top_template
    from r
    left join public.profiles p on p.id = r.user_id
    group by r.user_id, p.full_name
  ),
  unused as (
    select t.name
    from public.message_templates t
    where t.is_active and t.is_shared
      and not exists (select 1 from s where s.template_id = t.id)
    order by t.sort_order, t.name
  )
  select jsonb_build_object(
    'totals',    (select to_jsonb(x) from totals x),
    'templates', coalesce((select jsonb_agg(to_jsonb(x) order by x.sent desc, x.name) from per_template x), '[]'::jsonb),
    'people',    coalesce((select jsonb_agg(to_jsonb(x) order by x.sent desc) from per_person x), '[]'::jsonb),
    -- only when looking at everyone (one person not sending a template means little)
    'unused',    case when p_user_id is null
                      then coalesce((select jsonb_agg(x.name) from unused x), '[]'::jsonb)
                      else '[]'::jsonb end
  );
$$;

grant execute on function public.template_report(date, date, uuid) to authenticated;

create index if not exists call_logs_template_idx on public.call_logs (template_id, called_at) where template_id is not null;

notify pgrst, 'reload schema';
