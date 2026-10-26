-- =====================================================================
-- 0006 · Master data: courses, batches, sources, campaigns, stages,
--        lost reasons, call results, paper types, tags, lead types,
--        holidays, working days
-- =====================================================================

-- ---------------------------------------------------------------------
-- Courses and their fees
-- ---------------------------------------------------------------------
create table public.courses (
  id           uuid primary key default gen_random_uuid(),
  name         text not null,
  category     text,                         -- e.g. Diploma, Honours, Masters
  duration     text,                         -- e.g. 4 years / 8 semesters
  description  text,
  is_active    boolean not null default true,
  sort_order   integer not null default 0,
  created_by   uuid references auth.users (id),
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);
create unique index courses_name_key on public.courses (lower(name));

create table public.course_fees (
  id           uuid primary key default gen_random_uuid(),
  course_id    uuid not null references public.courses (id) on delete cascade,
  name         text not null,                -- e.g. Admission fee, Tuition per semester
  amount       numeric(12, 2) not null check (amount >= 0),
  sort_order   integer not null default 0,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);
create index course_fees_course_id_idx on public.course_fees (course_id);

-- ---------------------------------------------------------------------
-- Batches / intakes
-- ---------------------------------------------------------------------
create table public.batches (
  id             uuid primary key default gen_random_uuid(),
  course_id      uuid not null references public.courses (id) on delete restrict,
  name           text not null,              -- e.g. January 2027
  start_date     date,
  class_time     text,                       -- e.g. Morning shift
  seat_capacity  integer check (seat_capacity is null or seat_capacity >= 0),
  status         text not null default 'open'
                 check (status in ('open', 'closed', 'full')),
  is_active      boolean not null default true,
  sort_order     integer not null default 0,
  created_by     uuid references auth.users (id),
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now()
);
create index batches_course_id_idx on public.batches (course_id);
create unique index batches_course_name_key on public.batches (course_id, lower(name));

-- ---------------------------------------------------------------------
-- Lead sources and campaigns
-- ---------------------------------------------------------------------
create table public.lead_sources (
  id           uuid primary key default gen_random_uuid(),
  name         text not null,
  is_active    boolean not null default true,
  sort_order   integer not null default 0,
  created_by   uuid references auth.users (id),
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);
create unique index lead_sources_name_key on public.lead_sources (lower(name));

create table public.campaigns (
  id           uuid primary key default gen_random_uuid(),
  source_id    uuid references public.lead_sources (id) on delete set null,
  name         text not null,
  cost         numeric(12, 2) check (cost is null or cost >= 0),
  start_date   date,
  end_date     date,
  is_active    boolean not null default true,
  sort_order   integer not null default 0,
  created_by   uuid references auth.users (id),
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  check (end_date is null or start_date is null or end_date >= start_date)
);
create index campaigns_source_id_idx on public.campaigns (source_id);
create unique index campaigns_name_key on public.campaigns (lower(name));

-- ---------------------------------------------------------------------
-- Pipeline stages
-- kind: open = still in progress, won = admitted,
--       lost = lost, cancelled = admission cancelled later
-- ---------------------------------------------------------------------
create table public.pipeline_stages (
  id           uuid primary key default gen_random_uuid(),
  key          text not null unique,         -- stable code used by the app and reports
  name         text not null,
  kind         text not null default 'open'
               check (kind in ('open', 'won', 'lost', 'cancelled')),
  color        text not null default '#3557D4',
  is_system    boolean not null default false,  -- system stages cannot be removed
  is_active    boolean not null default true,
  sort_order   integer not null default 0,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);

-- ---------------------------------------------------------------------
-- Lost reasons
-- ---------------------------------------------------------------------
create table public.lost_reasons (
  id           uuid primary key default gen_random_uuid(),
  name         text not null,
  is_active    boolean not null default true,
  sort_order   integer not null default 0,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);
create unique index lost_reasons_name_key on public.lost_reasons (lower(name));

-- ---------------------------------------------------------------------
-- Call results
-- ---------------------------------------------------------------------
create table public.call_results (
  id                 uuid primary key default gen_random_uuid(),
  key                text not null unique,
  name               text not null,
  is_connected       boolean not null default false,  -- the lead was actually reached
  requires_note      boolean not null default false,  -- caller must write a note
  is_active          boolean not null default true,
  sort_order         integer not null default 0,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now()
);

-- ---------------------------------------------------------------------
-- Paper (document) types; course_id null = needed for every course
-- ---------------------------------------------------------------------
create table public.document_types (
  id           uuid primary key default gen_random_uuid(),
  name         text not null,
  course_id    uuid references public.courses (id) on delete cascade,
  is_required  boolean not null default true,
  is_active    boolean not null default true,
  sort_order   integer not null default 0,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);
create index document_types_course_id_idx on public.document_types (course_id);

-- ---------------------------------------------------------------------
-- Tags and lead types
-- ---------------------------------------------------------------------
create table public.tags (
  id           uuid primary key default gen_random_uuid(),
  name         text not null,
  color        text not null default '#3557D4',
  is_active    boolean not null default true,
  sort_order   integer not null default 0,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);
create unique index tags_name_key on public.tags (lower(name));

create table public.lead_types (
  id           uuid primary key default gen_random_uuid(),
  name         text not null,
  is_active    boolean not null default true,
  sort_order   integer not null default 0,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);
create unique index lead_types_name_key on public.lead_types (lower(name));

