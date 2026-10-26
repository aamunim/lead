-- =====================================================================
-- Add a note to one or many leads (Leads list → long press → Note)
--   - The note is added BELOW the lead's existing notes, never replacing them:
--       26 Oct 2026 · Rahim: Asked for the fee list
--   - Each lead gets a "Note added" line in its timeline
--   - Only leads the user can edit are changed (normal lead rules)
-- =====================================================================

-- ---------------------------------------------------------------------
-- 1. Timeline line, written when add_lead_note() changes the notes
--    (editing the notes on the lead edit screen does not add a line)
-- ---------------------------------------------------------------------
create or replace function public.log_lead_note()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_note text := coalesce(current_setting('app.note_added', true), '');
begin
  if v_note <> '' and new.notes is distinct from old.notes then
    insert into public.lead_activity (lead_id, user_id, action, details)
    values (new.id, auth.uid(), 'note_added', jsonb_build_object('note', v_note));
  end if;
  return null;
end;
$$;

create trigger leads_log_note
  after update of notes on public.leads
  for each row execute function public.log_lead_note();

-- ---------------------------------------------------------------------
-- 2. Add the note
--    Returns how many leads got it (leads the user can't edit are skipped)
-- ---------------------------------------------------------------------
create or replace function public.add_lead_note(
  p_lead_ids uuid[],
  p_note     text
)
returns int
language plpgsql
security invoker
set search_path = public
as $$
declare
  v_note text := trim(coalesce(p_note, ''));
  v_line text;
  v_rows int;
begin
  if not public.is_active_user() then raise exception 'Your account is not active.'; end if;
  if v_note = '' then raise exception 'Please write a note.'; end if;
  if length(v_note) > 2000 then raise exception 'The note is too long (2000 letters at most).'; end if;

  v_line := concat(
    to_char(now() at time zone 'Asia/Dhaka', 'DD Mon YYYY'),
    ' · ',
    coalesce((select nullif(trim(full_name), '') from public.profiles where id = auth.uid()), 'Someone'),
    ': ',
    v_note
  );

  perform set_config('app.note_added', v_note, true);

  update public.leads
     set notes = concat_ws(E'\n\n', nullif(trim(notes), ''), v_line)
   where id = any (coalesce(p_lead_ids, '{}'::uuid[]))
     and deleted_at is null;
  get diagnostics v_rows = row_count;

  perform set_config('app.note_added', '', true);

  return v_rows;
end;
$$;

grant execute on function public.add_lead_note(uuid[], text) to authenticated;
