-- =====================================================================
-- 0008 · Import (Excel / CSV) and export of leads
-- =====================================================================

-- ---------------------------------------------------------------------
-- Import batches (one row per import, used for history and undo)
-- ---------------------------------------------------------------------
create table public.import_batches (
  id           uuid primary key default gen_random_uuid(),
  file_name    text,
  settings     jsonb not null default '{}'::jsonb,
  created      integer not null default 0,
  updated      integer not null default 0,
  skipped      integer not null default 0,
  failed       integer not null default 0,
  rr_index     integer not null default 0,     -- round-robin position across chunks
  created_by   uuid references auth.users (id),
  created_at   timestamptz not null default now(),
  undone_at    timestamptz
);

-- Which import created a lead (so it can be undone)
alter table public.leads
  add column import_batch_id uuid references public.import_batches (id);

create index leads_import_batch_idx on public.leads (import_batch_id);

-- ---------------------------------------------------------------------
-- Export log (who exported how many leads, and when)
-- ---------------------------------------------------------------------
create table public.export_logs (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null references auth.users (id),
  row_count   integer not null,
  filters     jsonb not null default '{}'::jsonb,
  created_at  timestamptz not null default now()
);

-- ---------------------------------------------------------------------
-- RLS
-- ---------------------------------------------------------------------
alter table public.import_batches enable row level security;
alter table public.export_logs   enable row level security;

create policy "import_batches_read" on public.import_batches
  for select to authenticated
  using (public.has_permission('import.run'));

-- (import batches are written only by the functions below)

create policy "export_logs_insert" on public.export_logs
  for insert to authenticated
  with check (public.has_permission('leads.export') and user_id = auth.uid());

create policy "export_logs_read" on public.export_logs
  for select to authenticated
  using (public.has_permission('users.manage'));

-- =====================================================================
-- import_leads: import one chunk of rows
--
-- p_rows    : [{ "row": 2, "name": "...", "phone": "...", "alt_phone": "...",
--                "email": "...", "area": "...", "guardian_name": "...",
--                "guardian_phone": "...", "guardian_relation": "...",
--                "source": "Facebook", "course": "BBA", "notes": "..." }, ...]
-- p_options : { "batch_id": null | uuid,          -- null on the first chunk
--               "file_name": "leads.xlsx",
--               "default_source_id": uuid | null,
--               "duplicate_mode": "skip" | "update" | "create",
--               "assign_mode": "none" | "user" | "round_robin",
--               "assign_user_id": uuid | null,
--               "round_robin_user_ids": [uuid, ...] }
-- returns   : { batch_id, created, updated, skipped, errors: [{ row, reason }] }
-- =====================================================================
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

    -- Required fields
    if v_name = '' or v_phone is null then
      v_errors := v_errors || jsonb_build_object('row', v_row_no, 'reason', 'Name or phone is missing');
      continue;
    end if;

    if v_phone !~ '^01[3-9][0-9]{8}$' then
      v_errors := v_errors || jsonb_build_object('row', v_row_no, 'reason', 'Invalid mobile number: ' || (r ->> 'phone'));
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

    -- Duplicate?
    select id into v_existing_id
    from public.leads
    where deleted_at is null
      and v_phone in (phone, alt_phone, guardian_phone)
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
        notes             = coalesce(notes, nullif(trim(r ->> 'notes'), ''))
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
      source_id, stage_id, assigned_to, notes, import_batch_id
    ) values (
      v_name, v_phone,
      nullif(trim(r ->> 'alt_phone'), ''),
      nullif(trim(r ->> 'email'), ''),
      nullif(trim(r ->> 'area'), ''),
      nullif(trim(r ->> 'guardian_name'), ''),
      nullif(trim(r ->> 'guardian_phone'), ''),
      nullif(trim(r ->> 'guardian_relation'), ''),
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

-- =====================================================================
-- undo_import: hide every lead an import created (within 24 hours)
-- =====================================================================
create or replace function public.undo_import(p_batch_id uuid)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  v_batch public.import_batches%rowtype;
  v_count integer;
begin
  if not public.has_permission('import.run') then
    raise exception 'You are not allowed to undo imports';
  end if;

  select * into v_batch from public.import_batches where id = p_batch_id for update;

  if not found then
    raise exception 'Import not found';
  end if;
  if v_batch.undone_at is not null then
    raise exception 'This import has already been undone';
  end if;
  if v_batch.created_at < now() - interval '24 hours' then
    raise exception 'Imports can only be undone within 24 hours';
  end if;

  update public.leads
  set deleted_at = now()
  where import_batch_id = p_batch_id
    and deleted_at is null;

  get diagnostics v_count = row_count;

  update public.import_batches set undone_at = now() where id = p_batch_id;

  return v_count;
end;
$$;

-- ---------------------------------------------------------------------
-- Who may call the functions
-- ---------------------------------------------------------------------
revoke all on function public.import_leads(jsonb, jsonb) from public;
grant execute on function public.import_leads(jsonb, jsonb) to authenticated;

revoke all on function public.undo_import(uuid) from public;
grant execute on function public.undo_import(uuid) to authenticated;