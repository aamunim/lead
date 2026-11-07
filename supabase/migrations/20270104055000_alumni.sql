-- =====================================================================
-- 🎓 Alumni: students who passed. No pipeline: the institute keeps in
--   touch with them, and they refer new people. A referral goes to an
--   inbox; staff import it as a lead (choosing course and person), give
--   the alumnus credit on a lead that was already there, or reject it.
--   No accounts for alumni.
--   * alumni                 the people (+ custom fields the admin adds)
--   * alumni_fields          the custom fields (Settings → Alumni)
--   * alumni_events          notes / calls / messages / history
--   * alumni_referrals       the inbox
--   * alumni_rewards         money for a referral that was admitted
--   * leads.referred_by_alumni_id
--   Who sees / manages: setting 'alumni' (roles + people); admins always.
--   (Dated before 20270104060000_lead_merge so both can go in any order.)
-- =====================================================================

-- ---------------------------------------------------------------------
-- ⚙️ Setting
-- ---------------------------------------------------------------------
insert into public.app_settings (key, value, description)
values ('alumni', jsonb_build_object(
  'view',    jsonb_build_object('all', false, 'roles', jsonb_build_array('admin', 'team_lead'), 'user_ids', '[]'::jsonb),
  'manage',  jsonb_build_object('all', false, 'roles', jsonb_build_array('admin'), 'user_ids', '[]'::jsonb),
  'rewards', jsonb_build_object('enabled', false, 'default_amount', 0, 'by_course', '{}'::jsonb)
), 'Alumni: who sees and manages them, referral rewards')
on conflict (key) do nothing;

create or replace function public.alumni_setting()
returns jsonb
language sql
stable
security definer
set search_path = public
as $$
  select coalesce((select value from public.app_settings where key = 'alumni'), '{}'::jsonb);
$$;

-- 'view' or 'manage'. Admins (settings.manage / *) always; manage also gives view.
create or replace function public.alumni_can(p_level text default 'view')
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  with me as (
    select p.id, p.role_key, r.permissions
    from public.profiles p join public.roles r on r.key = p.role_key
    where p.id = auth.uid() and p.is_active and p.deleted_at is null
  ),
  rules as (
    select case when p_level = 'manage' then array[public.alumni_setting() -> 'manage']
                else array[public.alumni_setting() -> 'view', public.alumni_setting() -> 'manage'] end as list
  )
  select exists (select 1 from me) and (
    (select '*' = any (permissions) or 'settings.manage' = any (permissions) from me)
    or exists (
      select 1 from rules, unnest(rules.list) as rule
      where rule is not null and (
        coalesce((rule ->> 'all')::boolean, false)
        or (select role_key from me) in (select jsonb_array_elements_text(coalesce(rule -> 'roles', '[]')))
        or (select id::text from me) in (select jsonb_array_elements_text(coalesce(rule -> 'user_ids', '[]')))
      )
    )
  );
$$;

revoke all on function public.alumni_can(text) from public, anon;
grant execute on function public.alumni_can(text) to authenticated;

-- ---------------------------------------------------------------------
-- 🧩 Custom fields (the admin adds what they need)
-- ---------------------------------------------------------------------
create table if not exists public.alumni_fields (
  id          uuid primary key default gen_random_uuid(),
  key         text not null unique check (key ~ '^[a-z][a-z0-9_]{0,39}$'),
  label       text not null,
  type        text not null default 'text'
              check (type in ('text', 'long_text', 'number', 'date', 'select', 'phone', 'email', 'url', 'yes_no')),
  options     text[] not null default '{}',
  required    boolean not null default false,
  show_in_list boolean not null default false,
  is_active   boolean not null default true,
  sort_order  integer not null default 0,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);
alter table public.alumni_fields enable row level security;
drop policy if exists "alumni fields: read" on public.alumni_fields;
create policy "alumni fields: read" on public.alumni_fields
  for select to authenticated using ((select public.alumni_can('view')));
drop policy if exists "alumni fields: admins write" on public.alumni_fields;
create policy "alumni fields: admins write" on public.alumni_fields
  for all to authenticated
  using ((select public.has_permission('settings.manage')))
  with check ((select public.has_permission('settings.manage')));
drop trigger if exists alumni_fields_updated on public.alumni_fields;
create trigger alumni_fields_updated before update on public.alumni_fields
  for each row execute function public.set_updated_at();

-- ---------------------------------------------------------------------
-- 🎓 The alumni
-- ---------------------------------------------------------------------
create or replace function public.alumni_new_code()
returns text
language plpgsql
volatile
set search_path = public
as $$
declare
  -- no 0/O/1/I/L: easy to read out on the phone
  v_chars text := 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
  v_code  text;
begin
  loop
    v_code := '';
    for i in 1..6 loop
      v_code := v_code || substr(v_chars, 1 + floor(random() * length(v_chars))::int, 1);
    end loop;
    exit when not exists (select 1 from public.alumni where ref_code = v_code);
  end loop;
  return v_code;
end;
$$;

create table if not exists public.alumni (
  id              uuid primary key default gen_random_uuid(),
  name            text not null check (length(trim(name)) > 0),
  phone           text,
  whatsapp_number text,
  email           text,
  photo_url       text,
  course_id       uuid references public.courses (id) on delete set null,
  batch_id        uuid references public.batches (id) on delete set null,
  session         text,
  passing_year    integer check (passing_year is null or passing_year between 1950 and 2100),
  student_ref     text,
  workplace       text,
  designation     text,
  district        text,
  upazila         text,
  address         text,
  custom          jsonb not null default '{}'::jsonb,
  tags            text[] not null default '{}',
  notes           text,
  owner_id        uuid references public.profiles (id) on delete set null,
  do_not_contact  boolean not null default false,
  lead_id         uuid references public.leads (id) on delete set null,   -- the student record, when they came from Students
  ref_code        text not null unique default public.alumni_new_code(),
  last_contacted_at timestamptz,
  created_by      uuid references public.profiles (id) on delete set null,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  deleted_at      timestamptz
);
create unique index if not exists alumni_phone_key on public.alumni (phone) where deleted_at is null and phone is not null;
create unique index if not exists alumni_lead_key on public.alumni (lead_id) where deleted_at is null and lead_id is not null;
create index if not exists alumni_batch_idx on public.alumni (batch_id) where deleted_at is null;
create index if not exists alumni_course_idx on public.alumni (course_id) where deleted_at is null;
create index if not exists alumni_name_idx on public.alumni (lower(name)) where deleted_at is null;
alter table public.alumni enable row level security;

