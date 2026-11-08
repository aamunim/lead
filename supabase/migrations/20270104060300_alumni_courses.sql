-- =====================================================================
-- 🎓 Alumni courses, apart from lead courses
--   · courses.is_alumni: a course for alumni only. It never shows where
--     leads are (it is kept "not active" for leads: every lead picker,
--     the website form and the lead checks already leave inactive
--     courses out).
--   · A lead course can be made an alumni course (Settings → Courses),
--     or an alumni course made new (Settings → Alumni).
--   · An alumnus always gets an alumni course: when a lead course comes
--     (from Students, a closed batch, an older app), its alumni twin
--     (same name, from_course_id) is used, made the first time; the
--     batch too (same name).
--   · A new alumnus must have a course; a course can't be taken off.
-- =====================================================================

alter table public.courses add column if not exists is_alumni boolean not null default false;
alter table public.courses add column if not exists from_course_id uuid references public.courses (id) on delete set null;

-- the same name may be a lead course and an alumni course
drop index if exists public.courses_name_key;
create unique index if not exists courses_name_key on public.courses (lower(name), is_alumni);
create unique index if not exists courses_alumni_twin_key on public.courses (from_course_id) where is_alumni and from_course_id is not null;

-- an alumni course is never active for leads
create or replace function public.courses_alumni_guard()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  if new.is_alumni then new.is_active := false; end if;
  return new;
end;
$$;
drop trigger if exists courses_alumni_guard on public.courses;
create trigger courses_alumni_guard before insert or update of is_alumni, is_active on public.courses
  for each row execute function public.courses_alumni_guard();

