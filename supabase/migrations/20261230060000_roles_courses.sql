-- =====================================================================
-- 👥 Roles, courses and course pipelines
--   1. New roles (Settings → Roles, the Super Admin only): a name, what
--      the role "works like" (Caller / Team Lead / Admin: teams, self
--      assignment, discount limits), its permissions and its courses.
--   2. Who sees which course: a role (or one person) can be limited to
--      some courses. Leads and students of other courses are hidden
--      everywhere (lists, search, board, the lead page, export), and so
--      are those courses in the pickers. Leads with no course are seen
--      by admins only (and by the person who just added one).
--   3. Pipeline stages per course: an open stage can be for all courses
--      or only some. Each lead follows one "pipeline course" (its first
--      course; it can be changed on the lead).
--   4. 📚 Many leads at once get a course (admins): only leads without
--      any course; leads that have one are left as they are.
-- =====================================================================

-- ---------------------------------------------------------------------
-- 1. Roles
-- ---------------------------------------------------------------------
alter table public.roles
  add column if not exists acts_as text check (acts_as in ('caller', 'team_lead', 'admin')),
  add column if not exists course_ids uuid[];

update public.roles set acts_as = case key when 'caller' then 'caller' when 'team_lead' then 'team_lead' else 'admin' end
 where acts_as is null;

-- What a role works like (the four first roles: themselves)
create or replace function public.role_base(p_key text)
returns text
language sql
stable
security definer
set search_path = public
as $$
  select coalesce((select acts_as from public.roles where key = p_key),
                  case p_key when 'caller' then 'caller' when 'team_lead' then 'team_lead' else 'admin' end);
$$;
grant execute on function public.role_base(text) to authenticated;

-- The permissions a role may be given
create or replace function public.role_permission_list()
returns text[]
language sql
immutable
as $$
  select array[
    'leads.view_own', 'leads.edit_own', 'leads.view_team', 'leads.edit_team', 'leads.view_all', 'leads.edit_all',
    'leads.assign', 'leads.delete', 'leads.export', 'import.run',
    'reports.view_team', 'reports.view_all',
    'payments.manage', 'discounts.approve_limited', 'discounts.approve',
    'settings.manage', 'users.manage'];
$$;

-- ➕ / ✏️ A role (the Super Admin only); returns its key
create or replace function public.save_role(
  p_key text,
  p_name text,
  p_description text,
  p_acts_as text,
  p_permissions text[],
  p_course_ids uuid[])
returns text
language plpgsql
security definer
set search_path = public
as $$
declare
  v_name  text := nullif(trim(coalesce(p_name, '')), '');
  v_key   text := p_key;
  v_perms text[];
  v_rank  int;
  v_n     int := 1;
begin
  if public.current_role_key() is distinct from 'super_admin' then
    raise exception 'Only the Super Admin can change roles.';
  end if;
  if v_name is null then raise exception 'Please give the role a name.'; end if;
  if p_acts_as not in ('caller', 'team_lead', 'admin') then raise exception 'Choose what the role works like.'; end if;
  if v_key = 'super_admin' then raise exception 'The Super Admin role can''t be changed.'; end if;
  if exists (select 1 from public.roles where lower(name) = lower(v_name) and key is distinct from v_key) then
    raise exception 'A role called % is there already.', v_name;
  end if;

  select coalesce(array_agg(distinct x order by x), '{}') into v_perms
  from unnest(coalesce(p_permissions, '{}')) x
  where x = any (public.role_permission_list());

  v_rank := case p_acts_as when 'caller' then 15 when 'team_lead' then 55 else 85 end;

  if v_key is null then
    v_key := trim(both '_' from regexp_replace(lower(v_name), '[^a-z0-9]+', '_', 'g'));
    if v_key = '' then v_key := 'role'; end if;
    while exists (select 1 from public.roles where key = v_key || case when v_n = 1 then '' else '_' || v_n end) loop
      v_n := v_n + 1;
    end loop;
    v_key := v_key || case when v_n = 1 then '' else '_' || v_n end;
    insert into public.roles (key, name, description, rank, permissions, is_system, acts_as, course_ids)
    values (v_key, v_name, nullif(trim(coalesce(p_description, '')), ''), v_rank, v_perms, false, p_acts_as,
            nullif(p_course_ids, '{}'));
  else
    update public.roles
       set name = v_name,
           description = nullif(trim(coalesce(p_description, '')), ''),
           permissions = v_perms,
           acts_as = case when is_system then acts_as else p_acts_as end,
           rank = case when is_system then rank else v_rank end,
           course_ids = nullif(p_course_ids, '{}')
     where key = v_key;
    if not found then raise exception 'Role not found.'; end if;
  end if;
  return v_key;
