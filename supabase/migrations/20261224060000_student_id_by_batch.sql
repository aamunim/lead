-- =====================================================================
-- 🎓 Student ID (= roll number) from the batch's start year
--   Settings → Admission → Student ID: "year from" = admission day (as
--   before) or the batch's start year. {YYYY} / {YY} then mean the
--   batch's year, {SESSION} = 2027-28, {CODE} = the course's code.
--     {YY}{000} with a batch that starts in 2027 → 27001, 27002 …
--   The number counts per year (and per course when {CODE} is in it).
--   A button renumbers every student with the pattern now set.
-- =====================================================================

alter table public.courses add column if not exists code text;

-- The batch's start year: its start date, else a year in its name, else this year
create or replace function public.batch_start_year(p_batch uuid)
returns int
language sql
stable
security definer
set search_path = public
as $$
  select coalesce(
    (select coalesce(extract(year from b.start_date)::int, substring(b.name from '(20[0-9]{2})')::int)
       from public.batches b where b.id = p_batch),
    extract(year from now() at time zone 'Asia/Dhaka')::int);
$$;

-- The year a student ID uses (setting student_id.year_from: admission | batch)
create or replace function public.student_ref_year(p_batch uuid, p_at timestamptz default now())
returns int
language sql
stable
security definer
set search_path = public
as $$
  select case
    when coalesce(public.admission_setting()->'student_id'->>'year_from', 'admission') = 'batch' and p_batch is not null
      then public.batch_start_year(p_batch)
    else extract(year from coalesce(p_at, now()) at time zone 'Asia/Dhaka')::int
  end;
$$;

create or replace function public.format_student_ref_for(p_pattern text, p_number int, p_year int, p_code text)
returns text
language plpgsql
immutable
as $$
declare
  v_out   text := coalesce(nullif(trim(p_pattern), ''), 'ADM-{YYYY}-{0000}');
  v_zeros text;
  v_y     text := lpad(p_year::text, 4, '0');
begin
  v_out := replace(v_out, '{YYYY}', v_y);
  v_out := replace(v_out, '{YY}', right(v_y, 2));
  v_out := replace(v_out, '{SESSION}', v_y || '-' || right(lpad((p_year + 1)::text, 4, '0'), 2));
  v_out := replace(v_out, '{CODE}', upper(coalesce(nullif(trim(p_code), ''), '')));
  v_zeros := substring(v_out from '\{(0+)\}');
  if v_zeros is null then
    return v_out || p_number::text;
  end if;
  return regexp_replace(v_out, '\{0+\}', lpad(p_number::text, length(v_zeros), '0'));
end;
$$;

-- Which number series an ID belongs to: the year (when the pattern has one), and the course (with {CODE})
create or replace function public.student_ref_scope_for(p_pattern text, p_year int, p_code text)
returns text
language sql
immutable
as $$
  select concat_ws(':',
    case when coalesce(p_pattern, '') ~ '\{(YY|YYYY|SESSION)\}' then p_year::text else 'all' end,
    case when coalesce(p_pattern, '') like '%{CODE}%' then lower(coalesce(nullif(trim(p_code), ''), '-')) end);
$$;

-- What the next ID will look like for this course / batch (does not use it up)
drop function if exists public.preview_student_ref();
create or replace function public.preview_student_ref(p_course uuid default null, p_batch uuid default null)
returns text
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_pattern text := public.admission_setting()->'student_id'->>'pattern';
  v_year    int := public.student_ref_year(p_batch);
  v_code    text := (select code from public.courses where id = p_course);
  v_scope   text := public.student_ref_scope_for(v_pattern, v_year, v_code);
  v_n       int := coalesce((select last_value from public.admission_counters where scope = v_scope), 0);
  v_ref     text;
begin
  loop
    v_n := v_n + 1;
    v_ref := public.format_student_ref_for(v_pattern, v_n, v_year, v_code);
    exit when not exists (select 1 from public.leads where lower(student_ref) = lower(v_ref));
  end loop;
  return v_ref;
end;
$$;
grant execute on function public.preview_student_ref(uuid, uuid) to authenticated;

