-- =====================================================================
-- Campus visits, separate from the pipeline
--   A visit is something that happens (or not) at any time, not a step:
--   a student can be Ready for admission without visiting, or visit twice.
--     planned   → a date & time is set (or "date not set" for old data)
--     visited   → the student came (also for walk-ins with no plan)
--     missed    → the student didn't come
--     cancelled → the plan was dropped
--   The "Campus visit" pipeline stage is switched off; its leads move to
--   Interested and keep their visit date as a planned visit.
-- =====================================================================

-- ---------------------------------------------------------------------
-- 1. Setting (Settings → Campus visit)
-- ---------------------------------------------------------------------
insert into public.app_settings (key, value)
values ('campus_visit', '{"enabled": true, "visited_moves_to_interested": true, "missed_follow_up_days": 1}'::jsonb)
on conflict (key) do nothing;

create or replace function public.campus_visit_setting()
returns jsonb
language sql
stable
security definer
set search_path = public
as $$
  select jsonb_build_object(
           'enabled', true,
           'visited_moves_to_interested', true,
           'missed_follow_up_days', 1
         )
         || coalesce((select value from public.app_settings where key = 'campus_visit'), '{}'::jsonb);
$$;

grant execute on function public.campus_visit_setting() to authenticated;

-- ---------------------------------------------------------------------
-- 2. Visits (one row per visit, so the history is kept)
-- ---------------------------------------------------------------------
create table if not exists public.lead_visits (
  id          uuid primary key default gen_random_uuid(),
  lead_id     uuid not null references public.leads(id) on delete cascade,
  status      text not null default 'planned'
                check (status in ('planned', 'visited', 'missed', 'cancelled')),
  planned_at  timestamptz,                 -- the planned date & time (null = walk-in, or date not set)
  visited_at  timestamptz,                 -- when the student came
  note        text,
  created_by  uuid default auth.uid() references public.profiles(id) on delete set null,
  created_at  timestamptz not null default now(),
  updated_by  uuid references public.profiles(id) on delete set null,
  updated_at  timestamptz not null default now()
);

-- At most one planned visit per lead
create unique index if not exists lead_visits_one_planned
  on public.lead_visits (lead_id) where status = 'planned';
create index if not exists lead_visits_lead_idx on public.lead_visits (lead_id, created_at desc);
create index if not exists lead_visits_planned_idx on public.lead_visits (planned_at) where status = 'planned';

create trigger lead_visits_set_updated_at
  before update on public.lead_visits
  for each row execute function public.set_updated_at();

-- Same people who can see the lead (like follow-ups)
alter table public.lead_visits enable row level security;

create policy "lead_visits: view for visible leads"
  on public.lead_visits for select
  to authenticated
  using (
    public.is_active_user()
    and exists (select 1 from public.leads l where l.id = lead_visits.lead_id)
  );

create policy "lead_visits: add for visible leads"
  on public.lead_visits for insert
  to authenticated
  with check (
    public.is_active_user()
    and created_by = auth.uid()
    and exists (select 1 from public.leads l where l.id = lead_visits.lead_id and l.deleted_at is null)
  );

create policy "lead_visits: update for visible leads"
  on public.lead_visits for update
  to authenticated
  using (
    public.is_active_user()
    and exists (select 1 from public.leads l where l.id = lead_visits.lead_id)
  )
  with check (
    exists (select 1 from public.leads l where l.id = lead_visits.lead_id)
  );

-- ---------------------------------------------------------------------
-- 3. The lead's visit state, for the list badge and the filter
--      planned (+ date) → visited (+ last visit) → missed → none
-- ---------------------------------------------------------------------
alter table public.leads
  add column if not exists visit_status text check (visit_status in ('planned', 'visited', 'missed')),
  add column if not exists visit_at     timestamptz;

create index if not exists leads_visit_status_idx on public.leads (visit_status);

create or replace function public.sync_lead_visit()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_lead   uuid := coalesce(new.lead_id, old.lead_id);
  v_status text;
  v_at     timestamptz;
begin
  select 'planned', planned_at into v_status, v_at
  from public.lead_visits where lead_id = v_lead and status = 'planned';

  if v_status is null then
    select 'visited', max(coalesce(visited_at, updated_at)) into v_status, v_at
    from public.lead_visits where lead_id = v_lead and status = 'visited'
    having count(*) > 0;
  end if;

  if v_status is null then
    select 'missed', planned_at into v_status, v_at
    from public.lead_visits where lead_id = v_lead and status = 'missed'
    order by updated_at desc limit 1;
  end if;

  update public.leads set visit_status = v_status, visit_at = v_at where id = v_lead;
  return null;
end;
$$;

create trigger lead_visits_sync_lead
  after insert or update or delete on public.lead_visits
  for each row execute function public.sync_lead_visit();

