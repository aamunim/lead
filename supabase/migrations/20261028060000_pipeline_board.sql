-- =====================================================================
-- Pipeline board (Leads → Board) and moving many leads with the stage rules
--   1. Board setting (Settings → Pipeline board)
--   2. bulk_move_lead_stage(): the quick menu's Stage for one or many leads,
--      through move_lead_stage() so every stage rule applies (note required,
--      ask for a date, next call N days later, stage history)
-- =====================================================================

-- ---------------------------------------------------------------------
-- 1. Setting
--    enabled        : Board view on the Leads tab
--    closed_columns : Admitted and Lost columns at the end of the board
--    who            : who can use the board (admins always can)
-- ---------------------------------------------------------------------
insert into public.app_settings (key, value)
values ('board', '{"enabled": true, "closed_columns": true, "who": {"mode": "all", "roles": [], "user_ids": []}}'::jsonb)
on conflict (key) do nothing;

-- ---------------------------------------------------------------------
-- 2. Move many leads to an open stage
--    Leads that can't be moved (closed, no permission…) are skipped.
--    Returns {"done": n, "skipped": n, "error": "first reason"}
-- ---------------------------------------------------------------------
create or replace function public.bulk_move_lead_stage(
  p_lead_ids uuid[],
  p_stage_id uuid,
  p_note     text default null,
  p_due_at   timestamptz default null
)
returns jsonb
language plpgsql
security invoker
set search_path = public
as $$
declare
  v_id      uuid;
  v_done    int := 0;
  v_skipped int := 0;
  v_error   text;
begin
  if not public.is_active_user() then raise exception 'Your account is not active.'; end if;

  foreach v_id in array coalesce(p_lead_ids, '{}'::uuid[])
  loop
    begin
      perform public.move_lead_stage(v_id, p_stage_id, p_note, p_due_at);
      v_done := v_done + 1;
    exception when others then
      v_skipped := v_skipped + 1;
      v_error := coalesce(v_error, sqlerrm);
    end;
  end loop;

  -- Nothing moved: show why (e.g. "A note is needed to move to …")
  if v_done = 0 and v_error is not null then
    raise exception '%', v_error;
  end if;

  return jsonb_build_object('done', v_done, 'skipped', v_skipped, 'error', v_error);
end;
$$;

grant execute on function public.bulk_move_lead_stage(uuid[], uuid, text, timestamptz) to authenticated;

notify pgrst, 'reload schema';