drop policy if exists "alumni: read" on public.alumni;
create policy "alumni: read" on public.alumni
  for select to authenticated using ((select public.alumni_can('view')));
drop policy if exists "alumni: manage" on public.alumni;
create policy "alumni: manage" on public.alumni
  for update to authenticated
  using ((select public.alumni_can('manage')))
  with check ((select public.alumni_can('manage')));
-- (adding goes through save_alumni / the import functions)

create or replace function public.alumni_before_write()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  new.name := trim(new.name);
  new.phone := nullif(public.normalize_bd_phone(nullif(trim(coalesce(new.phone, '')), '')), '');
  new.whatsapp_number := nullif(public.normalize_bd_phone(nullif(trim(coalesce(new.whatsapp_number, '')), '')), '');
  new.email := nullif(lower(trim(coalesce(new.email, ''))), '');
  new.custom := coalesce(new.custom, '{}'::jsonb);
  new.tags := coalesce(new.tags, '{}');
  if tg_op = 'UPDATE' then new.updated_at := now(); end if;
  return new;
end;
$$;
drop trigger if exists alumni_before_write on public.alumni;
create trigger alumni_before_write before insert or update on public.alumni
  for each row execute function public.alumni_before_write();

-- ---------------------------------------------------------------------
-- 📝 Notes, calls, messages, history
-- ---------------------------------------------------------------------
create table if not exists public.alumni_events (
  id         uuid primary key default gen_random_uuid(),
  alumni_id  uuid not null references public.alumni (id) on delete cascade,
  kind       text not null check (kind in ('note', 'call', 'whatsapp', 'message', 'created', 'edited',
                                           'referral', 'referral_imported', 'referral_credited', 'referral_rejected',
                                           'admitted', 'reward', 'deleted', 'restored')),
  body       text,
  data       jsonb not null default '{}'::jsonb,
  by_user    uuid references public.profiles (id) on delete set null,
  created_at timestamptz not null default now()
);
create index if not exists alumni_events_alumni_idx on public.alumni_events (alumni_id, created_at desc);
alter table public.alumni_events enable row level security;
drop policy if exists "alumni events: read" on public.alumni_events;
create policy "alumni events: read" on public.alumni_events
  for select to authenticated using ((select public.alumni_can('view')));

-- ---------------------------------------------------------------------
-- 📨 Referrals (the inbox)
-- ---------------------------------------------------------------------
create table if not exists public.alumni_referrals (
  id               uuid primary key default gen_random_uuid(),
  alumni_id        uuid not null references public.alumni (id) on delete cascade,
  name             text not null,
  phone            text not null,
  course_id        uuid references public.courses (id) on delete set null,
  area             text,
  note             text,
  channel          text not null default 'staff' check (channel in ('staff', 'alumni_link', 'prospect_link')),
  status           text not null default 'new' check (status in ('new', 'imported', 'credited', 'rejected')),
  existing_lead_id uuid references public.leads (id) on delete set null,   -- the number was already a lead
  lead_id          uuid references public.leads (id) on delete set null,   -- the lead it became / was credited
  reject_reason    text,
  created_by       uuid references public.profiles (id) on delete set null,
  created_at       timestamptz not null default now(),
  handled_by       uuid references public.profiles (id) on delete set null,
  handled_at       timestamptz
);
create index if not exists alumni_referrals_status_idx on public.alumni_referrals (status, created_at desc);
create index if not exists alumni_referrals_alumni_idx on public.alumni_referrals (alumni_id, created_at desc);
create index if not exists alumni_referrals_lead_idx on public.alumni_referrals (lead_id) where lead_id is not null;
-- the same number waits in the inbox only once
create unique index if not exists alumni_referrals_open_phone on public.alumni_referrals (phone) where status = 'new';
alter table public.alumni_referrals enable row level security;
drop policy if exists "alumni referrals: read" on public.alumni_referrals;
create policy "alumni referrals: read" on public.alumni_referrals
  for select to authenticated using ((select public.alumni_can('view')));

-- ---------------------------------------------------------------------
-- 🎯 The lead remembers who referred it
-- ---------------------------------------------------------------------
alter table public.leads add column if not exists referred_by_alumni_id uuid references public.alumni (id) on delete set null;
create index if not exists leads_referred_by_alumni_idx on public.leads (referred_by_alumni_id) where referred_by_alumni_id is not null;

insert into public.lead_sources (name, sort_order)
select 'Alumni referral', coalesce((select max(sort_order) from public.lead_sources), 0) + 1
where not exists (select 1 from public.lead_sources where lower(name) = 'alumni referral');

-- ---------------------------------------------------------------------
-- 🎁 Rewards (Settings → Alumni → rewards, amount by course)
-- ---------------------------------------------------------------------
create table if not exists public.alumni_rewards (
  id          uuid primary key default gen_random_uuid(),
  alumni_id   uuid not null references public.alumni (id) on delete cascade,
  lead_id     uuid references public.leads (id) on delete set null,
  course_id   uuid references public.courses (id) on delete set null,
  amount      numeric(12, 2) not null default 0 check (amount >= 0),
  status      text not null default 'due' check (status in ('due', 'paid', 'cancelled')),
  paid_at     timestamptz,
  paid_by     uuid references public.profiles (id) on delete set null,
  method      text,
  note        text,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);