end;
$$;
grant execute on function public.save_role(text, text, text, text, text[], uuid[]) to authenticated;

create or replace function public.delete_role(p_key text)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_n int;
begin
  if public.current_role_key() is distinct from 'super_admin' then
    raise exception 'Only the Super Admin can change roles.';
  end if;
  if exists (select 1 from public.roles where key = p_key and is_system) then
    raise exception 'The first four roles can be changed, not removed.';
  end if;
  select count(*) into v_n from public.profiles where role_key = p_key;
  if v_n > 0 then raise exception '% people have this role. Give them another role first.', v_n; end if;
  delete from public.roles where key = p_key;
end;
$$;
grant execute on function public.delete_role(text) to authenticated;

-- How many people each role has (Settings → Roles)
create or replace function public.role_counts()
returns table (role_key text, people int)
language sql
stable
security definer
set search_path = public
as $$
  select role_key, count(*)::int from public.profiles where is_active group by role_key;
$$;
grant execute on function public.role_counts() to authenticated;

-- ---------------------------------------------------------------------
-- 2. Who sees which course
-- ---------------------------------------------------------------------
alter table public.profiles add column if not exists course_ids uuid[];  -- null = like the role

-- My courses: null = every course (admins, and roles without a limit)
create or replace function public.my_course_ids()
returns uuid[]
language sql
stable
security definer
set search_path = public
as $$
  select case
           when public.has_permission('settings.manage') then null
           else coalesce((select p.course_ids from public.profiles p where p.id = auth.uid()),
                         (select r.course_ids from public.profiles p join public.roles r on r.key = p.role_key
                           where p.id = auth.uid()))
         end;
$$;
grant execute on function public.my_course_ids() to authenticated;

-- Am I free of course limits? (admins; database tools)
create or replace function public.course_free()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select auth.uid() is null or public.has_permission('settings.manage');
$$;
grant execute on function public.course_free() to authenticated;

-- Each lead keeps its courses (interested + admitted) for a quick check
alter table public.leads add column if not exists course_ids uuid[] not null default '{}';
create index if not exists leads_course_ids_idx on public.leads using gin (course_ids);

create or replace function public.lead_course_list(p_lead uuid, p_admitted uuid)
returns uuid[]
language sql
stable
security definer
set search_path = public
as $$
  select coalesce(array_agg(distinct x), '{}') from (
    select course_id as x from public.lead_courses where lead_id = p_lead
    union select p_admitted where p_admitted is not null) t;
$$;

create or replace function public.lead_courses_keep_list()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_lead uuid := coalesce(new.lead_id, old.lead_id);
begin
  update public.leads l set course_ids = public.lead_course_list(l.id, l.admitted_course_id)
   where l.id = v_lead and l.course_ids is distinct from public.lead_course_list(l.id, l.admitted_course_id);
  return null;
end;
$$;
drop trigger if exists lead_courses_keep_list on public.lead_courses;
create trigger lead_courses_keep_list after insert or delete on public.lead_courses
  for each row execute function public.lead_courses_keep_list();

create or replace function public.leads_keep_course_list()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  new.course_ids := public.lead_course_list(new.id, new.admitted_course_id);
  return new;
end;
$$;
drop trigger if exists leads_keep_course_list on public.leads;
create trigger leads_keep_course_list before update of admitted_course_id on public.leads
  for each row execute function public.leads_keep_course_list();