-- ---------------------------------------------------------------------
-- Holidays (a single day or a range)
-- ---------------------------------------------------------------------
create table public.holidays (
  id           uuid primary key default gen_random_uuid(),
  name         text not null,
  start_date   date not null,
  end_date     date not null,
  is_active    boolean not null default true,
  created_by   uuid references auth.users (id),
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  check (end_date >= start_date)
);
create index holidays_dates_idx on public.holidays (start_date, end_date);

-- =====================================================================
-- Same rules for every master table:
--   * updated_at kept current
--   * RLS on: active users read, settings managers add / edit / delete
-- =====================================================================
do $$
declare
  t text;
begin
  foreach t in array array[
    'courses', 'course_fees', 'batches', 'lead_sources', 'campaigns',
    'pipeline_stages', 'lost_reasons', 'call_results', 'document_types',
    'tags', 'lead_types', 'holidays'
  ]
  loop
    execute format(
      'create trigger %1$s_set_updated_at before update on public.%1$s
         for each row execute function public.set_updated_at()', t);

    execute format('alter table public.%1$s enable row level security', t);

    execute format(
      'create policy "%1$s_read" on public.%1$s
         for select to authenticated using (public.is_active_user())', t);

    execute format(
      'create policy "%1$s_insert" on public.%1$s
         for insert to authenticated with check (public.has_permission(''settings.manage''))', t);

    execute format(
      'create policy "%1$s_update" on public.%1$s
         for update to authenticated
         using (public.has_permission(''settings.manage''))
         with check (public.has_permission(''settings.manage''))', t);

    execute format(
      'create policy "%1$s_delete" on public.%1$s
         for delete to authenticated using (public.has_permission(''settings.manage''))', t);
  end loop;
end;
$$;

-- System stages can be renamed but never deleted or switched off
create or replace function public.protect_system_stages()
returns trigger
language plpgsql
as $$
begin
  if tg_op = 'DELETE' and old.is_system then
    raise exception 'System stages cannot be deleted';
  end if;
  if tg_op = 'UPDATE' and old.is_system
     and (new.is_active = false or new.kind is distinct from old.kind or new.key is distinct from old.key) then
    raise exception 'System stages cannot be switched off or changed in type';
  end if;
  return coalesce(new, old);
end;
$$;

create trigger pipeline_stages_protect_system
before update or delete on public.pipeline_stages
for each row execute function public.protect_system_stages();

-- =====================================================================
-- Default data, so the app works on day one (all editable in Settings)
-- =====================================================================
insert into public.lead_sources (name, sort_order) values
  ('Facebook', 1), ('Website', 2), ('Walk-in', 3), ('Referral', 4),
  ('Incoming call', 5), ('SMS campaign', 6), ('Seminar', 7), ('Old records', 8);

insert into public.pipeline_stages (key, name, kind, color, is_system, sort_order) values
  ('new',            'New',                 'open',      '#8A94A8', true,  1),
  ('contacted',      'Contacted',           'open',      '#5A7BE0', false, 2),
  ('interested',     'Interested',          'open',      '#3557D4', false, 3),
  ('follow_up',      'Follow-up',           'open',      '#4B3FC4', false, 4),
  ('papers_pending', 'Papers pending',      'open',      '#6334B8', false, 5),
  ('ready',          'Ready for admission', 'open',      '#14213D', false, 6),
  ('admitted',       'Admitted',            'won',       '#1F6B42', true,  7),
  ('lost',           'Lost',                'lost',      '#B23A0B', true,  8),
  ('cancelled',      'Admission cancelled', 'cancelled', '#8A5300', true,  9);

insert into public.lost_reasons (name, sort_order) values
  ('Fee too high', 1), ('Admitted elsewhere', 2), ('Not interested', 3),
  ('Unreachable', 4), ('Too far', 5), ('Wrong number', 6), ('Other', 7);

insert into public.call_results (key, name, is_connected, requires_note, sort_order) values
  ('connected',    'Connected',            true,  true,  1),
  ('no_answer',    'No answer',            false, false, 2),
  ('busy',         'Busy',                 false, false, 3),
  ('switched_off', 'Switched off',         false, false, 4),
  ('call_back',    'Asked to call back',   true,  false, 5),
  ('wrong_number', 'Wrong number',         false, false, 6);

insert into public.document_types (name, is_required, sort_order) values
  ('SSC certificate', true, 1), ('HSC certificate', true, 2),
  ('NID / Birth certificate', true, 3), ('Photo', true, 4),
  ('Transcript', false, 5);

insert into public.tags (name, color, sort_order) values
  ('Scholarship', '#1F6B42', 1), ('Hostel needed', '#8A5300', 2),
  ('Sibling', '#6334B8', 3), ('VIP', '#B23A0B', 4), ('Next session', '#5B6478', 5);

insert into public.lead_types (name, sort_order) values
  ('Student', 1), ('Guardian / Parent', 2), ('Agent', 3), ('Group admission', 4);

-- Working days and hours (ISO weekdays: 1 = Monday … 7 = Sunday; Friday = 5 is off)
insert into public.app_settings (key, value, description) values
  ('working_days',  '[1, 2, 3, 4, 6, 7]', 'Working weekdays (1 = Monday … 7 = Sunday)'),
  ('working_hours', '{"start": "09:00", "end": "18:00"}', 'Office working hours')
on conflict (key) do nothing;