-- Take the next free ID for this course / batch (only while admitting)
create or replace function public.next_student_ref(p_course uuid, p_batch uuid)
returns text
language plpgsql
security definer
set search_path = public
as $$
declare
  v_pattern text := public.admission_setting()->'student_id'->>'pattern';
  v_year    int := public.student_ref_year(p_batch);
  v_code    text := (select code from public.courses where id = p_course);
  v_scope   text := public.student_ref_scope_for(v_pattern, v_year, v_code);
  v_n       int;
  v_ref     text;
begin
  if not public.can_mark_admitted() then
    raise exception 'You can''t admit students.';
  end if;
  loop
    insert into public.admission_counters (scope, last_value)
    values (v_scope, 1)
    on conflict (scope) do update set last_value = admission_counters.last_value + 1
    returning last_value into v_n;
    v_ref := public.format_student_ref_for(v_pattern, v_n, v_year, v_code);
    exit when not exists (select 1 from public.leads where lower(student_ref) = lower(v_ref));
  end loop;
  return v_ref;
end;
$$;
grant execute on function public.next_student_ref(uuid, uuid) to authenticated;

-- The old one (no course / batch) keeps working
create or replace function public.next_student_ref()
returns text
language sql
security definer
set search_path = public
as $$ select public.next_student_ref(null::uuid, null::uuid); $$;
grant execute on function public.next_student_ref() to authenticated;

