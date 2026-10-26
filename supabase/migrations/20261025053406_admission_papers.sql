-- =====================================================================
-- Admission papers checklist
--   - Settings: which papers, required or not, for which courses
--   - Per lead: received / not needed, original or photocopy, where it is kept,
--     original returned; one "kept at" place for the student's whole file
--   - Anyone who can see the lead can tick (like follow-ups)
--   - Admitting with required papers missing: block / warn / allow (setting)
-- =====================================================================

-- ---------------------------------------------------------------------
-- 1. The papers list (Settings → Required papers)
-- ---------------------------------------------------------------------
create table if not exists public.admission_papers (
  id          uuid primary key default gen_random_uuid(),
  name        text not null check (length(trim(name)) between 1 and 60),
  description text,
  is_required boolean not null default true,
  course_ids  uuid[],                       -- null / empty = all courses
  sort_order  integer not null default 0,
  is_active   boolean not null default true,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

alter table public.admission_papers enable row level security;

create policy "admission_papers: view"
  on public.admission_papers for select
  to authenticated
  using (public.is_active_user());

create policy "admission_papers: admins add"
  on public.admission_papers for insert
  to authenticated
  with check (public.has_permission('settings.manage'));

create policy "admission_papers: admins change"
  on public.admission_papers for update
  to authenticated
  using (public.has_permission('settings.manage'))
  with check (public.has_permission('settings.manage'));

create policy "admission_papers: admins remove"
  on public.admission_papers for delete
  to authenticated
  using (public.has_permission('settings.manage'));

drop trigger if exists admission_papers_updated_at on public.admission_papers;
create trigger admission_papers_updated_at
  before update on public.admission_papers
  for each row execute function public.set_updated_at();

-- A few common papers to start with (only if the list is empty)
insert into public.admission_papers (name, is_required, sort_order)
select v.name, v.req, v.ord
from (values
  ('SSC certificate', true, 1),
  ('HSC certificate / marksheet', true, 2),
  ('Birth certificate or NID', true, 3),
  ('Passport size photos (4)', true, 4),
  ('Testimonial', false, 5)
) as v(name, req, ord)
where not exists (select 1 from public.admission_papers);

-- ---------------------------------------------------------------------
-- 2. Papers of each lead
-- ---------------------------------------------------------------------
create table if not exists public.lead_papers (
  id           uuid primary key default gen_random_uuid(),
  lead_id      uuid not null references public.leads(id) on delete cascade,
  paper_id     uuid not null references public.admission_papers(id) on delete restrict,
  status       text not null default 'received' check (status in ('received', 'not_needed')),
  copy_type    text check (copy_type in ('original', 'photocopy')),
  kept_at      text,                       -- only if this paper is kept somewhere else than the file
  note         text,
  received_at  timestamptz not null default now(),
  received_by  uuid default auth.uid() references public.profiles(id) on delete set null,
  returned_at  timestamptz,                -- original given back to the student
  returned_by  uuid references public.profiles(id) on delete set null,
  updated_at   timestamptz not null default now(),
  unique (lead_id, paper_id)
);

create index if not exists lead_papers_lead_idx on public.lead_papers (lead_id);

alter table public.lead_papers enable row level security;

-- Same people who can see the lead
create policy "lead_papers: view for visible leads"
  on public.lead_papers for select
  to authenticated
  using (public.is_active_user() and exists (select 1 from public.leads l where l.id = lead_papers.lead_id));

create policy "lead_papers: add for visible leads"
  on public.lead_papers for insert
  to authenticated
  with check (
    public.is_active_user()
    and exists (select 1 from public.leads l where l.id = lead_papers.lead_id and l.deleted_at is null)
  );

create policy "lead_papers: change for visible leads"
  on public.lead_papers for update
  to authenticated
  using (public.is_active_user() and exists (select 1 from public.leads l where l.id = lead_papers.lead_id))
  with check (exists (select 1 from public.leads l where l.id = lead_papers.lead_id and l.deleted_at is null));

create policy "lead_papers: remove for visible leads"
  on public.lead_papers for delete
  to authenticated
  using (public.is_active_user() and exists (select 1 from public.leads l where l.id = lead_papers.lead_id));

-- Where the student's whole file is kept (one place per lead)
create table if not exists public.lead_paper_folders (
  lead_id    uuid primary key references public.leads(id) on delete cascade,
  kept_at    text not null check (length(trim(kept_at)) between 1 and 120),
  updated_by uuid default auth.uid() references public.profiles(id) on delete set null,
  updated_at timestamptz not null default now()
);

alter table public.lead_paper_folders enable row level security;

create policy "lead_paper_folders: view for visible leads"
  on public.lead_paper_folders for select
  to authenticated
  using (public.is_active_user() and exists (select 1 from public.leads l where l.id = lead_paper_folders.lead_id));

create policy "lead_paper_folders: add for visible leads"
  on public.lead_paper_folders for insert
  to authenticated
  with check (
    public.is_active_user()
    and exists (select 1 from public.leads l where l.id = lead_paper_folders.lead_id and l.deleted_at is null)
  );

create policy "lead_paper_folders: change for visible leads"
  on public.lead_paper_folders for update
  to authenticated
  using (public.is_active_user() and exists (select 1 from public.leads l where l.id = lead_paper_folders.lead_id))
  with check (exists (select 1 from public.leads l where l.id = lead_paper_folders.lead_id and l.deleted_at is null));

create policy "lead_paper_folders: remove for visible leads"
  on public.lead_paper_folders for delete
  to authenticated
  using (public.is_active_user() and exists (select 1 from public.leads l where l.id = lead_paper_folders.lead_id));

-- ---------------------------------------------------------------------
-- 3. Quick numbers on the lead (for the list badge and filters)
-- ---------------------------------------------------------------------
alter table public.leads
  add column if not exists papers_required       integer not null default 0,  -- required papers for this lead
  add column if not exists papers_received       integer not null default 0,  -- of those: received or not needed
  add column if not exists papers_originals_held integer not null default 0,  -- originals with us, not returned
  add column if not exists papers_kept_at        text;                        -- copy of the file's place

create index if not exists leads_papers_kept_at_idx on public.leads (papers_kept_at) where papers_kept_at is not null;

-- Which papers apply to a lead: "all courses" papers + papers of its course(s)
--   p_course given → that course (e.g. the course chosen while admitting)
--   else the admitted course, else the courses the lead is interested in
create or replace function public.papers_for_lead(p_lead_id uuid, p_course_id uuid default null)
returns setof public.admission_papers
language sql
stable
security definer
set search_path = public
as $$
  with c as (
    select coalesce(
      case when p_course_id is not null then array[p_course_id] end,
      (select array[l.admitted_course_id] from public.leads l
        where l.id = p_lead_id and l.admitted_course_id is not null),
      (select array_agg(lc.course_id) from public.lead_courses lc where lc.lead_id = p_lead_id),
      '{}'::uuid[]
    ) as ids
  )
  select p.*
  from public.admission_papers p, c
  where p.is_active
    and (p.course_ids is null or cardinality(p.course_ids) = 0 or p.course_ids && c.ids)
  order by p.sort_order, p.name;
$$;

revoke all on function public.papers_for_lead(uuid, uuid) from public, anon, authenticated;

create or replace function public.refresh_lead_papers(p_lead_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_req  int;
  v_done int;
  v_orig int;
  v_kept text;
begin
  select
    count(*) filter (where p.is_required),
    count(*) filter (where p.is_required and lp.id is not null)
  into v_req, v_done
  from public.papers_for_lead(p_lead_id) p
  left join public.lead_papers lp on lp.paper_id = p.id and lp.lead_id = p_lead_id;

  select count(*) into v_orig
  from public.lead_papers
  where lead_id = p_lead_id and status = 'received' and copy_type = 'original' and returned_at is null;

  select kept_at into v_kept from public.lead_paper_folders where lead_id = p_lead_id;

  update public.leads
     set papers_required = coalesce(v_req, 0),
         papers_received = coalesce(v_done, 0),
         papers_originals_held = coalesce(v_orig, 0),
         papers_kept_at = v_kept
   where id = p_lead_id
     and (papers_required, papers_received, papers_originals_held, coalesce(papers_kept_at, ''))
         is distinct from (coalesce(v_req, 0), coalesce(v_done, 0), coalesce(v_orig, 0), coalesce(v_kept, ''));
end;
$$;

revoke all on function public.refresh_lead_papers(uuid) from public, anon, authenticated;

-- Keep the numbers right when papers, the file place, courses or the paper list change
create or replace function public.on_lead_papers_changed()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  perform public.refresh_lead_papers(coalesce(new.lead_id, old.lead_id));
  return null;
end;
$$;

drop trigger if exists lead_papers_refresh on public.lead_papers;
create trigger lead_papers_refresh
  after insert or update or delete on public.lead_papers
  for each row execute function public.on_lead_papers_changed();

drop trigger if exists lead_paper_folders_refresh on public.lead_paper_folders;
create trigger lead_paper_folders_refresh
  after insert or update or delete on public.lead_paper_folders
  for each row execute function public.on_lead_papers_changed();

drop trigger if exists lead_courses_refresh_papers on public.lead_courses;
create trigger lead_courses_refresh_papers
  after insert or delete on public.lead_courses
  for each row execute function public.on_lead_papers_changed();

create or replace function public.on_lead_course_admitted()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  perform public.refresh_lead_papers(new.id);
  return null;
end;
$$;

drop trigger if exists leads_refresh_papers on public.leads;
create trigger leads_refresh_papers
  after update of admitted_course_id on public.leads
  for each row execute function public.on_lead_course_admitted();

-- The paper list changed: recount every lead
create or replace function public.on_admission_papers_changed()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_id uuid;
begin
  for v_id in select id from public.leads where deleted_at is null loop
    perform public.refresh_lead_papers(v_id);
  end loop;
  return null;
end;
$$;

drop trigger if exists admission_papers_refresh on public.admission_papers;
create trigger admission_papers_refresh
  after insert or update or delete on public.admission_papers
  for each statement execute function public.on_admission_papers_changed();

-- Numbers for every existing lead
do $$
declare
  v_id uuid;
begin
  for v_id in select id from public.leads where deleted_at is null loop
    perform public.refresh_lead_papers(v_id);
  end loop;
end;
$$;

-- ---------------------------------------------------------------------
-- 4. Timeline lines
-- ---------------------------------------------------------------------
create or replace function public.log_lead_paper_activity()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_name text;
begin
  select name into v_name from public.admission_papers where id = coalesce(new.paper_id, old.paper_id);

  if tg_op = 'INSERT' then
    insert into public.lead_activity (lead_id, user_id, action, details)
    values (new.lead_id, auth.uid(),
            case when new.status = 'not_needed' then 'paper_not_needed' else 'paper_received' end,
            jsonb_build_object('paper', v_name, 'copy_type', new.copy_type));

  elsif tg_op = 'DELETE' then
    insert into public.lead_activity (lead_id, user_id, action, details)
    values (old.lead_id, auth.uid(), 'paper_unticked', jsonb_build_object('paper', v_name));

  else
    if new.returned_at is not null and old.returned_at is null then
      insert into public.lead_activity (lead_id, user_id, action, details)
      values (new.lead_id, auth.uid(), 'paper_returned', jsonb_build_object('paper', v_name));
    elsif new.status is distinct from old.status then
      insert into public.lead_activity (lead_id, user_id, action, details)
      values (new.lead_id, auth.uid(),
              case when new.status = 'not_needed' then 'paper_not_needed' else 'paper_received' end,
              jsonb_build_object('paper', v_name, 'copy_type', new.copy_type));
    end if;
  end if;
  return null;
end;
$$;

drop trigger if exists lead_papers_activity on public.lead_papers;
create trigger lead_papers_activity
  after insert or update or delete on public.lead_papers
  for each row execute function public.log_lead_paper_activity();

create or replace function public.log_paper_folder_activity()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if tg_op = 'DELETE' then
    insert into public.lead_activity (lead_id, user_id, action, details)
    values (old.lead_id, auth.uid(), 'papers_moved', jsonb_build_object('kept_at', null));
  elsif tg_op = 'INSERT' or new.kept_at is distinct from old.kept_at then
    insert into public.lead_activity (lead_id, user_id, action, details)
    values (new.lead_id, auth.uid(), 'papers_moved', jsonb_build_object('kept_at', new.kept_at));
  end if;
  return null;
end;
$$;

drop trigger if exists lead_paper_folders_activity on public.lead_paper_folders;
create trigger lead_paper_folders_activity
  after insert or update or delete on public.lead_paper_folders
  for each row execute function public.log_paper_folder_activity();

-- ---------------------------------------------------------------------
-- 5. Functions for the app (run as the user: only visible leads)
-- ---------------------------------------------------------------------

-- The papers card: every paper that applies, with what was received
create or replace function public.lead_papers_status(p_lead_id uuid)
returns table (
  paper_id uuid, name text, description text, is_required boolean,
  record_id uuid, status text, copy_type text, kept_at text, note text,
  received_at timestamptz, received_by_name text,
  returned_at timestamptz, returned_by_name text
)
language sql
stable
security invoker
set search_path = public
as $$
  -- the lead must be visible to this user
  with visible as (select id from public.leads where id = p_lead_id)
  select p.id, p.name, p.description, p.is_required,
         lp.id, lp.status, lp.copy_type, lp.kept_at, lp.note,
         lp.received_at, rb.full_name,
         lp.returned_at, tb.full_name
  from visible v
  cross join lateral public.papers_for_lead(v.id) p
  left join public.lead_papers lp on lp.lead_id = v.id and lp.paper_id = p.id
  left join public.profiles rb on rb.id = lp.received_by
  left join public.profiles tb on tb.id = lp.returned_by
  union all
  -- papers received earlier that no longer apply (course changed / paper switched off)
  select p.id, p.name, p.description, false,
         lp.id, lp.status, lp.copy_type, lp.kept_at, lp.note,
         lp.received_at, rb.full_name,
         lp.returned_at, tb.full_name
  from visible v
  join public.lead_papers lp on lp.lead_id = v.id
  join public.admission_papers p on p.id = lp.paper_id
  left join public.profiles rb on rb.id = lp.received_by
  left join public.profiles tb on tb.id = lp.returned_by
  where not exists (select 1 from public.papers_for_lead(v.id) a where a.id = p.id);
$$;

grant execute on function public.lead_papers_status(uuid) to authenticated;

-- Tick / change / untick one paper
--   p_status: 'received' | 'not_needed' | null (untick)
create or replace function public.set_lead_paper(
  p_lead_id   uuid,
  p_paper_id  uuid,
  p_status    text,
  p_copy_type text default null,
  p_kept_at   text default null,
  p_note      text default null
)
returns void
language plpgsql
security invoker
set search_path = public
as $$
begin
  if not public.is_active_user() then raise exception 'Your account is not active.'; end if;

  if p_status is null then
    delete from public.lead_papers where lead_id = p_lead_id and paper_id = p_paper_id;
    return;
  end if;

  if p_status not in ('received', 'not_needed') then
    raise exception 'Unknown paper status.';
  end if;

  insert into public.lead_papers (lead_id, paper_id, status, copy_type, kept_at, note)
  values (
    p_lead_id, p_paper_id, p_status,
    case when p_status = 'received' then p_copy_type end,
    nullif(trim(coalesce(p_kept_at, '')), ''),
    nullif(trim(coalesce(p_note, '')), '')
  )
  on conflict (lead_id, paper_id) do update set
    status      = excluded.status,
    copy_type   = excluded.copy_type,
    kept_at     = excluded.kept_at,
    note        = excluded.note,
    received_at = case when lead_papers.status is distinct from excluded.status then now() else lead_papers.received_at end,
    received_by = case when lead_papers.status is distinct from excluded.status then auth.uid() else lead_papers.received_by end,
    -- an original that becomes a photocopy (or not needed) can't still be "returned"
    returned_at = case when excluded.copy_type = 'original' then lead_papers.returned_at end,
    returned_by = case when excluded.copy_type = 'original' then lead_papers.returned_by end,
    updated_at  = now();
end;
$$;

grant execute on function public.set_lead_paper(uuid, uuid, text, text, text, text) to authenticated;

-- An original given back to the student (or undo)
create or replace function public.return_lead_paper(p_lead_id uuid, p_paper_id uuid, p_undo boolean default false)
returns void
language plpgsql
security invoker
set search_path = public
as $$
declare
  v_rows int;
begin
  if not public.is_active_user() then raise exception 'Your account is not active.'; end if;

  update public.lead_papers
     set returned_at = case when p_undo then null else now() end,
         returned_by = case when p_undo then null else auth.uid() end,
         updated_at  = now()
   where lead_id = p_lead_id and paper_id = p_paper_id
     and status = 'received' and copy_type = 'original';

  get diagnostics v_rows = row_count;
  if v_rows = 0 then raise exception 'Only a received original can be returned.'; end if;
end;
$$;

grant execute on function public.return_lead_paper(uuid, uuid, boolean) to authenticated;

-- Where the student's file is kept (empty = remove)
create or replace function public.set_paper_folder(p_lead_id uuid, p_kept_at text)
returns void
language plpgsql
security invoker
set search_path = public
as $$
declare
  v_place text := nullif(trim(coalesce(p_kept_at, '')), '');
begin
  if not public.is_active_user() then raise exception 'Your account is not active.'; end if;

  if v_place is null then
    delete from public.lead_paper_folders where lead_id = p_lead_id;
    return;
  end if;

  insert into public.lead_paper_folders (lead_id, kept_at)
  values (p_lead_id, left(v_place, 120))
  on conflict (lead_id) do update
    set kept_at = excluded.kept_at, updated_by = auth.uid(), updated_at = now();
end;
$$;

grant execute on function public.set_paper_folder(uuid, text) to authenticated;

-- Places typed before (newest first), so nobody has to type them again
create or replace function public.paper_place_suggestions()
returns table (kept_at text)
language sql
stable
security definer
set search_path = public
as $$
  select place from (
    select kept_at as place, max(updated_at) as last_used from public.lead_paper_folders group by kept_at
    union all
    select kept_at, max(updated_at) from public.lead_papers where kept_at is not null group by kept_at
  ) x
  where public.is_active_user()
  group by place
  order by max(last_used) desc
  limit 20;
$$;

grant execute on function public.paper_place_suggestions() to authenticated;

-- Required papers still missing for a lead (and a course while admitting)
create or replace function public.lead_missing_papers(p_lead_id uuid, p_course_id uuid default null)
returns table (paper_id uuid, name text)
language sql
stable
security invoker
set search_path = public
as $$
  select p.id, p.name
  from (select id from public.leads where id = p_lead_id) v
  cross join lateral public.papers_for_lead(v.id, p_course_id) p
  where p.is_required
    and not exists (select 1 from public.lead_papers lp where lp.lead_id = v.id and lp.paper_id = p.id);
$$;

grant execute on function public.lead_missing_papers(uuid, uuid) to authenticated;

-- ---------------------------------------------------------------------
-- 6. Admission setting (replaces the earlier version): + papers_on_admit
--    'block' = can't admit with required papers missing
--    'warn'  = the app shows what's missing, the user can still admit (default)
--    'allow' = no check
-- ---------------------------------------------------------------------
create or replace function public.admission_setting()
returns jsonb
language sql
stable
security definer
set search_path = public
as $$
  select jsonb_build_object(
           'mark',   jsonb_build_object('mode', 'all', 'roles', '[]'::jsonb, 'user_ids', '[]'::jsonb),
           'cancel', jsonb_build_object('mode', 'roles', 'roles', '["super_admin","admin"]'::jsonb, 'user_ids', '[]'::jsonb),
           'batch_required', false,
           'allow_overbooking', false,
           'student_id', jsonb_build_object('mode', 'auto', 'pattern', 'ADM-{YYYY}-{0000}'),
           'closed_in_list', 'hide',
           'papers_on_admit', 'warn'
         )
         || coalesce((select value from public.app_settings where key = 'admission'), '{}'::jsonb);
$$;

-- "Block": checked in the database when a lead becomes Admitted
create or replace function public.check_papers_on_admit()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_new_kind text;
  v_old_kind text;
  v_missing  text;
begin
  if coalesce(public.admission_setting()->>'papers_on_admit', 'warn') <> 'block' then
    return new;
  end if;

  select kind into v_new_kind from public.pipeline_stages where id = new.stage_id;
  select kind into v_old_kind from public.pipeline_stages where id = old.stage_id;
  if v_new_kind <> 'won' or v_old_kind = 'won' then
    return new;
  end if;

  select string_agg(p.name, ', ' order by p.sort_order) into v_missing
  from public.papers_for_lead(new.id, new.admitted_course_id) p
  where p.is_required
    and not exists (select 1 from public.lead_papers lp where lp.lead_id = new.id and lp.paper_id = p.id);

  if v_missing is not null then
    raise exception 'Required papers missing: %', v_missing;
  end if;
  return new;
end;
$$;

drop trigger if exists leads_papers_on_admit on public.leads;
create trigger leads_papers_on_admit
  before update of stage_id on public.leads
  for each row execute function public.check_papers_on_admit();

notify pgrst, 'reload schema';