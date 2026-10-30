-- =====================================================================
-- ⚡ Call log sync: find the lead by number fast
--   sync_phone_calls() looked up each call by hashing every lead's phone
--   (no index), so a phone with many waiting calls ran past the server's
--   time limit ("canceling statement due to statement timeout").
--   Now each lead keeps the hash of its phone / other phone (kept up to
--   date by the database) with an index, and the lookup uses it.
--   Which lead a call goes to is unchanged.
-- =====================================================================

alter table public.leads
  add column if not exists phone_hash     text,
  add column if not exists alt_phone_hash text;

create or replace function public.leads_phone_hashes()
returns trigger
language plpgsql
set search_path = public, extensions
as $$
begin
  new.phone_hash     := case when new.phone is null then null else encode(digest(new.phone, 'sha256'), 'hex') end;
  new.alt_phone_hash := case when new.alt_phone is null then null else encode(digest(new.alt_phone, 'sha256'), 'hex') end;
  return new;
end;
$$;

drop trigger if exists leads_phone_hashes on public.leads;
create trigger leads_phone_hashes
  before insert or update of phone, alt_phone on public.leads
  for each row execute function public.leads_phone_hashes();

-- The leads already there (without touching updated_at or the change log)
do $$
begin
  -- digest() lives in the "extensions" schema on Supabase
  perform set_config('search_path', 'public, extensions', true);
  alter table public.leads disable trigger user;
  update public.leads
     set phone_hash     = case when phone is null then null else encode(digest(phone, 'sha256'), 'hex') end,
         alt_phone_hash = case when alt_phone is null then null else encode(digest(alt_phone, 'sha256'), 'hex') end;
  alter table public.leads enable trigger user;
end;
$$;

create index if not exists leads_phone_hash_idx on public.leads (phone_hash) where phone_hash is not null;
create index if not exists leads_alt_phone_hash_idx on public.leads (alt_phone_hash) where alt_phone_hash is not null;

-- Same as before, but the lead is found through the index
create or replace function public.sync_phone_calls(p_device_id text, p_calls jsonb)
returns jsonb
language plpgsql
security invoker
set search_path = public, extensions
as $$
declare
  v_cfg      jsonb := public.call_sync_setting();
  v_min      int := coalesce((v_cfg->>'connected_min_sec')::int, 5);
  v_incoming boolean := coalesce((v_cfg->>'incoming')::boolean, true);
  v_call     jsonb;
  v_hash     text;
  v_lead     uuid;
  v_dir      text;
  v_dur      int;
  v_at       timestamptz;
  v_outcome  text;
  v_match    uuid;
  v_added    int := 0;
  v_matched  int := 0;
  v_ignored  int := 0;
begin
  if not public.can_sync_calls() then
    raise exception 'Call log sync is not turned on for you.';
  end if;

  for v_call in select * from jsonb_array_elements(coalesce(p_calls, '[]'::jsonb))
  loop
    v_dir  := coalesce(v_call->>'direction', 'outgoing');
    v_dur  := greatest(coalesce((v_call->>'duration_sec')::int, 0), 0);
    v_at   := (v_call->>'called_at')::timestamptz;
    v_hash := v_call->>'hash';

    -- Incoming / missed calls switched off in Settings
    if v_dir <> 'outgoing' and not v_incoming then
      v_ignored := v_ignored + 1;
      continue;
    end if;

    -- Already synced from this phone
    if exists (
      select 1 from public.call_logs
      where user_id = auth.uid() and device_id = p_device_id and device_call_id = v_call->>'id'
    ) then
      continue;
    end if;

    -- A lead this user can see, with this number (row security decides what "can see" means)
    select x.id into v_lead
    from (
      select l.id, l.created_at from public.leads l
      where l.phone_hash = v_hash and l.deleted_at is null
      union all
      select l.id, l.created_at from public.leads l
      where l.alt_phone_hash = v_hash and l.deleted_at is null
    ) x
    order by x.created_at desc
    limit 1;

    if v_lead is null then
      v_ignored := v_ignored + 1;   -- not a lead: nothing is stored
      continue;
    end if;

    -- A call saved from the app popup a few minutes around this time? Match it instead.
    select c.id into v_match
    from public.call_logs c
    where c.user_id = auth.uid()
      and c.lead_id = v_lead
      and c.device_call_id is null
      and c.called_at between v_at - interval '10 minutes' and v_at + interval '10 minutes'
    order by abs(extract(epoch from (c.called_at - v_at)))
    limit 1;

    if v_match is not null then
      update public.call_logs
         set device_id = p_device_id,
             device_call_id = v_call->>'id',
             duration_sec = v_dur,
             direction = v_dir,
             sim_label = v_call->>'sim',
             phone_verified = true
       where id = v_match;
      v_matched := v_matched + 1;
      continue;
    end if;

    v_outcome := case
      when v_dir = 'outgoing' then case when v_dur >= v_min then 'connected' else 'no_answer' end
      when v_dir = 'incoming' then case when v_dur > 0 then 'connected' else 'missed' end
      else v_dir   -- missed / rejected
    end;

    insert into public.call_logs (
      lead_id, user_id, called_at, outcome, duration_sec, notes,
      direction, source, device_id, device_call_id, sim_label, phone_verified
    )
    values (
      v_lead, auth.uid(), v_at, v_outcome, v_dur, null,
      v_dir, 'phone', p_device_id, v_call->>'id', v_call->>'sim', true
    )
    on conflict do nothing;

    v_added := v_added + 1;
  end loop;

  return jsonb_build_object('added', v_added, 'matched', v_matched, 'ignored', v_ignored);
end;
$$;

grant execute on function public.sync_phone_calls(text, jsonb) to authenticated;

notify pgrst, 'reload schema';