create unique index if not exists alumni_rewards_one_per_lead on public.alumni_rewards (lead_id) where status <> 'cancelled' and lead_id is not null;
create index if not exists alumni_rewards_alumni_idx on public.alumni_rewards (alumni_id);
alter table public.alumni_rewards enable row level security;
drop policy if exists "alumni rewards: read" on public.alumni_rewards;
create policy "alumni rewards: read" on public.alumni_rewards
  for select to authenticated using ((select public.alumni_can('manage')));

-- ---------------------------------------------------------------------
-- 📋 The list with counts (the RLS of alumni applies: security_invoker)
-- ---------------------------------------------------------------------
-- (counted as the server: a caller sees the real totals, not only their own leads)
create or replace function public.alumni_lead_counts(p_alumni uuid)
returns table (leads bigint, admitted bigint)
language sql
stable
security definer
set search_path = public
as $$
  select count(*), count(*) filter (where ld.admitted_at is not null and ld.cancelled_at is null)
  from public.leads ld
  where ld.referred_by_alumni_id = p_alumni and ld.deleted_at is null and public.alumni_can('view');
$$;
revoke all on function public.alumni_lead_counts(uuid) from public, anon;
grant execute on function public.alumni_lead_counts(uuid) to authenticated;

create or replace view public.alumni_overview with (security_invoker = true) as
select a.*,
  c.name as course_name,
  b.name as batch_name,
  o.full_name as owner_name,
  coalesce(r.referrals, 0)  as referrals,
  coalesce(r.waiting, 0)    as referrals_waiting,
  coalesce(l.leads, 0)      as referred_leads,
  coalesce(l.admitted, 0)   as referred_admitted
from public.alumni a
left join public.courses c on c.id = a.course_id
left join public.batches b on b.id = a.batch_id
left join public.profiles o on o.id = a.owner_id
left join lateral (
  select count(*) as referrals, count(*) filter (where x.status = 'new') as waiting
  from public.alumni_referrals x where x.alumni_id = a.id
) r on true
left join lateral public.alumni_lead_counts(a.id) l on true
where a.deleted_at is null;

grant select on public.alumni_overview to authenticated;

-- ---------------------------------------------------------------------
-- Helpers
-- ---------------------------------------------------------------------
create or replace function public.alumni_log(p_alumni uuid, p_kind text, p_body text default null, p_data jsonb default '{}'::jsonb)
returns void
language sql
security definer
set search_path = public
as $$
  insert into public.alumni_events (alumni_id, kind, body, data, by_user)
  values (p_alumni, p_kind, nullif(trim(coalesce(p_body, '')), ''), coalesce(p_data, '{}'::jsonb), auth.uid());
$$;
revoke all on function public.alumni_log(uuid, text, text, jsonb) from public, anon, authenticated;

-- Everyone who manages alumni (for notifications)
create or replace function public.alumni_managers()
returns setof uuid
language sql
stable
security definer
set search_path = public
as $$
  select p.id
  from public.profiles p join public.roles r on r.key = p.role_key
  where p.is_active and p.deleted_at is null and (
    '*' = any (r.permissions) or 'settings.manage' = any (r.permissions)
    or coalesce((public.alumni_setting() -> 'manage' ->> 'all')::boolean, false)
    or p.role_key in (select jsonb_array_elements_text(coalesce(public.alumni_setting() -> 'manage' -> 'roles', '[]')))
    or p.id::text in (select jsonb_array_elements_text(coalesce(public.alumni_setting() -> 'manage' -> 'user_ids', '[]')))
  );
$$;
revoke all on function public.alumni_managers() from public, anon, authenticated;

-- Custom field values: only known keys, required ones present
create or replace function public.alumni_clean_custom(p_custom jsonb)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  f record;
  v_out jsonb := '{}'::jsonb;
  v_val jsonb;
