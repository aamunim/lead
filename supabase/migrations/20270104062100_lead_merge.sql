-- =====================================================================
-- 🔗 Merge leads: one person, two (or more) numbers
--   * leads.extra_phones: more numbers on one lead (search, duplicate
--     check, caller card and call matching know them too)
--   * merge_leads(): everything moves to the main lead; the others are
--     hidden ("merged into …"); assignees get a notification
--   * unmerge_lead(): admins can undo it within 30 days
--   * new permission leads.merge (Admin and Team lead to start)
-- =====================================================================

alter table public.leads
  add column if not exists extra_phones text[] not null default '{}',
  add column if not exists extra_phone_hashes text[] not null default '{}',
  add column if not exists extra_phones_text text,
  add column if not exists merged_into uuid references public.leads (id) on delete set null,
  add column if not exists merged_at timestamptz;

create index if not exists leads_extra_phones_idx on public.leads using gin (extra_phones);
create index if not exists leads_extra_phone_hashes_idx on public.leads using gin (extra_phone_hashes);

-- 🔑 Who may merge: Admin and Team lead to start (Settings → Roles can change it)
update public.roles
set permissions = array_append(permissions, 'leads.merge')
where key in ('admin', 'team_lead') and not ('leads.merge' = any (permissions));

-- What a merge did, so it can be undone
create table if not exists public.lead_merges (
  id          uuid primary key default gen_random_uuid(),
  main_id     uuid not null references public.leads (id) on delete cascade,
  other_ids   uuid[] not null,
  names       text[] not null default '{}',
  main_before jsonb not null,
  moved       jsonb not null default '[]',
  main_after  jsonb,
  added       jsonb not null default '[]',
  merged_by   uuid references public.profiles (id) on delete set null default auth.uid(),
  merged_at   timestamptz not null default now(),
  undone_at   timestamptz,
  undone_by   uuid references public.profiles (id) on delete set null
);
create index if not exists lead_merges_main_idx on public.lead_merges (main_id, merged_at desc);

alter table public.lead_merges enable row level security;
drop policy if exists lead_merges_read on public.lead_merges;
create policy lead_merges_read on public.lead_merges
  for select to authenticated
  using (public.can_view_lead((select l.assigned_to from public.leads l where l.id = main_id)));

-- ---------------------------------------------------------------------
-- Phone lookups that now know the extra numbers
-- ---------------------------------------------------------------------
-- leads_before_write
create or replace function public.leads_before_write()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
begin
  new.name              := trim(new.name);
  new.phone             := public.normalize_bd_phone(new.phone);
  new.alt_phone         := public.normalize_bd_phone(new.alt_phone);
  -- ☎ More numbers: clean, no repeats, not the phone / alternative again
  new.extra_phones      := coalesce((
    select array_agg(x order by x)
    from (select distinct public.normalize_bd_phone(e) as x from unnest(coalesce(new.extra_phones, '{}')) e) z
    where x is not null and x is distinct from new.phone and x is distinct from new.alt_phone
  ), '{}');
  new.extra_phones_text := nullif(array_to_string(new.extra_phones, ' '), '');
  new.guardian_phone    := public.normalize_bd_phone(new.guardian_phone);
  new.email             := nullif(lower(trim(new.email)), '');
  new.whatsapp_number   := public.normalize_wa_number(new.whatsapp_number);
  new.whatsapp_username := public.normalize_wa_username(new.whatsapp_username);

  -- Same as the phone: no need to keep it twice
  if new.whatsapp_number is not null and new.whatsapp_number = new.phone then
    new.whatsapp_number := null;
  end if;

  if new.name = '' then
    raise exception 'Lead name is required';
  end if;
  if new.phone is null and new.whatsapp_number is null and new.whatsapp_username is null then
    raise exception 'A phone number, WhatsApp number or WhatsApp username is required';
  end if;
  if new.whatsapp_number is not null
     and new.whatsapp_number !~ '^01[3-9][0-9]{8}$'
     and new.whatsapp_number !~ '^\+[1-9][0-9]{7,14}$' then
    raise exception 'Invalid WhatsApp number';
  end if;
  if new.whatsapp_username is not null
     and (new.whatsapp_username !~ '^[a-z0-9._]{3,35}$' or new.whatsapp_username !~ '[a-z]') then
    raise exception 'Invalid WhatsApp username (3–35 letters, numbers, . or _)';
  end if;

  if tg_op = 'INSERT' then
    new.created_by := coalesce(new.created_by, auth.uid());

    if new.stage_id is null then
      select id into new.stage_id from public.pipeline_stages where key = 'new';
    end if;

    -- Without the assign permission, a new lead is always your own
    if not public.has_permission('leads.assign') then
      new.assigned_to := auth.uid();
    end if;

  else -- UPDATE
    -- The first source never changes (keeps reports honest)
    if old.source_id is not null
       and new.source_id is distinct from old.source_id
       and not public.has_permission('leads.edit_all')
       and coalesce(current_setting('app.merging', true), '') <> 'on' then
      raise exception 'The original source of a lead cannot be changed';
    end if;

    if new.assigned_to is distinct from old.assigned_to
       and not public.has_permission('leads.assign')
       and coalesce(current_setting('app.handover', true), '') <> 'on' then
      raise exception 'You are not allowed to reassign leads';
    end if;

    if new.deleted_at is distinct from old.deleted_at
       and not public.has_permission('leads.delete')
       and coalesce(current_setting('app.merging', true), '') <> 'on' then
      raise exception 'You are not allowed to delete leads';
    end if;

    new.created_by := old.created_by;
    new.created_at := old.created_at;
  end if;

  return new;
end;
$function$;

-- check_lead_delete_permission
create or replace function public.check_lead_delete_permission()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
begin
  if new.deleted_at is distinct from old.deleted_at
     and auth.uid() is not null
     and coalesce(current_setting('app.contacts_undo', true), '') <> 'on'
     and coalesce(current_setting('app.merging', true), '') <> 'on'
     and not public.has_permission('leads.delete') then
    raise exception 'You do not have permission to delete or restore leads.';
  end if;
  return new;
end;
$function$;

-- leads_log_activity
create or replace function public.leads_log_activity()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_user uuid := auth.uid();
begin
  if tg_op = 'INSERT' then
    insert into public.lead_activity (lead_id, user_id, action, details)
    values (new.id, v_user, 'created',
            jsonb_build_object('source_id', new.source_id, 'assigned_to', new.assigned_to));
    return new;
  end if;

  if new.stage_id is distinct from old.stage_id then
    insert into public.lead_activity (lead_id, user_id, action, details)
    values (new.id, v_user, 'stage_changed',
            jsonb_build_object('from', old.stage_id, 'to', new.stage_id));
  end if;

  if new.rating is distinct from old.rating then
    insert into public.lead_activity (lead_id, user_id, action, details)
    values (new.id, v_user, 'rating_changed',
            jsonb_build_object('from', old.rating, 'to', new.rating));
  end if;

  if new.assigned_to is distinct from old.assigned_to then
    insert into public.lead_activity (lead_id, user_id, action, details)
    values (new.id, v_user, 'assigned',
            jsonb_build_object('from', old.assigned_to, 'to', new.assigned_to));
  end if;

  if new.phone is distinct from old.phone or new.name is distinct from old.name then
    insert into public.lead_activity (lead_id, user_id, action, details)
    values (new.id, v_user, 'details_changed',
            jsonb_build_object('old_name', old.name, 'new_name', new.name,
                               'old_phone', old.phone, 'new_phone', new.phone));
  end if;

  if new.deleted_at is distinct from old.deleted_at
     and coalesce(current_setting('app.bank', true), '') <> 'on'
     and coalesce(current_setting('app.merging', true), '') <> 'on' then
    insert into public.lead_activity (lead_id, user_id, action, details)
    values (new.id, v_user, case when new.deleted_at is null then 'restored' else 'deleted' end, '{}');
  end if;

  return new;
end;
$function$;

-- leads_phone_hashes
create or replace function public.leads_phone_hashes()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'public', 'extensions'
AS $function$
begin
  if tg_op = 'INSERT' or new.phone is distinct from old.phone or new.phone_hash is null then
    new.phone_hash := case when new.phone is null then null else encode(digest(new.phone, 'sha256'), 'hex') end;
  end if;
  if tg_op = 'INSERT' or new.alt_phone is distinct from old.alt_phone or new.alt_phone_hash is null then
    new.alt_phone_hash := case when new.alt_phone is null then null else encode(digest(new.alt_phone, 'sha256'), 'hex') end;
  end if;
  -- ☎ more numbers
  if tg_op = 'INSERT' or new.extra_phones is distinct from old.extra_phones then
    new.extra_phone_hashes := coalesce(
      (select array_agg(encode(digest(e, 'sha256'), 'hex')) from unnest(coalesce(new.extra_phones, '{}')) e), '{}');
  end if;
  return new;
end;
$function$;

