-- =====================================================================
-- Pipeline stages v2
--   1. New stages get a key automatically (fixes: null value in column "key")
--   2. New open stages always go before Admitted / Lost / Cancelled
--   3. A stage with leads in it can't be removed (clear message)
--   4. New rule: "Ask for a date & time when moving here" (e.g. Campus visit)
--   5. A "Campus visit" stage is added after "Interested"
--   6. Reorder function for the Stages screen
-- =====================================================================

-- ---------------------------------------------------------------------
-- 1. New stage options
-- ---------------------------------------------------------------------
alter table public.pipeline_stages
  add column if not exists ask_date   boolean not null default false,  -- ask for a date & time when moving here
  add column if not exists date_label text;                            -- e.g. "Visit date & time"

-- ---------------------------------------------------------------------
-- 2. Key and position for new stages
-- ---------------------------------------------------------------------
create or replace function public.pipeline_stage_defaults()
returns trigger
language plpgsql
set search_path = public
as $$
declare
  v_base text;
  v_key  text;
  v_n    int := 1;
  v_pos  int;
begin
  -- Key from the name: "Campus visit" → campus_visit (Bangla names → stage_1, stage_2…)
  if new.key is null or trim(new.key) = '' then
    v_base := trim(both '_' from lower(regexp_replace(coalesce(new.name, ''), '[^a-zA-Z0-9]+', '_', 'g')));
    if v_base = '' then v_base := 'stage'; end if;
    v_key := v_base;
    while exists (select 1 from public.pipeline_stages where key = v_key) loop
      v_n := v_n + 1;
      v_key := v_base || '_' || v_n;
    end loop;
    new.key := v_key;
  end if;

  -- An open stage goes right after the last open stage; the final stages move down one
  if new.kind = 'open' then
    select coalesce(max(sort_order), 0) + 1 into v_pos
    from public.pipeline_stages where kind = 'open';

    update public.pipeline_stages
       set sort_order = sort_order + 1
     where kind <> 'open' and sort_order >= v_pos;

    new.sort_order := v_pos;
  end if;

  return new;
end;
$$;

drop trigger if exists pipeline_stages_defaults on public.pipeline_stages;
create trigger pipeline_stages_defaults
  before insert on public.pipeline_stages
  for each row execute function public.pipeline_stage_defaults();

-- ---------------------------------------------------------------------
-- 3. Guard (replaces the earlier version): + clear message when leads are in a stage
-- ---------------------------------------------------------------------
create or replace function public.guard_pipeline_stage()
returns trigger
language plpgsql
set search_path = public
as $$
declare
  v_count int;
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
    select count(*) into v_count from public.leads where stage_id = old.id and deleted_at is null;
    if v_count > 0 then
      raise exception '% leads are in "%". Move them to another stage first, or switch the stage off.', v_count, old.name;
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
  if old.kind = 'open' and old.is_active and not new.is_active then
    select count(*) into v_count from public.leads where stage_id = old.id and deleted_at is null;
    if v_count > 0 then
      raise exception '% leads are in "%". Move them to another stage before switching it off.', v_count, old.name;
    end if;
  end if;
  return new;
end;
$$;

-- ---------------------------------------------------------------------
-- 4. Reorder open stages (Stages screen). Final stages stay at the end.
-- ---------------------------------------------------------------------
create or replace function public.reorder_pipeline_stages(p_open_ids uuid[])
returns void
language plpgsql
security invoker
set search_path = public
as $$
declare
  v_id  uuid;
  v_pos int := 0;
begin
  if not public.has_permission('settings.manage') then
    raise exception 'Only admins can change stages.';
  end if;

  foreach v_id in array coalesce(p_open_ids, '{}'::uuid[])
  loop
    v_pos := v_pos + 1;
    update public.pipeline_stages set sort_order = v_pos where id = v_id and kind = 'open';
  end loop;

  -- Open stages not in the list (switched off ones) after the listed ones
  for v_id in
    select id from public.pipeline_stages
    where kind = 'open' and not (id = any (coalesce(p_open_ids, '{}'::uuid[])))
    order by sort_order
  loop
    v_pos := v_pos + 1;
    update public.pipeline_stages set sort_order = v_pos where id = v_id;
  end loop;

  -- Final stages last, in their usual order
  for v_id in
    select id from public.pipeline_stages
    where kind <> 'open'
    order by case kind when 'won' then 1 when 'lost' then 2 else 3 end, sort_order
  loop
    v_pos := v_pos + 1;
    update public.pipeline_stages set sort_order = v_pos where id = v_id;
  end loop;
end;
$$;

grant execute on function public.reorder_pipeline_stages(uuid[]) to authenticated;

