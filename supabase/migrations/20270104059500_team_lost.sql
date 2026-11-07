-- =====================================================================
-- ❌ Team activity → who marked how many leads Lost (with the note)
--   From the stage history: every move into a Lost stage, by whom, when,
--   and its note ("Lost: <reason> · <note>"), even if the lead was opened
--   again later (still_lost tells).
--   Runs as the viewer: only leads they may see, only people whose
--   activity they may see (Settings → Team activity).
--   (Dated before 20270104060000_lead_merge so both can go in any order.)
-- =====================================================================

create or replace function public.team_lost(p_from date, p_to date, p_limit int default 300)
returns jsonb
language sql
stable
security invoker
set search_path = public
as $$
  -- ⚡ whose activity I may see: asked once per person, not once per row
  with people as materialized (
    select p.id from public.profiles p where public.can_see_activity(p.id)
  ),
  lost as materialized (
    select h.lead_id, h.changed_by, h.changed_at, h.note
    from public.lead_stage_history h
    join public.pipeline_stages s on s.id = h.to_stage_id and s.kind = 'lost'
    join people pp on pp.id = h.changed_by
    where h.changed_at >= (p_from::timestamp at time zone 'Asia/Dhaka')
      and h.changed_at <  ((p_to + 1)::timestamp at time zone 'Asia/Dhaka')
  )
  select jsonb_build_object(
    'total', (select count(*) from lost),
    'people', coalesce((
      select jsonb_agg(jsonb_build_object('user_id', x.changed_by, 'name', p.full_name, 'count', x.n)
                       order by x.n desc, p.full_name)
      from (select changed_by, count(*)::int as n from lost group by changed_by) x
      left join public.profiles p on p.id = x.changed_by), '[]'::jsonb),
    'items', coalesce((
      select jsonb_agg(i order by i.at desc)
      from (
        select lo.lead_id, l.name as lead_name, l.phone, lo.changed_at as at,
               lo.changed_by as user_id, p.full_name as user_name, lo.note,
               (cs.kind = 'lost') as still_lost
        from lost lo
        join public.leads l on l.id = lo.lead_id
        left join public.pipeline_stages cs on cs.id = l.stage_id
        left join public.profiles p on p.id = lo.changed_by
        order by lo.changed_at desc
        limit greatest(1, least(coalesce(p_limit, 300), 1000))
      ) i), '[]'::jsonb)
  );
$$;

revoke all on function public.team_lost(date, date, int) from public, anon;
grant execute on function public.team_lost(date, date, int) to authenticated;
