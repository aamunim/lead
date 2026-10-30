-- =====================================================================
-- 📞 Popup call: replace ANY earlier copy of the same phone call
--   20261117060000 only replaced a copy saved by the automatic sync.
--   The same phone call can also be saved earlier by the app itself
--   (the "add a note" notification, a second popup, or the sync linking
--   it to a call typed by hand), and the popup then still hit
--   "duplicate key … call_logs_device_call_unique".
--   Now any earlier copy is replaced: its note is kept (joined with the
--   new note), the new result wins, its timeline line and its count in
--   the call attempts are taken out. Uploads by the sync itself still
--   just skip a call that is already there.
-- =====================================================================

create or replace function public.replace_synced_call()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_old  public.call_logs;
  v_kind text;
begin
  if new.device_call_id is null or new.device_id is null or new.source = 'phone' then
    return new;
  end if;

  select * into v_old from public.call_logs
   where user_id = new.user_id and device_id = new.device_id and device_call_id = new.device_call_id;
  if v_old.id is null then
    return new;
  end if;

  -- Undo the old copy's count in the call attempts (the new entry counts itself)
  select s.kind into v_kind
  from public.leads l join public.pipeline_stages s on s.id = l.stage_id
  where l.id = v_old.lead_id;
  if coalesce(v_kind, 'open') = 'open' and v_old.direction = 'outgoing'
     and v_old.outcome in ('no_answer', 'busy', 'switched_off') then
    update public.leads set call_attempts = greatest(call_attempts - 1, 0) where id = v_old.lead_id;
  end if;

  -- Keep the old note too
  new.notes := case
                 when nullif(trim(coalesce(v_old.notes, '')), '') is null then new.notes
                 when nullif(trim(coalesce(new.notes, '')), '') is null or new.notes = v_old.notes then v_old.notes
                 else v_old.notes || E'\n' || new.notes
               end;
  new.duration_sec := coalesce(new.duration_sec, v_old.duration_sec);
  new.sim_label    := coalesce(new.sim_label, v_old.sim_label);
  new.called_at    := coalesce(new.called_at, v_old.called_at);

  -- Things that pointed at the old copy point at nothing (follow-ups keep working)
  delete from public.lead_activity
   where lead_id = v_old.lead_id and action = 'call_logged' and details ->> 'call_id' = v_old.id::text;
  delete from public.call_logs where id = v_old.id;

  return new;
end;
$$;

drop trigger if exists call_logs_replace_synced on public.call_logs;
create trigger call_logs_replace_synced
  before insert on public.call_logs
  for each row execute function public.replace_synced_call();

notify pgrst, 'reload schema';