-- How many leads are in each stage (for the Stages screen)
create or replace function public.stage_lead_counts()
returns table (stage_id uuid, leads int)
language sql
stable
security invoker
set search_path = public
as $$
  select l.stage_id, count(*)::int
  from public.leads l
  where l.deleted_at is null
  group by l.stage_id;
$$;

grant execute on function public.stage_lead_counts() to authenticated;

-- ---------------------------------------------------------------------
-- 5. Move a lead (replaces the earlier version): + date & time for stages that ask for it
-- ---------------------------------------------------------------------
drop function if exists public.move_lead_stage(uuid, uuid, text);

create function public.move_lead_stage(
  p_lead_id  uuid,
  p_stage_id uuid,
  p_note     text default null,
  p_due_at   timestamptz default null
)
returns jsonb
language plpgsql
security invoker
set search_path = public
as $$
declare
  v_kind    text;
  v_current uuid;
  v_stage   record;
  v_note    text := nullif(trim(coalesce(p_note, '')), '');
  v_due     timestamptz;
  v_label   text;
  v_rows    int;
begin
  if not public.is_active_user() then raise exception 'Your account is not active.'; end if;

  select s.kind, l.stage_id into v_kind, v_current
  from public.leads l
  join public.pipeline_stages s on s.id = l.stage_id
  where l.id = p_lead_id and l.deleted_at is null;

  if v_kind is null then raise exception 'Lead not found.'; end if;
  if v_kind <> 'open' then raise exception 'This lead is closed. Reopen it first.'; end if;

  select id, name, kind, is_active, follow_up_days, note_required, ask_date, date_label into v_stage
  from public.pipeline_stages where id = p_stage_id;

  if v_stage.id is null or not v_stage.is_active or v_stage.kind <> 'open' then
    raise exception 'Please choose a normal stage.';
  end if;
  if v_current = p_stage_id and p_due_at is null then
    return jsonb_build_object('follow_up_at', null);
  end if;
  if v_stage.note_required and v_note is null then
    raise exception 'A note is needed to move to "%".', v_stage.name;
  end if;
  if v_stage.ask_date and p_due_at is null then
    raise exception 'Please pick the % for "%".', lower(coalesce(v_stage.date_label, 'date & time')), v_stage.name;
  end if;
  if p_due_at is not null and p_due_at < now() - interval '5 minutes' then
    raise exception 'The date & time must be in the future.';
  end if;

  if v_current <> p_stage_id then
    perform set_config('app.stage_note', coalesce(v_note, ''), true);
    update public.leads set stage_id = p_stage_id where id = p_lead_id;
    get diagnostics v_rows = row_count;
    if v_rows = 0 then raise exception 'You can''t change this lead.'; end if;
  end if;

  -- The next call / reminder
  if p_due_at is not null then
    -- A date picked by the user (e.g. the campus visit)
    v_due := p_due_at;
    v_label := coalesce(nullif(trim(v_stage.date_label), ''), v_stage.name);
    perform public.schedule_follow_up(
      p_lead_id, v_due, concat_ws(' · ', '📌 ' || v_stage.name || ': ' || to_char(v_due at time zone 'Asia/Dhaka', 'DD Mon, HH12:MI AM'), v_note)
    );
  elsif v_stage.follow_up_days is not null then
    -- N days later, at 10 am Bangladesh time
    v_due := ((date_trunc('day', now() at time zone 'Asia/Dhaka')
               + make_interval(days => v_stage.follow_up_days)
               + interval '10 hours') at time zone 'Asia/Dhaka');
    if v_due <= now() then
      v_due := now() + interval '1 hour';
    end if;
    perform public.schedule_follow_up(
      p_lead_id, v_due, coalesce(v_note, 'Moved to ' || v_stage.name)
    );
  end if;

  return jsonb_build_object('follow_up_at', v_due);
end;
$$;

grant execute on function public.move_lead_stage(uuid, uuid, text, timestamptz) to authenticated;

-- ---------------------------------------------------------------------
-- 6. "Campus visit" stage, right after "Interested" (only if it isn't there yet)
-- ---------------------------------------------------------------------
do $$
declare
  v_after int;
begin
  if exists (select 1 from public.pipeline_stages where key = 'campus_visit') then
    return;
  end if;

  select sort_order into v_after
  from public.pipeline_stages where key = 'interested' and kind = 'open';

  insert into public.pipeline_stages (key, name, kind, color, is_active, ask_date, date_label)
  values ('campus_visit', 'Campus visit', 'open', '#0EA5E9', true, true, 'Visit date & time');

  -- Put it after Interested (if Interested exists), moving the later stages down
  if v_after is not null then
    update public.pipeline_stages
       set sort_order = sort_order + 1
     where sort_order > v_after and key <> 'campus_visit';
    update public.pipeline_stages
       set sort_order = v_after + 1
     where key = 'campus_visit';
  end if;
end;
$$;

notify pgrst, 'reload schema';