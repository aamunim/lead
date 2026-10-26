-- =====================================================================
-- Stage rules (Settings → Admission → Stage rules)
--   - "Note required when moving here"
--   - "Next call N days after moving here"
--   Moving a lead between open stages from the lead page goes through
--   move_lead_stage(), which checks both and records the note in the history.
-- =====================================================================

create or replace function public.move_lead_stage(
  p_lead_id  uuid,
  p_stage_id uuid,
  p_note     text default null
)
returns jsonb
language plpgsql
security invoker
set search_path = public
as $$
declare
  v_kind    text;
  v_current uuid;
  v_stage   record;
  v_note    text := nullif(trim(coalesce(p_note, '')), '');
  v_due     timestamptz;
  v_rows    int;
begin
  if not public.is_active_user() then raise exception 'Your account is not active.'; end if;

  select s.kind, l.stage_id into v_kind, v_current
  from public.leads l
  join public.pipeline_stages s on s.id = l.stage_id
  where l.id = p_lead_id and l.deleted_at is null;

  if v_kind is null then raise exception 'Lead not found.'; end if;
  if v_kind <> 'open' then raise exception 'This lead is closed. Reopen it first.'; end if;

  select id, name, kind, is_active, follow_up_days, note_required into v_stage
  from public.pipeline_stages where id = p_stage_id;

  if v_stage.id is null or not v_stage.is_active or v_stage.kind <> 'open' then
    raise exception 'Please choose a normal stage.';
  end if;
  if v_current = p_stage_id then
    return jsonb_build_object('follow_up_at', null);
  end if;
  if v_stage.note_required and v_note is null then
    raise exception 'A note is needed to move to "%".', v_stage.name;
  end if;

  perform set_config('app.stage_note', coalesce(v_note, ''), true);

  update public.leads set stage_id = p_stage_id where id = p_lead_id;
  get diagnostics v_rows = row_count;
  if v_rows = 0 then raise exception 'You can''t change this lead.'; end if;

  -- Next call N days later, at 10 am Bangladesh time
  if v_stage.follow_up_days is not null then
    v_due := ((date_trunc('day', now() at time zone 'Asia/Dhaka')
               + make_interval(days => v_stage.follow_up_days)
               + interval '10 hours') at time zone 'Asia/Dhaka');
    if v_due <= now() then
      v_due := now() + interval '1 hour';
    end if;
    perform public.schedule_follow_up(
      p_lead_id, v_due, coalesce(v_note, 'Moved to ' || v_stage.name)
    );
  end if;

  return jsonb_build_object('follow_up_at', v_due);
end;
$$;

grant execute on function public.move_lead_stage(uuid, uuid, text) to authenticated;

notify pgrst, 'reload schema';