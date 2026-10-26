-- =====================================================================
-- Phase 3, Part 1: Pipeline (Admitted / Lost / Cancelled / Reopen)
--   Everything that closes or reopens a lead goes through the functions
--   below; a normal stage change can only move between OPEN stages.
-- =====================================================================

-- ---------------------------------------------------------------------
-- 1. Admission settings (Settings → Admission)
-- ---------------------------------------------------------------------
insert into public.app_settings (key, value, description)
values (
  'admission',
  '{
    "mark":   { "mode": "all",   "roles": ["super_admin", "admin", "team_lead", "caller"], "user_ids": [] },
    "cancel": { "mode": "roles", "roles": ["super_admin", "admin"], "user_ids": [] },
    "batch_required": false,
    "allow_overbooking": false,
    "student_id": { "mode": "auto", "pattern": "ADM-{YYYY}-{0000}" },
    "closed_in_list": "hide"
  }'::jsonb,
  'Who can admit / cancel, batch and student ID rules, closed leads in the list'
)
on conflict (key) do nothing;

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
           'closed_in_list', 'hide'
         )
         || coalesce((select value from public.app_settings where key = 'admission'), '{}'::jsonb);
$$;

grant execute on function public.admission_setting() to authenticated;

-- Does a "who can" rule ({mode, roles, user_ids}) allow the signed-in user?
-- The Super Admin is always allowed.
create or replace function public.admission_rule_allows(p_rule jsonb)
returns boolean
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_role text;
begin
  if auth.uid() is null or not public.is_active_user() then return false; end if;
  select role_key into v_role from public.profiles where id = auth.uid();
  if v_role = 'super_admin' then return true; end if;

  case coalesce(p_rule->>'mode', 'all')
    when 'all'   then return true;
    when 'roles' then return coalesce(p_rule->'roles', '[]'::jsonb) ? v_role;
    when 'users' then return coalesce(p_rule->'user_ids', '[]'::jsonb) ? auth.uid()::text;
    else return false;
  end case;
end;
$$;

revoke all on function public.admission_rule_allows(jsonb) from public, anon, authenticated;

create or replace function public.can_mark_admitted()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select public.admission_rule_allows(public.admission_setting()->'mark');
$$;

create or replace function public.can_cancel_admission()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select public.admission_rule_allows(public.admission_setting()->'cancel');
$$;

grant execute on function public.can_mark_admitted() to authenticated;
grant execute on function public.can_cancel_admission() to authenticated;

-- ---------------------------------------------------------------------
-- 2. Stages: the 4 kinds, plus two new options
-- ---------------------------------------------------------------------
alter table public.pipeline_stages drop constraint if exists pipeline_stages_kind_check;
alter table public.pipeline_stages
  add constraint pipeline_stages_kind_check check (kind in ('open', 'won', 'lost', 'cancelled'));

alter table public.pipeline_stages
  add column if not exists follow_up_days integer check (follow_up_days between 0 and 365),  -- next call N days after moving here
  add column if not exists note_required boolean not null default false;                      -- a note is needed to move here

-- Admitted / Lost / Cancelled always exist: they can't be added, removed, switched off or changed to another kind
create or replace function public.guard_pipeline_stage()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  if auth.uid() is null then
    return coalesce(new, old);   -- database tools
  end if;

  if tg_op = 'INSERT' then
    if new.kind <> 'open' then
      raise exception 'Only normal (open) stages can be added.';
    end if;
    return new;
  end if;

  if tg_op = 'DELETE' then
    if old.kind <> 'open' then
      raise exception '"%" is needed by the app and can''t be removed.', old.name;
    end if;
    return old;
  end if;

  -- UPDATE
  if old.kind <> 'open' and (new.kind <> old.kind or not new.is_active) then
    raise exception '"%" is needed by the app. You can rename it or change its colour only.', old.name;
  end if;
  if old.kind = 'open' and new.kind <> 'open' then
    raise exception 'A normal stage can''t become Admitted, Lost or Cancelled.';
  end if;
  return new;