-- claim_held_calls
create or replace function public.claim_held_calls(p_lead_id uuid)
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_lead  public.leads;
  v_cfg   jsonb := public.call_sync_setting();
  v_min   int := coalesce((v_cfg->>'connected_min_sec')::int, 5);
  v_in    boolean := coalesce((v_cfg->>'incoming')::boolean, true);
  h       public.held_calls;
  n       integer := 0;
begin
  select * into v_lead from public.leads where id = p_lead_id and deleted_at is null;
  if v_lead.id is null or (v_lead.phone_hash is null and v_lead.alt_phone_hash is null and cardinality(v_lead.extra_phone_hashes) = 0) then return 0; end if;

  perform set_config('app.earlier_calls', 'on', true);
  for h in
    delete from public.held_calls
     where (phone_hash in (v_lead.phone_hash, v_lead.alt_phone_hash) or phone_hash = any (v_lead.extra_phone_hashes))
    returning *
  loop
    if h.direction <> 'outgoing' and not v_in then continue; end if;
    insert into public.call_logs (
      lead_id, user_id, called_at, outcome, duration_sec, notes,
      direction, source, device_id, device_call_id, sim_label, phone_verified
    )
    values (
      v_lead.id, h.user_id, h.called_at,
      case
        when h.direction = 'outgoing' then case when h.duration_sec >= v_min then 'connected' else 'no_answer' end
        when h.direction = 'incoming' then case when h.duration_sec > 0 then 'connected' else 'missed' end
        else h.direction
      end,
      h.duration_sec, null, h.direction, 'phone', h.device_id, h.device_call_id, h.sim_label, true
    )
    on conflict do nothing;
    n := n + 1;
  end loop;
  perform set_config('app.earlier_calls', 'off', true);
  return n;
end;
$function$;

-- hold_call
create or replace function public.hold_call(p_device_id text, p_call_id text, p_hash text, p_direction text, p_duration integer, p_at timestamp with time zone, p_sim text)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
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
  where (l.phone_hash = p_hash or l.alt_phone_hash = p_hash or p_hash = any (l.extra_phone_hashes))
    and l.deleted_at is null
    and l.created_at > p_at
  order by l.created_at desc
  limit 1;

  if v_lead is not null then
    perform public.claim_held_calls(v_lead);
  end if;
end;
$function$;

-- leads_claim_held_calls
create or replace function public.leads_claim_held_calls()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
begin
  if new.deleted_at is null and (new.phone_hash is not null or new.alt_phone_hash is not null or cardinality(new.extra_phone_hashes) > 0) then
    perform public.claim_held_calls(new.id);
  end if;
  return null;
end;
$function$;

