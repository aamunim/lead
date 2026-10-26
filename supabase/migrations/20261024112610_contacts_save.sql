-- =====================================================================
-- Save marked phone contacts as leads (with undo)
-- =====================================================================

-- p_rows:    [{"name": "...", "phone": "..."}, ...]
-- p_options: {"source_id", "rating", "tag_ids": [], "course_ids": [],
--             "assigned_to", "assign_manual": true|false}
-- Returns:   {"created": n, "created_ids": [...], "already_leads": n, "invalid": n}
create or replace function public.save_contacts_as_leads(p_rows jsonb, p_options jsonb default '{}'::jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
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
$$;

grant execute on function public.save_contacts_as_leads(jsonb, jsonb) to authenticated;

-- ---------------------------------------------------------------------
-- Undo: remove leads you just saved from contacts (within 24 hours).
-- Uses a flag so the "delete needs permission" check lets this through,
-- because the user is only taking back what they themselves just added.
-- ---------------------------------------------------------------------
create or replace function public.check_lead_delete_permission()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if new.deleted_at is distinct from old.deleted_at
     and auth.uid() is not null
     and coalesce(current_setting('app.contacts_undo', true), '') <> 'on'
     and not public.has_permission('leads.delete') then
    raise exception 'You do not have permission to delete or restore leads.';
  end if;
  return new;
end;
$$;

create or replace function public.undo_contacts_save(p_lead_ids uuid[])
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  v_count integer;
begin
  perform set_config('app.contacts_undo', 'on', true);

  update public.leads
     set deleted_at = now()
   where id = any(p_lead_ids)
     and created_by = auth.uid()
     and created_at > now() - interval '24 hours'
     and deleted_at is null;

  get diagnostics v_count = row_count;
  return v_count;
end;
$$;

grant execute on function public.undo_contacts_save(uuid[]) to authenticated;

notify pgrst, 'reload schema';