-- May I see this lead, by its courses? (the assignment rules stay on top)
--   no course: admins only (and the person who added it, so it doesn't vanish)
drop policy if exists "leads: course access" on public.leads;
create policy "leads: course access" on public.leads as restrictive for select to authenticated
  using ((select public.course_free())
         or case when cardinality(course_ids) = 0 then created_by = (select auth.uid())
                 else (select public.my_course_ids()) is null or course_ids && (select public.my_course_ids()) end);
drop policy if exists "leads: course access (change)" on public.leads;
create policy "leads: course access (change)" on public.leads as restrictive for update to authenticated
  using ((select public.course_free())
         or case when cardinality(course_ids) = 0 then created_by = (select auth.uid())
                 else (select public.my_course_ids()) is null or course_ids && (select public.my_course_ids()) end);

-- The pickers show my courses only (and their batches)
drop policy if exists "courses: course access" on public.courses;
create policy "courses: course access" on public.courses as restrictive for select to authenticated
  using ((select public.my_course_ids()) is null or id = any (coalesce((select public.my_course_ids()), '{}')));
drop policy if exists "batches: course access" on public.batches;
create policy "batches: course access" on public.batches as restrictive for select to authenticated
  using ((select public.my_course_ids()) is null or course_id = any (coalesce((select public.my_course_ids()), '{}')));

-- One person's own courses (Users → the person); null = like the role
create or replace function public.set_user_courses(p_user uuid, p_course_ids uuid[])
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if not public.has_permission('users.manage') then raise exception 'Only admins can change this.'; end if;
  if (select role_key from public.profiles where id = p_user) = 'super_admin'
     and public.current_role_key() is distinct from 'super_admin' then
    raise exception 'Only the Super Admin can change a Super Admin.';
  end if;
  update public.profiles set course_ids = nullif(p_course_ids, '{}') where id = p_user;
  if not found then raise exception 'User not found.'; end if;
end;
$$;
grant execute on function public.set_user_courses(uuid, uuid[]) to authenticated;

-- ---------------------------------------------------------------------
-- 3. Pipeline stages per course
-- ---------------------------------------------------------------------
alter table public.pipeline_stages add column if not exists course_ids uuid[];  -- null = every course
alter table public.leads add column if not exists pipeline_course_id uuid references public.courses(id) on delete set null;
create index if not exists leads_pipeline_course_idx on public.leads (pipeline_course_id);

-- Is this stage used for this course? (closed and system stages: always)
create or replace function public.stage_ok_for_course(p_stage uuid, p_course uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select coalesce((
    select s.kind <> 'open' or s.is_system or s.course_ids is null or coalesce(p_course = any (s.course_ids), false)
    from public.pipeline_stages s where s.id = p_stage), true);
$$;
grant execute on function public.stage_ok_for_course(uuid, uuid) to authenticated;

-- The first open stage of a course (when a lead moves to a course without its stage)
create or replace function public.first_stage_for_course(p_course uuid)
returns uuid
language sql
stable
security definer
set search_path = public
as $$
  select s.id from public.pipeline_stages s
  where s.kind = 'open' and s.is_active and public.stage_ok_for_course(s.id, p_course)
  order by s.sort_order limit 1;
$$;

create or replace function public.set_stage_courses(p_stage uuid, p_course_ids uuid[])
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  s public.pipeline_stages;
begin
  if not public.has_permission('settings.manage') then raise exception 'Only admins can change this.'; end if;
  select * into s from public.pipeline_stages where id = p_stage;
  if not found then raise exception 'Stage not found.'; end if;
  if s.kind <> 'open' or s.is_system then raise exception 'This stage is used for every course.'; end if;
  update public.pipeline_stages set course_ids = nullif(p_course_ids, '{}') where id = p_stage;
end;
$$;
grant execute on function public.set_stage_courses(uuid, uuid[]) to authenticated;

-- A stage must belong to the lead's pipeline course
create or replace function public.leads_stage_course_check()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if tg_op = 'UPDATE' and new.stage_id is not distinct from old.stage_id
     and new.pipeline_course_id is not distinct from old.pipeline_course_id then
    return new;
  end if;
  if not public.stage_ok_for_course(new.stage_id, new.pipeline_course_id) then
    raise exception 'The stage "%" is not used for %.',
      (select name from public.pipeline_stages where id = new.stage_id),
      coalesce((select name from public.courses where id = new.pipeline_course_id), 'leads without a course');
  end if;
  return new;
end;
$$;
drop trigger if exists leads_stage_course_check on public.leads;
create trigger leads_stage_course_check
  before insert or update of stage_id, pipeline_course_id on public.leads
  for each row execute function public.leads_stage_course_check();

-- Moves the lead to a pipeline course (its stage follows when it isn't used there)
create or replace function public.apply_pipeline_course(p_lead uuid, p_course uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  l public.leads;
  v_stage uuid;
begin
  select * into l from public.leads where id = p_lead;
  if not found or l.pipeline_course_id is not distinct from p_course then return; end if;
  v_stage := l.stage_id;
  if not public.stage_ok_for_course(l.stage_id, p_course) then
    v_stage := public.first_stage_for_course(p_course);
  end if;
  perform set_config('app.pipeline_action', 'on', true);
  update public.leads set pipeline_course_id = p_course, stage_id = coalesce(v_stage, stage_id) where id = p_lead;
  perform set_config('app.pipeline_action', 'off', true);
  if v_stage is distinct from l.stage_id then
    insert into public.lead_activity (lead_id, user_id, action, details)
    values (p_lead, auth.uid(), 'pipeline_course_changed', jsonb_build_object(
      'course', (select name from public.courses where id = p_course),
      'from_stage', (select name from public.pipeline_stages where id = l.stage_id),
      'to_stage', (select name from public.pipeline_stages where id = v_stage)));
  end if;
end;
$$;
revoke execute on function public.apply_pipeline_course(uuid, uuid) from public, anon, authenticated;

-- ✏️ On the lead: which of its courses the pipeline follows
create or replace function public.set_pipeline_course(p_lead uuid, p_course uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  l public.leads;
begin
  select * into l from public.leads where id = p_lead and deleted_at is null;
  if not found or not public.can_edit_lead(l.assigned_to) then raise exception 'You can''t change this lead.'; end if;
  if not exists (select 1 from public.lead_courses where lead_id = p_lead and course_id = p_course) then
    raise exception 'Choose one of the lead''s courses.';
  end if;
  perform public.apply_pipeline_course(p_lead, p_course);
  insert into public.lead_activity (lead_id, user_id, action, details)
  values (p_lead, auth.uid(), 'pipeline_course_set', jsonb_build_object('course', (select name from public.courses where id = p_course)));
end;
$$;
grant execute on function public.set_pipeline_course(uuid, uuid) to authenticated;

-- A lead gets its first course → that is its pipeline; its pipeline course is removed → the next one
create or replace function public.lead_courses_pipeline()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_cur  uuid;
  v_next uuid;
begin
  if tg_op = 'INSERT' then
    select pipeline_course_id into v_cur from public.leads where id = new.lead_id;
    if v_cur is null then perform public.apply_pipeline_course(new.lead_id, new.course_id); end if;
    return null;
  end if;
  select pipeline_course_id into v_cur from public.leads where id = old.lead_id;
  if v_cur = old.course_id then
    select course_id into v_next from public.lead_courses where lead_id = old.lead_id order by created_at limit 1;
    perform public.apply_pipeline_course(old.lead_id, v_next);
  end if;
  return null;
end;
$$;
drop trigger if exists lead_courses_pipeline on public.lead_courses;
create trigger lead_courses_pipeline after insert or delete on public.lead_courses
  for each row execute function public.lead_courses_pipeline();

-- ---------------------------------------------------------------------
-- 4. 📚 Many leads get a course (admins; only leads without a course)
-- ---------------------------------------------------------------------
create or replace function public.bulk_add_lead_course(p_leads uuid[], p_course uuid, p_dry boolean default true)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_ready uuid[];
  v_has   int;
  v_skip  int;
begin
  if not public.has_permission('settings.manage') then raise exception 'Only admins can do this.'; end if;
  if not exists (select 1 from public.courses where id = p_course and is_active) then
    raise exception 'That course is not available.';
  end if;

  select coalesce(array_agg(l.id) filter (
           where l.admitted_course_id is null and not exists (select 1 from public.lead_courses c where c.lead_id = l.id)), '{}'),
         count(*) filter (
           where l.admitted_course_id is not null or exists (select 1 from public.lead_courses c where c.lead_id = l.id))
    into v_ready, v_has
  from public.leads l
  where l.id = any (p_leads) and l.deleted_at is null;
  v_skip := cardinality(p_leads) - cardinality(v_ready) - v_has;

  if not p_dry and cardinality(v_ready) > 0 then
    insert into public.lead_courses (lead_id, course_id)
    select x, p_course from unnest(v_ready) x
    on conflict do nothing;
  end if;

  return jsonb_build_object('ready', cardinality(v_ready), 'done', case when p_dry then 0 else cardinality(v_ready) end,
                            'has_course', v_has, 'skipped', greatest(v_skip, 0),
                            'course', (select name from public.courses where id = p_course));
end;
$$;
grant execute on function public.bulk_add_lead_course(uuid[], uuid, boolean) to authenticated;

-- ---------------------------------------------------------------------
-- 5. The places that knew the four roles by name: now "works like"
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.protect_profile_fields()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_actor_role   text := public.current_role_key();
  v_sensitive    boolean;
  v_other_supers integer;
begin
  if coalesce(current_setting('app.bypass_profile_guard', true), '') = 'on' then
    return new;
  end if;

  v_sensitive :=
       new.role_key     is distinct from old.role_key
    or new.team_lead_id is distinct from old.team_lead_id
    or new.is_active    is distinct from old.is_active;

  if v_sensitive then
    if not public.has_permission('users.manage') then
      raise exception 'You are not allowed to change role, team or status';
    end if;

    if new.id = auth.uid()
       and (new.role_key is distinct from old.role_key
            or new.is_active is distinct from old.is_active) then
      raise exception 'You cannot change your own role or status';
    end if;

    if (old.role_key = 'super_admin' or new.role_key = 'super_admin')
       and v_actor_role is distinct from 'super_admin' then
      raise exception 'Only a Super Admin can change a Super Admin account';
    end if;

    if old.role_key = 'super_admin' and old.is_active
       and (new.role_key is distinct from 'super_admin' or not new.is_active) then
      select count(*) into v_other_supers
      from public.profiles
      where role_key = 'super_admin'
        and is_active
        and id <> old.id;

      if v_other_supers = 0 then
        raise exception 'There must always be at least one active Super Admin';
      end if;
    end if;

    if new.team_lead_id is not null
       and new.team_lead_id is distinct from old.team_lead_id then
      if new.team_lead_id = new.id then
        raise exception 'A user cannot be their own Team Lead';
      end if;
      if not exists (
        select 1 from public.profiles
        where id = new.team_lead_id
          and is_active
          and public.role_base(role_key) in ('team_lead', 'admin')
      ) then
        raise exception 'The selected Team Lead is not an active Team Lead';
      end if;
    end if;
  end if;

  if new.is_active = false and old.is_active = true then
    new.deactivated_at = now();
  elsif new.is_active = true then
    new.deactivated_at = null;
  end if;

  return new;
end;
$function$;

CREATE OR REPLACE FUNCTION public.assign_new_lead()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_uid uuid := auth.uid();
  v_cfg jsonb := public.assignment_setting();
  v_role text;
  v_manual boolean;
  v_auto_user uuid;
begin
  new.created_by := coalesce(new.created_by, v_uid);

  -- Database tools / server jobs: keep what was given
  if v_uid is null then
    new.assignment_method := coalesce(new.assignment_method, case when new.assigned_to is null then 'none' else 'manual' end);
    return new;
  end if;

  -- 1. Switch off
  if not coalesce((v_cfg->>'enabled')::boolean, true) then
    new.assigned_to := null;
    new.assignment_method := 'none';
    return new;
  end if;

  -- 2. Picked by hand. Also counts: a person given without a method
  --    (older app screens and Excel import), if the user may assign.
  v_manual := new.assignment_method = 'manual'
              or (new.assignment_method is null and new.assigned_to is not null);

  if v_manual and public.has_permission('leads.assign') then
    if not public.can_assign_to(new.assigned_to) then
      raise exception 'You cannot assign leads to this person.';
    end if;
    new.assignment_method := 'manual';
    return new;
  end if;

  select public.role_base(role_key) into v_role from public.profiles where id = v_uid;

  -- 3. Caller adds
  if v_role = 'caller' and coalesce((v_cfg->>'caller_self')::boolean, true) then
    new.assigned_to := v_uid;
    new.assignment_method := 'self';
    return new;
  end if;

  -- 4. Team Lead adds
  if v_role = 'team_lead' and coalesce((v_cfg->>'team_lead_self')::boolean, true) then
    new.assigned_to := v_uid;
    new.assignment_method := 'self';
    return new;
  end if;

  -- 5. Admin adds
  if public.has_permission('leads.view_all') and coalesce((v_cfg->>'admin_auto')::boolean, false) then
    v_auto_user := nullif(v_cfg->>'admin_auto_user_id', '')::uuid;
    if v_auto_user is not null
       and exists (select 1 from public.profiles where id = v_auto_user and is_active) then
      new.assigned_to := v_auto_user;
      new.assignment_method := 'auto';
      return new;
    end if;
  end if;

  -- 6. Otherwise
  new.assigned_to := null;
  new.assignment_method := 'none';
  return new;
end;
$function$;

CREATE OR REPLACE FUNCTION public.can_hand_over_to(p_target uuid)
 RETURNS boolean
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_rule text := coalesce(public.assignment_setting() ->> 'handover', 'anyone');
  v_me   public.profiles;
  v_t    public.profiles;
begin
  if p_target is null then return false; end if;
  if public.can_assign_to(p_target) then return true; end if;

  select * into v_me from public.profiles where id = auth.uid();
  select * into v_t  from public.profiles where id = p_target;
  if v_t.id is null or not v_t.is_active or not public.is_active_user() then return false; end if;

  return case v_rule
    when 'anyone'   then true
    when 'team'     then (v_t.team_lead_id is not distinct from v_me.team_lead_id and v_me.team_lead_id is not null)
                         or v_t.id = v_me.team_lead_id
                         or v_t.team_lead_id = v_me.id
    when 'managers' then public.role_base(v_t.role_key) in ('team_lead', 'admin')
    else false
  end;
end;
$function$;

CREATE OR REPLACE FUNCTION public.call_lock_can_override()
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  select case coalesce((select value->>'override' from public.app_settings where key = 'call_lock'), 'admin')
           when 'none' then false
           when 'admin_tl' then public.role_base(public.current_role_key()) in ('admin', 'team_lead')
           else public.role_base(public.current_role_key()) = 'admin'
         end;
$function$;

CREATE OR REPLACE FUNCTION public.discount_limit(p_user uuid DEFAULT auth.uid())
 RETURNS numeric
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  select case
           when r.key is null then 0
           when '*' = any (r.permissions) or 'discounts.approve' = any (r.permissions) then 100
           else least(100, greatest(0, coalesce(coalesce(public.fee_setting() -> 'limits' ->> r.key, public.fee_setting() -> 'limits' ->> r.acts_as)::numeric, 0)))
         end
  from (select 1) one
  left join public.profiles p on p.id = p_user and p.is_active
  left join public.roles r on r.key = p.role_key;
$function$;

-- ---------------------------------------------------------------------
-- 6. The leads we have: their pipeline course (the first course)
-- ---------------------------------------------------------------------
do $$
begin
  alter table public.leads disable trigger user;
  update public.leads l set course_ids = public.lead_course_list(l.id, l.admitted_course_id);
  update public.leads l
     set pipeline_course_id = coalesce(
       (select c.course_id from public.lead_courses c where c.lead_id = l.id order by c.created_at limit 1),
       l.admitted_course_id)
   where l.pipeline_course_id is null;
  alter table public.leads enable trigger user;
end $$;

notify pgrst, 'reload schema';
