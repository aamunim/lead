-- =====================================================================
-- 🎓 Every new lead needs an interested course
--   * create_lead(): the lead, its courses and tags in one go
--   * a check at the end of each change: a new lead has a course, and the
--     last course of a lead cannot be taken off
--   * save from phone contacts and Excel import need a course too
--   (Not checked while no course is set up, or for leads already admitted.)
-- =====================================================================

create or replace function public.lead_course_ok(p_lead uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select
    not exists (select 1 from public.courses where is_active)
    or exists (select 1 from public.lead_courses c where c.lead_id = p_lead)
    or not exists (
      select 1 from public.leads l
      where l.id = p_lead and l.deleted_at is null and l.admitted_course_id is null
    );
$$;

create or replace function public.check_lead_course()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_lead uuid;
begin
  if tg_table_name = 'leads' then
    v_lead := new.id;
  else
    v_lead := old.lead_id;
    -- the course itself was deleted (Settings): nothing to check
    if not exists (select 1 from public.courses where id = old.course_id) then
      return null;
    end if;
  end if;
  if not public.lead_course_ok(v_lead) then
    raise exception 'Please choose an interested course.' using hint = 'course_required';
  end if;
  return null;
end;
$$;

drop trigger if exists leads_need_course on public.leads;
create constraint trigger leads_need_course
  after insert on public.leads
  deferrable initially deferred
  for each row execute function public.check_lead_course();

drop trigger if exists lead_courses_keep_one on public.lead_courses;
create constraint trigger lead_courses_keep_one
  after delete on public.lead_courses
  deferrable initially deferred
  for each row execute function public.check_lead_course();

-- ---------------------------------------------------------------------
-- New lead: row + courses + tags in one transaction (security rules apply)
-- ---------------------------------------------------------------------
create or replace function public.create_lead(p_row jsonb, p_course_ids uuid[], p_tag_ids uuid[] default '{}')
returns uuid
language plpgsql
security invoker
set search_path = public
as $$
declare
  v_cols text;
  v_id   uuid;
begin
  if coalesce(array_length(p_course_ids, 1), 0) = 0 and exists (select 1 from public.courses where is_active) then
    raise exception 'Please choose an interested course.' using hint = 'course_required';
  end if;

  -- only the columns that were sent (the others keep their defaults)
  select string_agg(quote_ident(a.attname), ', ')
  into v_cols
  from pg_attribute a
  where a.attrelid = 'public.leads'::regclass
    and a.attnum > 0 and not a.attisdropped
    and a.attname <> 'id'
    and p_row ? a.attname;

  if v_cols is null then
    raise exception 'Nothing to save';
  end if;

  execute format(
    'insert into public.leads (%1$s) select %1$s from jsonb_populate_record(null::public.leads, $1) returning id',
    v_cols
  ) into v_id using p_row;

  insert into public.lead_courses (lead_id, course_id)
  select v_id, c from unnest(coalesce(p_course_ids, '{}')) c
  on conflict do nothing;

  insert into public.lead_tags (lead_id, tag_id)
  select v_id, t from unnest(coalesce(p_tag_ids, '{}')) t
  on conflict do nothing;

  return v_id;
end;
$$;

revoke all on function public.create_lead(jsonb, uuid[], uuid[]) from public;
grant execute on function public.create_lead(jsonb, uuid[], uuid[]) to authenticated;

-- ---------------------------------------------------------------------
-- 📇 Save from phone contacts: a course is needed
-- ---------------------------------------------------------------------
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
         where l.deleted_at is null and (l.phone = v_phone or l.alt_phone = v_phone)
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
      v_phone,
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

-- ---------------------------------------------------------------------
-- 📥 Excel import: a row with no known course uses the chosen course
-- ---------------------------------------------------------------------
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
      where lower(name) = lower(trim(r ->> 'course')) limit 1;
    end if;
    v_course_id := coalesce(v_course_id, v_default_crs);

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
$function$;