-- ---------------------------------------------------------------------
-- 4. Timeline lines (users can't write the timeline directly)
-- ---------------------------------------------------------------------
create or replace function public.log_lead_visit()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_action text;
  v_at     timestamptz;
  v_note   text;
begin
  if tg_op = 'INSERT' then
    v_action := case new.status when 'visited' then 'visit_done' else 'visit_planned' end;
    v_at := coalesce(new.visited_at, new.planned_at);
  elsif new.status is distinct from old.status then
    v_action := case new.status
                  when 'visited'   then 'visit_done'
                  when 'missed'    then 'visit_missed'
                  when 'cancelled' then 'visit_cancelled'
                  else 'visit_planned'
                end;
    v_at := coalesce(new.visited_at, new.planned_at);
  elsif new.status = 'planned' and new.planned_at is distinct from old.planned_at then
    v_action := 'visit_moved';
    v_at := new.planned_at;
  else
    return null;
  end if;

  -- The note only when it is new (not the plan's note again on "missed")
  if tg_op = 'INSERT' or new.note is distinct from old.note then
    v_note := nullif(trim(coalesce(new.note, '')), '');
  end if;

  insert into public.lead_activity (lead_id, user_id, action, details)
  values (new.lead_id, auth.uid(), v_action, jsonb_strip_nulls(jsonb_build_object('at', v_at, 'note', v_note)));
  return null;
end;
$$;

create trigger lead_visits_log_activity
  after insert or update on public.lead_visits
  for each row execute function public.log_lead_visit();

-- ---------------------------------------------------------------------
-- 5. Plan a visit (or move the planned one to a new date & time)
--    Only for leads that are not admitted / lost / cancelled.
-- ---------------------------------------------------------------------
create or replace function public.plan_visit(
  p_lead_id uuid,
  p_at      timestamptz,
  p_note    text default null
)
returns uuid
language plpgsql
security invoker
set search_path = public
as $$
declare
  v_kind text;
  v_id   uuid;
  v_note text := nullif(trim(coalesce(p_note, '')), '');
begin
  if not public.is_active_user() then raise exception 'Your account is not active.'; end if;
  if not (public.campus_visit_setting() ->> 'enabled')::boolean then
    raise exception 'Campus visits are switched off (Settings → Campus visit).';
  end if;
  if p_at is null then raise exception 'Please pick the visit date & time.'; end if;
  if p_at < now() - interval '5 minutes' then raise exception 'The visit date & time must be in the future.'; end if;

  select s.kind into v_kind
  from public.leads l
  join public.pipeline_stages s on s.id = l.stage_id
  where l.id = p_lead_id and l.deleted_at is null;

  if v_kind is null then raise exception 'Lead not found.'; end if;
  if v_kind <> 'open' then raise exception 'This lead is closed. Reopen it first.'; end if;

  update public.lead_visits
     set planned_at = p_at, note = coalesce(v_note, note), updated_by = auth.uid()
   where lead_id = p_lead_id and status = 'planned'
  returning id into v_id;

  if v_id is null then
    insert into public.lead_visits (lead_id, status, planned_at, note)
    values (p_lead_id, 'planned', p_at, v_note)
    returning id into v_id;
  end if;

  return v_id;
end;
$$;

-- ---------------------------------------------------------------------
-- 6. The visit happened (visited) or not (missed)
--    visited: closes the planned visit, or adds a walk-in visit
--             New / Contacted leads move to Interested (setting)
--    missed:  closes the planned visit; a next call N days later (setting),
--             unless an earlier call is already set
-- ---------------------------------------------------------------------
create or replace function public.finish_visit(
  p_lead_id    uuid,
  p_status     text,
  p_note       text default null,
  p_visited_at timestamptz default null
)
returns jsonb
language plpgsql
security invoker
set search_path = public
as $$
declare
  v_setting  jsonb := public.campus_visit_setting();
  v_note     text := nullif(trim(coalesce(p_note, '')), '');
  v_when     timestamptz := coalesce(p_visited_at, now());
  v_id       uuid;
  v_stage    text;
  v_kind     text;
  v_moved    text;
  v_days     int;
  v_due      timestamptz;
  v_pending  timestamptz;
  v_call_set timestamptz;
begin
  if not public.is_active_user() then raise exception 'Your account is not active.'; end if;
  if p_status not in ('visited', 'missed') then raise exception 'Unknown visit result.'; end if;
  if v_when > now() + interval '5 minutes' then raise exception 'The visit time can''t be in the future.'; end if;

  select s.key, s.kind into v_stage, v_kind
  from public.leads l
  join public.pipeline_stages s on s.id = l.stage_id
  where l.id = p_lead_id and l.deleted_at is null;
  if v_kind is null then raise exception 'Lead not found.'; end if;

  update public.lead_visits
     set status = p_status,
         visited_at = case when p_status = 'visited' then v_when end,
         note = coalesce(v_note, note),
         updated_by = auth.uid()
   where lead_id = p_lead_id and status = 'planned'
  returning id into v_id;

  if v_id is null then
    if p_status = 'missed' then raise exception 'There is no planned visit.'; end if;
    if not (v_setting ->> 'enabled')::boolean then
      raise exception 'Campus visits are switched off (Settings → Campus visit).';
    end if;
    -- Walk-in: the student came without a plan
    insert into public.lead_visits (lead_id, status, visited_at, note)
    values (p_lead_id, 'visited', v_when, v_note)
    returning id into v_id;
  end if;

  if p_status = 'visited' then
    if coalesce((v_setting ->> 'visited_moves_to_interested')::boolean, false)
       and v_kind = 'open' and v_stage in ('new', 'contacted') then
      select name into v_moved from public.pipeline_stages
       where key = 'interested' and kind = 'open' and is_active;
      if v_moved is not null then
        perform set_config('app.stage_note', '🏫 Visited the campus', true);
        update public.leads
           set stage_id = (select id from public.pipeline_stages where key = 'interested')
         where id = p_lead_id;
        if not found then v_moved := null; end if;
      end if;
    end if;
  elsif v_kind = 'open' then
    v_days := nullif(v_setting ->> 'missed_follow_up_days', '')::int;
    if v_days is not null then
      -- N days later, at 10 am Bangladesh time
      v_due := ((date_trunc('day', now() at time zone 'Asia/Dhaka')
                 + make_interval(days => v_days)
                 + interval '10 hours') at time zone 'Asia/Dhaka');
      if v_due <= now() then v_due := now() + interval '1 hour'; end if;

      select due_at into v_pending from public.follow_ups
       where lead_id = p_lead_id and status = 'pending';
      if v_pending is null or v_pending > v_due then
        perform public.schedule_follow_up(p_lead_id, v_due, concat_ws(' · ', '🏫 Didn''t come to the campus visit', v_note));
        v_call_set := v_due;
      end if;
    end if;
  end if;

  return jsonb_build_object('id', v_id, 'moved_to', v_moved, 'follow_up_at', v_call_set);
end;
$$;

-- ---------------------------------------------------------------------
-- 7. Drop the planned visit
-- ---------------------------------------------------------------------
create or replace function public.cancel_visit(p_lead_id uuid)
returns void
language plpgsql
security invoker
set search_path = public
as $$
begin
  if not public.is_active_user() then raise exception 'Your account is not active.'; end if;
  update public.lead_visits
     set status = 'cancelled', updated_by = auth.uid()
   where lead_id = p_lead_id and status = 'planned';
  if not found then raise exception 'There is no planned visit.'; end if;
end;
$$;

grant execute on function public.plan_visit(uuid, timestamptz, text) to authenticated;
grant execute on function public.finish_visit(uuid, text, text, timestamptz) to authenticated;
grant execute on function public.cancel_visit(uuid) to authenticated;

-- ---------------------------------------------------------------------
-- 8. Move leads out of the "Campus visit" stage and switch the stage off
--    Their pending visit date (the 📌 reminder) becomes a planned visit.
-- ---------------------------------------------------------------------
do $$
declare
  v_visit_stage uuid;
  v_target      uuid;
  r             record;
begin
  select id into v_visit_stage from public.pipeline_stages where key = 'campus_visit';
  if v_visit_stage is null then return; end if;

  select id into v_target from public.pipeline_stages where key = 'interested' and kind = 'open' and is_active;
  if v_target is null then
    select id into v_target from public.pipeline_stages
     where kind = 'open' and is_active and id <> v_visit_stage
     order by sort_order limit 1;
  end if;

  for r in
    select l.id,
           (select f.due_at from public.follow_ups f
             where f.lead_id = l.id and f.status = 'pending' and f.note like '📌%') as visit_at
    from public.leads l
    where l.stage_id = v_visit_stage
  loop
    insert into public.lead_visits (lead_id, status, planned_at, note, created_by)
    values (r.id, 'planned', r.visit_at, 'From the old "Campus visit" stage', null)
    on conflict do nothing;
  end loop;

  if v_target is not null then
    perform set_config('app.pipeline_action', 'on', true);
    perform set_config('app.stage_note', 'Campus visit is now separate from the pipeline', true);
    update public.leads set stage_id = v_target where stage_id = v_visit_stage;
    perform set_config('app.pipeline_action', '', true);
    perform set_config('app.stage_note', '', true);
  end if;

  update public.pipeline_stages set is_active = false where id = v_visit_stage;
end;
$$;

notify pgrst, 'reload schema';