begin
  for f in select * from public.alumni_fields where is_active order by sort_order loop
    v_val := coalesce(p_custom, '{}'::jsonb) -> f.key;
    if v_val is null or v_val = 'null'::jsonb or (jsonb_typeof(v_val) = 'string' and trim(v_val #>> '{}') = '') then
      if f.required then raise exception 'Please fill in "%".', f.label; end if;
      continue;
    end if;
    if f.type = 'number' and (v_val #>> '{}') !~ '^-?[0-9]+(\.[0-9]+)?$' then
      raise exception '"%" must be a number.', f.label;
    end if;
    if f.type = 'select' and cardinality(f.options) > 0 and not ((v_val #>> '{}') = any (f.options)) then
      raise exception '"%": choose one of the options.', f.label;
    end if;
    v_out := v_out || jsonb_build_object(f.key, v_val);
  end loop;
  return v_out;
end;
$$;
revoke all on function public.alumni_clean_custom(jsonb) from public, anon, authenticated;

-- ---------------------------------------------------------------------
-- ✍️ Add / change one alumnus
-- ---------------------------------------------------------------------
create or replace function public.save_alumni(p_id uuid, p_row jsonb)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_id    uuid := p_id;
  v_phone text := nullif(public.normalize_bd_phone(nullif(trim(coalesce(p_row ->> 'phone', '')), '')), '');
  v_dup   record;
  v_custom jsonb;
begin
  if not public.alumni_can('manage') then raise exception 'You cannot add or change alumni.'; end if;
  if nullif(trim(coalesce(p_row ->> 'name', '')), '') is null then raise exception 'Please type the name.'; end if;
  if v_phone is not null and length(regexp_replace(v_phone, '\D', '', 'g')) < 7 then
    raise exception 'The phone number looks wrong.';
  end if;

  select id, name into v_dup from public.alumni
  where phone = v_phone and v_phone is not null and deleted_at is null and (v_id is null or id <> v_id) limit 1;
  if v_dup.id is not null then
    raise exception '% already has this number.', v_dup.name using hint = 'alumni_duplicate:' || v_dup.id;
  end if;

  v_custom := public.alumni_clean_custom(p_row -> 'custom');

  if v_id is null then
    insert into public.alumni (name, phone, whatsapp_number, email, course_id, batch_id, session, passing_year,
                               student_ref, workplace, designation, district, upazila, address, custom, tags, notes,
                               owner_id, do_not_contact, created_by)
    values (p_row ->> 'name', v_phone, p_row ->> 'whatsapp_number', p_row ->> 'email',
            nullif(p_row ->> 'course_id', '')::uuid, nullif(p_row ->> 'batch_id', '')::uuid,
            nullif(trim(coalesce(p_row ->> 'session', '')), ''), nullif(p_row ->> 'passing_year', '')::int,
            nullif(trim(coalesce(p_row ->> 'student_ref', '')), ''), nullif(trim(coalesce(p_row ->> 'workplace', '')), ''),
            nullif(trim(coalesce(p_row ->> 'designation', '')), ''), nullif(trim(coalesce(p_row ->> 'district', '')), ''),
            nullif(trim(coalesce(p_row ->> 'upazila', '')), ''), nullif(trim(coalesce(p_row ->> 'address', '')), ''),
            v_custom,
            coalesce((select array_agg(trim(t)) from jsonb_array_elements_text(coalesce(p_row -> 'tags', '[]')) t where trim(t) <> ''), '{}'),
            nullif(trim(coalesce(p_row ->> 'notes', '')), ''),
            nullif(p_row ->> 'owner_id', '')::uuid, coalesce((p_row ->> 'do_not_contact')::boolean, false), auth.uid())
    returning id into v_id;
    perform public.alumni_log(v_id, 'created');
  else
    update public.alumni set
      name = p_row ->> 'name',
      phone = v_phone,
      whatsapp_number = p_row ->> 'whatsapp_number',
      email = p_row ->> 'email',
      course_id = nullif(p_row ->> 'course_id', '')::uuid,
      batch_id = nullif(p_row ->> 'batch_id', '')::uuid,
      session = nullif(trim(coalesce(p_row ->> 'session', '')), ''),
      passing_year = nullif(p_row ->> 'passing_year', '')::int,
      student_ref = nullif(trim(coalesce(p_row ->> 'student_ref', '')), ''),
      workplace = nullif(trim(coalesce(p_row ->> 'workplace', '')), ''),
      designation = nullif(trim(coalesce(p_row ->> 'designation', '')), ''),
      district = nullif(trim(coalesce(p_row ->> 'district', '')), ''),
      upazila = nullif(trim(coalesce(p_row ->> 'upazila', '')), ''),
      address = nullif(trim(coalesce(p_row ->> 'address', '')), ''),
      custom = v_custom,
      tags = coalesce((select array_agg(trim(t)) from jsonb_array_elements_text(coalesce(p_row -> 'tags', '[]')) t where trim(t) <> ''), '{}'),
      notes = nullif(trim(coalesce(p_row ->> 'notes', '')), ''),
      owner_id = nullif(p_row ->> 'owner_id', '')::uuid,
      do_not_contact = coalesce((p_row ->> 'do_not_contact')::boolean, false)
    where id = v_id and deleted_at is null;
    if not found then raise exception 'Alumnus not found.'; end if;
    perform public.alumni_log(v_id, 'edited');
  end if;
  return v_id;
end;
$$;

create or replace function public.delete_alumni(p_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if not public.alumni_can('manage') then raise exception 'You cannot delete alumni.'; end if;
  update public.alumni set deleted_at = now() where id = p_id and deleted_at is null;
  if found then perform public.alumni_log(p_id, 'deleted'); end if;
end;
$$;

-- 📝 A note / a call / a message, by anyone who can see alumni
create or replace function public.add_alumni_event(p_alumni uuid, p_kind text, p_body text default null)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if not public.alumni_can('view') then raise exception 'You cannot see alumni.'; end if;
  if p_kind not in ('note', 'call', 'whatsapp', 'message') then raise exception 'Unknown kind.'; end if;
  if p_kind = 'note' and nullif(trim(coalesce(p_body, '')), '') is null then raise exception 'Please type the note.'; end if;
  if not exists (select 1 from public.alumni where id = p_alumni and deleted_at is null) then raise exception 'Alumnus not found.'; end if;
  perform public.alumni_log(p_alumni, p_kind, left(p_body, 2000));
  if p_kind in ('call', 'whatsapp', 'message') then
    update public.alumni set last_contacted_at = now() where id = p_alumni;
  end if;
end;
$$;

-- ---------------------------------------------------------------------
-- 📥 Many at once: from Students, Excel, phone contacts
--   p_rows: [{name, phone, ..., custom:{...}, lead_id?}]
--   Same phone (or same student) already there → skipped (or filled in, p_update)
-- ---------------------------------------------------------------------
create or replace function public.import_alumni(p_rows jsonb, p_update boolean default false)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  r        jsonb;
  v_phone  text;
  v_lead   uuid;
  v_found  uuid;
  v_added  int := 0;
  v_upd    int := 0;
  v_skip   int := 0;
  v_errors jsonb := '[]'::jsonb;
  v_n      int := 0;
begin
  if not public.alumni_can('manage') then raise exception 'You cannot add alumni.'; end if;
  if jsonb_typeof(p_rows) <> 'array' then raise exception 'Nothing to import.'; end if;
  if jsonb_array_length(p_rows) > 5000 then raise exception 'At most 5000 rows at a time.'; end if;

  for r in select * from jsonb_array_elements(p_rows) loop
    v_n := v_n + 1;
    begin
      if nullif(trim(coalesce(r ->> 'name', '')), '') is null then
        raise exception 'no name';
      end if;
      v_phone := nullif(public.normalize_bd_phone(nullif(trim(coalesce(r ->> 'phone', '')), '')), '');
      v_lead := nullif(r ->> 'lead_id', '')::uuid;
      select id into v_found from public.alumni
      where deleted_at is null and ((v_phone is not null and phone = v_phone) or (v_lead is not null and lead_id = v_lead))
      limit 1;

      if v_found is not null then
        if p_update then
          update public.alumni a set
            name = coalesce(nullif(trim(coalesce(r ->> 'name', '')), ''), a.name),
            email = coalesce(nullif(r ->> 'email', ''), a.email),
            whatsapp_number = coalesce(nullif(r ->> 'whatsapp_number', ''), a.whatsapp_number),
            course_id = coalesce(nullif(r ->> 'course_id', '')::uuid, a.course_id),
            batch_id = coalesce(nullif(r ->> 'batch_id', '')::uuid, a.batch_id),
            session = coalesce(nullif(trim(coalesce(r ->> 'session', '')), ''), a.session),
            passing_year = coalesce(nullif(r ->> 'passing_year', '')::int, a.passing_year),
            student_ref = coalesce(nullif(trim(coalesce(r ->> 'student_ref', '')), ''), a.student_ref),
            workplace = coalesce(nullif(trim(coalesce(r ->> 'workplace', '')), ''), a.workplace),
            designation = coalesce(nullif(trim(coalesce(r ->> 'designation', '')), ''), a.designation),
            district = coalesce(nullif(trim(coalesce(r ->> 'district', '')), ''), a.district),
            upazila = coalesce(nullif(trim(coalesce(r ->> 'upazila', '')), ''), a.upazila),
            lead_id = coalesce(a.lead_id, v_lead),
            custom = a.custom || coalesce((select jsonb_object_agg(k, v) from jsonb_each(coalesce(r -> 'custom', '{}')) as e(k, v)
                                           where k in (select key from public.alumni_fields where is_active)), '{}'::jsonb)
          where a.id = v_found;
          v_upd := v_upd + 1;
        else
          v_skip := v_skip + 1;
        end if;
        continue;
      end if;

      insert into public.alumni (name, phone, whatsapp_number, email, course_id, batch_id, session, passing_year,
                                 student_ref, workplace, designation, district, upazila, address, custom, notes,
                                 lead_id, created_by)
      values (r ->> 'name', v_phone, r ->> 'whatsapp_number', r ->> 'email',
              nullif(r ->> 'course_id', '')::uuid, nullif(r ->> 'batch_id', '')::uuid,
              nullif(trim(coalesce(r ->> 'session', '')), ''), nullif(r ->> 'passing_year', '')::int,
              nullif(trim(coalesce(r ->> 'student_ref', '')), ''), nullif(trim(coalesce(r ->> 'workplace', '')), ''),
              nullif(trim(coalesce(r ->> 'designation', '')), ''), nullif(trim(coalesce(r ->> 'district', '')), ''),
              nullif(trim(coalesce(r ->> 'upazila', '')), ''), nullif(trim(coalesce(r ->> 'address', '')), ''),
              coalesce((select jsonb_object_agg(k, v) from jsonb_each(coalesce(r -> 'custom', '{}')) as e(k, v)
                        where k in (select key from public.alumni_fields where is_active)), '{}'::jsonb),
              nullif(trim(coalesce(r ->> 'notes', '')), ''), v_lead, auth.uid())
      returning id into v_found;
      perform public.alumni_log(v_found, 'created', null, jsonb_build_object('import', coalesce(r ->> 'from', 'excel')));
      v_added := v_added + 1;
    exception when others then
      if jsonb_array_length(v_errors) < 50 then
        v_errors := v_errors || jsonb_build_object('row', v_n, 'name', r ->> 'name', 'error', sqlerrm);
      end if;
    end;
  end loop;

  return jsonb_build_object('added', v_added, 'updated', v_upd, 'skipped', v_skip,
                            'failed', v_n - v_added - v_upd - v_skip, 'errors', v_errors);
end;
$$;

-- 🎓 → 🎓 Students who passed become alumni (by student, or a whole batch)
create or replace function public.alumni_from_students(p_lead_ids uuid[] default null, p_batch_id uuid default null)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_rows jsonb;
begin
  if not public.alumni_can('manage') then raise exception 'You cannot add alumni.'; end if;
  if p_lead_ids is null and p_batch_id is null then raise exception 'Choose students or a batch.'; end if;

  select coalesce(jsonb_agg(jsonb_build_object(
           'name', l.name, 'phone', coalesce(l.phone, l.whatsapp_number), 'whatsapp_number', l.whatsapp_number,
           'email', l.email, 'course_id', l.admitted_course_id, 'batch_id', l.admitted_batch_id,
           'student_ref', l.student_ref, 'district', l.area, 'lead_id', l.id, 'from', 'students')), '[]'::jsonb)
  into v_rows
  from public.leads l
  where l.deleted_at is null
    and l.admitted_at is not null and l.cancelled_at is null
    and ((p_lead_ids is not null and l.id = any (p_lead_ids))
         or (p_batch_id is not null and l.admitted_batch_id = p_batch_id));

  return public.import_alumni(v_rows, false);
end;
$$;

-- ---------------------------------------------------------------------
-- 📨 Referrals
-- ---------------------------------------------------------------------
-- Add (staff, from the alumnus's page). Returns {id, existing_lead}
create or replace function public.add_alumni_referral(p_alumni uuid, p_name text, p_phone text,
                                                     p_course_id uuid default null, p_area text default null,
                                                     p_note text default null, p_channel text default 'staff')
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_phone  text := nullif(public.normalize_bd_phone(nullif(trim(coalesce(p_phone, '')), '')), '');
  v_alum   record;
  v_lead   uuid;
  v_id     uuid;
  v_wait   uuid;
  m        uuid;
begin
  -- staff need to see alumni; the public pages call this as the server (channel ≠ staff)
  if p_channel = 'staff' and not public.alumni_can('view') then raise exception 'You cannot see alumni.'; end if;
  if p_channel not in ('staff', 'alumni_link', 'prospect_link') then raise exception 'Unknown channel.'; end if;
  if nullif(trim(coalesce(p_name, '')), '') is null then raise exception 'Please type the name.'; end if;
  if v_phone is null or length(regexp_replace(v_phone, '\D', '', 'g')) < 10 then
    raise exception 'Please type a correct phone number.';
  end if;

  select id, name into v_alum from public.alumni where id = p_alumni and deleted_at is null;
  if v_alum.id is null then raise exception 'Alumnus not found.'; end if;

  select id into v_wait from public.alumni_referrals where phone = v_phone and status = 'new' limit 1;
  if v_wait is not null then
    raise exception 'This number is already waiting in the referral inbox.' using hint = 'referral_waiting';
  end if;

  -- already a lead? (the same check as Add lead)
  select f.id into v_lead from public.find_leads_by_phone(v_phone, null) f limit 1;
  if v_lead is null then
    -- find_leads_by_phone only answers active staff; the public pages are not
    select l.id into v_lead from public.leads l
    where l.deleted_at is null and v_phone in (l.phone, l.alt_phone, l.guardian_phone) limit 1;
  end if;

  insert into public.alumni_referrals (alumni_id, name, phone, course_id, area, note, channel, existing_lead_id, created_by)
  values (p_alumni, left(trim(p_name), 120), v_phone, p_course_id, left(nullif(trim(coalesce(p_area, '')), ''), 120),
          left(nullif(trim(coalesce(p_note, '')), ''), 1000), p_channel, v_lead, auth.uid())
  returning id into v_id;

  perform public.alumni_log(p_alumni, 'referral', trim(p_name), jsonb_build_object('referral_id', v_id, 'phone', v_phone));

  for m in select public.alumni_managers() loop
    continue when m = auth.uid();
    perform public.notify(m, 'alumni', '🎓 New referral from ' || v_alum.name,
      trim(p_name) || case when v_lead is not null then ' · already a lead' else '' end,
      jsonb_build_object('route', '/alumni/referrals'), 'alumni-ref:' || v_id, false);
  end loop;

  return jsonb_build_object('id', v_id, 'existing_lead', v_lead);
end;
$$;

-- Import as a new lead: the course(s) and the person are chosen here
create or replace function public.import_alumni_referral(p_referral uuid, p_course_ids uuid[], p_assign_to uuid default null,
                                                        p_stage_id uuid default null)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  r       public.alumni_referrals;
  v_alum  record;
  v_lead  uuid;
  v_src   uuid;
  v_stage uuid;
  v_dup   uuid;
begin
  if not public.alumni_can('manage') then raise exception 'You cannot import referrals.'; end if;
  select * into r from public.alumni_referrals where id = p_referral for update;
  if r.id is null then raise exception 'Referral not found.'; end if;
  if r.status <> 'new' then raise exception 'This referral was handled already.'; end if;

  select l.id into v_dup from public.leads l
  where l.deleted_at is null and r.phone in (l.phone, l.alt_phone, l.guardian_phone) limit 1;
  if v_dup is not null then
    update public.alumni_referrals set existing_lead_id = v_dup where id = r.id;
    raise exception 'This number is already a lead. Give the alumnus credit instead.' using hint = 'referral_duplicate:' || v_dup;
  end if;

  select id, name into v_alum from public.alumni where id = r.alumni_id;
  select id into v_src from public.lead_sources where lower(name) = 'alumni referral' limit 1;
  v_stage := coalesce(p_stage_id,
    (select id from public.pipeline_stages where is_active and kind = 'open' order by sort_order limit 1),
    (select id from public.pipeline_stages where is_active order by sort_order limit 1));

  v_lead := public.create_lead(
    jsonb_strip_nulls(jsonb_build_object(
      'name', r.name, 'phone', r.phone, 'area', r.area, 'notes', r.note,
      'stage_id', v_stage, 'source_id', v_src,
      'referred_by', v_alum.name, 'referred_by_alumni_id', r.alumni_id)),
    coalesce(p_course_ids, case when r.course_id is not null then array[r.course_id] end),
    '{}');

  -- The person chosen here (managing alumni is enough to give the lead to someone)
  if p_assign_to is not null then
    if not exists (select 1 from public.profiles where id = p_assign_to and is_active and deleted_at is null) then
      raise exception 'That person cannot take leads.';
    end if;
    perform set_config('app.handover', 'on', true);
    update public.leads set assigned_to = p_assign_to where id = v_lead and assigned_to is distinct from p_assign_to;
    perform set_config('app.handover', 'off', true);
  end if;

  update public.alumni_referrals set status = 'imported', lead_id = v_lead, handled_by = auth.uid(), handled_at = now()
  where id = r.id;
  insert into public.lead_activity (lead_id, user_id, action, details)
  values (v_lead, auth.uid(), 'alumni_referral', jsonb_build_object('alumni_id', r.alumni_id, 'alumni_name', v_alum.name, 'channel', r.channel));
  perform public.alumni_log(r.alumni_id, 'referral_imported', r.name, jsonb_build_object('referral_id', r.id, 'lead_id', v_lead));

  if p_assign_to is not null and p_assign_to is distinct from auth.uid() then
    perform public.notify(p_assign_to, 'alumni', '🎓 Referral lead for you',
      r.name || ' · referred by ' || v_alum.name, jsonb_build_object('lead_id', v_lead), 'alumni-lead:' || v_lead, false);
  end if;
  return v_lead;
end;
$$;

-- The number was already a lead: the admin decides whether the alumnus gets credit
create or replace function public.credit_alumni_referral(p_referral uuid, p_lead_id uuid default null, p_replace boolean default false)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  r      public.alumni_referrals;
  v_lead uuid;
  v_had  uuid;
  v_name text;
begin
  if not public.alumni_can('manage') then raise exception 'You cannot handle referrals.'; end if;
  select * into r from public.alumni_referrals where id = p_referral for update;
  if r.id is null then raise exception 'Referral not found.'; end if;
  if r.status <> 'new' then raise exception 'This referral was handled already.'; end if;
  v_lead := coalesce(p_lead_id, r.existing_lead_id);
  if v_lead is null then raise exception 'Choose the lead to give credit on.'; end if;

  select referred_by_alumni_id into v_had from public.leads where id = v_lead and deleted_at is null;
  if not found then raise exception 'Lead not found.'; end if;
  if v_had is not null and v_had <> r.alumni_id and not p_replace then
    raise exception 'Another alumnus already has credit for this lead.' using hint = 'referral_other_alumnus:' || v_had;
  end if;

  select name into v_name from public.alumni where id = r.alumni_id;
  update public.leads set referred_by_alumni_id = r.alumni_id, referred_by = coalesce(nullif(referred_by, ''), v_name)
  where id = v_lead;
  update public.alumni_referrals set status = 'credited', lead_id = v_lead, handled_by = auth.uid(), handled_at = now()
  where id = r.id;
  insert into public.lead_activity (lead_id, user_id, action, details)
  values (v_lead, auth.uid(), 'alumni_referral', jsonb_build_object('alumni_id', r.alumni_id, 'alumni_name', v_name, 'credit', true));
  perform public.alumni_log(r.alumni_id, 'referral_credited', r.name, jsonb_build_object('referral_id', r.id, 'lead_id', v_lead));
end;
$$;

create or replace function public.reject_alumni_referral(p_referral uuid, p_reason text default null)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  r public.alumni_referrals;
begin
  if not public.alumni_can('manage') then raise exception 'You cannot handle referrals.'; end if;
  select * into r from public.alumni_referrals where id = p_referral for update;
  if r.id is null then raise exception 'Referral not found.'; end if;
  if r.status <> 'new' then raise exception 'This referral was handled already.'; end if;
  update public.alumni_referrals set status = 'rejected', reject_reason = nullif(trim(coalesce(p_reason, '')), ''),
         handled_by = auth.uid(), handled_at = now()
  where id = r.id;
  perform public.alumni_log(r.alumni_id, 'referral_rejected', r.name, jsonb_build_object('referral_id', r.id, 'reason', p_reason));
end;
$$;

-- On the lead page: pick (or clear) the alumnus who referred this lead
create or replace function public.set_lead_alumni_referrer(p_lead uuid, p_alumni uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_name text;
  v_old  uuid;
begin
  if not public.alumni_can('view') then raise exception 'You cannot see alumni.'; end if;
  -- the lead must be one this person may change (the normal rules of the leads table)
  if not exists (select 1 from public.leads l where l.id = p_lead and l.deleted_at is null
                 and (public.has_permission('leads.edit_all') or public.has_permission('leads.view_all')
                      or l.assigned_to = auth.uid()
                      or (public.has_permission('leads.view_team') and l.assigned_to = any (coalesce(public.my_team_ids(), '{}'))))) then
    raise exception 'You cannot change this lead.';
  end if;
  select referred_by_alumni_id into v_old from public.leads where id = p_lead;
  if p_alumni is not null then
    select name into v_name from public.alumni where id = p_alumni and deleted_at is null;
    if v_name is null then raise exception 'Alumnus not found.'; end if;
    if v_old is not null and v_old <> p_alumni and not public.alumni_can('manage') then
      raise exception 'Another alumnus already has credit for this lead. Ask an admin.';
    end if;
  end if;
  update public.leads set referred_by_alumni_id = p_alumni,
         referred_by = case when p_alumni is null then referred_by else v_name end
  where id = p_lead;
  if p_alumni is not null and v_old is distinct from p_alumni then
    insert into public.lead_activity (lead_id, user_id, action, details)
    values (p_lead, auth.uid(), 'alumni_referral', jsonb_build_object('alumni_id', p_alumni, 'alumni_name', v_name, 'credit', true));
    perform public.alumni_log(p_alumni, 'referral_credited', (select name from public.leads where id = p_lead),
                              jsonb_build_object('lead_id', p_lead));
  end if;
end;
$$;

-- ---------------------------------------------------------------------
-- 🎉 A referred lead is admitted → event, notification, reward (if on)
--   Admission cancelled → the reward that is still due is cancelled
-- ---------------------------------------------------------------------
create or replace function public.alumni_on_admission()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_cfg    jsonb := public.alumni_setting() -> 'rewards';
  v_amount numeric;
  v_name   text;
  m        uuid;
begin
  if new.referred_by_alumni_id is null then return null; end if;

  if new.admitted_at is not null and new.cancelled_at is null
     and (old.admitted_at is null or old.cancelled_at is not null) then
    select name into v_name from public.alumni where id = new.referred_by_alumni_id;
    perform public.alumni_log(new.referred_by_alumni_id, 'admitted', new.name, jsonb_build_object('lead_id', new.id));

    if coalesce((v_cfg ->> 'enabled')::boolean, false) then
      v_amount := coalesce((v_cfg -> 'by_course' ->> new.admitted_course_id::text)::numeric,
                           (v_cfg ->> 'default_amount')::numeric, 0);
      if v_amount > 0 and not exists (select 1 from public.alumni_rewards where lead_id = new.id and status <> 'cancelled') then
        insert into public.alumni_rewards (alumni_id, lead_id, course_id, amount)
        values (new.referred_by_alumni_id, new.id, new.admitted_course_id, v_amount);
        perform public.alumni_log(new.referred_by_alumni_id, 'reward', 'Reward due: ৳' || v_amount,
                                  jsonb_build_object('lead_id', new.id, 'amount', v_amount));
      end if;
    end if;

    for m in select public.alumni_managers() loop
      perform public.notify(m, 'alumni', '🎉 Admitted by referral',
        new.name || ' · referred by ' || coalesce(v_name, 'an alumnus'),
        jsonb_build_object('route', '/alumni/' || new.referred_by_alumni_id), 'alumni-adm:' || new.id, false);
    end loop;

  elsif (new.cancelled_at is not null and old.cancelled_at is null)
        or (new.admitted_at is null and old.admitted_at is not null) then
    update public.alumni_rewards set status = 'cancelled', updated_at = now(),
           note = coalesce(note || ' · ', '') || 'admission cancelled'
    where lead_id = new.id and status = 'due';
  end if;
  return null;
end;
$$;

drop trigger if exists leads_alumni_admission on public.leads;
create trigger leads_alumni_admission
  after update of admitted_at, cancelled_at on public.leads
  for each row execute function public.alumni_on_admission();

-- 💵 Mark a reward paid / back to due / cancelled
create or replace function public.set_alumni_reward(p_reward uuid, p_status text, p_method text default null, p_note text default null)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_alumni uuid;
  v_amount numeric;
begin
  if not public.alumni_can('manage') then raise exception 'You cannot change rewards.'; end if;
  if p_status not in ('due', 'paid', 'cancelled') then raise exception 'Unknown status.'; end if;
  update public.alumni_rewards set
    status = p_status,
    paid_at = case when p_status = 'paid' then now() else null end,
    paid_by = case when p_status = 'paid' then auth.uid() else null end,
    method = case when p_status = 'paid' then nullif(trim(coalesce(p_method, '')), '') else method end,
    note = coalesce(nullif(trim(coalesce(p_note, '')), ''), note),
    updated_at = now()
  where id = p_reward
  returning alumni_id, amount into v_alumni, v_amount;
  if v_alumni is null then raise exception 'Reward not found.'; end if;
  perform public.alumni_log(v_alumni, 'reward',
    case p_status when 'paid' then 'Reward paid: ৳' || v_amount when 'due' then 'Reward due again: ৳' || v_amount
                  else 'Reward cancelled' end,
    jsonb_build_object('reward_id', p_reward, 'status', p_status, 'method', p_method));
end;
$$;

-- ---------------------------------------------------------------------
-- 📊 Numbers for the tab / Home
-- ---------------------------------------------------------------------
create or replace function public.alumni_summary()
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_month timestamptz := date_trunc('month', now());
begin
  if not public.alumni_can('view') then return null; end if;
  return jsonb_build_object(
    'alumni',            (select count(*) from public.alumni where deleted_at is null),
    'waiting',           (select count(*) from public.alumni_referrals where status = 'new'),
    'referrals_month',   (select count(*) from public.alumni_referrals where created_at >= v_month),
    'leads_month',       (select count(*) from public.leads where referred_by_alumni_id is not null and deleted_at is null and created_at >= v_month),
    'admitted_month',    (select count(*) from public.leads where referred_by_alumni_id is not null and deleted_at is null
                            and admitted_at >= v_month and cancelled_at is null),
    'admitted_total',    (select count(*) from public.leads where referred_by_alumni_id is not null and deleted_at is null
                            and admitted_at is not null and cancelled_at is null),
    'rewards_due',       case when public.alumni_can('manage')
                           then (select coalesce(sum(amount), 0) from public.alumni_rewards where status = 'due') end,
    'can_manage',        public.alumni_can('manage')
  );
end;
$$;

-- ---------------------------------------------------------------------
-- Grants (RLS above decides the rows)
-- ---------------------------------------------------------------------
grant select on public.alumni, public.alumni_fields, public.alumni_events, public.alumni_referrals, public.alumni_rewards
  to authenticated;
grant update on public.alumni to authenticated;
grant insert, update, delete on public.alumni_fields to authenticated;
revoke all on public.alumni, public.alumni_fields, public.alumni_events, public.alumni_referrals, public.alumni_rewards,
  public.alumni_overview from anon;
revoke all on function public.save_alumni(uuid, jsonb) from public, anon;
revoke all on function public.delete_alumni(uuid) from public, anon;
revoke all on function public.add_alumni_event(uuid, text, text) from public, anon;
revoke all on function public.import_alumni(jsonb, boolean) from public, anon;
revoke all on function public.alumni_from_students(uuid[], uuid) from public, anon;
revoke all on function public.add_alumni_referral(uuid, text, text, uuid, text, text, text) from public, anon;
revoke all on function public.import_alumni_referral(uuid, uuid[], uuid, uuid) from public, anon;
revoke all on function public.credit_alumni_referral(uuid, uuid, boolean) from public, anon;
revoke all on function public.reject_alumni_referral(uuid, text) from public, anon;
revoke all on function public.set_lead_alumni_referrer(uuid, uuid) from public, anon;
revoke all on function public.set_alumni_reward(uuid, text, text, text) from public, anon;
revoke all on function public.alumni_summary() from public, anon;
grant execute on function public.save_alumni(uuid, jsonb) to authenticated;
grant execute on function public.delete_alumni(uuid) to authenticated;
grant execute on function public.add_alumni_event(uuid, text, text) to authenticated;
grant execute on function public.import_alumni(jsonb, boolean) to authenticated;
grant execute on function public.alumni_from_students(uuid[], uuid) to authenticated;
grant execute on function public.add_alumni_referral(uuid, text, text, uuid, text, text, text) to authenticated;
grant execute on function public.import_alumni_referral(uuid, uuid[], uuid, uuid) to authenticated;
grant execute on function public.credit_alumni_referral(uuid, uuid, boolean) to authenticated;
grant execute on function public.reject_alumni_referral(uuid, text) to authenticated;
grant execute on function public.set_lead_alumni_referrer(uuid, uuid) to authenticated;
grant execute on function public.set_alumni_reward(uuid, text, text, text) to authenticated;
grant execute on function public.alumni_summary() to authenticated;