-- people who see only some courses still see every alumni course (and its batches)
create or replace function public.is_alumni_course(p_course uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select coalesce((select is_alumni from public.courses where id = p_course), false);
$$;
revoke all on function public.is_alumni_course(uuid) from public, anon;
grant execute on function public.is_alumni_course(uuid) to authenticated;

drop policy if exists "courses: course access" on public.courses;
create policy "courses: course access" on public.courses as restrictive for select to authenticated
  using (is_alumni
         or (select public.my_course_ids()) is null
         or id = any (coalesce((select public.my_course_ids()), '{}'::uuid[])));
drop policy if exists "batches: course access" on public.batches;
create policy "batches: course access" on public.batches as restrictive for select to authenticated
  using ((select public.my_course_ids()) is null
         or course_id = any (coalesce((select public.my_course_ids()), '{}'::uuid[]))
         or course_id in (select c.id from public.courses c where c.is_alumni));

-- a lead can't get an alumni course
create or replace function public.lead_courses_no_alumni()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  if exists (select 1 from public.courses where id = new.course_id and is_alumni) then
    raise exception 'That is an alumni course; leads can''t have it.';
  end if;
  return new;
end;
$$;
drop trigger if exists lead_courses_no_alumni on public.lead_courses;
create trigger lead_courses_no_alumni before insert or update of course_id on public.lead_courses
  for each row execute function public.lead_courses_no_alumni();

-- ---------------------------------------------------------------------
-- The alumni course (and batch) for any course / batch
-- ---------------------------------------------------------------------
create or replace function public.alumni_course_for(p_course uuid, p_batch uuid, out course_id uuid, out batch_id uuid)
language plpgsql
security definer
set search_path = public
as $$
declare
  c        public.courses;
  v_bname  text;
  v_bcourse uuid;
begin
  if p_course is null then
    -- a batch alone: its course
    select b.course_id into p_course from public.batches b where b.id = p_batch;
    if p_course is null then return; end if;
  end if;
  select * into c from public.courses where id = p_course;
  if c.id is null then return; end if;

  if c.is_alumni then
    course_id := c.id;
  else
    select id into course_id from public.courses where is_alumni and from_course_id = c.id;
    if course_id is null then
      -- its twin: the same name (already an alumni course with that name: that one)
      select id into course_id from public.courses where is_alumni and lower(name) = lower(c.name);
      if course_id is null then
        insert into public.courses (name, code, category, duration, is_alumni, from_course_id, sort_order)
        values (c.name, c.code, c.category, c.duration, true, c.id, c.sort_order)
        returning id into course_id;
      else
        update public.courses set from_course_id = c.id where id = course_id and from_course_id is null;
      end if;
    end if;
  end if;

  if p_batch is not null then
    select b.name, b.course_id into v_bname, v_bcourse from public.batches b where b.id = p_batch;
    if v_bname is not null then
      if v_bcourse = alumni_course_for.course_id then
        batch_id := p_batch;
      else
        select b.id into batch_id from public.batches b where b.course_id = alumni_course_for.course_id
          and lower(b.name) = lower(v_bname);
        if batch_id is null then
          insert into public.batches (course_id, name, status)
          values (alumni_course_for.course_id, v_bname, 'closed')
          returning id into batch_id;
        end if;
      end if;
    end if;
  end if;
end;
$$;
revoke all on function public.alumni_course_for(uuid, uuid) from public, anon, authenticated;

-- ---------------------------------------------------------------------
-- Every write to an alumnus: an alumni course; a new one must have one
-- ---------------------------------------------------------------------
create or replace function public.alumni_course_check()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  m record;
begin
  if tg_op = 'UPDATE' and new.course_id is not distinct from old.course_id
     and new.batch_id is not distinct from old.batch_id then
    return new;
  end if;
  if new.course_id is null and new.batch_id is null then
    if tg_op = 'INSERT' then
      raise exception 'Choose a course for the alumnus.' using hint = 'course_required';
    elsif old.course_id is not null then
      raise exception 'An alumnus must keep a course (choose another one instead).' using hint = 'course_required';
    end if;
    return new;
  end if;
  if new.course_id is not null and public.is_alumni_course(new.course_id) then
    -- an alumni course given: a batch of another course is dropped (never a new batch made for it)
    if new.batch_id is not null
       and not exists (select 1 from public.batches b where b.id = new.batch_id and b.course_id = new.course_id) then
      new.batch_id := null;
    end if;
    return new;
  end if;
  m := public.alumni_course_for(new.course_id, new.batch_id);
  new.course_id := m.course_id;
  new.batch_id := m.batch_id;
  if new.course_id is null then
    raise exception 'Choose a course for the alumnus.' using hint = 'course_required';
  end if;
  return new;
end;
$$;
-- runs before alumni_before_write (triggers fire in name order: "alumni_a_course" first)
drop trigger if exists alumni_a_course on public.alumni;
create trigger alumni_a_course before insert or update of course_id, batch_id on public.alumni
  for each row execute function public.alumni_course_check();

-- ---------------------------------------------------------------------
-- Make a lead course an alumni course (or back), from Settings
-- ---------------------------------------------------------------------
create or replace function public.set_course_alumni(p_course uuid, p_alumni boolean)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  c        public.courses;
  v_twin   uuid;
  v_moved  int := 0;
  v_leads  int := 0;
begin
  if not public.has_permission('settings.manage') then raise exception 'Only an admin can do this.'; end if;
  select * into c from public.courses where id = p_course for update;
  if c.id is null then raise exception 'Course not found.'; end if;
  if c.is_alumni = p_alumni then return jsonb_build_object('ok', true); end if;

  if p_alumni then
    -- its twin made earlier (alumni from Students): its alumni and batches come here, then it goes
    select id into v_twin from public.courses where is_alumni and from_course_id = c.id;
    if exists (select 1 from public.courses where is_alumni and lower(name) = lower(c.name)
                 and id <> c.id and id is distinct from v_twin) then
      raise exception 'There is already an alumni course named %.', c.name;
    end if;
    if v_twin is not null then
      -- out of the way of the name first
      update public.courses set name = name || ' (' || left(id::text, 8) || ')', from_course_id = null
       where id = v_twin;
    end if;
    update public.courses set is_alumni = true where id = c.id;
    if v_twin is not null then
      update public.batches tb set course_id = c.id
       where tb.course_id = v_twin
         and not exists (select 1 from public.batches b where b.course_id = c.id and lower(b.name) = lower(tb.name));
      update public.alumni a
         set course_id = c.id,
             batch_id = case when a.batch_id is null then null
                             else (select b.id from public.batches b join public.batches tb on lower(b.name) = lower(tb.name)
                                    where tb.id = a.batch_id and b.course_id = c.id limit 1) end
       where a.course_id = v_twin;
      get diagnostics v_moved = row_count;
      delete from public.batches b where b.course_id = v_twin
        and not exists (select 1 from public.alumni a where a.batch_id = b.id);
      delete from public.courses where id = v_twin
        and not exists (select 1 from public.alumni where course_id = v_twin)
        and not exists (select 1 from public.batches where course_id = v_twin);
    end if;
    select count(*) into v_leads from public.lead_courses lc join public.leads l on l.id = lc.lead_id
     where lc.course_id = c.id and l.deleted_at is null and l.admitted_at is null and l.closed_at is null;
  else
    if exists (select 1 from public.courses where not is_alumni and lower(name) = lower(c.name) and id <> c.id) then
      raise exception 'There is already a lead course named %.', c.name;
    end if;
    -- deleted ones too (they could be brought back)
    if exists (select 1 from public.alumni where course_id = c.id) then
      raise exception 'Alumni are in this course (deleted ones count too). Move them to another alumni course first.';
    end if;
    update public.courses set is_alumni = false, is_active = true, from_course_id = null where id = c.id;
  end if;
  return jsonb_build_object('ok', true, 'alumni_moved', v_moved, 'open_leads', v_leads);
end;
$$;
revoke all on function public.set_course_alumni(uuid, boolean) from public, anon;
grant execute on function public.set_course_alumni(uuid, boolean) to authenticated;

-- ---------------------------------------------------------------------
-- The alumni already there: their lead course → its alumni twin
-- ---------------------------------------------------------------------
do $$
declare
  r record;
  m record;
begin
  for r in select distinct a.course_id, a.batch_id from public.alumni a
           join public.courses c on c.id = a.course_id and not c.is_alumni
  loop
    m := public.alumni_course_for(r.course_id, r.batch_id);
    update public.alumni set course_id = m.course_id, batch_id = m.batch_id
     where course_id = r.course_id and batch_id is not distinct from r.batch_id;
  end loop;
end $$;

-- ---------------------------------------------------------------------
-- Excel import of leads finds a course by its name: lead courses only
-- (an alumni course may have the same name). Only that line changes.
-- ---------------------------------------------------------------------
do $$
declare
  d text;
  f regprocedure;
begin
  for f in select oid::regprocedure from pg_proc
           where proname = 'import_leads' and pronamespace = 'public'::regnamespace
  loop
    d := pg_get_functiondef(f);
    if position('and not is_alumni' in d) > 0 then continue; end if;
    d := replace(d, 'where lower(name) = lower(trim(r ->> ''course'')) limit 1',
                    'where lower(name) = lower(trim(r ->> ''course'')) and not is_alumni limit 1');
    if position('and not is_alumni' in d) = 0 then
      raise exception 'import_leads: the course lookup was not found (%), update this migration', f;
    end if;
    execute d;
  end loop;
end $$;

-- ---------------------------------------------------------------------
-- Excel import, "update existing": an alumnus keeps their course and batch
-- (the chosen course is only for new ones, or those without a course);
-- Home "Alumni to contact": says who must not be contacted (no 📞 button)
-- ---------------------------------------------------------------------
do $$
declare
  d text;
begin
  d := pg_get_functiondef('public.import_alumni(jsonb, boolean)'::regprocedure);
  if position('course_id = coalesce(a.course_id,' in d) = 0 then
    d := replace(d, 'course_id = coalesce(nullif(r ->> ''course_id'', '''')::uuid, a.course_id),',
                    'course_id = coalesce(a.course_id, nullif(r ->> ''course_id'', '''')::uuid),');
    d := replace(d, 'batch_id = coalesce(nullif(r ->> ''batch_id'', '''')::uuid, a.batch_id),',
                    'batch_id = case when a.course_id is null then nullif(r ->> ''batch_id'', '''')::uuid else a.batch_id end,');
    if position('course_id = coalesce(a.course_id,' in d) = 0 or position('when a.course_id is null then' in d) = 0 then
      raise exception 'import_alumni: the update lines were not found, update this migration';
    end if;
    execute d;
  end if;

  d := pg_get_functiondef('public.alumni_today(integer)'::regprocedure);
  if position('a.do_not_contact, a.next_contact_at < now() as late' in d) = 0 then
    d := replace(d, 'b.name as batch_name,
                     a.next_contact_at < now() as late',
                    'b.name as batch_name,
                     a.do_not_contact, a.next_contact_at < now() as late');
    if position('a.do_not_contact, a.next_contact_at < now() as late' in d) = 0 then
      raise exception 'alumni_today: the list line was not found, update this migration';
    end if;
    execute d;
  end if;
end $$;

notify pgrst, 'reload schema';
