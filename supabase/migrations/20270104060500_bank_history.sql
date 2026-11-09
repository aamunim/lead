-- =====================================================================
-- 👁 Lead Bank: a returned number's old lead, seen from the bank screen
--   (admins): what it was, every call, every timeline line, in one request.
--   Nothing else changes; safe to run again.
-- =====================================================================

-- ---------------------------------------------------------------------
-- 👁 A returned number's old lead, from the bank screen (admins): what it
--   was, every call and every timeline line (one request)
-- ---------------------------------------------------------------------
create or replace function public.bank_history(p_bank_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
set jit = off
as $$
declare
  v_lead uuid;
begin
  if not public.bank_can() then raise exception 'Only an admin can do this.'; end if;
  select lead_id into v_lead from public.lead_bank where id = p_bank_id;
  if v_lead is null then
    return jsonb_build_object('lead', null, 'calls', '[]'::jsonb, 'activity', '[]'::jsonb,
                              'stages', '{}'::jsonb, 'people', '{}'::jsonb);
  end if;
  return jsonb_build_object(
    'lead', (
      select jsonb_build_object(
        'id', l.id, 'name', l.name, 'phone', l.phone, 'rating', l.rating,
        'stage', s.name, 'stage_kind', s.kind, 'owner', p.full_name, 'source', src.name,
        'created_at', l.created_at, 'lost_reason', lr.name, 'lost_note', l.lost_note,
        'hidden', l.deleted_at is not null,
        'courses', (select string_agg(c.name, ', ' order by c.name)
                      from public.lead_courses lc join public.courses c on c.id = lc.course_id
                     where lc.lead_id = l.id))
      from public.leads l
      left join public.pipeline_stages s on s.id = l.stage_id
      left join public.profiles p on p.id = l.assigned_to
      left join public.lead_sources src on src.id = l.source_id
      left join public.lost_reasons lr on lr.id = l.lost_reason_id
      where l.id = v_lead),
    'calls', coalesce((
      select jsonb_agg(x order by x.called_at desc) from (
        select cl.id, cl.called_at, cl.outcome, cl.duration_sec, cl.notes, cl.direction, cl.channel, cl.media,
               p.full_name as by
        from public.call_logs cl
        left join public.profiles p on p.id = cl.user_id
        where cl.lead_id = v_lead and cl.deleted_at is null
        order by cl.called_at desc
        limit 200) x), '[]'::jsonb),
    'activity', coalesce((
      select jsonb_agg(x order by x.created_at desc) from (
        select a.id, a.created_at, a.action, a.details, p.full_name as by
        from public.lead_activity a
        left join public.profiles p on p.id = a.user_id
        -- calls come from the calls themselves
        where a.lead_id = v_lead and a.action <> 'call_logged'
        order by a.created_at desc
        limit 300) x), '[]'::jsonb),
    'stages', (select jsonb_object_agg(id, jsonb_build_object('name', name, 'kind', kind)) from public.pipeline_stages),
    -- names for "assigned to …" lines
    'people', coalesce((select jsonb_object_agg(id, coalesce(full_name, 'No name')) from public.profiles), '{}'::jsonb)
  );
end;
$$;
revoke all on function public.bank_history(uuid) from public, anon;
grant execute on function public.bank_history(uuid) to authenticated;

notify pgrst, 'reload schema';
