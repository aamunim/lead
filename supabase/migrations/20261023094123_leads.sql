-- =====================================================================
-- 0007 · Leads: table, phone normalising, duplicate check,
--        access rules and automatic activity log
-- =====================================================================

-- ---------------------------------------------------------------------
-- Phone numbers: +8801711… / 8801711… / 01711… / 1711… → 01711…
-- ---------------------------------------------------------------------
create or replace function public.normalize_bd_phone(p text)
returns text
language plpgsql
immutable
as $$
declare
  d text;
begin
  if p is null then
    return null;
  end if;

  d := regexp_replace(p, '\D', '', 'g');   -- keep digits only

  if d = '' then
    return null;
  elsif length(d) = 13 and d like '880%' then
    d := '0' || substr(d, 4);              -- 8801711… → 01711…
  elsif length(d) = 10 and d like '1%' then
    d := '0' || d;                         -- 1711… → 01711…
  end if;

  return d;
end;
$$;

-- ---------------------------------------------------------------------
-- Leads
-- ---------------------------------------------------------------------
create table public.leads (
  id                 uuid primary key default gen_random_uuid(),

  -- who
  name               text not null,
  phone              text not null,           -- always stored normalised
  alt_phone          text,
  email              text,
  area               text,
  guardian_name      text,
  guardian_phone     text,
  guardian_relation  text,
  lead_type_id       uuid references public.lead_types (id),

  -- where from
  source_id          uuid references public.lead_sources (id),
  campaign_id        uuid references public.campaigns (id),
  referred_by        text,

  -- where it stands
  stage_id           uuid not null references public.pipeline_stages (id),
  rating             text check (rating in ('hot', 'warm', 'cold')),
  score              integer not null default 0,
  lost_reason_id     uuid references public.lost_reasons (id),

  -- who works on it
  assigned_to        uuid references public.profiles (id),

  -- dates the lists sort and filter by (kept up to date by later features)
  next_follow_up_at  timestamptz,
  last_contacted_at  timestamptz,
  admitted_at        timestamptz,

  notes              text,
  custom_fields      jsonb not null default '{}'::jsonb,

  created_by         uuid references auth.users (id),
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now(),
  deleted_at         timestamptz
);

create index leads_phone_idx          on public.leads (phone);
create index leads_alt_phone_idx      on public.leads (alt_phone);
create index leads_guardian_phone_idx on public.leads (guardian_phone);
create index leads_assigned_to_idx    on public.leads (assigned_to);
create index leads_stage_id_idx       on public.leads (stage_id);
create index leads_source_id_idx      on public.leads (source_id);
create index leads_next_follow_up_idx on public.leads (next_follow_up_at);
create index leads_created_at_idx     on public.leads (created_at desc);
create index leads_custom_fields_idx  on public.leads using gin (custom_fields);

create trigger leads_set_updated_at
before update on public.leads
for each row execute function public.set_updated_at();

-- Interested courses (a lead can want more than one)
create table public.lead_courses (
  lead_id    uuid not null references public.leads (id) on delete cascade,
  course_id  uuid not null references public.courses (id) on delete restrict,
  created_at timestamptz not null default now(),
  primary key (lead_id, course_id)
);
create index lead_courses_course_id_idx on public.lead_courses (course_id);