-- Admitting: the ID now knows the course and the batch
create or replace function public.mark_admitted(
  p_lead_id     uuid,
  p_course_id   uuid,
  p_batch_id    uuid default null,
  p_admitted_at timestamptz default null,
  p_student_ref text default null,
  p_note        text default null
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

    v_capacity := v_batch.seat_capacity;
    v_taken := public.batch_seats_taken(p_batch_id);
    if v_capacity is not null
       and v_taken >= v_capacity
       and not coalesce((v_cfg->>'allow_overbooking')::boolean, false) then
      raise exception '% is full (% of % seats).', v_batch.name, v_taken, v_capacity;
    end if;
  end if;

  -- Student ID
  v_ref := nullif(trim(coalesce(p_student_ref, '')), '');
  if v_mode = 'off' then
    v_ref := v_old_ref;
  elsif v_mode = 'manual' then
    v_ref := coalesce(v_ref, v_old_ref);
    if v_ref is null then raise exception 'Please type the student ID.'; end if;
  else -- auto
    v_ref := coalesce(v_ref, v_old_ref, public.next_student_ref(p_course_id, p_batch_id));
  end if;

  if v_ref is not null and exists (
    select 1 from public.leads where lower(student_ref) = lower(v_ref) and id <> p_lead_id
  ) then
    raise exception 'Student ID % is already used.', v_ref;
  end if;

  perform set_config('app.pipeline_action', 'on', true);
  perform set_config('app.stage_note', coalesce(v_note, ''), true);

  update public.leads
     set stage_id           = public.stage_of_kind('won'),
         admitted_at        = coalesce(p_admitted_at, now()),
         admitted_by        = auth.uid(),
         admitted_course_id = p_course_id,
         admitted_batch_id  = p_batch_id,
         student_ref        = v_ref,
         admission_note     = v_note,
         closed_at          = now(),
         lost_reason_id     = null,
         lost_at            = null,
         lost_by            = null,
         lost_note          = null,
         cancelled_at       = null,
         cancelled_by       = null,
         cancel_reason      = null,
         call_attempts      = 0,
         unreachable_at     = null
   where id = p_lead_id;

  get diagnostics v_rows = row_count;
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

-- ---------------------------------------------------------------------
-- ⚠️ Two batches of one course starting in the same year share one
--    number series when the ID follows the batch year
-- ---------------------------------------------------------------------
create or replace function public.student_ref_warnings()
returns table (course_id uuid, course_name text, year int, batches text[])
language sql
stable
security definer
set search_path = public
as $$
  select c.id, c.name, public.batch_start_year(b.id), array_agg(b.name order by b.start_date nulls last, b.name)
  from public.batches b
  join public.courses c on c.id = b.course_id and c.is_active
  where b.is_active
  group by c.id, c.name, public.batch_start_year(b.id)
  having count(*) > 1
  order by 3 desc, 2;
$$;
grant execute on function public.student_ref_warnings() to authenticated;

-- ---------------------------------------------------------------------
-- 🔁 Give every student a new ID with the pattern now set
--   In admission order (oldest first), per series. p_apply = false only
--   shows what would happen (count + the first examples).
-- ---------------------------------------------------------------------
create or replace function public.renumber_student_refs(p_apply boolean default false)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_pattern text := public.admission_setting()->'student_id'->>'pattern';
  r         record;
  v_n       int;
  v_new     text;
  v_count   int := 0;
  v_changed int := 0;
  v_examples jsonb := '[]'::jsonb;
begin
  if not public.has_permission('settings.manage') then raise exception 'Only admins can do this.'; end if;
  if coalesce(public.admission_setting()->'student_id'->>'mode', 'auto') <> 'auto' then
    raise exception 'Student IDs are not automatic (Settings → Admission).';
  end if;

  perform pg_advisory_xact_lock(hashtext('student-ref-renumber'));
  drop table if exists _renum;
  create temp table _renum (lead_id uuid primary key, old_ref text, new_ref text, scope text, n int) on commit drop;

  for r in
    select l.id, l.student_ref, l.admitted_course_id, l.admitted_batch_id, l.admitted_at,
           public.student_ref_year(l.admitted_batch_id, l.admitted_at) as yr,
           (select code from public.courses where id = l.admitted_course_id) as code
    from public.leads l
    where l.deleted_at is null and l.admitted_at is not null
    order by l.admitted_at, l.created_at, l.id
  loop
    select coalesce(max(n), 0) + 1 into v_n
    from _renum where scope = public.student_ref_scope_for(v_pattern, r.yr, r.code);
    v_new := public.format_student_ref_for(v_pattern, v_n, r.yr, r.code);
    insert into _renum values (r.id, r.student_ref, v_new, public.student_ref_scope_for(v_pattern, r.yr, r.code), v_n);
    v_count := v_count + 1;
    if r.student_ref is distinct from v_new then
      v_changed := v_changed + 1;
      if jsonb_array_length(v_examples) < 8 then
        v_examples := v_examples || jsonb_build_object('old', r.student_ref, 'new', v_new);
      end if;
    end if;
  end loop;

  -- An ID kept on someone who is no longer a student (a cancelled admission) would clash
  if exists (
    select 1 from public.leads l join _renum x on lower(x.new_ref) = lower(l.student_ref)
    where l.deleted_at is null and l.admitted_at is null
  ) then
    if p_apply then
      update public.leads l set student_ref = null
      where l.deleted_at is null and l.admitted_at is null
        and exists (select 1 from _renum x where lower(x.new_ref) = lower(l.student_ref));
    end if;
  end if;

  if p_apply and v_changed > 0 then
    perform set_config('app.bypass_student_ref_log', 'on', true);
    -- two steps, so swapping IDs never meets the "already used" rule
    update public.leads l set student_ref = 'tmp-' || l.id::text
    from _renum x where x.lead_id = l.id and l.student_ref is distinct from x.new_ref;
    update public.leads l set student_ref = x.new_ref
    from _renum x where x.lead_id = l.id and l.student_ref = 'tmp-' || l.id::text;

    insert into public.lead_activity (lead_id, user_id, action, details)
    select x.lead_id, auth.uid(), 'student_ref_renumbered', jsonb_build_object('old', x.old_ref, 'new', x.new_ref)
    from _renum x where x.old_ref is distinct from x.new_ref;

    -- the counters continue after the last number of each series
    insert into public.admission_counters (scope, last_value)
    select scope, max(n) from _renum group by scope
    on conflict (scope) do update set last_value = excluded.last_value;
  end if;

  return jsonb_build_object('students', v_count, 'changed', v_changed, 'examples', v_examples, 'applied', p_apply);
end;
$$;
grant execute on function public.renumber_student_refs(boolean) to authenticated;

notify pgrst, 'reload schema';