end;
$$;

drop trigger if exists pipeline_stages_guard on public.pipeline_stages;
create trigger pipeline_stages_guard
  before insert or update or delete on public.pipeline_stages
  for each row execute function public.guard_pipeline_stage();

-- The (first active) stage of a kind
create or replace function public.stage_of_kind(p_kind text)
returns uuid
language sql
stable
security definer
set search_path = public
as $$
  select id from public.pipeline_stages
  where kind = p_kind and is_active
  order by sort_order
  limit 1;
$$;

grant execute on function public.stage_of_kind(text) to authenticated;

-- ---------------------------------------------------------------------
-- 3. Leads: admission, lost and cancel details
-- ---------------------------------------------------------------------
alter table public.leads
  add column if not exists admitted_by        uuid references public.profiles(id) on delete set null,
  add column if not exists admitted_course_id uuid references public.courses(id)  on delete set null,
  add column if not exists admitted_batch_id  uuid references public.batches(id)  on delete set null,
  add column if not exists student_ref        text,
  add column if not exists admission_note     text,
  add column if not exists lost_at            timestamptz,
  add column if not exists lost_by            uuid references public.profiles(id) on delete set null,
  add column if not exists lost_note          text,
  add column if not exists closed_at          timestamptz,
  add column if not exists cancelled_at       timestamptz,
  add column if not exists cancelled_by       uuid references public.profiles(id) on delete set null,
  add column if not exists cancel_reason      text;

create unique index if not exists leads_student_ref_unique
  on public.leads (lower(student_ref)) where student_ref is not null;
create index if not exists leads_admitted_batch_idx
  on public.leads (admitted_batch_id) where admitted_batch_id is not null;
create index if not exists leads_closed_idx
  on public.leads (closed_at) where closed_at is not null;

-- Leads already in a closed stage get a closed time
update public.leads l
   set closed_at = coalesce(l.admitted_at, l.updated_at),
       lost_at   = case when s.kind = 'lost' then coalesce(l.lost_at, l.updated_at) else l.lost_at end
  from public.pipeline_stages s
 where s.id = l.stage_id and s.kind <> 'open' and l.closed_at is null;

-- Follow-ups get a purpose, so "♻️ Revive" can still show for a lost lead
alter table public.follow_ups
  add column if not exists purpose text check (purpose in ('revive'));

-- ---------------------------------------------------------------------
-- 4. Stage history (for the funnel and "time in each stage")
-- ---------------------------------------------------------------------
create table if not exists public.lead_stage_history (
  id            uuid primary key default gen_random_uuid(),
  lead_id       uuid not null references public.leads(id) on delete cascade,
  from_stage_id uuid references public.pipeline_stages(id) on delete set null,
  to_stage_id   uuid references public.pipeline_stages(id) on delete set null,
  changed_by    uuid references public.profiles(id) on delete set null,
  changed_at    timestamptz not null default now(),
  note          text
);

create index if not exists lead_stage_history_lead_idx on public.lead_stage_history (lead_id, changed_at desc);
create index if not exists lead_stage_history_to_idx on public.lead_stage_history (to_stage_id, changed_at);

alter table public.lead_stage_history enable row level security;

-- Same people who can see the lead
create policy "lead_stage_history: view for visible leads"
  on public.lead_stage_history for select
  to authenticated
  using (public.is_active_user() and exists (select 1 from public.leads l where l.id = lead_stage_history.lead_id));

-- Today's stage of every existing lead is its first history line
insert into public.lead_stage_history (lead_id, from_stage_id, to_stage_id, changed_by, changed_at)
select l.id, null, l.stage_id, l.created_by, l.created_at
from public.leads l
where not exists (select 1 from public.lead_stage_history h where h.lead_id = l.id);