-- Tags
create table public.lead_tags (
  lead_id    uuid not null references public.leads (id) on delete cascade,
  tag_id     uuid not null references public.tags (id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (lead_id, tag_id)
);
create index lead_tags_tag_id_idx on public.lead_tags (tag_id);

-- Activity timeline (written only by triggers / server functions)
create table public.lead_activity (
  id          uuid primary key default gen_random_uuid(),
  lead_id     uuid not null references public.leads (id) on delete cascade,
  user_id     uuid references auth.users (id),
  action      text not null,          -- created, stage_changed, assigned, …
  details     jsonb not null default '{}'::jsonb,
  created_at  timestamptz not null default now()
);
create index lead_activity_lead_idx on public.lead_activity (lead_id, created_at desc);

-- =====================================================================
-- Who can see / change a lead
-- =====================================================================
create or replace function public.can_view_lead(p_assigned_to uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select
    public.has_permission('leads.view_all')
    or (p_assigned_to = auth.uid() and public.is_active_user())
    or (
      public.has_permission('leads.view_team')
      and exists (
        select 1 from public.profiles
        where id = p_assigned_to and team_lead_id = auth.uid()
      )
    );
$$;

create or replace function public.can_edit_lead(p_assigned_to uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select
    public.has_permission('leads.edit_all')
    or (p_assigned_to = auth.uid() and public.has_permission('leads.edit_own'))
    or (
      public.has_permission('leads.edit_team')
      and (
        p_assigned_to = auth.uid()
        or exists (
          select 1 from public.profiles
          where id = p_assigned_to and team_lead_id = auth.uid()
        )
      )
    );
$$;

-- =====================================================================
-- Before saving a lead: tidy phones, default stage, guard rules
-- =====================================================================
create or replace function public.leads_before_write()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  new.name           := trim(new.name);
  new.phone          := public.normalize_bd_phone(new.phone);
  new.alt_phone      := public.normalize_bd_phone(new.alt_phone);
  new.guardian_phone := public.normalize_bd_phone(new.guardian_phone);
  new.email          := nullif(lower(trim(new.email)), '');

  if new.name = '' then
    raise exception 'Lead name is required';
  end if;
  if new.phone is null then
    raise exception 'A phone number is required';
  end if;

  if tg_op = 'INSERT' then
    new.created_by := coalesce(new.created_by, auth.uid());

    if new.stage_id is null then
      select id into new.stage_id from public.pipeline_stages where key = 'new';
    end if;

    -- Without the assign permission, a new lead is always your own
    if not public.has_permission('leads.assign') then
      new.assigned_to := auth.uid();
    end if;

  else -- UPDATE
    -- The first source never changes (keeps reports honest)
    if old.source_id is not null
       and new.source_id is distinct from old.source_id
       and not public.has_permission('leads.edit_all') then
      raise exception 'The original source of a lead cannot be changed';
    end if;

    if new.assigned_to is distinct from old.assigned_to
       and not public.has_permission('leads.assign') then
      raise exception 'You are not allowed to reassign leads';
    end if;

    if new.deleted_at is distinct from old.deleted_at
       and not public.has_permission('leads.delete') then
      raise exception 'You are not allowed to delete leads';
    end if;

    new.created_by := old.created_by;
    new.created_at := old.created_at;
  end if;

  return new;
end;
$$;

create trigger leads_before_write
before insert or update on public.leads
for each row execute function public.leads_before_write();

-- =====================================================================
-- After saving a lead: write the activity timeline
-- =====================================================================
create or replace function public.leads_log_activity()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_user uuid := auth.uid();
begin
  if tg_op = 'INSERT' then
    insert into public.lead_activity (lead_id, user_id, action, details)
    values (new.id, v_user, 'created',
            jsonb_build_object('source_id', new.source_id, 'assigned_to', new.assigned_to));
    return new;
  end if;

  if new.stage_id is distinct from old.stage_id then
    insert into public.lead_activity (lead_id, user_id, action, details)
    values (new.id, v_user, 'stage_changed',
            jsonb_build_object('from', old.stage_id, 'to', new.stage_id));
  end if;

  if new.rating is distinct from old.rating then
    insert into public.lead_activity (lead_id, user_id, action, details)
    values (new.id, v_user, 'rating_changed',
            jsonb_build_object('from', old.rating, 'to', new.rating));
  end if;

  if new.assigned_to is distinct from old.assigned_to then
    insert into public.lead_activity (lead_id, user_id, action, details)
    values (new.id, v_user, 'assigned',
            jsonb_build_object('from', old.assigned_to, 'to', new.assigned_to));
  end if;

  if new.phone is distinct from old.phone or new.name is distinct from old.name then
    insert into public.lead_activity (lead_id, user_id, action, details)
    values (new.id, v_user, 'details_changed',
            jsonb_build_object('old_name', old.name, 'new_name', new.name,
                               'old_phone', old.phone, 'new_phone', new.phone));
  end if;

  if new.deleted_at is distinct from old.deleted_at then
    insert into public.lead_activity (lead_id, user_id, action, details)
    values (new.id, v_user, case when new.deleted_at is null then 'restored' else 'deleted' end, '{}');
  end if;

  return new;
end;
$$;

create trigger leads_log_activity
after insert or update on public.leads
for each row execute function public.leads_log_activity();

-- =====================================================================
-- Duplicate check: is this phone number already a lead?
-- Works for everyone (even if the lead belongs to someone else),
-- but only returns enough to warn, not the full record.
-- =====================================================================
create or replace function public.find_leads_by_phone(p_phone text, p_exclude_id uuid default null)
returns table (
  id               uuid,
  name             text,
  phone            text,
  stage_name       text,
  assigned_to_name text,
  can_open         boolean
)
language sql
stable
security definer
set search_path = public
as $$
  select
    l.id,
    l.name,
    l.phone,
    s.name,
    p.full_name,
    public.can_view_lead(l.assigned_to)
  from public.leads l
  join public.pipeline_stages s on s.id = l.stage_id
  left join public.profiles p on p.id = l.assigned_to
  where public.is_active_user()
    and l.deleted_at is null
    and (p_exclude_id is null or l.id <> p_exclude_id)
    and public.normalize_bd_phone(p_phone) in (l.phone, l.alt_phone, l.guardian_phone)
  limit 5;
$$;

revoke all on function public.find_leads_by_phone(text, uuid) from public;
grant execute on function public.find_leads_by_phone(text, uuid) to authenticated;

-- =====================================================================
-- Row Level Security
-- =====================================================================
alter table public.leads         enable row level security;
alter table public.lead_courses  enable row level security;
alter table public.lead_tags     enable row level security;
alter table public.lead_activity enable row level security;

-- Leads
create policy "leads_read" on public.leads
  for select to authenticated
  using (public.can_view_lead(assigned_to));

create policy "leads_insert" on public.leads
  for insert to authenticated
  with check (public.is_active_user());

create policy "leads_update" on public.leads
  for update to authenticated
  using (public.can_edit_lead(assigned_to))
  with check (public.can_view_lead(assigned_to) or public.has_permission('leads.assign'));

-- No hard delete from the app (leads are soft-deleted with deleted_at)

-- Interested courses and tags follow their lead
create policy "lead_courses_read" on public.lead_courses
  for select to authenticated
  using (exists (select 1 from public.leads l where l.id = lead_id));

create policy "lead_courses_write" on public.lead_courses
  for all to authenticated
  using (exists (select 1 from public.leads l where l.id = lead_id and public.can_edit_lead(l.assigned_to)))
  with check (exists (select 1 from public.leads l where l.id = lead_id and public.can_edit_lead(l.assigned_to)));

create policy "lead_tags_read" on public.lead_tags
  for select to authenticated
  using (exists (select 1 from public.leads l where l.id = lead_id));

create policy "lead_tags_write" on public.lead_tags
  for all to authenticated
  using (exists (select 1 from public.leads l where l.id = lead_id and public.can_edit_lead(l.assigned_to)))
  with check (exists (select 1 from public.leads l where l.id = lead_id and public.can_edit_lead(l.assigned_to)));

-- Activity: readable with the lead; written only by triggers
create policy "lead_activity_read" on public.lead_activity
  for select to authenticated
  using (exists (select 1 from public.leads l where l.id = lead_id));