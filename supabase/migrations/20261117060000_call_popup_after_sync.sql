-- =====================================================================
-- 📞 The popup's call after the automatic sync, for every app version
--   An app that saves the popup's call with a plain insert (every build
--   installed before 2.4.11) still hit "duplicate key … call_logs_device_call_unique"
--   when the automatic sync had uploaded the same call first. That
--   happens most with short / unanswered calls, which sync at once.
--   Now, before the popup's call is saved, the automatically synced copy
--   of the same phone call is taken out (with its timeline line and its
--   count in the call attempts), so the person's own entry — their
--   result and note — is the one kept. Nothing changes for the app's
--   newer save_phone_call().
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
  if v_old.id is null or v_old.source <> 'phone' then
    return new;   -- nothing there, or a copy someone saved by hand: the unique rule decides
  end if;

  -- Undo the synced copy's count in the call attempts (the new entry counts itself)
  select s.kind into v_kind
  from public.leads l join public.pipeline_stages s on s.id = l.stage_id
  where l.id = v_old.lead_id;
  if coalesce(v_kind, 'open') = 'open' and v_old.direction = 'outgoing'
     and v_old.outcome in ('no_answer', 'busy', 'switched_off') then
    update public.leads set call_attempts = greatest(call_attempts - 1, 0) where id = v_old.lead_id;
  end if;

  delete from public.lead_activity
   where lead_id = v_old.lead_id and action = 'call_logged' and details ->> 'call_id' = v_old.id::text;
  delete from public.call_logs where id = v_old.id;

  -- Keep the phone's details from the synced copy when the popup didn't have them
  new.duration_sec := coalesce(new.duration_sec, v_old.duration_sec);
  new.sim_label    := coalesce(new.sim_label, v_old.sim_label);
  new.called_at    := coalesce(new.called_at, v_old.called_at);
  return new;
end;
$$;

drop trigger if exists call_logs_replace_synced on public.call_logs;
create trigger call_logs_replace_synced
  before insert on public.call_logs
  for each row execute function public.replace_synced_call();

notify pgrst, 'reload schema';