-- ---------------------------------------------------------------------
-- 5. Guard: only the pipeline functions may close or reopen a lead
--    (they set app.pipeline_action for their own transaction only)
-- ---------------------------------------------------------------------
create or replace function public.guard_lead_pipeline()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_old_kind text;
  v_new_kind text;
begin
  if auth.uid() is null or coalesce(current_setting('app.pipeline_action', true), '') = 'on' then
    return new;   -- database tools, or one of the pipeline functions
  end if;

  select kind into v_new_kind from public.pipeline_stages where id = new.stage_id;

  if tg_op = 'INSERT' then
    if v_new_kind <> 'open' then
      raise exception 'A new lead must start in a normal stage.';
    end if;
    return new;
  end if;

  -- Admission / lost / closed details can't be typed in directly
  if new.admitted_at        is distinct from old.admitted_at
     or new.admitted_by        is distinct from old.admitted_by
     or new.admitted_course_id is distinct from old.admitted_course_id
     or new.admitted_batch_id  is distinct from old.admitted_batch_id
     or new.student_ref        is distinct from old.student_ref
     or new.lost_reason_id     is distinct from old.lost_reason_id
     or new.lost_at            is distinct from old.lost_at
     or new.closed_at          is distinct from old.closed_at
     or new.cancelled_at       is distinct from old.cancelled_at then
    raise exception 'Use Mark admitted, Mark lost, Reopen or Cancel admission for this.';
  end if;

  if new.stage_id is not distinct from old.stage_id then
    return new;
  end if;

  select kind into v_old_kind from public.pipeline_stages where id = old.stage_id;

  if v_old_kind <> 'open' then
    raise exception 'This lead is closed. Reopen it first.';
  end if;
  if v_new_kind <> 'open' then
    raise exception 'Use "Mark admitted" or "Mark lost" for this.';
  end if;
  return new;
end;
$$;

drop trigger if exists leads_guard_pipeline on public.leads;
create trigger leads_guard_pipeline
  before insert or update on public.leads
  for each row execute function public.guard_lead_pipeline();

-- Every stage change goes into the history
create or replace function public.log_lead_stage_history()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if tg_op = 'INSERT' or new.stage_id is distinct from old.stage_id then
    insert into public.lead_stage_history (lead_id, from_stage_id, to_stage_id, changed_by, note)
    values (
      new.id,
      case when tg_op = 'INSERT' then null else old.stage_id end,
      new.stage_id,
      auth.uid(),
      nullif(current_setting('app.stage_note', true), '')
    );
  end if;
  return null;
end;
$$;

drop trigger if exists leads_stage_history on public.leads;
create trigger leads_stage_history
  after insert or update of stage_id on public.leads
  for each row execute function public.log_lead_stage_history();

-- ---------------------------------------------------------------------
-- 6. Seats and batches
-- ---------------------------------------------------------------------
create or replace function public.batch_seats_taken(p_batch_id uuid)
returns integer
language sql
stable
security definer
set search_path = public
as $$
  select count(*)::int
  from public.leads l
  join public.pipeline_stages s on s.id = l.stage_id
  where l.admitted_batch_id = p_batch_id and s.kind = 'won' and l.deleted_at is null;
$$;

grant execute on function public.batch_seats_taken(uuid) to authenticated;

-- Batches of a course, with seats taken / left (for the Admit sheet)
create or replace function public.admission_batches(p_course_id uuid)
returns table (
  id uuid, name text, start_date date, class_time text, status text,
  seat_capacity int, seats_taken int, seats_left int, is_full boolean
)
language sql
stable
security definer
set search_path = public
as $$
  select b.id, b.name, b.start_date, b.class_time, b.status,
         b.seat_capacity,
         t.taken,
         case when b.seat_capacity is null then null else greatest(b.seat_capacity - t.taken, 0) end,
         b.seat_capacity is not null and t.taken >= b.seat_capacity
  from public.batches b
  cross join lateral (select public.batch_seats_taken(b.id) as taken) t
  where b.course_id = p_course_id and b.is_active and public.is_active_user()
  order by b.sort_order, b.start_date nulls last, b.name;
