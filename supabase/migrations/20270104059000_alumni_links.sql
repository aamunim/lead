-- =====================================================================
-- 🔗 Public links (no sign-in) + 🎓 alumni in bulk
--   lead.ittc.edu.bd/refer/<code>  an alumnus shares it; a friend fills
--                                  name + phone + course → Referral inbox
--   lead.ittc.edu.bd/apply         anyone interested → a new lead
--                                  (source "Website form", assigned by the
--                                  usual rules); ?ref=<code> → referral
--   Guards: one number at most 3 times an hour, at most 60 forms in 10
--   minutes for the whole site; Settings → Alumni can switch each off.
--   alumni_bulk: marked alumni → a course (+ batch) / no course / delete
--   (Dated before 20270104060000_lead_merge so both can go in any order.)
-- =====================================================================

-- On / off (Settings → Alumni)
insert into public.app_settings (key, value, description)
values ('public_forms', jsonb_build_object('refer', true, 'apply', true),
        'Public links: alumni referral link and the interested-person form')
on conflict (key) do nothing;

-- Every form that came in (for the limits; kept two days)
create table if not exists public.public_form_hits (
  id         bigint generated always as identity primary key,
  kind       text not null,
  key        text,
  created_at timestamptz not null default now()
);
create index if not exists public_form_hits_at_idx on public.public_form_hits (created_at);
create index if not exists public_form_hits_key_idx on public.public_form_hits (key, created_at);
alter table public.public_form_hits enable row level security;   -- only through the functions below

create or replace function public.public_form_guard(p_kind text, p_key text)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if (select count(*) from public.public_form_hits where created_at > now() - interval '10 minutes') >= 60 then
    raise exception 'Too many forms right now. Please try again in a few minutes.' using hint = 'busy';
  end if;
  if p_key is not null and (select count(*) from public.public_form_hits
                            where key = p_key and created_at > now() - interval '1 hour') >= 3 then
    raise exception 'This number was sent already. We will call you soon.' using hint = 'again';
  end if;
  insert into public.public_form_hits (kind, key) values (p_kind, p_key);
  -- now and then: forget old ones
  if random() < 0.02 then
    delete from public.public_form_hits where created_at < now() - interval '2 days';
  end if;
end;
$$;
revoke all on function public.public_form_guard(text, text) from public, anon, authenticated;

create or replace function public.public_forms_on(p_which text)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select coalesce((select (value ->> p_which)::boolean from public.app_settings where key = 'public_forms'), true);
$$;
revoke all on function public.public_forms_on(text) from public, anon;
grant execute on function public.public_forms_on(text) to authenticated;

-- ---------------------------------------------------------------------
-- What the public pages show: the active courses, and whose link it is
-- (the first name only)
-- ---------------------------------------------------------------------
create or replace function public.public_form_info(p_code text default null)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_alum record;
begin
  if nullif(trim(coalesce(p_code, '')), '') is not null then
    select a.name into v_alum from public.alumni a
    where a.ref_code = upper(trim(p_code)) and a.deleted_at is null;
  end if;
  return jsonb_build_object(
    'refer_on', public.public_forms_on('refer'),
    'apply_on', public.public_forms_on('apply'),
    'referrer', case when v_alum.name is not null then split_part(trim(v_alum.name), ' ', 1) end,
    'courses', coalesce((select jsonb_agg(jsonb_build_object('id', c.id, 'name', c.name) order by c.name)
                         from public.courses c where c.is_active), '[]'::jsonb));
end;
$$;
revoke all on function public.public_form_info(text) from public;
grant execute on function public.public_form_info(text) to anon, authenticated;

