-- =====================================================================
-- 🎓 Student ID rules for each course, batch and section
--   The most exact rule wins: section → batch → course → the default
--   pattern (Settings → Admission). A rule is either
--     🔤 a pattern  ({YY}{000}, {CODE}-{YY}-{000} …; its own number series)
--     🔢 a range    (27001 – 27110: the next free number in it)
--   A full range stops the admission (with a clear message).
--   Mark admitted now asks for the section (when the batch has any), and
--   the ID is given from the section's rule. Moving a student to another
--   section / batch / course gives a new ID; the old one stays in the log.
-- =====================================================================

create table if not exists public.student_id_rules (
  id          uuid primary key default gen_random_uuid(),
  course_id   uuid references public.courses(id) on delete cascade,
  batch_id    uuid references public.batches(id) on delete cascade,
  section_id  uuid references public.batch_sections(id) on delete cascade,
  kind        text not null check (kind in ('pattern', 'range')),
  pattern     text,
  range_start bigint,
  range_end   bigint,
  updated_at  timestamptz not null default now(),
  updated_by  uuid references public.profiles(id) on delete set null,
  check (num_nonnulls(course_id, batch_id, section_id) = 1),
  check ((kind = 'pattern' and pattern ~ '\{0+\}')
      or (kind = 'range' and range_start > 0 and range_end >= range_start))
);
create unique index if not exists student_id_rules_course_key on public.student_id_rules (course_id) where course_id is not null;
create unique index if not exists student_id_rules_batch_key on public.student_id_rules (batch_id) where batch_id is not null;
create unique index if not exists student_id_rules_section_key on public.student_id_rules (section_id) where section_id is not null;
alter table public.student_id_rules enable row level security;
grant select on public.student_id_rules to authenticated;
drop policy if exists "student id rules: read" on public.student_id_rules;
create policy "student id rules: read" on public.student_id_rules for select to authenticated using (public.is_active_user());
-- written only through save_student_id_rule

-- The rule for a placement (null = the default pattern)
create or replace function public.student_id_rule_for(p_course uuid, p_batch uuid, p_section uuid)
returns public.student_id_rules
language sql
stable
security definer
set search_path = public
as $$
  select r.* from public.student_id_rules r
  where (p_section is not null and r.section_id = p_section)
     or (p_batch is not null and r.batch_id = p_batch)
     or (p_course is not null and r.course_id = p_course)
  order by case when r.section_id is not null then 1 when r.batch_id is not null then 2 else 3 end
  limit 1;
$$;

-- Words for a rule's place: "B.Ed · Jan 2027 · Section A"
create or replace function public.student_id_rule_label(r public.student_id_rules)
returns text
language sql
stable
security definer
set search_path = public
as $$
  select case
    when r.section_id is not null then
      (select concat_ws(' · ', c.name, b.name, 'Section ' || s.name)
         from public.batch_sections s join public.batches b on b.id = s.batch_id join public.courses c on c.id = b.course_id
        where s.id = r.section_id)
    when r.batch_id is not null then
      (select concat_ws(' · ', c.name, b.name) from public.batches b join public.courses c on c.id = b.course_id where b.id = r.batch_id)
    else (select name from public.courses where id = r.course_id)
  end;
$$;