$$;

grant execute on function public.admission_batches(uuid) to authenticated;

-- ---------------------------------------------------------------------
-- 7. Student ID: pattern like ADM-{YYYY}-{0000}
--    {YYYY} year · {YY} short year · {0000} running number (width = number of zeros)
--    The number starts again each year when the pattern has a year in it.
-- ---------------------------------------------------------------------
create table if not exists public.admission_counters (
  scope      text primary key,
  last_value integer not null default 0
);

alter table public.admission_counters enable row level security;   -- no policies: only the functions use it

create or replace function public.format_student_ref(p_pattern text, p_number int)
returns text
language plpgsql
immutable
as $$
declare
  v_now   timestamptz := now();
  v_out   text := coalesce(nullif(trim(p_pattern), ''), 'ADM-{YYYY}-{0000}');
  v_zeros text := substring(v_out from '\{(0+)\}');
begin
  v_out := replace(v_out, '{YYYY}', to_char(v_now at time zone 'Asia/Dhaka', 'YYYY'));
  v_out := replace(v_out, '{YY}',   to_char(v_now at time zone 'Asia/Dhaka', 'YY'));
  if v_zeros is null then
    return v_out || p_number::text;
  end if;
  return regexp_replace(v_out, '\{0+\}', lpad(p_number::text, length(v_zeros), '0'));
end;
$$;

create or replace function public.student_ref_scope(p_pattern text)
returns text
language sql
stable
as $$
  select case
    when coalesce(p_pattern, '') like '%{YY%' then to_char(now() at time zone 'Asia/Dhaka', 'YYYY')
    else 'all'
  end;
$$;

-- What the next ID will look like (for the Admit sheet; does not use it up)
create or replace function public.preview_student_ref()
returns text
language sql
stable
security definer
set search_path = public
as $$
  select public.format_student_ref(
    public.admission_setting()->'student_id'->>'pattern',
    coalesce((
      select last_value from public.admission_counters
      where scope = public.student_ref_scope(public.admission_setting()->'student_id'->>'pattern')
    ), 0) + 1
  );
$$;

grant execute on function public.preview_student_ref() to authenticated;

-- Take the next free ID (only while admitting)
create or replace function public.next_student_ref()
returns text
language plpgsql
security definer
set search_path = public
as $$
declare
  v_pattern text := public.admission_setting()->'student_id'->>'pattern';
  v_scope   text := public.student_ref_scope(v_pattern);
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

    v_ref := public.format_student_ref(v_pattern, v_n);
    -- skip numbers someone typed by hand earlier
    exit when not exists (select 1 from public.leads where lower(student_ref) = lower(v_ref));
  end loop;

  return v_ref;
end;
$$;

grant execute on function public.next_student_ref() to authenticated;

-- ---------------------------------------------------------------------
-- 8. Helper: close the pending follow-up without a "removed" timeline line
-- ---------------------------------------------------------------------
create or replace function public.finish_pending_follow_up(p_lead_id uuid)
returns void
language sql
security invoker
set search_path = public
as $$
  update public.follow_ups
     set status = 'done', completed_at = now(), completed_by = auth.uid()
   where lead_id = p_lead_id and status = 'pending';
$$;

