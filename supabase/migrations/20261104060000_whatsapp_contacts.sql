-- =====================================================================
-- Leads with only WhatsApp (no phone number)
--   1. WhatsApp number (any country) and WhatsApp username on a lead
--   2. Phone is no longer required: phone, WhatsApp number or username,
--      at least one of them
--   3. Duplicate check, import and the phone's lead directory know about it
-- =====================================================================

-- ---------------------------------------------------------------------
-- 1. Tidy helpers
-- ---------------------------------------------------------------------
-- WhatsApp number: a Bangladeshi mobile is kept like phone (01711…),
-- any other country as +<digits> (00971… / +971… → +971…)
create or replace function public.normalize_wa_number(p text)
returns text
language plpgsql
immutable
as $$
declare
  d  text;
  bd text;
begin
  if p is null then return null; end if;
  d := regexp_replace(p, '\D', '', 'g');
  if d = '' then return null; end if;

  bd := public.normalize_bd_phone(d);
  if bd ~ '^01[3-9][0-9]{8}$' and not (trim(p) like '+%' and d not like '880%') then
    return bd;
  end if;

  if d like '00%' then d := substr(d, 3); end if;
  return '+' || d;
end;
$$;

-- WhatsApp username: lower case, no "@" in front
create or replace function public.normalize_wa_username(p text)
returns text
language sql
immutable
as $$
  select nullif(lower(regexp_replace(trim(coalesce(p, '')), '^@+', '')), '');
$$;

-- What to show for a lead when there may be no phone
create or replace function public.lead_contact_label(p_phone text, p_wa_number text, p_wa_username text)
returns text
language sql
immutable
as $$
  select coalesce(p_phone, p_wa_number, '@' || p_wa_username);
$$;

-- ---------------------------------------------------------------------
-- 2. New columns; phone not required any more
-- ---------------------------------------------------------------------
alter table public.leads
  add column if not exists whatsapp_number   text,
  add column if not exists whatsapp_username text;

alter table public.leads alter column phone drop not null;

alter table public.leads drop constraint if exists leads_contact_check;
alter table public.leads add constraint leads_contact_check
  check (phone is not null or whatsapp_number is not null or whatsapp_username is not null);

create index if not exists leads_whatsapp_number_idx on public.leads (whatsapp_number) where whatsapp_number is not null;
create index if not exists leads_whatsapp_username_idx on public.leads (whatsapp_username) where whatsapp_username is not null;

-- ---------------------------------------------------------------------
-- 3. Before saving a lead (replaces the version in 20261102060000):
--    same rules, plus the WhatsApp fields
-- ---------------------------------------------------------------------
create or replace function public.leads_before_write()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  new.name              := trim(new.name);
  new.phone             := public.normalize_bd_phone(new.phone);
  new.alt_phone         := public.normalize_bd_phone(new.alt_phone);
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
       and not public.has_permission('leads.edit_all') then
      raise exception 'The original source of a lead cannot be changed';
    end if;

    if new.assigned_to is distinct from old.assigned_to
       and not public.has_permission('leads.assign')
       and coalesce(current_setting('app.handover', true), '') <> 'on' then
      raise exception 'You are not allowed to reassign leads';
    end if;

    if new.deleted_at is distinct from old.deleted_at
       and not public.has_permission('leads.delete') then
      raise exception 'You are not allowed to delete leads';
    end if;

    new.created_by := old.created_by;
    new.created_at := old.created_at;
  end if;

  return new;
end;
$$;

-- Change log lines for the WhatsApp fields (Team activity → Change log)
create or replace function public.log_lead_whatsapp_changes()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_changes jsonb := '[]'::jsonb;
begin
  if new.whatsapp_number is distinct from old.whatsapp_number then
    v_changes := v_changes || jsonb_build_object('field', 'WhatsApp number', 'from', old.whatsapp_number, 'to', new.whatsapp_number);
  end if;
  if new.whatsapp_username is distinct from old.whatsapp_username then
    v_changes := v_changes || jsonb_build_object('field', 'WhatsApp username', 'from', old.whatsapp_username, 'to', new.whatsapp_username);
  end if;
  if jsonb_array_length(v_changes) > 0 then
    insert into public.lead_activity (lead_id, user_id, action, details)
    values (new.id, auth.uid(), 'fields_changed', jsonb_build_object('changes', v_changes));
  end if;
  return null;
end;
$$;

drop trigger if exists leads_log_whatsapp_changes on public.leads;
create trigger leads_log_whatsapp_changes
  after update of whatsapp_number, whatsapp_username on public.leads
  for each row execute function public.log_lead_whatsapp_changes();

-- ---------------------------------------------------------------------
-- 4. Duplicate check by phone, WhatsApp number or username
--    (find_leads_by_phone stays for older app versions)
-- ---------------------------------------------------------------------
create or replace function public.find_leads_by_contact(
  p_phone             text default null,
  p_whatsapp_number   text default null,
  p_whatsapp_username text default null,
  p_exclude_id        uuid default null
)
returns table (
  id               uuid,
  name             text,
  phone            text,
  stage_name       text,
  assigned_to_name text,
  can_open         boolean,
  matched          text      -- 'phone' | 'whatsapp_number' | 'whatsapp_username'
)
language sql
stable
security definer
set search_path = public
as $$
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
      when q.wa is not null and q.wa in (l.whatsapp_number, l.phone, l.alt_phone) then 'whatsapp_number'
      else 'phone'
    end
  from q, public.leads l
  join public.pipeline_stages s on s.id = l.stage_id
  left join public.profiles p on p.id = l.assigned_to
  where public.is_active_user()
    and l.deleted_at is null
    and (p_exclude_id is null or l.id <> p_exclude_id)
    and (
      (q.phone is not null and q.phone in (l.phone, l.alt_phone, l.guardian_phone, l.whatsapp_number))
      or (q.wa is not null and q.wa in (l.whatsapp_number, l.phone, l.alt_phone))
      or (q.un is not null and l.whatsapp_username = q.un)
    )
  limit 5;