-- The first free number of a range (p_self: this lead's own ID does not count as taken)
create or replace function public.student_id_range_free(p_start bigint, p_end bigint, p_self uuid default null)
returns bigint
language sql
stable
security definer
set search_path = public
as $$
  select n from generate_series(p_start, p_end) n
  where not exists (
    select 1 from public.leads l
    where l.student_ref is not null and lower(l.student_ref) = n::text and l.id is distinct from p_self)
  order by n
  limit 1;
$$;

-- ---------------------------------------------------------------------
-- Giving an ID (inside the database only: no permission check here)
-- ---------------------------------------------------------------------
create or replace function public.student_ref_take(
  p_course uuid, p_batch uuid, p_section uuid, p_self uuid default null, p_preview boolean default false)
returns text
language plpgsql
security definer
set search_path = public
as $$
declare
  r         public.student_id_rules := public.student_id_rule_for(p_course, p_batch, p_section);
  v_pattern text;
  v_year    int := public.student_ref_year(p_batch);
  v_code    text := (select code from public.courses where id = p_course);
  v_scope   text;
  v_n       int;
  v_free    bigint;
  v_ref     text;
begin
  if r.id is not null and r.kind = 'range' then
    if not p_preview then perform pg_advisory_xact_lock(hashtext('student-id-rule:' || r.id::text)); end if;
    v_free := public.student_id_range_free(r.range_start, r.range_end, p_self);
    if v_free is null then
      if p_preview then return null; end if;
      raise exception 'All student IDs of % (% – %) are used. Make the range bigger in Settings → Student ID rules.',
        public.student_id_rule_label(r), r.range_start, r.range_end;
    end if;
    return v_free::text;
  end if;

  v_pattern := case when r.id is not null then r.pattern else public.admission_setting()->'student_id'->>'pattern' end;
  -- a course / batch / section pattern counts on its own; the default as before
  v_scope := case when r.id is not null then 'rule:' || r.id::text || ':' else '' end
             || public.student_ref_scope_for(v_pattern, v_year, v_code);
  v_n := coalesce((select last_value from public.admission_counters where scope = v_scope), 0);
  loop
    v_n := v_n + 1;
    v_ref := public.format_student_ref_for(v_pattern, v_n, v_year, v_code);
    exit when not exists (
      select 1 from public.leads where lower(student_ref) = lower(v_ref) and id is distinct from p_self);
  end loop;
  if not p_preview then
    insert into public.admission_counters (scope, last_value) values (v_scope, v_n)
    on conflict (scope) do update set last_value = greatest(admission_counters.last_value, excluded.last_value);
  end if;
  return v_ref;
end;
$$;
revoke all on function public.student_ref_take(uuid, uuid, uuid, uuid, boolean) from public, anon, authenticated;

-- What the next ID will be (null = the range is full)
drop function if exists public.preview_student_ref(uuid, uuid);
create or replace function public.preview_student_ref(p_course uuid default null, p_batch uuid default null, p_section uuid default null)
returns text
language sql
stable
security definer
set search_path = public
as $$ select public.student_ref_take(p_course, p_batch, p_section, null, true); $$;
grant execute on function public.preview_student_ref(uuid, uuid, uuid) to authenticated;

create or replace function public.next_student_ref(p_course uuid, p_batch uuid, p_section uuid)
returns text
language plpgsql
security definer
set search_path = public
as $$
begin
  if not public.can_mark_admitted() then raise exception 'You can''t admit students.'; end if;
  return public.student_ref_take(p_course, p_batch, p_section);
end;
$$;
grant execute on function public.next_student_ref(uuid, uuid, uuid) to authenticated;

create or replace function public.next_student_ref(p_course uuid, p_batch uuid)
returns text
language sql
security definer
set search_path = public
as $$ select public.next_student_ref(p_course, p_batch, null::uuid); $$;

-- ---------------------------------------------------------------------
-- Mark admitted: the section too (needed when the batch has sections)
-- ---------------------------------------------------------------------
drop function if exists public.mark_admitted(uuid, uuid, uuid, timestamptz, text, text);
create or replace function public.mark_admitted(
  p_lead_id     uuid,
  p_course_id   uuid,
  p_batch_id    uuid default null,
  p_admitted_at timestamptz default null,
  p_student_ref text default null,
  p_note        text default null,
  p_section_id  uuid default null
)
returns jsonb
language plpgsql
set search_path to 'public'
as $function$
declare
  v_cfg        jsonb := public.admission_setting();
  v_kind       text;
  v_ref        text;
  v_old_ref    text;
  v_batch      record;
  v_taken      int;
  v_capacity   int;
  v_seats_left int;
  v_mode       text := coalesce(v_cfg->'student_id'->>'mode', 'auto');
  v_note       text := nullif(trim(coalesce(p_note, '')), '');
  v_rows       int;
begin
  if not public.can_mark_admitted() then
    raise exception 'You are not allowed to mark admissions.';
  end if;

  select s.kind, l.student_ref into v_kind, v_old_ref
  from public.leads l
  join public.pipeline_stages s on s.id = l.stage_id
  where l.id = p_lead_id and l.deleted_at is null;

  if v_kind is null then raise exception 'Lead not found.'; end if;
  if v_kind = 'won' then raise exception 'This lead is already admitted.'; end if;
  if v_kind = 'cancelled' then raise exception 'This admission was cancelled. Reopen the lead first.'; end if;

  if p_course_id is null then raise exception 'Please choose a course.'; end if;
  if not exists (select 1 from public.courses where id = p_course_id and is_active) then
    raise exception 'That course is not available.';
  end if;

  if p_batch_id is null and coalesce((v_cfg->>'batch_required')::boolean, false) then
    raise exception 'Please choose a batch.';
  end if;

  if p_batch_id is not null then
    perform pg_advisory_xact_lock(hashtext('batch:' || p_batch_id::text));

    select id, course_id, name, seat_capacity, is_active into v_batch
    from public.batches where id = p_batch_id;

    if not found or not v_batch.is_active then raise exception 'That batch is not available.'; end if;
    if v_batch.course_id <> p_course_id then raise exception 'That batch belongs to another course.'; end if;

    -- 🏫 the section: needed when the batch has sections
    if p_section_id is null then
      if exists (select 1 from public.batch_sections where batch_id = p_batch_id and is_active) then
        raise exception 'Please choose a section.';
      end if;
    elsif not exists (select 1 from public.batch_sections where id = p_section_id and batch_id = p_batch_id and is_active) then
      raise exception 'That section is not in this batch.';
    end if;

    v_capacity := v_batch.seat_capacity;
    v_taken := public.batch_seats_taken(p_batch_id);
    if v_capacity is not null
       and v_taken >= v_capacity
       and not coalesce((v_cfg->>'allow_overbooking')::boolean, false) then
      raise exception '% is full (% of % seats).', v_batch.name, v_taken, v_capacity;
    end if;
  elsif p_section_id is not null then
    raise exception 'Choose the batch of that section.';
  end if;

  -- Student ID (from the section's / batch's / course's rule)
  v_ref := nullif(trim(coalesce(p_student_ref, '')), '');
  if v_mode = 'off' then
    v_ref := v_old_ref;
  elsif v_mode = 'manual' then
    v_ref := coalesce(v_ref, v_old_ref);
    if v_ref is null then raise exception 'Please type the student ID.'; end if;
  else -- auto: a kept old ID is used again only when the rule has no range
    v_ref := coalesce(v_ref,
                      case when (public.student_id_rule_for(p_course_id, p_batch_id, p_section_id)).kind = 'range'
                           then null else v_old_ref end,
                      public.next_student_ref(p_course_id, p_batch_id, p_section_id));
  end if;

  if v_ref is not null and exists (
    select 1 from public.leads where lower(student_ref) = lower(v_ref) and id <> p_lead_id
  ) then
    raise exception 'Student ID % is already used.', v_ref;
  end if;

  perform set_config('app.pipeline_action', 'on', true);
  perform set_config('app.stage_note', coalesce(v_note, ''), true);
  perform set_config('app.admit_section', coalesce(p_section_id::text, ''), true);

  update public.leads
     set stage_id            = public.stage_of_kind('won'),
         admitted_at         = coalesce(p_admitted_at, now()),
         admitted_by         = auth.uid(),
         admitted_course_id  = p_course_id,
         admitted_batch_id   = p_batch_id,
         admitted_section_id = p_section_id,
         student_ref         = v_ref,
         admission_note      = v_note,
         closed_at           = now(),
         lost_reason_id      = null,
         lost_at             = null,
         lost_by             = null,
         lost_note           = null,
         cancelled_at        = null,
         cancelled_by        = null,
         cancel_reason       = null,
         call_attempts       = 0,
         unreachable_at      = null
   where id = p_lead_id;

  get diagnostics v_rows = row_count;
  perform set_config('app.admit_section', '', true);
  if v_rows = 0 then raise exception 'You can''t change this lead.'; end if;

  perform public.finish_pending_follow_up(p_lead_id);

  begin
    insert into public.lead_courses (lead_id, course_id) values (p_lead_id, p_course_id)
    on conflict do nothing;
  exception when others then
    null;
  end;

  if p_batch_id is not null and v_capacity is not null then
    v_seats_left := greatest(v_capacity - public.batch_seats_taken(p_batch_id), 0);
  end if;

  return jsonb_build_object('student_ref', v_ref, 'seats_left', v_seats_left);
end;
$function$;
grant execute on function public.mark_admitted(uuid, uuid, uuid, timestamptz, text, text, uuid) to authenticated;

-- The approval check no longer clears the section chosen while admitting
create or replace function public.leads_admission_approval()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_by_rpc boolean := coalesce(current_setting('app.admission_approval', true), '') = 'on';
  v_admit_section text := coalesce(current_setting('app.admit_section', true), '');
  r        record;
begin
  if new.admitted_at is not null and old.admitted_at is null then
    new.approval_status := 'waiting';
    new.approval_by := null;
    new.approval_at := null;
    new.approval_note := null;
    new.nu_admission_id := null;
    new.admitted_section_id := nullif(v_admit_section, '')::uuid;
    new.registration_status := null;
    new.registration_by := null;
    new.registration_at := null;
    new.registration_note := null;
    for r in
      select p.id from public.profiles p
      where p.is_active and p.id is distinct from new.admitted_by and public.can_approve_admission(p.id)
    loop
      perform public.notify(
        r.id, 'admission_waiting', '🎓 Admission to check: ' || new.name,
        'Admitted, waiting for approval.',
        jsonb_build_object('lead_id', new.id), 'approval:' || new.id || ':' || extract(epoch from new.admitted_at)::bigint);
    end loop;
    return new;
  end if;

  if (new.admitted_at is null and old.admitted_at is not null)
     or (new.cancelled_at is not null and old.cancelled_at is null) then
    if old.approval_status is not null or old.nu_admission_id is not null or old.registration_status is not null
       or old.admitted_section_id is not null then
      insert into public.lead_activity (lead_id, user_id, action, details)
      values (new.id, auth.uid(), 'admission_approval_cleared', jsonb_build_object(
        'status', old.approval_status, 'nu_admission_id', old.nu_admission_id, 'student_ref', old.student_ref,
        'registration', old.registration_status,
        'section', (select name from public.batch_sections where id = old.admitted_section_id)));
    end if;
    new.approval_status := null;
    new.approval_by := null;
    new.approval_at := null;
    new.approval_note := null;
    new.nu_admission_id := null;
    new.admitted_section_id := null;
    new.registration_status := null;
    new.registration_by := null;
    new.registration_at := null;
    new.registration_note := null;
    return new;
  end if;

  if not v_by_rpc and (
       new.approval_status     is distinct from old.approval_status
    or new.approval_by         is distinct from old.approval_by
    or new.approval_at         is distinct from old.approval_at
    or new.approval_note       is distinct from old.approval_note
    or new.nu_admission_id     is distinct from old.nu_admission_id
    or new.admitted_section_id is distinct from old.admitted_section_id
    or new.registration_status is distinct from old.registration_status
    or new.registration_by     is distinct from old.registration_by
    or new.registration_at     is distinct from old.registration_at
    or new.registration_note   is distinct from old.registration_note) then
    raise exception 'Use Approve, Send back or Change for this.';
  end if;
  return new;
end;
$$;

-- 🔁 A student moved to another section / batch / course: a new ID from its rule
create or replace function public.leads_student_ref_follow()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_new text;
begin
  if old.admitted_at is null or new.admitted_at is null then return new; end if;
  if coalesce(public.admission_setting()->'student_id'->>'mode', 'auto') <> 'auto' then return new; end if;
  if new.admitted_section_id is not distinct from old.admitted_section_id
     and new.admitted_batch_id is not distinct from old.admitted_batch_id
     and new.admitted_course_id is not distinct from old.admitted_course_id then
    return new;
  end if;
  if new.student_ref is distinct from old.student_ref then return new; end if; -- the ID was set by hand at the same time

  v_new := public.student_ref_take(new.admitted_course_id, new.admitted_batch_id, new.admitted_section_id, new.id);
  if v_new is distinct from old.student_ref then
    new.student_ref := v_new;
    insert into public.lead_activity (lead_id, user_id, action, details)
    values (new.id, auth.uid(), 'student_ref_renumbered',
            jsonb_build_object('old', old.student_ref, 'new', v_new, 'why', 'placement'));
  end if;
  return new;
end;
$$;
drop trigger if exists leads_student_ref_follow on public.leads;
create trigger leads_student_ref_follow
  before update of admitted_section_id, admitted_batch_id, admitted_course_id on public.leads
  for each row execute function public.leads_student_ref_follow();

-- ---------------------------------------------------------------------
-- ⚙️ Saving rules (admins): checks that no two ranges share a number
-- ---------------------------------------------------------------------
create or replace function public.save_student_id_rule(
  p_level text, p_target uuid, p_kind text, p_pattern text default null,
  p_start bigint default null, p_end bigint default null)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_clash public.student_id_rules;
  v_pattern text := nullif(trim(coalesce(p_pattern, '')), '');
begin
  if not public.has_permission('settings.manage') then raise exception 'Only admins can change this.'; end if;
  if p_level not in ('course', 'batch', 'section') then raise exception 'Unknown level.'; end if;

  -- "Use the rule above": no rule of its own
  if p_kind is null or p_kind = 'inherit' then
    delete from public.student_id_rules
    where (p_level = 'course' and course_id = p_target)
       or (p_level = 'batch' and batch_id = p_target)
       or (p_level = 'section' and section_id = p_target);
    return;
  end if;

  if p_kind = 'pattern' and (v_pattern is null or v_pattern !~ '\{0+\}') then
    raise exception 'The pattern needs a number part, e.g. {000}.';
  end if;
  if p_kind = 'range' then
    if p_start is null or p_end is null or p_start <= 0 or p_end < p_start then
      raise exception 'Write the first and the last number (the last one bigger).';
    end if;
    if p_end - p_start > 100000 then raise exception 'A range can hold at most 100,000 IDs.'; end if;
    select * into v_clash from public.student_id_rules r
    where r.kind = 'range'
      and int8range(r.range_start, r.range_end, '[]') && int8range(p_start, p_end, '[]')
      and not coalesce((p_level = 'course' and r.course_id = p_target)
            or (p_level = 'batch' and r.batch_id = p_target)
            or (p_level = 'section' and r.section_id = p_target), false)
    limit 1;
    if v_clash.id is not null then
      raise exception '% – % overlaps % (% – %).', p_start, p_end, public.student_id_rule_label(v_clash),
        v_clash.range_start, v_clash.range_end;
    end if;
  end if;

  delete from public.student_id_rules
  where (p_level = 'course' and course_id = p_target)
     or (p_level = 'batch' and batch_id = p_target)
     or (p_level = 'section' and section_id = p_target);
  insert into public.student_id_rules (course_id, batch_id, section_id, kind, pattern, range_start, range_end, updated_by)
  values (case when p_level = 'course' then p_target end,
          case when p_level = 'batch' then p_target end,
          case when p_level = 'section' then p_target end,
          p_kind,
          case when p_kind = 'pattern' then v_pattern end,
          case when p_kind = 'range' then p_start end,
          case when p_kind = 'range' then p_end end,
          auth.uid());
end;
$$;
grant execute on function public.save_student_id_rule(text, uuid, text, text, bigint, bigint) to authenticated;

-- One tap: ranges for every section of a batch, one after the other
create or replace function public.fill_section_ranges(p_batch uuid, p_start bigint, p_per int)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  s     record;
  v_at  bigint := p_start;
  v_out jsonb := '[]'::jsonb;
begin
  if not public.has_permission('settings.manage') then raise exception 'Only admins can change this.'; end if;
  if p_start is null or p_start <= 0 or p_per is null or p_per <= 0 then
    raise exception 'Write the first number and how many in each section.';
  end if;
  for s in
    select id, name from public.batch_sections where batch_id = p_batch and is_active order by sort_order, name
  loop
    perform public.save_student_id_rule('section', s.id, 'range', null, v_at, v_at + p_per - 1);
    v_out := v_out || jsonb_build_object('section', s.name, 'from', v_at, 'to', v_at + p_per - 1);
    v_at := v_at + p_per;
  end loop;
  if jsonb_array_length(v_out) = 0 then raise exception 'This batch has no sections yet.'; end if;
  return v_out;
end;
$$;
grant execute on function public.fill_section_ranges(uuid, bigint, int) to authenticated;

-- Every rule with how much of a range is used
create or replace function public.student_id_rules_overview()
returns table (id uuid, course_id uuid, batch_id uuid, section_id uuid, kind text, pattern text,
               range_start bigint, range_end bigint, used int, label text)
language sql
stable
security definer
set search_path = public
as $$
  select r.id, r.course_id, r.batch_id, r.section_id, r.kind, r.pattern, r.range_start, r.range_end,
         case when r.kind = 'range' then (
           select count(*)::int from public.leads l
           where l.deleted_at is null and l.student_ref ~ '^[0-9]{1,18}$'
             and l.student_ref::bigint between r.range_start and r.range_end)
         end,
         public.student_id_rule_label(r)
  from public.student_id_rules r
  where public.is_active_user();
$$;
grant execute on function public.student_id_rules_overview() to authenticated;

-- ---------------------------------------------------------------------
-- 🔁 Renumbering every student now follows the rules too
-- ---------------------------------------------------------------------
create or replace function public.renumber_student_refs(p_apply boolean default false)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_default text := public.admission_setting()->'student_id'->>'pattern';
  r         record;
  rule      public.student_id_rules;
  v_pattern text;
  v_scope   text;
  v_n       int;
  v_new     text;
  v_count   int := 0;
  v_changed int := 0;
  v_full    jsonb := '[]'::jsonb;
  v_examples jsonb := '[]'::jsonb;
begin
  if not public.has_permission('settings.manage') then raise exception 'Only admins can do this.'; end if;
  if coalesce(public.admission_setting()->'student_id'->>'mode', 'auto') <> 'auto' then
    raise exception 'Student IDs are not automatic (Settings → Admission).';
  end if;

  perform pg_advisory_xact_lock(hashtext('student-ref-renumber'));
  drop table if exists _renum;
  create temp table _renum (lead_id uuid primary key, old_ref text, new_ref text, scope text, n bigint) on commit drop;

  for r in
    select l.id, l.student_ref, l.admitted_course_id, l.admitted_batch_id, l.admitted_section_id,
           public.student_ref_year(l.admitted_batch_id, l.admitted_at) as yr,
           (select code from public.courses where id = l.admitted_course_id) as code
    from public.leads l
    where l.deleted_at is null and l.admitted_at is not null
    order by l.admitted_at, l.created_at, l.id
  loop
    rule := public.student_id_rule_for(r.admitted_course_id, r.admitted_batch_id, r.admitted_section_id);
    if rule.id is not null and rule.kind = 'range' then
      v_scope := 'range:' || rule.id::text;
      select coalesce(max(n) + 1, rule.range_start) into v_n from _renum where scope = v_scope;
      if v_n > rule.range_end then
        if jsonb_array_length(v_full) < 8 and not (v_full @> jsonb_build_array(public.student_id_rule_label(rule))) then
          v_full := v_full || to_jsonb(public.student_id_rule_label(rule));
        end if;
        v_new := r.student_ref; -- stays as it is
      else
        v_new := v_n::text;
      end if;
    else
      v_pattern := case when rule.id is not null then rule.pattern else v_default end;
      v_scope := case when rule.id is not null then 'rule:' || rule.id::text || ':' else '' end
                 || public.student_ref_scope_for(v_pattern, r.yr, r.code);
      select coalesce(max(n), 0) + 1 into v_n from _renum where scope = v_scope;
      v_new := public.format_student_ref_for(v_pattern, v_n, r.yr, r.code);
    end if;

    insert into _renum values (r.id, r.student_ref, v_new, v_scope, v_n);
    v_count := v_count + 1;
    if r.student_ref is distinct from v_new then
      v_changed := v_changed + 1;
      if jsonb_array_length(v_examples) < 8 then
        v_examples := v_examples || jsonb_build_object('old', r.student_ref, 'new', v_new);
      end if;
    end if;
  end loop;

  if p_apply and jsonb_array_length(v_full) > 0 then
    raise exception 'These ranges are too small for their students: %. Make them bigger first.',
      (select string_agg(x, ', ') from jsonb_array_elements_text(v_full) x);
  end if;

  if p_apply and v_changed > 0 then
    -- an ID kept on a cancelled admission that would clash goes
    update public.leads l set student_ref = null
    where l.deleted_at is null and l.admitted_at is null
      and exists (select 1 from _renum x where lower(x.new_ref) = lower(l.student_ref));

    update public.leads l set student_ref = 'tmp-' || l.id::text
    from _renum x where x.lead_id = l.id and l.student_ref is distinct from x.new_ref;
    update public.leads l set student_ref = x.new_ref
    from _renum x where x.lead_id = l.id and l.student_ref = 'tmp-' || l.id::text;

    insert into public.lead_activity (lead_id, user_id, action, details)
    select x.lead_id, auth.uid(), 'student_ref_renumbered', jsonb_build_object('old', x.old_ref, 'new', x.new_ref)
    from _renum x where x.old_ref is distinct from x.new_ref;

    insert into public.admission_counters (scope, last_value)
    select scope, max(n)::int from _renum where scope not like 'range:%' group by scope
    on conflict (scope) do update set last_value = excluded.last_value;
  end if;

  return jsonb_build_object('students', v_count, 'changed', v_changed, 'examples', v_examples,
                            'full', v_full, 'applied', p_apply);
end;
$$;
grant execute on function public.renumber_student_refs(boolean) to authenticated;

notify pgrst, 'reload schema';