-- ---------------------------------------------------------------------
-- 9. Mark admitted
--    Runs as the user: only leads they can edit (RLS) can be admitted.
-- ---------------------------------------------------------------------
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
security invoker
set search_path = public
as $$
declare
  v_cfg     jsonb := public.admission_setting();
  v_kind    text;
  v_ref     text;
  v_old_ref text;
  v_batch   record;
  v_taken   int;
  v_mode    text := coalesce(v_cfg->'student_id'->>'mode', 'auto');
  v_note    text := nullif(trim(coalesce(p_note, '')), '');
  v_rows    int;
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

  -- Course
  if p_course_id is null then raise exception 'Please choose a course.'; end if;
  if not exists (select 1 from public.courses where id = p_course_id and is_active) then
    raise exception 'That course is not available.';
  end if;

  -- Batch
  if p_batch_id is null and coalesce((v_cfg->>'batch_required')::boolean, false) then
    raise exception 'Please choose a batch.';
  end if;

  if p_batch_id is not null then
    -- one admission at a time per batch, so two people can't take the last seat
    perform pg_advisory_xact_lock(hashtext('batch:' || p_batch_id::text));

    select id, course_id, name, seat_capacity, is_active into v_batch
    from public.batches where id = p_batch_id;

    if v_batch.id is null or not v_batch.is_active then raise exception 'That batch is not available.'; end if;
    if v_batch.course_id <> p_course_id then raise exception 'That batch belongs to another course.'; end if;

    v_taken := public.batch_seats_taken(p_batch_id);
    if v_batch.seat_capacity is not null
       and v_taken >= v_batch.seat_capacity
       and not coalesce((v_cfg->>'allow_overbooking')::boolean, false) then
      raise exception '% is full (% of % seats).', v_batch.name, v_taken, v_batch.seat_capacity;
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
    v_ref := coalesce(v_ref, v_old_ref, public.next_student_ref());
  end if;

  if v_ref is not null and exists (
    select 1 from public.leads where lower(student_ref) = lower(v_ref) and id <> p_lead_id
  ) then
    raise exception 'Student ID % is already used.', v_ref;
  end if;

  -- Close it
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

  -- Keep the course on the lead's interests too (ignore if not allowed)
  begin
    insert into public.lead_courses (lead_id, course_id) values (p_lead_id, p_course_id)
    on conflict do nothing;
  exception when others then
    null;
  end;

  return jsonb_build_object(
    'student_ref', v_ref,
    'seats_left', case
      when p_batch_id is null or v_batch.seat_capacity is null then null
      else greatest(v_batch.seat_capacity - public.batch_seats_taken(p_batch_id), 0)
    end
  );
end;
$$;

grant execute on function public.mark_admitted(uuid, uuid, uuid, timestamptz, text, text) to authenticated;

-- ---------------------------------------------------------------------
-- 10. Mark lost (anyone who can edit the lead)
-- ---------------------------------------------------------------------
create or replace function public.mark_lost(
  p_lead_id   uuid,
  p_reason_id uuid,
  p_note      text default null,
  p_revive_at timestamptz default null
)
returns void
language plpgsql
security invoker
set search_path = public
as $$
declare
  v_kind   text;
  v_reason text;
  v_note   text := nullif(trim(coalesce(p_note, '')), '');
  v_rows   int;
begin
  if not public.is_active_user() then raise exception 'Your account is not active.'; end if;

  select s.kind into v_kind
  from public.leads l
  join public.pipeline_stages s on s.id = l.stage_id
  where l.id = p_lead_id and l.deleted_at is null;

  if v_kind is null then raise exception 'Lead not found.'; end if;
  if v_kind = 'won' then raise exception 'This lead is admitted. Use Cancel admission instead.'; end if;
  if v_kind = 'lost' then raise exception 'This lead is already lost.'; end if;

  select name into v_reason from public.lost_reasons where id = p_reason_id and is_active;
  if v_reason is null then raise exception 'Please choose why the lead was lost.'; end if;
  if v_reason ilike 'other%' and v_note is null then
    raise exception 'Please add a note for "%".', v_reason;
  end if;
  if p_revive_at is not null and p_revive_at <= now() then
    raise exception 'The "try again" date must be in the future.';
  end if;

  perform set_config('app.pipeline_action', 'on', true);
  perform set_config('app.stage_note', concat_ws(' · ', 'Lost: ' || v_reason, v_note), true);

  update public.leads
     set stage_id       = public.stage_of_kind('lost'),
         lost_reason_id = p_reason_id,
         lost_at        = now(),
         lost_by        = auth.uid(),
         lost_note      = v_note,
         closed_at      = now()
   where id = p_lead_id;

  get diagnostics v_rows = row_count;
  if v_rows = 0 then raise exception 'You can''t change this lead.'; end if;

  perform public.finish_pending_follow_up(p_lead_id);

  -- Try again later → a "♻️ Revive" call on that day
  if p_revive_at is not null then
    insert into public.follow_ups (lead_id, due_at, note, purpose)
    values (p_lead_id, p_revive_at, '♻️ Revive: lost (' || v_reason || '). Try again.', 'revive');
  end if;
