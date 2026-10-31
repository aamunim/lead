-- =====================================================================
-- 📞 Calls before the lead was saved: two fixes (20261125060000)
--   1. Editing a lead to add / change its phone or other phone didn't
--      bring the waiting calls: the trigger listened to phone_hash, which
--      the app never sets itself (the database fills it in). It now
--      listens to phone / alt_phone.
--   2. A call synced only after its lead was saved (e.g. by someone else,
--      so the caller can't see it) stayed waiting. Now, when a waiting call
--      is kept and a lead with that number was saved (or changed) after
--      the call, it goes to that lead at once.
--   3. Calls already waiting that match such a lead are moved now.
-- =====================================================================

-- 1. Phone / other phone added or changed
drop trigger if exists leads_claim_held_calls on public.leads;
create trigger leads_claim_held_calls
  after insert or update of phone, alt_phone on public.leads
  for each row execute function public.leads_claim_held_calls();

-- 2. Kept a call: a lead with this number saved after it? Give it the call now.
create or replace function public.hold_call(
  p_device_id text, p_call_id text, p_hash text, p_direction text, p_duration int, p_at timestamptz, p_sim text
)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_cfg  jsonb := public.call_sync_setting();
  v_lead uuid;
begin
  if auth.uid() is null or p_hash is null or p_call_id is null or p_at is null then return; end if;
  if not coalesce((v_cfg->>'hold_calls')::boolean, true) then return; end if;
  if p_at < now() - make_interval(days => greatest(coalesce((v_cfg->>'hold_days')::int, 15), 1)) then return; end if;

  insert into public.held_calls (user_id, device_id, device_call_id, phone_hash, direction, duration_sec, called_at, sim_label)
  values (auth.uid(), p_device_id, p_call_id, p_hash, coalesce(p_direction, 'outgoing'), greatest(coalesce(p_duration, 0), 0), p_at, p_sim)
  on conflict (user_id, device_id, device_call_id) do nothing;

  select l.id into v_lead
  from public.leads l
  where (l.phone_hash = p_hash or l.alt_phone_hash = p_hash)
    and l.deleted_at is null
    and l.created_at > p_at
  order by l.created_at desc
  limit 1;

  if v_lead is not null then
    perform public.claim_held_calls(v_lead);
  end if;
end;
$$;

-- 3. Waiting calls whose lead was saved or changed after the call
do $$
declare
  v_lead uuid;
begin
  for v_lead in
    select distinct on (h.id) l.id
    from public.held_calls h
    join public.leads l
      on (l.phone_hash = h.phone_hash or l.alt_phone_hash = h.phone_hash)
     and l.deleted_at is null
     and (l.created_at > h.called_at or l.updated_at > h.called_at)
    order by h.id, l.created_at desc
  loop
    perform public.claim_held_calls(v_lead);
  end loop;
end;
$$;

notify pgrst, 'reload schema';