$$;

revoke all on function public.find_leads_by_contact(text, text, text, uuid) from public;
grant execute on function public.find_leads_by_contact(text, text, text, uuid) to authenticated;

-- ---------------------------------------------------------------------
-- 5. The phone's lead directory: leads without a phone are left out
--    (replaces the version in 20261025041859; same columns)
-- ---------------------------------------------------------------------
create or replace function public.my_lead_directory()
returns table (hash text, lead_id uuid, name text, rating text, stage text, course text, last_note text)
language sql
stable
security invoker
set search_path = public, extensions
as $$
  with visible as (
    select
      l.id, l.name, l.rating, l.phone, l.alt_phone,
      case s.kind
        when 'won'       then '🎓 Admitted' || coalesce(' · ' || b.name, '')
        when 'lost'      then '✕ Lost' || coalesce(' · ' || lr.name, '')
        when 'cancelled' then 'Admission cancelled'
        else s.name
      end as stage,
      coalesce(
        ac.name,
        (select c.name from public.lead_courses lc join public.courses c on c.id = lc.course_id
          where lc.lead_id = l.id limit 1)
      ) as course,
      (select cl.notes from public.call_logs cl
        where cl.lead_id = l.id and cl.notes is not null
        order by cl.called_at desc limit 1) as last_note
    from public.leads l
    left join public.pipeline_stages s on s.id = l.stage_id
    left join public.courses ac on ac.id = l.admitted_course_id and s.kind = 'won'
    left join public.batches b on b.id = l.admitted_batch_id
    left join public.lost_reasons lr on lr.id = l.lost_reason_id
    where l.deleted_at is null
      and (l.phone is not null or l.alt_phone is not null)
    order by l.updated_at desc nulls last
    limit 10000
  )
  select encode(digest(v.phone, 'sha256'), 'hex'), v.id, v.name, v.rating, v.stage, v.course, left(v.last_note, 120)
  from visible v
  where v.phone is not null
  union all
  select encode(digest(v.alt_phone, 'sha256'), 'hex'), v.id, v.name, v.rating, v.stage, v.course, left(v.last_note, 120)
  from visible v
  where v.alt_phone is not null;
$$;

grant execute on function public.my_lead_directory() to authenticated;

-- ---------------------------------------------------------------------
-- 6. "Lead given to you": the name alone when there is no phone
--    (replaces the version in 20261102060000)
-- ---------------------------------------------------------------------
create or replace function public.notify_assigned(p_rows jsonb)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  r        record;
  v_who    text := public.person_name(auth.uid());
  v_note   text := nullif(current_setting('app.handover_note', true), '');
  v_urgent boolean := coalesce((public.notification_setting() ->> 'assigned_in_quiet_hours')::boolean, true);
begin
  for r in
    select x.assigned_to as user_id, array_agg(x.id) as ids, min(x.name) as first_name,
           min(x.phone) as first_phone, count(*) as n, bool_and(x.auto) as auto
    from jsonb_to_recordset(coalesce(p_rows, '[]'::jsonb))
         as x(id uuid, name text, phone text, assigned_to uuid, auto boolean)
    group by x.assigned_to
  loop
    perform public.notify(
      r.user_id,
      case when r.auto then 'auto_assigned' else 'assigned' end,
      case
        when r.n = 1 then '👥 ' || case when r.auto then 'A new lead for you' else v_who || ' gave you a lead' end
        else '👥 ' || case when r.auto then r.n || ' new leads for you' else v_who || ' gave you ' || r.n || ' leads' end
      end,
      concat_ws(E'\n',
        case when r.n = 1 then concat_ws(' · ', r.first_name, r.first_phone) else 'Tap to see them.' end,
        case when v_note is not null then '“' || v_note || '”' end),
      case when r.n = 1 then jsonb_build_object('lead_id', r.ids[1]) else jsonb_build_object('lead_ids', to_jsonb(r.ids)) end,
      null,
      v_urgent and not r.auto
    );
  end loop;
end;
$$;

-- ---------------------------------------------------------------------
-- 7. Import (replaces the version in 20261023105419):
--    a row needs a name and one of phone / whatsapp_number / whatsapp_username
--    p_rows may now also hold "whatsapp_number" and "whatsapp_username"
-- ---------------------------------------------------------------------
create or replace function public.import_leads(p_rows jsonb, p_options jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_batch_id     uuid := nullif(p_options ->> 'batch_id', '')::uuid;
  v_default_src  uuid := nullif(p_options ->> 'default_source_id', '')::uuid;
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
      where lower(name) = lower(trim(r ->> 'course')) limit 1;
    end if;

    -- Duplicate? (phone, WhatsApp number or username)
    select id into v_existing_id
    from public.leads
    where deleted_at is null
      and (
        (v_phone is not null and v_phone in (phone, alt_phone, guardian_phone, whatsapp_number))
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
        phone             = coalesce(phone, v_phone),
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
      v_name, v_phone,
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
$$;