end;
$$;

grant execute on function public.mark_lost(uuid, uuid, text, timestamptz) to authenticated;

-- Many leads at once (needs team or all edit rights)
create or replace function public.bulk_mark_lost(
  p_lead_ids  uuid[],
  p_reason_id uuid,
  p_note      text default null
)
returns jsonb
language plpgsql
security invoker
set search_path = public
as $$
declare
  v_id      uuid;
  v_done    int := 0;
  v_skipped int := 0;
begin
  if not (public.has_permission('leads.edit_team') or public.has_permission('leads.edit_all')) then
    raise exception 'You can''t mark many leads lost at once.';
  end if;

  foreach v_id in array coalesce(p_lead_ids, '{}'::uuid[])
  loop
    begin
      perform public.mark_lost(v_id, p_reason_id, p_note, null);
      v_done := v_done + 1;
    exception when others then
      v_skipped := v_skipped + 1;   -- admitted, already lost, or not allowed
    end;
  end loop;

  return jsonb_build_object('done', v_done, 'skipped', v_skipped);
end;
$$;

grant execute on function public.bulk_mark_lost(uuid[], uuid, text) to authenticated;

-- ---------------------------------------------------------------------
-- 11. Reopen a lost or cancelled lead (anyone who can edit it)
-- ---------------------------------------------------------------------
create or replace function public.reopen_lead(
  p_lead_id  uuid,
  p_stage_id uuid default null,
  p_note     text default null
)
returns void
language plpgsql
security invoker
set search_path = public
as $$
declare
  v_kind  text;
  v_stage uuid := p_stage_id;
  v_rows  int;
begin
  if not public.is_active_user() then raise exception 'Your account is not active.'; end if;

  select s.kind into v_kind
  from public.leads l
  join public.pipeline_stages s on s.id = l.stage_id
  where l.id = p_lead_id and l.deleted_at is null;

  if v_kind is null then raise exception 'Lead not found.'; end if;
  if v_kind = 'open' then raise exception 'This lead is already open.'; end if;
  if v_kind = 'won' then raise exception 'This lead is admitted. Use Cancel admission instead.'; end if;

  -- Default: "Interested", else the first open stage
  if v_stage is null then
    select id into v_stage from public.pipeline_stages where key = 'interested' and kind = 'open' and is_active;
    if v_stage is null then
      select id into v_stage from public.pipeline_stages where kind = 'open' and is_active order by sort_order limit 1;
    end if;
  elsif not exists (select 1 from public.pipeline_stages where id = v_stage and kind = 'open' and is_active) then
    raise exception 'Please choose a normal stage.';
  end if;

  perform set_config('app.pipeline_action', 'on', true);
  perform set_config('app.stage_note', concat_ws(' · ', 'Reopened', nullif(trim(coalesce(p_note, '')), '')), true);

  update public.leads
     set stage_id       = v_stage,
         closed_at      = null,
         lost_reason_id = null,
         lost_at        = null,
         lost_by        = null,
         lost_note      = null,
         cancelled_at   = null,
         cancelled_by   = null,
         cancel_reason  = null,
         call_attempts  = 0,
         unreachable_at = null
   where id = p_lead_id;

  get diagnostics v_rows = row_count;
  if v_rows = 0 then raise exception 'You can''t change this lead.'; end if;

  -- An old "♻️ Revive" call has done its job
  update public.follow_ups
     set status = 'done', completed_at = now(), completed_by = auth.uid()
   where lead_id = p_lead_id and status = 'pending' and purpose = 'revive';