-- sync_phone_calls
create or replace function public.sync_phone_calls(p_device_id text, p_calls jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SET search_path TO 'public', 'extensions'
AS $function$
declare
  v_cfg      jsonb := public.call_sync_setting();
  v_min      int := coalesce((v_cfg->>'connected_min_sec')::int, 5);
  v_incoming boolean := coalesce((v_cfg->>'incoming')::boolean, true);
  v_alumni_on boolean := public.alumni_can('view');
  v_call     jsonb;
  v_hash     text;
  v_lead     uuid;
  v_alum     uuid;
  v_dir      text;
  v_dur      int;
  v_at       timestamptz;
  v_outcome  text;
  v_match    uuid;
  v_res      text;
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

    v_outcome := case
      when v_dir = 'outgoing' then case when v_dur >= v_min then 'connected' else 'no_answer' end
      when v_dir = 'incoming' then case when v_dur > 0 then 'connected' else 'missed' end
      else v_dir   -- missed / rejected
    end;

    -- A lead this user can see, with this number (row security decides what "can see" means)
    select x.id into v_lead
    from (
      select l.id, l.created_at from public.leads l
      where l.phone_hash = v_hash and l.deleted_at is null
      union all
      select l.id, l.created_at from public.leads l
      where l.alt_phone_hash = v_hash and l.deleted_at is null
      union all
      select l.id, l.created_at from public.leads l
      where v_hash = any (l.extra_phone_hashes) and l.deleted_at is null
    ) x
    order by x.created_at desc
    limit 1;

    if v_lead is null then
      -- 🎓 An alumnus with this number?
      v_alum := null;
      if v_alumni_on and v_hash is not null then
        select a.id into v_alum from public.alumni a
        where (a.phone_hash = v_hash or a.wa_hash = v_hash) and a.deleted_at is null
        order by a.created_at desc limit 1;
      end if;
      if v_alum is not null then
        v_res := public.alumni_record_phone_call(v_alum, p_device_id, v_call, v_outcome);
        if v_res = 'added' then v_added := v_added + 1;
        elsif v_res = 'matched' then v_matched := v_matched + 1;
        else v_ignored := v_ignored + 1; end if;
        continue;
      end if;

      -- Not a lead (yet): kept for a few days in case it is saved as a lead
      -- (only the number's hash, time and length; see hold_call)
      perform public.hold_call(p_device_id, v_call->>'id', v_hash, v_dir, v_dur, v_at, v_call->>'sim');
      v_ignored := v_ignored + 1;
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
$function$;

-- my_lead_directory
create or replace function public.my_lead_directory()
 RETURNS TABLE(hash text, lead_id uuid, name text, rating text, stage text, course text, last_note text, student_ref text, fee_due numeric, next_call timestamp with time zone, owner text)
 LANGUAGE sql
 STABLE
 SET search_path TO 'public', 'extensions'
 SET jit TO 'off'
AS $function$
  with visible as (
    select
      l.id, l.name, l.rating, l.phone_hash, l.alt_phone_hash, l.extra_phone_hashes, l.whatsapp_number, l.whatsapp_username,
      l.student_ref, l.next_follow_up_at,
      case when s.kind = 'won' and coalesce(l.fee_due, 0) > 0 then l.fee_due end as fee_due,
      p.full_name as owner,
      case s.kind
        when 'won'       then '🎓 Admitted' || coalesce(' · ' || b.name, '')
        when 'lost'      then '✕ Not Now' || coalesce(' · ' || lr.name, '')
        when 'cancelled' then 'Admission cancelled'
        else s.name
      end as stage,
      coalesce(
        ac.name,
        (select c.name from public.lead_courses lc join public.courses c on c.id = lc.course_id
          where lc.lead_id = l.id limit 1)
      ) as course,
      -- the latest note (a call's or a typed one), kept up to date in lead_last
      ll.note_text as last_note
    from public.leads l
    left join public.pipeline_stages s on s.id = l.stage_id
    left join public.courses ac on ac.id = l.admitted_course_id and s.kind = 'won'
    left join public.batches b on b.id = l.admitted_batch_id
    left join public.lost_reasons lr on lr.id = l.lost_reason_id
    left join public.profiles p on p.id = l.assigned_to
    left join public.lead_last ll on ll.lead_id = l.id
    where l.deleted_at is null
    order by l.updated_at desc nulls last
    limit 10000
  ),
  alum as (
    select a.id, a.name, a.phone, a.whatsapp_number, a.student_ref, a.next_contact_at, a.last_note,
           p.full_name as owner,
           '🎓 Alumni' || coalesce(' · ' || b.name, '') ||
             case when a.cnt_referrals > 0 then ' · ' || a.cnt_referrals || ' referral' ||
                    case when a.cnt_referrals > 1 then 's' else '' end else '' end as stage,
           c.name as course
    from public.alumni a
    left join public.batches b on b.id = a.batch_id
    left join public.courses c on c.id = a.course_id
    left join public.profiles p on p.id = a.owner_id
    where a.deleted_at is null and public.alumni_can('view')
    order by a.updated_at desc
    limit 5000
  ),
  keys as (
    select 1 as prio, v.id, v.name, v.rating, v.stage, v.course, v.last_note, v.student_ref, v.fee_due,
           v.next_follow_up_at as next_call, v.owner, k.h
    from visible v
    -- (the phone numbers' hashes are kept on the lead: only WhatsApp ones are worked out here)
    cross join lateral (select x from unnest(v.extra_phone_hashes) x union all values
      (v.phone_hash),
      (v.alt_phone_hash),
      (case when v.whatsapp_number is not null then encode(digest(v.whatsapp_number, 'sha256'), 'hex') end),
      (case when v.whatsapp_username is not null then encode(digest('u:' || v.whatsapp_username, 'sha256'), 'hex') end)
    ) as k(h)
    where k.h is not null
    union all
    select 2, a.id, a.name, null, a.stage, a.course, a.last_note, a.student_ref, null::numeric,
           a.next_contact_at, a.owner, encode(digest(k.key, 'sha256'), 'hex')
    from alum a
    cross join lateral (values (a.phone), (a.whatsapp_number)) as k(key)
    where k.key is not null
    union all
    -- 🏦 the bank (waiting numbers only; the hash is kept on the row)
    select 3, bd.id, bd.name, null, bd.stage, null, bd.note, null, null::numeric, null::timestamptz, null, bd.hash
    from public.bank_directory() bd
  )
  select distinct on (k.h)
         k.h, k.id, k.name, k.rating, k.stage, k.course, left(k.last_note, 120),
         k.student_ref, k.fee_due, k.next_call, k.owner
  from keys k
  order by k.h, k.prio;
$function$;

-- existing_lead_phones
create or replace function public.existing_lead_phones(p_phones text[])
 RETURNS SETOF text
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  select distinct p.phone
  from unnest(p_phones) as p(phone)
  where public.is_active_user()
    and exists (
      select 1
      from public.leads l
      where l.deleted_at is null
        and (l.phone = public.normalize_bd_phone(p.phone)
             or l.alt_phone = public.normalize_bd_phone(p.phone)
             or public.normalize_bd_phone(p.phone) = any (l.extra_phones))
    );
$function$;

-- find_leads_by_phone
create or replace function public.find_leads_by_phone(p_phone text, p_exclude_id uuid DEFAULT NULL::uuid)
 RETURNS TABLE(id uuid, name text, phone text, stage_name text, assigned_to_name text, can_open boolean)
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  select
    l.id,
    l.name,
    l.phone,
    s.name,
    p.full_name,
    public.can_view_lead(l.assigned_to)
  from public.leads l
  join public.pipeline_stages s on s.id = l.stage_id
  left join public.profiles p on p.id = l.assigned_to
  where public.is_active_user()
    and l.deleted_at is null
    and (p_exclude_id is null or l.id <> p_exclude_id)
    and (public.normalize_bd_phone(p_phone) in (l.phone, l.alt_phone, l.guardian_phone)
         or public.normalize_bd_phone(p_phone) = any (l.extra_phones))
  limit 5;
$function$;

-- find_leads_by_contact
create or replace function public.find_leads_by_contact(p_phone text DEFAULT NULL::text, p_whatsapp_number text DEFAULT NULL::text, p_whatsapp_username text DEFAULT NULL::text, p_exclude_id uuid DEFAULT NULL::uuid)
 RETURNS TABLE(id uuid, name text, phone text, stage_name text, assigned_to_name text, can_open boolean, matched text)
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  with q as (
    select public.normalize_bd_phone(p_phone)               as phone,
           public.normalize_wa_number(p_whatsapp_number)     as wa,
           public.normalize_wa_username(p_whatsapp_username) as un
  )
  select
    l.id,
    l.name,
    public.lead_contact_label(l.phone, l.whatsapp_number, l.whatsapp_username),
    s.name,
    p.full_name,
    public.can_view_lead(l.assigned_to),
    case
      when q.un is not null and l.whatsapp_username = q.un then 'whatsapp_username'
      when q.wa is not null and (q.wa in (l.whatsapp_number, l.phone, l.alt_phone) or q.wa = any (l.extra_phones)) then 'whatsapp_number'
      else 'phone'
    end
  from q, public.leads l
  join public.pipeline_stages s on s.id = l.stage_id
  left join public.profiles p on p.id = l.assigned_to
  where public.is_active_user()
    and l.deleted_at is null
    and (p_exclude_id is null or l.id <> p_exclude_id)
    and (
      (q.phone is not null and (q.phone in (l.phone, l.alt_phone, l.guardian_phone, l.whatsapp_number) or q.phone = any (l.extra_phones)))
      or (q.wa is not null and (q.wa in (l.whatsapp_number, l.phone, l.alt_phone) or q.wa = any (l.extra_phones)))
      or (q.un is not null and l.whatsapp_username = q.un)
    )
  limit 5;
$function$;

-- save_contacts_as_leads
create or replace function public.save_contacts_as_leads(p_rows jsonb, p_options jsonb DEFAULT '{}'::jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_row        jsonb;
  v_name       text;
  v_phone      text;
  v_id         uuid;
  v_ids        uuid[] := '{}';
  v_seen       text[] := '{}';
  v_existing   int := 0;
  v_invalid    int := 0;
  v_source     uuid := nullif(p_options->>'source_id', '')::uuid;
  v_rating     text := nullif(p_options->>'rating', '');
  v_manual     boolean := coalesce((p_options->>'assign_manual')::boolean, false);
  v_assignee   uuid := nullif(p_options->>'assigned_to', '')::uuid;
  v_tag        text;
  v_course     text;
begin
  if not public.can_import_contacts() then
    raise exception 'You are not allowed to add leads from phone contacts.';
  end if;

  if jsonb_array_length(coalesce(p_options->'course_ids', '[]'::jsonb)) = 0
     and exists (select 1 from public.courses where is_active) then
    raise exception 'Please choose an interested course.' using hint = 'course_required';
  end if;

  if jsonb_array_length(coalesce(p_rows, '[]'::jsonb)) > 1000 then
    raise exception 'Please save at most 1000 contacts at a time.';
  end if;

  for v_row in select * from jsonb_array_elements(coalesce(p_rows, '[]'::jsonb))
  loop
    v_name  := nullif(trim(v_row->>'name'), '');
    v_phone := public.normalize_bd_phone(coalesce(v_row->>'phone', ''));

    -- Not a Bangladeshi mobile number
    if v_phone is null or v_phone !~ '^01[3-9][0-9]{8}$' then
      v_invalid := v_invalid + 1;
      continue;
    end if;

    -- Same number twice in this batch, or already a lead
    if v_phone = any(v_seen) or exists (
         select 1 from public.leads l
         where l.deleted_at is null and (l.phone = v_phone or l.alt_phone = v_phone or v_phone = any (l.extra_phones))
       ) then
      v_existing := v_existing + 1;
      continue;
    end if;
    v_seen := array_append(v_seen, v_phone);

    -- Insert; the assignment trigger applies the rules
    -- (a manual choice is checked against the user's rights there)
    insert into public.leads (name, phone, source_id, rating, assigned_to, assignment_method)
    values (
      coalesce(v_name, v_phone),
      case when cardinality(public.phone_extras(v_row ->> 'phone')) > 0 then v_row ->> 'phone' else v_phone end,
      v_source,
      v_rating,
      case when v_manual then v_assignee else null end,
      case when v_manual then 'manual' else null end
    )
    returning id into v_id;

    v_ids := array_append(v_ids, v_id);

    for v_tag in select jsonb_array_elements_text(coalesce(p_options->'tag_ids', '[]'::jsonb))
    loop
      insert into public.lead_tags (lead_id, tag_id) values (v_id, v_tag::uuid);
    end loop;

    for v_course in select jsonb_array_elements_text(coalesce(p_options->'course_ids', '[]'::jsonb))
    loop
      insert into public.lead_courses (lead_id, course_id) values (v_id, v_course::uuid);
    end loop;
  end loop;

  return jsonb_build_object(
    'created', coalesce(array_length(v_ids, 1), 0),
    'created_ids', to_jsonb(v_ids),
    'already_leads', v_existing,
    'invalid', v_invalid
  );
end;
$function$;

-- import_leads
create or replace function public.import_leads(p_rows jsonb, p_options jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_batch_id     uuid := nullif(p_options ->> 'batch_id', '')::uuid;
  v_default_src  uuid := nullif(p_options ->> 'default_source_id', '')::uuid;
  -- 🎓 used when a row has no (known) course
  v_default_crs  uuid := nullif(p_options ->> 'default_course_id', '')::uuid;
  v_dup_mode     text := coalesce(p_options ->> 'duplicate_mode', 'skip');
  v_assign_mode  text := coalesce(p_options ->> 'assign_mode', 'none');
  v_assign_user  uuid := nullif(p_options ->> 'assign_user_id', '')::uuid;
  v_rr_users     uuid[] := coalesce(
                    array(select jsonb_array_elements_text(p_options -> 'round_robin_user_ids'))::uuid[],
                    '{}');
  v_rr_index     integer := 0;
  v_stage_id     uuid;

  r              jsonb;
  v_row_no       integer;
  v_name         text;
  v_phone        text;
  v_wa           text;
  v_un           text;
  v_source_id    uuid;
  v_course_id    uuid;
  v_existing_id  uuid;
  v_assignee     uuid;
  v_lead_id      uuid;

  v_created      integer := 0;
  v_updated      integer := 0;
  v_skipped      integer := 0;
  v_errors       jsonb := '[]'::jsonb;
begin
  if not public.has_permission('import.run') then
    raise exception 'You are not allowed to import leads';
  end if;

  if v_dup_mode not in ('skip', 'update', 'create') then
    raise exception 'Unknown duplicate mode';
  end if;

  -- First chunk creates the batch; later chunks continue it
  if v_batch_id is null then
    insert into public.import_batches (file_name, settings, created_by)
    values (p_options ->> 'file_name', p_options, auth.uid())
    returning id, rr_index into v_batch_id, v_rr_index;
  else
    select rr_index into v_rr_index
    from public.import_batches
    where id = v_batch_id and undone_at is null
    for update;

    if not found then
      raise exception 'Import batch not found';
    end if;
  end if;

  select id into v_stage_id from public.pipeline_stages where key = 'new';

  for r in select * from jsonb_array_elements(p_rows)
  loop
    v_row_no := coalesce((r ->> 'row')::integer, 0);
    v_name   := trim(coalesce(r ->> 'name', ''));
    v_phone  := public.normalize_bd_phone(r ->> 'phone');
    v_wa     := public.normalize_wa_number(r ->> 'whatsapp_number');
    v_un     := public.normalize_wa_username(r ->> 'whatsapp_username');

    -- Required fields
    if v_name = '' then
      v_errors := v_errors || jsonb_build_object('row', v_row_no, 'reason', 'Name is missing');
      continue;
    end if;
    if v_phone is null and v_wa is null and v_un is null then
      v_errors := v_errors || jsonb_build_object('row', v_row_no, 'reason', 'Phone, WhatsApp number or username is missing');
      continue;
    end if;

    if v_phone is not null and v_phone !~ '^01[3-9][0-9]{8}$' then
      v_errors := v_errors || jsonb_build_object('row', v_row_no, 'reason', 'Invalid mobile number: ' || (r ->> 'phone'));
      continue;
    end if;
    if v_wa is not null and v_wa !~ '^01[3-9][0-9]{8}$' and v_wa !~ '^\+[1-9][0-9]{7,14}$' then
      v_errors := v_errors || jsonb_build_object('row', v_row_no, 'reason', 'Invalid WhatsApp number: ' || (r ->> 'whatsapp_number'));
      continue;
    end if;
    if v_un is not null and (v_un !~ '^[a-z0-9._]{3,35}$' or v_un !~ '[a-z]') then
      v_errors := v_errors || jsonb_build_object('row', v_row_no, 'reason', 'Invalid WhatsApp username: ' || (r ->> 'whatsapp_username'));
      continue;
    end if;

    -- Source and course by name (falls back to the default source)
    v_source_id := null;
    if coalesce(trim(r ->> 'source'), '') <> '' then
      select id into v_source_id from public.lead_sources
      where lower(name) = lower(trim(r ->> 'source')) limit 1;
    end if;
    v_source_id := coalesce(v_source_id, v_default_src);

    v_course_id := null;
    if coalesce(trim(r ->> 'course'), '') <> '' then
      select id into v_course_id from public.courses
      where lower(name) = lower(trim(r ->> 'course')) and not is_alumni limit 1;
    end if;
    v_course_id := coalesce(v_course_id, v_default_crs);

    -- Duplicate? (phone, WhatsApp number or username)
    select id into v_existing_id
    from public.leads
    where deleted_at is null
      and (
        (v_phone is not null and (v_phone in (phone, alt_phone, guardian_phone, whatsapp_number) or v_phone = any (extra_phones)))
        or (v_wa is not null and v_wa in (whatsapp_number, phone, alt_phone))
        or (v_un is not null and whatsapp_username = v_un)
      )
    limit 1;

    if v_existing_id is not null and v_dup_mode = 'skip' then
      v_skipped := v_skipped + 1;
      continue;
    end if;

    if v_existing_id is not null and v_dup_mode = 'update' then
      update public.leads set
        email             = coalesce(email, nullif(trim(r ->> 'email'), '')),
        alt_phone         = coalesce(alt_phone, nullif(trim(r ->> 'alt_phone'), '')),
        area              = coalesce(area, nullif(trim(r ->> 'area'), '')),
        guardian_name     = coalesce(guardian_name, nullif(trim(r ->> 'guardian_name'), '')),
        guardian_phone    = coalesce(guardian_phone, nullif(trim(r ->> 'guardian_phone'), '')),
        guardian_relation = coalesce(guardian_relation, nullif(trim(r ->> 'guardian_relation'), '')),
        notes             = coalesce(notes, nullif(trim(r ->> 'notes'), '')),
        phone             = coalesce(phone, case when cardinality(public.phone_extras(r ->> 'phone')) > 0 then r ->> 'phone' else v_phone end),
        whatsapp_number   = coalesce(whatsapp_number, v_wa),
        whatsapp_username = coalesce(whatsapp_username, v_un)
      where id = v_existing_id;

      insert into public.lead_activity (lead_id, user_id, action, details)
      values (v_existing_id, auth.uid(), 're_enquiry',
              jsonb_build_object('import_batch_id', v_batch_id, 'source_id', v_source_id));

      if v_course_id is not null then
        insert into public.lead_courses (lead_id, course_id)
        values (v_existing_id, v_course_id)
        on conflict do nothing;
      end if;

      v_updated := v_updated + 1;
      continue;
    end if;

    -- 🎓 A new lead needs an interested course
    if v_course_id is null then
      v_errors := v_errors || jsonb_build_object('row', v_row_no, 'reason', 'Course is missing');
      continue;
    end if;

    -- Who gets the new lead
    v_assignee := null;
    if v_assign_mode = 'user' then
      v_assignee := v_assign_user;
    elsif v_assign_mode = 'round_robin' and array_length(v_rr_users, 1) > 0 then
      v_assignee := v_rr_users[(v_rr_index % array_length(v_rr_users, 1)) + 1];
      v_rr_index := v_rr_index + 1;
    end if;

    insert into public.leads (
      name, phone, alt_phone, email, area,
      guardian_name, guardian_phone, guardian_relation,
      whatsapp_number, whatsapp_username,
      source_id, stage_id, assigned_to, notes, import_batch_id
    ) values (
      v_name, case when cardinality(public.phone_extras(r ->> 'phone')) > 0 then r ->> 'phone' else v_phone end,
      nullif(trim(r ->> 'alt_phone'), ''),
      nullif(trim(r ->> 'email'), ''),
      nullif(trim(r ->> 'area'), ''),
      nullif(trim(r ->> 'guardian_name'), ''),
      nullif(trim(r ->> 'guardian_phone'), ''),
      nullif(trim(r ->> 'guardian_relation'), ''),
      v_wa, v_un,
      v_source_id, v_stage_id, v_assignee,
      nullif(trim(r ->> 'notes'), ''),
      v_batch_id
    )
    returning id into v_lead_id;

    if v_course_id is not null then
      insert into public.lead_courses (lead_id, course_id) values (v_lead_id, v_course_id);
    end if;

    v_created := v_created + 1;
  end loop;

  update public.import_batches set
    created  = created + v_created,
    updated  = updated + v_updated,
    skipped  = skipped + v_skipped,
    failed   = failed + jsonb_array_length(v_errors),
    rr_index = v_rr_index
  where id = v_batch_id;

  return jsonb_build_object(
    'batch_id', v_batch_id,
    'created',  v_created,
    'updated',  v_updated,
    'skipped',  v_skipped,
    'errors',   v_errors
  );
end;
$function$;

-- log_lead_field_changes
create or replace function public.log_lead_field_changes()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_changes jsonb := '[]'::jsonb;
begin
  if new.notes is distinct from old.notes
     and coalesce(current_setting('app.note_added', true), '') = '' then
    insert into public.lead_activity (lead_id, user_id, action, details)
    values (new.id, auth.uid(), 'note_edited',
            jsonb_build_object('from', left(old.notes, 150), 'to', left(new.notes, 150)));
  end if;

  if new.email is distinct from old.email then
    v_changes := v_changes || jsonb_build_object('field', 'Email', 'from', old.email, 'to', new.email);
  end if;
  if new.alt_phone is distinct from old.alt_phone then
    v_changes := v_changes || jsonb_build_object('field', 'Alternative phone', 'from', old.alt_phone, 'to', new.alt_phone);
  end if;
  if new.extra_phones is distinct from old.extra_phones then
    v_changes := v_changes || jsonb_build_object('field', 'More numbers',
      'from', nullif(array_to_string(old.extra_phones, ', '), ''), 'to', nullif(array_to_string(new.extra_phones, ', '), ''));
  end if;
  if new.area is distinct from old.area then
    v_changes := v_changes || jsonb_build_object('field', 'Area', 'from', old.area, 'to', new.area);
  end if;
  if new.guardian_name is distinct from old.guardian_name then
    v_changes := v_changes || jsonb_build_object('field', 'Guardian', 'from', old.guardian_name, 'to', new.guardian_name);
  end if;
  if new.guardian_phone is distinct from old.guardian_phone then
    v_changes := v_changes || jsonb_build_object('field', 'Guardian phone', 'from', old.guardian_phone, 'to', new.guardian_phone);
  end if;
  if new.guardian_relation is distinct from old.guardian_relation then
    v_changes := v_changes || jsonb_build_object('field', 'Guardian relation', 'from', old.guardian_relation, 'to', new.guardian_relation);
  end if;
  if new.referred_by is distinct from old.referred_by then
    v_changes := v_changes || jsonb_build_object('field', 'Referred by', 'from', old.referred_by, 'to', new.referred_by);
  end if;
  if new.source_id is distinct from old.source_id then
    v_changes := v_changes || jsonb_build_object('field', 'Source',
      'from', (select name from public.lead_sources where id = old.source_id),
      'to',   (select name from public.lead_sources where id = new.source_id));
  end if;
  if new.campaign_id is distinct from old.campaign_id then
    v_changes := v_changes || jsonb_build_object('field', 'Campaign',
      'from', (select name from public.campaigns where id = old.campaign_id),
      'to',   (select name from public.campaigns where id = new.campaign_id));
  end if;
  if new.lead_type_id is distinct from old.lead_type_id then
    v_changes := v_changes || jsonb_build_object('field', 'Lead type',
      'from', (select name from public.lead_types where id = old.lead_type_id),
      'to',   (select name from public.lead_types where id = new.lead_type_id));
  end if;

  if jsonb_array_length(v_changes) > 0 then
    insert into public.lead_activity (lead_id, user_id, action, details)
    values (new.id, auth.uid(), 'fields_changed', jsonb_build_object('changes', v_changes));
  end if;
  return null;
end;
$function$;

-- ---------------------------------------------------------------------
-- 🔗 merge_leads: checks as the person (row security), then merges
-- ---------------------------------------------------------------------
-- the cached lines on a lead, from its own rows again (after rows moved in a merge or an undo)
create or replace function public.lead_merge_refresh(p_lead uuid)
returns void
language plpgsql
security definer
set search_path = public
as $fn$
declare
  v_status text;
  v_at     timestamptz;
begin
  perform public.refresh_lead_fee(p_lead);
  perform public.refresh_lead_payments(p_lead);
  perform public.refresh_lead_papers(p_lead);
  perform public.refresh_lead_last(p_lead);

  select 'planned', planned_at into v_status, v_at
  from public.lead_visits where lead_id = p_lead and status = 'planned' limit 1;
  if v_status is null then
    select 'visited', max(coalesce(visited_at, updated_at)) into v_status, v_at
    from public.lead_visits where lead_id = p_lead and status = 'visited' having count(*) > 0;
  end if;
  if v_status is null then
    select 'missed', planned_at into v_status, v_at
    from public.lead_visits where lead_id = p_lead and status = 'missed' order by updated_at desc limit 1;
  end if;

  update public.leads l set
    visit_status = v_status,
    visit_at = v_at,
    next_follow_up_at = (select f.due_at from public.follow_ups f
                         where f.lead_id = p_lead and f.status = 'pending' order by f.due_at limit 1),
    -- (as when a call is logged: only calls that reached the person, and never earlier)
    last_contacted_at = greatest(l.last_contacted_at,
                                 (select max(c.called_at) from public.call_logs c
                                  where c.lead_id = p_lead and c.deleted_at is null
                                    and (c.direction = 'outgoing' or c.outcome = 'connected')))
  where l.id = p_lead;
end;
$fn$;
revoke all on function public.lead_merge_refresh(uuid) from public, anon, authenticated;

create or replace function public.merge_leads(p_main uuid, p_others uuid[], p_fields jsonb default '{}')
returns uuid
language plpgsql
security invoker
set search_path = public
as $$
declare
  v_all uuid[];
  v_ok  int;
begin
  if not public.has_permission('leads.merge') then
    raise exception 'You are not allowed to merge leads.';
  end if;
  p_others := array(select distinct x from unnest(coalesce(p_others, '{}')) x where x is not null and x <> p_main);
  if cardinality(p_others) = 0 then
    raise exception 'Choose at least one other lead.';
  end if;
  if cardinality(p_others) > 9 then
    raise exception 'Merge at most 10 leads at a time.';
  end if;
  v_all := p_main || p_others;

  -- Every lead must be one I can see and change (the security rules decide)
  with u as (
    update public.leads set name = name
    where id = any (v_all) and deleted_at is null
    returning 1
  )
  select count(*) into v_ok from u;
  if v_ok <> cardinality(v_all) then
    raise exception 'You can only merge leads you can see and change (or a lead was merged already).';
  end if;

  perform set_config('app.merge_ok', array_to_string(v_all, ','), true);
  return public.merge_leads_apply(p_main, p_others, coalesce(p_fields, '{}'));
end;
$$;

create or replace function public.merge_leads_apply(p_main uuid, p_others uuid[], p_fields jsonb)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_main    public.leads;
  v_o       public.leads;
  v_all     uuid[] := p_main || p_others;
  v_merge   uuid;
  v_moved   jsonb := '[]';
  v_added   jsonb := '[]';
  v_ids     jsonb;
  v_nums    text[] := '{}';
  v_names   text[] := '{}';
  v_notes   text;
  v_wa      text;
  v_un      text;
  v_phone   text;
  v_alt     text;
  v_extra   text[];
  v_tbl     text;
  v_extra_w text;
  v_won     int;
  v_fee     int;
  v_main_open boolean;
  v_stage   uuid;
  v_assign  uuid;
  v_source  uuid;
  v_name    text;
  v_who     text := public.person_name(auth.uid());
  v_users   uuid[];
  u         uuid;
  v_ref     uuid;
  v_work    text;
  v_custom  jsonb;
begin
  if coalesce(current_setting('app.merge_ok', true), '') <> array_to_string(v_all, ',') then
    raise exception 'Use merge_leads.';
  end if;
  perform set_config('app.merge_ok', '', true);

  -- Lock them
  perform 1 from public.leads where id = any (v_all) for update;
  select * into v_main from public.leads where id = p_main;

  -- 🎓 Admitted / 💰 fee: never two
  select count(*) into v_won
  from public.leads l join public.pipeline_stages s on s.id = l.stage_id
  where l.id = any (v_all) and s.kind = 'won';
  if v_won > 1 then
    raise exception 'More than one of these leads is admitted. They can’t be merged.';
  end if;
  if v_won = 1 and not exists (
       select 1 from public.pipeline_stages s where s.id = v_main.stage_id and s.kind = 'won') then
    raise exception 'Keep the admitted lead as the main one.';
  end if;

  select count(distinct lead_id) into v_fee from (
    select lead_id from public.fee_payments where lead_id = any (v_all)
    union all select lead_id from public.lead_negotiations where lead_id = any (v_all)
    union all select lead_id from public.fee_discounts where lead_id = any (v_all)
    union all select lead_id from public.fee_installments where lead_id = any (v_all)
  ) f;
  if v_fee > 1 then
    raise exception 'More than one of these leads has fee talk or payments. They can’t be merged.';
  end if;

  select s.kind = 'open' into v_main_open from public.pipeline_stages s where s.id = v_main.stage_id;

  insert into public.lead_merges (main_id, other_ids, main_before)
  values (p_main, p_others, to_jsonb(v_main))
  returning id into v_merge;

  -- The rules that guard normal edits step aside for this one change
  perform set_config('app.merging', 'on', true);
  perform set_config('app.handover', 'on', true);
  perform set_config('app.pipeline_action', 'on', true);
  perform set_config('app.call_admin', 'on', true);
  perform set_config('app.note_added', 'on', true);

  v_notes := nullif(trim(coalesce(v_main.notes, '')), '');
  v_wa := v_main.whatsapp_number;
  v_un := v_main.whatsapp_username;

  for v_o in select * from public.leads where id = any (p_others) order by created_at loop
    v_names := v_names || v_o.name;
    v_nums := v_nums || array[v_o.phone, v_o.alt_phone, v_o.whatsapp_number] || v_o.extra_phones;
    v_wa := coalesce(v_wa, v_o.whatsapp_number);
    v_un := coalesce(v_un, v_o.whatsapp_username);
    -- 🎓 who referred, workplace, the extra fields: the main lead's, else the others'
    v_ref := coalesce(v_ref, v_o.referred_by_alumni_id);
    v_work := coalesce(v_work, nullif(trim(coalesce(v_o.workplace, '')), ''));
    v_custom := coalesce(v_o.custom_fields, '{}'::jsonb) || coalesce(v_custom, '{}'::jsonb);
    if nullif(trim(coalesce(v_o.notes, '')), '') is not null then
      v_notes := concat_ws(E'\n', v_notes, '— ' || v_o.name || ': ' || trim(v_o.notes));
    end if;

    -- Rows that move to the main lead (and can move back)
    for v_tbl, v_extra_w in
      select * from (values
        ('lead_activity', ''),
        ('call_logs', ''),
        ('lead_stage_history', ''),
        ('lead_files', ''),
        ('lead_negotiations', ''),
        ('negotiation_events', ''),
        ('fee_discounts', ''),
        ('fee_payments', ''),
        ('fee_installments', ''),
        ('follow_ups', 'and not (t.status = ''pending'' and exists (select 1 from public.follow_ups x where x.lead_id = $1 and x.status = ''pending''))'),
        ('lead_visits', 'and not (t.status = ''planned'' and exists (select 1 from public.lead_visits x where x.lead_id = $1 and x.status = ''planned''))'),
        ('lead_papers', 'and t.paper_id not in (select x.paper_id from public.lead_papers x where x.lead_id = $1)'),
        -- added later: SMS sent, what the AI read in the notes, the Lead Bank row it came from,
        -- its alumni links (one alumnus and one open reward per lead at most)
        ('sms_messages', ''),
        ('note_insights', ''),
        ('lead_bank', ''),
        ('alumni_referrals', ''),
        ('alumni', 'and not exists (select 1 from public.alumni x where x.lead_id = $1 and x.deleted_at is null)'),
        ('alumni_rewards', 'and not (t.status <> ''cancelled'' and exists (select 1 from public.alumni_rewards x where x.lead_id = $1 and x.status <> ''cancelled''))')
      ) v(t, w)
    loop
      execute format(
        'with m as (update public.%I t set lead_id = $1 where t.lead_id = $2 %s returning t.id) '
        'select coalesce(jsonb_agg(id), ''[]'') from m',
        v_tbl, v_extra_w
      ) into v_ids using p_main, v_o.id;
      if jsonb_array_length(v_ids) > 0 then
        v_moved := v_moved || jsonb_build_array(jsonb_build_object('t', v_tbl, 'from', v_o.id, 'ids', v_ids));
      end if;
    end loop;

    -- Links: copied to the main lead (the other keeps its own)
    for v_tbl, v_extra_w in
      select * from (values ('lead_courses', 'course_id'), ('lead_tags', 'tag_id'),
                            ('lead_stars', 'user_id'), ('lead_views', 'user_id')) v(t, c)
    loop
      execute format(
        'with m as (insert into public.%1$I (lead_id, %2$I) select $1, %2$I from public.%1$I where lead_id = $2 '
        'on conflict do nothing returning %2$I) select coalesce(jsonb_agg(%2$I), ''[]'') from m',
        v_tbl, v_extra_w
      ) into v_ids using p_main, v_o.id;
      if jsonb_array_length(v_ids) > 0 then
        v_added := v_added || jsonb_build_array(jsonb_build_object('t', v_tbl, 'c', v_extra_w, 'vals', v_ids));
      end if;
    end loop;
  end loop;

  -- ☎ All the numbers on one lead
  -- (in the order they came: each lead's phone, alt phone, WhatsApp, more numbers)
  v_nums := array(
    select z.x from (
      select x, min(o) as o from unnest(v_nums || v_main.extra_phones) with ordinality t(x, o) group by x
    ) z
    where z.x ~ '^01[3-9][0-9]{8}$' and z.x is distinct from v_main.phone and z.x is distinct from v_main.alt_phone
    order by z.o
  );
  v_phone := coalesce(v_main.phone, v_nums[1]);
  v_nums := array(select x from unnest(v_nums) x where x is distinct from v_phone);
  v_alt := coalesce(v_main.alt_phone, v_nums[1]);
  v_extra := array(select x from unnest(v_nums) x where x is distinct from v_alt);

  -- Chosen values must come from one of the leads
  v_name := coalesce(nullif(trim(p_fields->>'name'), ''), v_main.name);
  v_assign := v_main.assigned_to;
  if p_fields ? 'assigned_to' then
    v_assign := nullif(p_fields->>'assigned_to', '')::uuid;
    if v_assign is not null and not exists (select 1 from public.leads where id = any (v_all) and assigned_to = v_assign) then
      raise exception 'Choose a person from one of the leads.';
    end if;
  end if;
  v_source := v_main.source_id;
  if p_fields ? 'source_id' then
    v_source := nullif(p_fields->>'source_id', '')::uuid;
    if v_source is not null and not exists (select 1 from public.leads where id = any (v_all) and source_id = v_source) then
      raise exception 'Choose a source from one of the leads.';
    end if;
  end if;
  v_stage := v_main.stage_id;
  if p_fields ? 'stage_id' and v_main_open then
    select l.stage_id into v_stage
    from public.leads l join public.pipeline_stages s on s.id = l.stage_id
    where l.id = any (v_all) and l.stage_id = (p_fields->>'stage_id')::uuid and s.kind = 'open'
    limit 1;
    v_stage := coalesce(v_stage, v_main.stage_id);
  end if;

  update public.leads set
    name              = v_name,
    phone             = v_phone,
    alt_phone         = v_alt,
    extra_phones      = v_extra,
    whatsapp_number   = v_wa,
    whatsapp_username = v_un,
    assigned_to       = v_assign,
    source_id         = v_source,
    stage_id          = v_stage,
    rating            = case when p_fields ? 'rating' then nullif(p_fields->>'rating', '') else rating end,
    email             = case when p_fields ? 'email' then nullif(p_fields->>'email', '') else email end,
    area              = case when p_fields ? 'area' then nullif(p_fields->>'area', '') else area end,
    guardian_name     = case when p_fields ? 'guardian_name' then nullif(p_fields->>'guardian_name', '') else guardian_name end,
    guardian_phone    = case when p_fields ? 'guardian_phone' then nullif(p_fields->>'guardian_phone', '') else guardian_phone end,
    guardian_relation = case when p_fields ? 'guardian_relation' then nullif(p_fields->>'guardian_relation', '') else guardian_relation end,
    referred_by       = case when p_fields ? 'referred_by' then nullif(p_fields->>'referred_by', '') else referred_by end,
    lead_type_id      = case when p_fields ? 'lead_type_id' then nullif(p_fields->>'lead_type_id', '')::uuid else lead_type_id end,
    campaign_id       = case when p_fields ? 'campaign_id' then nullif(p_fields->>'campaign_id', '')::uuid else campaign_id end,
    notes             = v_notes,
    referred_by_alumni_id = coalesce(referred_by_alumni_id, v_ref),
    workplace         = coalesce(nullif(trim(coalesce(workplace, '')), ''), v_work),
    custom_fields     = coalesce(v_custom, '{}'::jsonb) || coalesce(custom_fields, '{}'::jsonb)
  where id = p_main;

  -- The others: hidden, pointing to the main lead
  update public.leads set deleted_at = now(), merged_into = p_main, merged_at = now()
  where id = any (p_others);

  insert into public.lead_activity (lead_id, user_id, action, details)
  values (p_main, auth.uid(), 'merged',
          jsonb_build_object('merge_id', v_merge, 'names', to_jsonb(v_names), 'count', cardinality(p_others)));
  insert into public.lead_activity (lead_id, user_id, action, details)
  select o, auth.uid(), 'merged_away', jsonb_build_object('merge_id', v_merge, 'into', p_main, 'into_name', v_name)
  from unnest(p_others) o;

  update public.lead_merges set moved = v_moved, added = v_added, names = v_names where id = v_merge;

  -- the cached lines on the lead (fee, payments, papers, visit, next call, last call/note)
  perform public.lead_merge_refresh(p_main);
  -- the alumni who referred these leads: their counts again
  perform public.alumni_recount(a) from (
    select distinct referred_by_alumni_id a from public.leads
    where id = any (v_all) and referred_by_alumni_id is not null) z;
  -- what the merge wrote on the main lead (an undo only puts back what is still so)
  update public.lead_merges set main_after = (select to_jsonb(l) from public.leads l where l.id = p_main)
  where id = v_merge;
  if to_regproc('public.ai_chance_mark') is not null then
    begin
      perform public.ai_chance_mark(array[p_main], false);
    exception when others then null;
    end;
  end if;

  -- 🔔 The people the leads belonged to
  select array_agg(distinct x) into v_users
  from (select assigned_to as x from public.leads where id = any (v_all)
        union select v_main.assigned_to) z
  where x is not null and x is distinct from auth.uid();
  foreach u in array coalesce(v_users, '{}') loop
    perform public.notify(
      u, 'lead_merged',
      '🔗 Leads merged: ' || v_name,
      (cardinality(p_others) + 1) || ' leads are one now · By ' || coalesce(v_who, 'someone'),
      jsonb_build_object('lead_id', p_main)
    );
  end loop;

  perform set_config('app.merging', 'off', true);
  perform set_config('app.handover', 'off', true);
  perform set_config('app.pipeline_action', 'off', true);
  perform set_config('app.call_admin', 'off', true);
  perform set_config('app.note_added', '', true);
  return v_merge;
end;
$$;

revoke all on function public.merge_leads(uuid, uuid[], jsonb) from public;
grant execute on function public.merge_leads(uuid, uuid[], jsonb) to authenticated;
revoke all on function public.merge_leads_apply(uuid, uuid[], jsonb) from public;
grant execute on function public.merge_leads_apply(uuid, uuid[], jsonb) to authenticated;

-- ---------------------------------------------------------------------
-- ↩ unmerge_lead: admins, within 30 days
-- ---------------------------------------------------------------------
create or replace function public.unmerge_lead(p_merge uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  m        public.lead_merges;
  e        jsonb;
  v_before public.leads;
  v_open   boolean;
  v_vals   jsonb;
  v_after  public.leads;
  v_has_after boolean;
begin
  if not public.has_permission('settings.manage') then
    raise exception 'Only an admin can undo a merge.';
  end if;
  select * into m from public.lead_merges where id = p_merge for update;
  if m.id is null or m.undone_at is not null then
    raise exception 'This merge is not found or was undone already.';
  end if;
  if m.merged_at < now() - interval '30 days' then
    raise exception 'A merge can be undone for 30 days only.';
  end if;
  -- the main lead was itself merged (or deleted) since: undo that first
  if exists (select 1 from public.leads where id = m.main_id and (deleted_at is not null or merged_into is not null)) then
    raise exception 'The main lead was merged into another lead, deleted or sent to the Lead Bank since. Bring it back first.';
  end if;

  perform set_config('app.merging', 'on', true);
  perform set_config('app.handover', 'on', true);
  perform set_config('app.pipeline_action', 'on', true);
  perform set_config('app.call_admin', 'on', true);
  perform set_config('app.note_added', 'on', true);

  -- The others come back
  update public.leads set deleted_at = null, merged_into = null, merged_at = null
  where id = any (m.other_ids) and merged_into = m.main_id;

  -- Moved rows go back
  for e in select * from jsonb_array_elements(m.moved) loop
    execute format('update public.%I set lead_id = $1 where lead_id = $2 and id = any ($3)', e->>'t')
    using (e->>'from')::uuid, m.main_id, array(select jsonb_array_elements_text(e->'ids'))::uuid[];
  end loop;

  -- Copied links go (a lead keeps at least one course)
  for e in select * from jsonb_array_elements(m.added) loop
    v_vals := e->'vals';
    if e->>'t' = 'lead_courses' then
      delete from public.lead_courses
      where lead_id = m.main_id
        and course_id = any (array(select jsonb_array_elements_text(v_vals))::uuid[])
        and exists (select 1 from public.lead_courses k where k.lead_id = m.main_id
                    and k.course_id <> all (array(select jsonb_array_elements_text(v_vals))::uuid[]));
    else
      execute format('delete from public.%I where lead_id = $1 and %I = any ($2)', e->>'t', e->>'c')
      using m.main_id, array(select jsonb_array_elements_text(v_vals))::uuid[];
    end if;
  end loop;

  -- The main lead as it was (the stage only while it is still open)
  v_before := jsonb_populate_record(null::public.leads, m.main_before);
  select s.kind = 'open' into v_open from public.leads l join public.pipeline_stages s on s.id = l.stage_id
  where l.id = m.main_id;
  -- a value someone changed after the merge stays as they set it
  v_has_after := m.main_after is not null;
  v_after := jsonb_populate_record(null::public.leads, coalesce(m.main_after, '{}'::jsonb));
  update public.leads l set
    name = case when not v_has_after or l.name is not distinct from v_after.name then v_before.name else l.name end,
    phone = case when not v_has_after or l.phone is not distinct from v_after.phone then v_before.phone else l.phone end,
    alt_phone = case when not v_has_after or l.alt_phone is not distinct from v_after.alt_phone then v_before.alt_phone else l.alt_phone end,
    extra_phones = case when not v_has_after or l.extra_phones is not distinct from v_after.extra_phones
                        then coalesce(v_before.extra_phones, '{}') else l.extra_phones end,
    whatsapp_number = case when not v_has_after or l.whatsapp_number is not distinct from v_after.whatsapp_number then v_before.whatsapp_number else l.whatsapp_number end,
    whatsapp_username = case when not v_has_after or l.whatsapp_username is not distinct from v_after.whatsapp_username then v_before.whatsapp_username else l.whatsapp_username end,
    assigned_to = case when not v_has_after or l.assigned_to is not distinct from v_after.assigned_to then v_before.assigned_to else l.assigned_to end,
    source_id = case when not v_has_after or l.source_id is not distinct from v_after.source_id then v_before.source_id else l.source_id end,
    stage_id = case when v_open and (not v_has_after or l.stage_id is not distinct from v_after.stage_id) then v_before.stage_id else l.stage_id end,
    rating = case when not v_has_after or l.rating is not distinct from v_after.rating then v_before.rating else l.rating end,
    email = case when not v_has_after or l.email is not distinct from v_after.email then v_before.email else l.email end,
    area = case when not v_has_after or l.area is not distinct from v_after.area then v_before.area else l.area end,
    guardian_name = case when not v_has_after or l.guardian_name is not distinct from v_after.guardian_name then v_before.guardian_name else l.guardian_name end,
    guardian_phone = case when not v_has_after or l.guardian_phone is not distinct from v_after.guardian_phone then v_before.guardian_phone else l.guardian_phone end,
    guardian_relation = case when not v_has_after or l.guardian_relation is not distinct from v_after.guardian_relation then v_before.guardian_relation else l.guardian_relation end,
    referred_by = case when not v_has_after or l.referred_by is not distinct from v_after.referred_by then v_before.referred_by else l.referred_by end,
    lead_type_id = case when not v_has_after or l.lead_type_id is not distinct from v_after.lead_type_id then v_before.lead_type_id else l.lead_type_id end,
    campaign_id = case when not v_has_after or l.campaign_id is not distinct from v_after.campaign_id then v_before.campaign_id else l.campaign_id end,
    notes = case when not v_has_after or l.notes is not distinct from v_after.notes then v_before.notes else l.notes end,
    referred_by_alumni_id = case when not v_has_after or l.referred_by_alumni_id is not distinct from v_after.referred_by_alumni_id then v_before.referred_by_alumni_id else l.referred_by_alumni_id end,
    workplace = case when not v_has_after or l.workplace is not distinct from v_after.workplace then v_before.workplace else l.workplace end,
    custom_fields = case when not v_has_after or l.custom_fields is not distinct from v_after.custom_fields then coalesce(v_before.custom_fields, '{}'::jsonb) else l.custom_fields end,
    -- from before the merge (its own calls are added back below)
    last_contacted_at = v_before.last_contacted_at
  where l.id = m.main_id;

  update public.lead_merges set undone_at = now(), undone_by = auth.uid() where id = m.id;

  insert into public.lead_activity (lead_id, user_id, action, details)
  select x, auth.uid(), 'unmerged', jsonb_build_object('merge_id', m.id)
  from unnest(m.main_id || m.other_ids) x;

  -- the cached lines of each lead again (fee, payments, papers, visit, next call, last call/note)
  perform public.lead_merge_refresh(x) from unnest(m.main_id || m.other_ids) x;
  perform public.alumni_recount(a) from (
    select distinct referred_by_alumni_id a from public.leads
    where id = any (m.main_id || m.other_ids) and referred_by_alumni_id is not null) z;

  perform set_config('app.merging', 'off', true);
  perform set_config('app.handover', 'off', true);
  perform set_config('app.pipeline_action', 'off', true);
  perform set_config('app.call_admin', 'off', true);
  perform set_config('app.note_added', '', true);
end;
$$;

revoke all on function public.unmerge_lead(uuid) from public;
grant execute on function public.unmerge_lead(uuid) to authenticated;

-- ---------------------------------------------------------------------
-- ☎ Add a number to a lead (from the duplicate warning)
-- ---------------------------------------------------------------------
create or replace function public.add_lead_phone(p_lead uuid, p_phone text)
returns boolean
language plpgsql
security invoker
set search_path = public
as $$
declare
  v_phone text := public.normalize_bd_phone(p_phone);
  v_n     int;
begin
  if v_phone is null or v_phone !~ '^01[3-9][0-9]{8}$' then
    raise exception 'Not a valid mobile number.';
  end if;
  with u as (
    update public.leads set
      phone = coalesce(phone, v_phone),
      extra_phones = case when phone is null or phone = v_phone or alt_phone = v_phone then extra_phones
                          else extra_phones || v_phone end
    where id = p_lead and deleted_at is null
    returning 1
  )
  select count(*) into v_n from u;
  if v_n = 0 then
    raise exception 'You can’t change this lead.';
  end if;
  return true;
end;
$$;

grant execute on function public.add_lead_phone(uuid, text) to authenticated;

-- =====================================================================
-- ➕ Added when this was brought up to date (Nov 2026)
-- =====================================================================

-- ---------------------------------------------------------------------
-- ☎ A box with three or more mobile numbers: Phone, Alt phone, then the
--   rest go to "More numbers" (only landlines and the like stay in notes)
-- ---------------------------------------------------------------------
create or replace function public.leads_split_phone()
returns trigger
language plpgsql
as $$
declare
  extra text[];
  mob   text[];
  other text[];
begin
  if new.phone is null or new.phone ~ '^01[3-9][0-9]{8}$' then return new; end if;
  extra := public.phone_extras(new.phone);
  if cardinality(extra) = 0 then return new; end if;
  new.phone := public.bd_mobile(new.phone);
  if nullif(trim(coalesce(new.alt_phone, '')), '') is null then
    new.alt_phone := extra[1];
    extra := extra[2:];
  else
    extra := array_remove(extra, public.normalize_bd_phone(new.alt_phone));
  end if;
  mob := array(select x from unnest(extra) x where x ~ '^01[3-9][0-9]{8}$');
  other := array(select x from unnest(extra) x where x !~ '^01[3-9][0-9]{8}$');
  if cardinality(mob) > 0 then
    new.extra_phones := coalesce(new.extra_phones, '{}') || mob;
  end if;
  if cardinality(other) > 0 then
    new.notes := concat_ws(E'\n', nullif(trim(coalesce(new.notes, '')), ''),
                           'Other number: ' || array_to_string(other, ', '));
  end if;
  return new;
end;
$$;

-- ---------------------------------------------------------------------
-- 🔍 Possible duplicates: leads that share a number (phone, alt phone,
--   more numbers or WhatsApp). Only the leads the person can see; groups
--   someone marked "not the same person" stay hidden.
-- ---------------------------------------------------------------------
create table if not exists public.lead_duplicate_ignores (
  ids        uuid[] primary key,          -- sorted
  marked_by  uuid references public.profiles (id) on delete set null default auth.uid(),
  marked_at  timestamptz not null default now()
);
alter table public.lead_duplicate_ignores enable row level security;
drop policy if exists lead_duplicate_ignores_rw on public.lead_duplicate_ignores;
drop policy if exists lead_duplicate_ignores_read on public.lead_duplicate_ignores;
drop policy if exists lead_duplicate_ignores_write on public.lead_duplicate_ignores;
create policy lead_duplicate_ignores_read on public.lead_duplicate_ignores
  for select to authenticated using (true);
create policy lead_duplicate_ignores_write on public.lead_duplicate_ignores
  for insert to authenticated with check ((select public.has_permission('leads.merge')));
grant select, insert on public.lead_duplicate_ignores to authenticated;
grant select on public.lead_merges to authenticated;

-- the numbers (as hashes) a lead can be reached on
create or replace function public.lead_number_hashes(l public.leads)
returns text[]
language sql
immutable
set search_path = public, extensions
as $$
  select array(
    select distinct h from unnest(
      array[l.phone_hash, l.alt_phone_hash,
            case when l.whatsapp_number is not null then encode(digest(l.whatsapp_number, 'sha256'), 'hex') end]
      || coalesce(l.extra_phone_hashes, '{}')
    ) h
    where h is not null);
$$;

-- groups of leads sharing a number → [{ids, number, reason}]
create or replace function public.lead_duplicate_groups(p_limit int default 100)
returns jsonb
language plpgsql
stable
security invoker
set search_path = public, extensions
as $$
declare
  v jsonb;
begin
  if not public.has_permission('leads.merge') then
    raise exception 'You are not allowed to merge leads.';
  end if;
  with seen as (
    select l.id, l.created_at, unnest(public.lead_number_hashes(l)) as h
    from public.leads l
    where l.deleted_at is null and l.merged_into is null
  ),
  g as (
    select h, array_agg(distinct id order by id) as ids, max(created_at) as newest
    from seen
    group by h
    having count(distinct id) > 1
  ),
  u as (
    select ids, max(newest) as newest, min(h) as h
    from g
    where not exists (select 1 from public.lead_duplicate_ignores i where i.ids = g.ids)
    group by ids
    order by max(newest) desc
    limit greatest(1, least(coalesce(p_limit, 100), 500))
  )
  select coalesce(jsonb_agg(jsonb_build_object(
           'ids', to_jsonb(u.ids),
           'number', (select x from public.leads l
                      cross join lateral unnest(array[l.phone, l.alt_phone, l.whatsapp_number] || l.extra_phones) x
                      where l.id = u.ids[1] and x is not null and encode(digest(x, 'sha256'), 'hex') = u.h
                      limit 1),
           'newest', u.newest) order by u.newest desc), '[]'::jsonb)
    into v
  from u;
  return v;
end;
$$;
revoke all on function public.lead_duplicate_groups(int) from public, anon;
grant execute on function public.lead_duplicate_groups(int) to authenticated;

-- other leads sharing a number with this one (for the warning on the lead page)
create or replace function public.lead_duplicates_of(p_lead uuid)
returns table (id uuid, name text, stage text, owner text)
language sql
stable
security invoker
set search_path = public, extensions
as $$
  with me as (select public.lead_number_hashes(l) as hs,
                     array_remove(array[l.phone, l.alt_phone, l.whatsapp_number] || coalesce(l.extra_phones, '{}'), null) as nums
              from public.leads l where l.id = p_lead)
  select o.id, o.name, s.name, p.full_name
  from me
  join public.leads o
    on o.id <> p_lead
   and (o.phone_hash = any (me.hs) or o.alt_phone_hash = any (me.hs) or o.extra_phone_hashes && me.hs
        or o.whatsapp_number = any (me.nums))
  left join public.pipeline_stages s on s.id = o.stage_id
  left join public.profiles p on p.id = o.assigned_to
  where cardinality(me.hs) > 0
    and o.deleted_at is null and o.merged_into is null
    and not exists (select 1 from public.lead_duplicate_ignores i
                    where i.ids = case when p_lead < o.id then array[p_lead, o.id] else array[o.id, p_lead] end)
  order by o.created_at desc
  limit 5;
$$;
revoke all on function public.lead_duplicates_of(uuid) from public, anon;
grant execute on function public.lead_duplicates_of(uuid) to authenticated;

-- "not the same person": hide this group from the list and the warning
create or replace function public.lead_duplicates_ignore(p_ids uuid[])
returns void
language plpgsql
security invoker
set search_path = public
as $$
begin
  if not public.has_permission('leads.merge') then
    raise exception 'You are not allowed to merge leads.';
  end if;
  if cardinality(p_ids) < 2 then return; end if;
  insert into public.lead_duplicate_ignores (ids)
  values ((select array_agg(distinct x order by x) from unnest(p_ids) x))
  on conflict (ids) do nothing;
  -- every pair inside the group too (the lead page warning looks at pairs)
  insert into public.lead_duplicate_ignores (ids)
  select array[a, b] from unnest(p_ids) a cross join unnest(p_ids) b where a < b
  on conflict (ids) do nothing;
end;
$$;
revoke all on function public.lead_duplicates_ignore(uuid[]) from public, anon;
grant execute on function public.lead_duplicates_ignore(uuid[]) to authenticated;

-- ---------------------------------------------------------------------
-- 👀 Before merging: what will move to the main lead (counts)
-- ---------------------------------------------------------------------
create or replace function public.merge_preview(p_main uuid, p_others uuid[])
returns jsonb
language sql
stable
security invoker
set search_path = public
as $$
  select jsonb_build_object(
    'calls',     (select count(*) from public.call_logs where lead_id = any (p_others) and deleted_at is null),
    'notes',     (select count(*) from public.lead_activity where lead_id = any (p_others) and action = 'note'),
    -- a next call moves only when the main lead has none (one next call per lead)
    'follow_ups',(select count(*) from public.follow_ups f where f.lead_id = any (p_others) and f.status = 'pending'
                   and not exists (select 1 from public.follow_ups x where x.lead_id = p_main and x.status = 'pending')),
    'visits',    (select count(*) from public.lead_visits v where v.lead_id = any (p_others)
                   and (v.status <> 'planned'
                        or not exists (select 1 from public.lead_visits x where x.lead_id = p_main and x.status = 'planned'))),
    'files',     (select count(*) from public.lead_files where lead_id = any (p_others)),
    'payments',  (select count(*) from public.fee_payments where lead_id = any (p_others)),
    'sms',       (select count(*) from public.sms_messages where lead_id = any (p_others))
  );
$$;
revoke all on function public.merge_preview(uuid, uuid[]) from public, anon;
grant execute on function public.merge_preview(uuid, uuid[]) to authenticated;

-- a merge / undo may put back an assignee even when assigning is off in Settings
create or replace function public.check_lead_reassign()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_cfg jsonb := public.assignment_setting();
begin
  if new.assigned_to is not distinct from old.assigned_to then
    return new;
  end if;

  -- Database tools / server jobs
  if auth.uid() is null then
    new.assignment_method := 'manual';
    return new;
  end if;

  -- 🔗 a merge or its undo (checked in merge_leads / unmerge_lead)
  if coalesce(current_setting('app.merging', true), '') = 'on' then
    new.assignment_method := 'manual';
    return new;
  end if;

  if not coalesce((v_cfg->>'enabled')::boolean, true) then
    raise exception 'Lead assignment is turned off in Settings.';
  end if;

  -- A hand over (checked in hand_over_leads)
  if coalesce(current_setting('app.handover', true), '') = 'on' then
    new.assignment_method := 'manual';
    return new;
  end if;

  if not public.can_assign_to(new.assigned_to) then
    raise exception 'You cannot assign leads to this person.';
  end if;

  new.assignment_method := 'manual';
  return new;
end;
$$;

notify pgrst, 'reload schema';