-- ---------------------------------------------------------------------
-- 🎓 A friend of an alumnus (the alumnus's link)
-- ---------------------------------------------------------------------
create or replace function public.public_refer(p_code text, p_name text, p_phone text,
                                              p_course_id uuid default null, p_area text default null,
                                              p_note text default null)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_alum  uuid;
  v_phone text := nullif(public.normalize_bd_phone(nullif(trim(coalesce(p_phone, '')), '')), '');
begin
  if not public.public_forms_on('refer') then raise exception 'This link is switched off.'; end if;
  select id into v_alum from public.alumni where ref_code = upper(trim(coalesce(p_code, ''))) and deleted_at is null;
  if v_alum is null then raise exception 'This link is not valid any more.'; end if;
  if nullif(trim(coalesce(p_name, '')), '') is null then raise exception 'Please type the name.'; end if;
  if v_phone is null or length(regexp_replace(v_phone, '\D', '', 'g')) < 10 then
    raise exception 'Please type a correct mobile number.';
  end if;
  if p_course_id is not null and not exists (select 1 from public.courses where id = p_course_id and is_active) then
    p_course_id := null;
  end if;
  perform public.public_form_guard('refer', v_phone);
  begin
    perform public.add_alumni_referral(v_alum, p_name, v_phone, p_course_id, p_area, p_note, 'alumni_link');
  exception when others then
    -- already waiting in the inbox: the same answer (nothing to tell a stranger)
    if sqlerrm not like '%already waiting%' then raise; end if;
  end;
  return jsonb_build_object('ok', true);
end;
$$;
revoke all on function public.public_refer(text, text, text, uuid, text, text) from public;
grant execute on function public.public_refer(text, text, text, uuid, text, text) to anon, authenticated;

-- ---------------------------------------------------------------------
-- 🙋 Someone interested (the college's own link / QR)
--   a new number → a new lead; a known number → a line on that lead
-- ---------------------------------------------------------------------
create or replace function public.public_apply(p_name text, p_phone text, p_course_id uuid,
                                              p_area text default null, p_note text default null,
                                              p_ref text default null)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_phone text := nullif(public.normalize_bd_phone(nullif(trim(coalesce(p_phone, '')), '')), '');
  v_name  text := left(nullif(trim(coalesce(p_name, '')), ''), 120);
  v_area  text := left(nullif(trim(coalesce(p_area, '')), ''), 120);
  v_note  text := left(nullif(trim(coalesce(p_note, '')), ''), 1000);
  v_alum  uuid;
  v_lead  uuid;
  v_src   uuid;
  v_stage uuid;
begin
  -- with an alumnus's code: it is their referral
  if nullif(trim(coalesce(p_ref, '')), '') is not null then
    select id into v_alum from public.alumni where ref_code = upper(trim(p_ref)) and deleted_at is null;
    if v_alum is not null and public.public_forms_on('refer') then
      return public.public_refer(p_ref, p_name, p_phone, p_course_id, p_area, p_note);
    end if;
  end if;

  if not public.public_forms_on('apply') then raise exception 'This form is switched off.'; end if;
  if v_name is null then raise exception 'Please type your name.'; end if;
  if v_phone is null or length(regexp_replace(v_phone, '\D', '', 'g')) < 10 then
    raise exception 'Please type a correct mobile number.';
  end if;
  if p_course_id is null or not exists (select 1 from public.courses where id = p_course_id and is_active) then
    if exists (select 1 from public.courses where is_active) then raise exception 'Please choose a course.'; end if;
    p_course_id := null;
  end if;
  perform public.public_form_guard('apply', v_phone);

  select l.id into v_lead from public.leads l
  where l.deleted_at is null and v_phone in (l.phone, l.alt_phone, l.guardian_phone)
  order by l.created_at desc limit 1;

  if v_lead is not null then
    -- known already: the people on it see that they asked again
    insert into public.lead_activity (lead_id, user_id, action, details)
    values (v_lead, null, 'web_form', jsonb_build_object('again', true, 'name', v_name, 'course_id', p_course_id,
                                                          'area', v_area, 'note', v_note));
    return jsonb_build_object('ok', true);
  end if;

  select id into v_src from public.lead_sources where lower(name) = 'website form' limit 1;
  if v_src is null then
    insert into public.lead_sources (name, sort_order)
    values ('Website form', coalesce((select max(sort_order) from public.lead_sources), 0) + 1)
    returning id into v_src;
  end if;
  v_stage := coalesce(
    (select id from public.pipeline_stages where is_active and kind = 'open' order by sort_order limit 1),
    (select id from public.pipeline_stages where is_active order by sort_order limit 1));

  v_lead := public.create_lead(
    jsonb_strip_nulls(jsonb_build_object('name', v_name, 'phone', v_phone, 'area', v_area, 'notes', v_note,
                                         'stage_id', v_stage, 'source_id', v_src)),
    case when p_course_id is not null then array[p_course_id] else '{}'::uuid[] end,
    '{}');
  insert into public.lead_activity (lead_id, user_id, action, details)
  values (v_lead, null, 'web_form', jsonb_build_object('course_id', p_course_id));
  return jsonb_build_object('ok', true);
end;
$$;
revoke all on function public.public_apply(text, text, uuid, text, text, text) from public;
grant execute on function public.public_apply(text, text, uuid, text, text, text) to anon, authenticated;

-- ---------------------------------------------------------------------
-- 🎓 Marked alumni, all at once
--   'course'   → this course (and batch, if given)
--   'unassign' → no course, no batch
--   'delete'   → removed from the list (their referrals stay)
-- ---------------------------------------------------------------------
create or replace function public.alumni_bulk(p_ids uuid[], p_action text, p_course_id uuid default null,
                                             p_batch_id uuid default null)
returns int
language plpgsql
security definer
set search_path = public
as $$
declare
  v_n   int := 0;
  v_ids uuid[];
  v_c   text;
begin
  if not public.alumni_can('manage') then raise exception 'You cannot change alumni.'; end if;
  if coalesce(array_length(p_ids, 1), 0) = 0 then return 0; end if;
  if array_length(p_ids, 1) > 5000 then raise exception 'Mark at most 5000 at a time.'; end if;

  if p_action = 'course' then
    if p_course_id is null then raise exception 'Choose a course.'; end if;
    select name into v_c from public.courses where id = p_course_id;
    if v_c is null then raise exception 'Course not found.'; end if;
    if p_batch_id is not null and not exists (select 1 from public.batches where id = p_batch_id and course_id = p_course_id) then
      raise exception 'That batch is not in this course.';
    end if;
    with u as (
      update public.alumni set course_id = p_course_id, batch_id = p_batch_id
      where id = any (p_ids) and deleted_at is null
        and (course_id is distinct from p_course_id or batch_id is distinct from p_batch_id)
      returning id)
    select array_agg(id) into v_ids from u;
    insert into public.alumni_events (alumni_id, kind, body, by_user)
    select x, 'edited', 'Course: ' || v_c, auth.uid() from unnest(coalesce(v_ids, '{}')) x;
  elsif p_action = 'unassign' then
    with u as (
      update public.alumni set course_id = null, batch_id = null
      where id = any (p_ids) and deleted_at is null and (course_id is not null or batch_id is not null)
      returning id)
    select array_agg(id) into v_ids from u;
    insert into public.alumni_events (alumni_id, kind, body, by_user)
    select x, 'edited', 'Course removed', auth.uid() from unnest(coalesce(v_ids, '{}')) x;
  elsif p_action = 'delete' then
    with u as (
      update public.alumni set deleted_at = now()
      where id = any (p_ids) and deleted_at is null
      returning id)
    select array_agg(id) into v_ids from u;
    insert into public.alumni_events (alumni_id, kind, by_user)
    select x, 'deleted', auth.uid() from unnest(coalesce(v_ids, '{}')) x;
  else
    raise exception 'Unknown action.';
  end if;
  v_n := coalesce(array_length(v_ids, 1), 0);
  return v_n;
end;
$$;
revoke all on function public.alumni_bulk(uuid[], text, uuid, uuid) from public, anon;
grant execute on function public.alumni_bulk(uuid[], text, uuid, uuid) to authenticated;