end;
$$;

grant execute on function public.reopen_lead(uuid, uuid, text) to authenticated;

-- ---------------------------------------------------------------------
-- 12. Cancel an admission (Settings → Admission → who can cancel)
--     The seat is freed because only Admitted leads count.
--     Student ID is kept, so a re-admission gets the same ID.
-- ---------------------------------------------------------------------
create or replace function public.cancel_admission(
  p_lead_id uuid,
  p_reason  text,
  p_note    text default null
)
returns void
language plpgsql
security invoker
set search_path = public
as $$
declare
  v_kind   text;
  v_reason text := nullif(trim(coalesce(p_reason, '')), '');
  v_rows   int;
begin
  if not public.can_cancel_admission() then
    raise exception 'You are not allowed to cancel admissions.';
  end if;
  if v_reason is null then raise exception 'Please give a reason.'; end if;

  select s.kind into v_kind
  from public.leads l
  join public.pipeline_stages s on s.id = l.stage_id
  where l.id = p_lead_id and l.deleted_at is null;

  if v_kind is null then raise exception 'Lead not found.'; end if;
  if v_kind <> 'won' then raise exception 'Only an admitted lead can be cancelled.'; end if;

  perform set_config('app.pipeline_action', 'on', true);
  perform set_config('app.stage_note',
    concat_ws(' · ', 'Admission cancelled: ' || v_reason, nullif(trim(coalesce(p_note, '')), '')), true);

  update public.leads
     set stage_id      = public.stage_of_kind('cancelled'),
         cancelled_at  = now(),
         cancelled_by  = auth.uid(),
         cancel_reason = concat_ws(' · ', v_reason, nullif(trim(coalesce(p_note, '')), ''))
   where id = p_lead_id;

  get diagnostics v_rows = row_count;
  if v_rows = 0 then raise exception 'You can''t change this lead.'; end if;
end;
$$;

grant execute on function public.cancel_admission(uuid, text, text) to authenticated;

-- ---------------------------------------------------------------------
-- 13. After a call (replaces the earlier version): closed leads
--     - no attempt counting / Unreachable
--     - Admitted / Cancelled: no automatic follow-ups
--     - Lost lead calls and we miss it: "♻️ Lost lead called you"
-- ---------------------------------------------------------------------
create or replace function public.after_call_logged()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_cfg      jsonb := public.call_sync_setting();
  v_reached  boolean := new.direction = 'outgoing' or new.outcome = 'connected';
  v_after    int := coalesce((v_cfg->>'unreachable_after')::int, 5);
  v_retry    int := coalesce((v_cfg->>'unreachable_retry_days')::int, 7);
  v_attempts int;
  v_kind     text;
