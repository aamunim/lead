-- =====================================================================
-- 📞 Saving a call from the app popup when the automatic sync got there first
--   After a call, the popup saves the call with the phone's call id. If the
--   automatic call sync had already uploaded that same call, the insert hit
--   "duplicate key value violates unique constraint call_logs_device_call_unique".
--   save_phone_call(): insert; if the call is already there, put the
--   person's result and note on the saved call instead.
-- =====================================================================

create or replace function public.save_phone_call(
  p_lead_id        uuid,
  p_outcome        text,
  p_notes          text,
  p_duration_sec   integer,
  p_called_at      timestamptz,
  p_direction      text,
  p_device_id      text,
  p_device_call_id text,
  p_sim_label      text default null
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_id    uuid;
  v_old   public.call_logs;
  v_notes text := nullif(trim(coalesce(p_notes, '')), '');
begin
  if not public.is_active_user() then raise exception 'Your account is not active.'; end if;
  if not public.fee_can_see_lead(p_lead_id) then raise exception 'Lead not found.'; end if;
  if p_device_id is null or p_device_call_id is null then raise exception 'Missing the phone''s call id.'; end if;

  insert into public.call_logs (
    lead_id, user_id, called_at, outcome, duration_sec, notes,
    direction, source, device_id, device_call_id, sim_label, phone_verified
  )
  values (
    p_lead_id, auth.uid(), coalesce(p_called_at, now()), p_outcome, p_duration_sec, v_notes,
    coalesce(p_direction, 'outgoing'), 'app', p_device_id, p_device_call_id, p_sim_label, true
  )
  on conflict (user_id, device_id, device_call_id) where device_call_id is not null do nothing
  returning id into v_id;

  if v_id is not null then return v_id; end if;

  -- Already saved by the automatic sync: the person's result and note win
  select * into v_old from public.call_logs
   where user_id = auth.uid() and device_id = p_device_id and device_call_id = p_device_call_id;

  perform set_config('app.call_admin', 'on', true);
  update public.call_logs
     set outcome = p_outcome,
         notes = case
                   when v_notes is null then notes
                   when notes is null or notes = v_notes then v_notes
                   else notes || E'\n' || v_notes
                 end
   where id = v_old.id;
  perform set_config('app.call_admin', '', true);

  -- The timeline line shows the chosen result too
  if v_old.outcome is distinct from p_outcome then
    update public.lead_activity
       set details = details || jsonb_build_object('outcome', p_outcome)
     where lead_id = v_old.lead_id and action = 'call_logged' and details ->> 'call_id' = v_old.id::text;
  end if;

  return v_old.id;
end;
$$;

grant execute on function public.save_phone_call(uuid, text, text, integer, timestamptz, text, text, text, text) to authenticated;

notify pgrst, 'reload schema';