begin
  select s.kind into v_kind
  from public.leads l
  join public.pipeline_stages s on s.id = l.stage_id
  where l.id = new.lead_id;

  if v_reached then
    update public.leads
       set last_contacted_at = greatest(coalesce(last_contacted_at, new.called_at), new.called_at)
     where id = new.lead_id;

    update public.follow_ups
       set status = 'done',
           completed_at = new.called_at,
           completed_by = new.user_id,
           call_id = new.id
     where lead_id = new.lead_id
       and status = 'pending'
       and due_at < date_trunc('day', now() at time zone 'Asia/Dhaka') at time zone 'Asia/Dhaka' + interval '1 day';
  end if;

  -- Attempts only count while the lead is open
  if coalesce(v_kind, 'open') = 'open' then
    if new.outcome = 'connected' then
      update public.leads set call_attempts = 0, unreachable_at = null where id = new.lead_id;
    elsif new.direction = 'outgoing' and new.outcome in ('no_answer', 'busy', 'switched_off') then
      update public.leads
         set call_attempts = call_attempts + 1
       where id = new.lead_id
       returning call_attempts into v_attempts;

      if v_attempts >= v_after then
        update public.leads
           set unreachable_at = coalesce(unreachable_at, now())
         where id = new.lead_id;

        if not exists (select 1 from public.follow_ups f where f.lead_id = new.lead_id and f.status = 'pending') then
          insert into public.follow_ups (lead_id, due_at, note, created_by)
          values (
            new.lead_id,
            now() + make_interval(days => v_retry),
            format('🔕 No answer %s times in a row. Try again.', v_attempts),
            new.user_id
          );
        end if;
      end if;
    end if;
  end if;

  insert into public.lead_activity (lead_id, user_id, action, details)
  values (
    new.lead_id,
    new.user_id,
    'call_logged',
    jsonb_build_object('outcome', new.outcome, 'call_id', new.id, 'direction', new.direction, 'source', new.source)
  );

  -- Missed call from the lead → call back (only if nothing is planned yet)
  if new.direction in ('missed', 'rejected')
     and coalesce((v_cfg->>'missed_follow_up')::boolean, true)
     and not exists (select 1 from public.follow_ups f where f.lead_id = new.lead_id and f.status = 'pending') then
    if coalesce(v_kind, 'open') = 'open' then
      insert into public.follow_ups (lead_id, due_at, note, created_by)
      values (new.lead_id, new.called_at, '📵 Missed call from this lead. Call back.', new.user_id);
    elsif v_kind = 'lost' then
      insert into public.follow_ups (lead_id, due_at, note, created_by, purpose)
      values (new.lead_id, new.called_at, '♻️ This lost lead called you. Call back, they may be interested again.', new.user_id, 'revive');
    end if;
    -- Admitted / Cancelled: no follow-up, the call is on the timeline
  end if;

  return new;
end;
$$;

-- ---------------------------------------------------------------------
-- 14. Lead directory for the phone (replaces the earlier version):
--     closed leads show "🎓 Admitted · batch" or "✕ Lost · reason"
-- ---------------------------------------------------------------------
create or replace function public.my_lead_directory()
returns table (hash text, lead_id uuid, name text, rating text, stage text, course text, last_note text)
language sql
stable
security invoker
set search_path = public, extensions
as $$
  with visible as (
    select
      l.id, l.name, l.rating, l.phone, l.alt_phone,
      case s.kind
        when 'won'       then '🎓 Admitted' || coalesce(' · ' || b.name, '')
        when 'lost'      then '✕ Lost' || coalesce(' · ' || lr.name, '')
        when 'cancelled' then 'Admission cancelled'
        else s.name
      end as stage,
      coalesce(
        ac.name,
        (select c.name from public.lead_courses lc join public.courses c on c.id = lc.course_id
          where lc.lead_id = l.id limit 1)
      ) as course,
      (select cl.notes from public.call_logs cl
        where cl.lead_id = l.id and cl.notes is not null
        order by cl.called_at desc limit 1) as last_note
    from public.leads l
    left join public.pipeline_stages s on s.id = l.stage_id
    left join public.courses ac on ac.id = l.admitted_course_id and s.kind = 'won'
    left join public.batches b on b.id = l.admitted_batch_id
    left join public.lost_reasons lr on lr.id = l.lost_reason_id
    where l.deleted_at is null
    order by l.updated_at desc nulls last
    limit 10000
  )
  select encode(digest(v.phone, 'sha256'), 'hex'), v.id, v.name, v.rating, v.stage, v.course, left(v.last_note, 120)
  from visible v
  union all
  select encode(digest(v.alt_phone, 'sha256'), 'hex'), v.id, v.name, v.rating, v.stage, v.course, left(v.last_note, 120)
  from visible v
  where v.alt_phone is not null;
$$;

grant execute on function public.my_lead_directory() to authenticated;

notify pgrst, 'reload schema';