-- =====================================================================
-- 🏦 Lead Bank: many numbers kept aside, out of the lead list
--   · Lists ("Teachers Dhaka", "Education fair"…), import with no
--     duplicates (bank or live leads), ⛔ do not call
--   · Admins only: put numbers in the leads (course, people in turn,
--     stage), and send leads back. A lead sent back keeps its whole
--     history and comes back as the SAME lead (hidden meanwhile).
--   · Two tabs: New (never in the leads) / Returned (came back)
--   · A returned number rests (cooldown) before it can go out again
--   · The phone's caller card knows bank numbers ("🏦 Lead Bank")
--   · "Lost" is called "Not Now" from now on (texts only; keys stay)
--   ⚡ A table of its own: the lead list, Home and reports never read it
-- =====================================================================

-- ---------------------------------------------------------------------
-- Who: admins (settings.manage)
-- ---------------------------------------------------------------------
create or replace function public.bank_can()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select public.has_permission('settings.manage');
$$;
revoke all on function public.bank_can() from public, anon;
grant execute on function public.bank_can() to authenticated;

-- ---------------------------------------------------------------------
-- Tables
-- ---------------------------------------------------------------------
create table if not exists public.lead_bank_lists (
  id         uuid primary key default gen_random_uuid(),
  name       text not null check (length(trim(name)) between 1 and 80),
  note       text,
  created_by uuid references public.profiles (id) on delete set null default auth.uid(),
  created_at timestamptz not null default now()
);
create unique index if not exists lead_bank_lists_name_key on public.lead_bank_lists (lower(name));

create table if not exists public.lead_bank (
  id              uuid primary key default gen_random_uuid(),
  list_id         uuid references public.lead_bank_lists (id) on delete set null,
  name            text,
  phone           text not null,
  whatsapp_number text,
  area            text,
  note            text,
  tags            text[] not null default '{}',
  -- new: never in the leads · returned: came back from the leads · in_leads: out now
  status          text not null default 'new' check (status in ('new', 'returned', 'in_leads')),
  do_not_call     boolean not null default false,
  lead_id         uuid references public.leads (id) on delete set null,
  times_pulled    integer not null default 0,
  last_pulled_at  timestamptz,
  last_pulled_by  uuid references public.profiles (id) on delete set null,
  returned_at     timestamptz,
  returned_by     uuid references public.profiles (id) on delete set null,
  return_reason   text,
  cooldown_until  timestamptz,
  phone_hash      text,
  created_by      uuid references public.profiles (id) on delete set null default auth.uid(),
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);
create unique index if not exists lead_bank_phone_key on public.lead_bank (phone);
create index if not exists lead_bank_status_idx on public.lead_bank (status, created_at desc);
create index if not exists lead_bank_list_idx on public.lead_bank (list_id, status);
create index if not exists lead_bank_lead_idx on public.lead_bank (lead_id) where lead_id is not null;
create index if not exists lead_bank_wa_idx on public.lead_bank (whatsapp_number) where whatsapp_number is not null;
-- the caller card reads the newest waiting numbers
create index if not exists lead_bank_dir_idx on public.lead_bank (updated_at desc)
  where status <> 'in_leads' and not do_not_call;

-- a lead sent to the bank: hidden like a deleted one (every list, count and report leaves it out)
alter table public.leads add column if not exists banked_at timestamptz;

alter table public.lead_bank_lists enable row level security;
alter table public.lead_bank enable row level security;
drop policy if exists "lead bank lists: admins" on public.lead_bank_lists;
create policy "lead bank lists: admins" on public.lead_bank_lists for all to authenticated
  using ((select public.bank_can())) with check ((select public.bank_can()));
drop policy if exists "lead bank: admins" on public.lead_bank;
create policy "lead bank: admins" on public.lead_bank for all to authenticated
  using ((select public.bank_can())) with check ((select public.bank_can()));
grant select, insert, update, delete on public.lead_bank_lists, public.lead_bank to authenticated;

-- numbers in one form, the caller card's hash
create or replace function public.lead_bank_before_write()
returns trigger
language plpgsql
set search_path = public, extensions
as $$
begin
  new.name := nullif(trim(coalesce(new.name, '')), '');
  new.phone := nullif(public.normalize_bd_phone(nullif(trim(coalesce(new.phone, '')), '')), '');
  new.whatsapp_number := nullif(public.normalize_bd_phone(nullif(trim(coalesce(new.whatsapp_number, '')), '')), '');
  if new.phone is null then new.phone := new.whatsapp_number; end if;
  if new.phone is null then raise exception 'A number is needed.'; end if;
  if new.whatsapp_number = new.phone then new.whatsapp_number := null; end if;
  new.tags := coalesce(new.tags, '{}');
  new.phone_hash := encode(digest(new.phone, 'sha256'), 'hex');
  if tg_op = 'UPDATE' then new.updated_at := now(); end if;
  return new;
end;
$$;
drop trigger if exists lead_bank_before_write on public.lead_bank;
create trigger lead_bank_before_write before insert or update on public.lead_bank
  for each row execute function public.lead_bank_before_write();

-- A new lead with a bank number (typed in, the website form, an import…):
-- the bank row is "in the leads" now (it is never put out twice)
create or replace function public.leads_claim_bank()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if new.phone is null and new.whatsapp_number is null then return null; end if;
  update public.lead_bank b
     set status = 'in_leads', lead_id = new.id, updated_at = now()
   where b.status <> 'in_leads'
     and (b.phone in (new.phone, new.whatsapp_number) or b.whatsapp_number in (new.phone, new.whatsapp_number))
     -- a returned number keeps its own (hidden) lead and history
     and not (b.lead_id is not null and b.lead_id <> new.id
              and exists (select 1 from public.leads x where x.id = b.lead_id and x.banked_at is not null));
  return null;
end;
$$;
drop trigger if exists leads_claim_bank on public.leads;
create trigger leads_claim_bank after insert on public.leads
  for each row execute function public.leads_claim_bank();

-- ---------------------------------------------------------------------
-- 📥 Import: [{name, phone, whatsapp_number, area, note, tags}]
-- ---------------------------------------------------------------------
create or replace function public.bank_import(p_list uuid, p_rows jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  r       jsonb;
  v_phone text;
  v_wa    text;
  v_added int := 0;
  v_bank  int := 0;
  v_leads int := 0;
  v_bad   int := 0;
begin
  if not public.bank_can() then raise exception 'Only an admin can do this.'; end if;
  if jsonb_typeof(p_rows) <> 'array' then raise exception 'Nothing to import.'; end if;
  if jsonb_array_length(p_rows) > 5000 then raise exception 'At most 5000 rows at a time.'; end if;
  if p_list is not null and not exists (select 1 from public.lead_bank_lists where id = p_list) then
    raise exception 'List not found.';
  end if;

  for r in select * from jsonb_array_elements(p_rows) loop
    v_phone := nullif(public.normalize_bd_phone(nullif(trim(coalesce(r ->> 'phone', '')), '')), '');
    v_wa := nullif(public.normalize_bd_phone(nullif(trim(coalesce(r ->> 'whatsapp_number', '')), '')), '');
    v_phone := coalesce(v_phone, v_wa);
    if v_phone is null or length(regexp_replace(v_phone, '\D', '', 'g')) < 10 then
      v_bad := v_bad + 1;
      continue;
    end if;
    if exists (select 1 from public.lead_bank where phone in (v_phone, v_wa) or whatsapp_number in (v_phone, v_wa)) then
      v_bank := v_bank + 1;
      continue;
    end if;
    if exists (select 1 from public.leads l where l.deleted_at is null
                 and (v_phone in (l.phone, l.alt_phone, l.whatsapp_number)
                      or (v_wa is not null and v_wa in (l.phone, l.alt_phone, l.whatsapp_number)))) then
      v_leads := v_leads + 1;
      continue;
    end if;
    insert into public.lead_bank (list_id, name, phone, whatsapp_number, area, note, tags)
    values (p_list, left(r ->> 'name', 120), v_phone, v_wa, left(r ->> 'area', 120), left(r ->> 'note', 1000),
            coalesce((select array_agg(left(trim(t), 40)) from jsonb_array_elements_text(coalesce(r -> 'tags', '[]')) t
                      where trim(t) <> ''), '{}'))
    on conflict (phone) do nothing;
    if found then v_added := v_added + 1; else v_bank := v_bank + 1; end if;
  end loop;
  return jsonb_build_object('added', v_added, 'in_bank', v_bank, 'in_leads', v_leads, 'invalid', v_bad);
end;
$$;
revoke all on function public.bank_import(uuid, jsonb) from public, anon;
grant execute on function public.bank_import(uuid, jsonb) to authenticated;

-- ---------------------------------------------------------------------
-- ➡️ Into the leads: a course (for new ones), people in turn, a stage
--   A returned number comes back as its own lead, with all its history.
-- ---------------------------------------------------------------------
create or replace function public.bank_pull(p_ids uuid[], p_course uuid, p_assignees uuid[], p_stage uuid default null)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  b         public.lead_bank;
  v_src     uuid;
  v_stage   uuid := p_stage;
  v_kind    text;
  v_pc      uuid;
  v_lstage  uuid;
  v_lead    uuid;
  v_who     uuid;
  v_n       int := 0;
  v_people  int := coalesce(array_length(p_assignees, 1), 0);
  v_created int := 0;
  v_back    int := 0;
begin
  if not public.bank_can() then raise exception 'Only an admin can do this.'; end if;
  if coalesce(array_length(p_ids, 1), 0) = 0 then raise exception 'Choose the numbers.'; end if;
  if array_length(p_ids, 1) > 2000 then raise exception 'At most 2000 at a time.'; end if;
  if p_course is not null and not exists (select 1 from public.courses where id = p_course and is_active) then
    raise exception 'Choose a course that is open for leads.';
  end if;
  if v_stage is null then
    select id into v_stage from public.pipeline_stages where key = 'new' and kind = 'open' and is_active;
    if v_stage is null then
      select id into v_stage from public.pipeline_stages where kind = 'open' and is_active order by sort_order limit 1;
    end if;
  elsif not exists (select 1 from public.pipeline_stages where id = v_stage and kind = 'open' and is_active) then
    raise exception 'Please choose a normal stage.';
  end if;
  if exists (select 1 from unnest(coalesce(p_assignees, '{}')) u
             where not exists (select 1 from public.profiles p where p.id = u and p.is_active)) then
    raise exception 'Someone chosen is not an active user.';
  end if;

  select id into v_src from public.lead_sources where lower(name) = 'lead bank' limit 1;
  if v_src is null then
    insert into public.lead_sources (name, sort_order)
    values ('Lead Bank', coalesce((select max(sort_order) from public.lead_sources), 0) + 1)
    returning id into v_src;
  end if;

  -- the timeline shows "from the Lead Bank", not "deleted / restored"
  perform set_config('app.bank', 'on', true);
  for b in select * from public.lead_bank
           where id = any (p_ids) and status <> 'in_leads' and not do_not_call
             and (cooldown_until is null or cooldown_until <= now())
           order by created_at
           for update
  loop
    -- a live lead has this number already (added by hand meanwhile): leave it
    if exists (select 1 from public.leads l
               where l.deleted_at is null and l.id is distinct from b.lead_id
                 and (b.phone in (l.phone, l.alt_phone, l.whatsapp_number)
                      or (b.whatsapp_number is not null and b.whatsapp_number in (l.phone, l.alt_phone, l.whatsapp_number)))) then
      continue;
    end if;
    v_who := case when v_people > 0 then p_assignees[(v_n % v_people) + 1] end;
    v_n := v_n + 1;
    v_lead := null;

    -- 🔁 its own lead, back from the bank
    if b.lead_id is not null and exists (select 1 from public.leads where id = b.lead_id and banked_at is not null) then
      v_lead := b.lead_id;
      perform set_config('app.pipeline_action', 'on', true);
      update public.leads
         set deleted_at = null, banked_at = null,
             assigned_to = coalesce(v_who, assigned_to)
       where id = v_lead;
      -- a course first (its pipeline follows), then the stage that fits that course
      if p_course is not null and not exists (select 1 from public.lead_courses where lead_id = v_lead) then
        insert into public.lead_courses (lead_id, course_id) values (v_lead, p_course) on conflict do nothing;
      end if;
      select s.kind, l.pipeline_course_id into v_kind, v_pc
        from public.leads l join public.pipeline_stages s on s.id = l.stage_id where l.id = v_lead;
      v_lstage := case when public.stage_ok_for_course(v_stage, v_pc) then v_stage
                       else coalesce(public.first_stage_for_course(v_pc), v_stage) end;
      perform set_config('app.pipeline_action', 'on', true);
      if v_kind <> 'open' then
        perform public.reopen_lead(v_lead, v_lstage, 'From the Lead Bank');
        perform set_config('app.stage_note', '', true);
        perform set_config('app.pipeline_action', 'on', true);
      else
        update public.leads set stage_id = v_lstage where id = v_lead and stage_id <> v_lstage;
      end if;
      perform set_config('app.pipeline_action', '', true);
      insert into public.lead_activity (lead_id, user_id, action, details)
      values (v_lead, auth.uid(), 'bank_pulled', jsonb_build_object(
        'times', b.times_pulled + 1, 'back', true,
        'list', (select name from public.lead_bank_lists where id = b.list_id)));
      v_back := v_back + 1;
    else
      if p_course is null and exists (select 1 from public.courses where is_active) then
        raise exception 'Choose a course for the new leads.' using hint = 'course_required';
      end if;
      -- the stage must be one used for this course
      v_lstage := case when public.stage_ok_for_course(v_stage, p_course) then v_stage
                       else coalesce(public.first_stage_for_course(p_course), v_stage) end;
      insert into public.leads (name, phone, whatsapp_number, area, notes, source_id, stage_id, pipeline_course_id,
                                assigned_to, created_by)
      values (coalesce(b.name, 'No name'), b.phone, b.whatsapp_number, b.area, b.note, v_src, v_lstage, p_course,
              v_who, auth.uid())
      returning id into v_lead;
      if p_course is not null then
        insert into public.lead_courses (lead_id, course_id) values (v_lead, p_course) on conflict do nothing;
      end if;
      insert into public.lead_activity (lead_id, user_id, action, details)
      values (v_lead, auth.uid(), 'bank_pulled',
              jsonb_build_object('list', (select name from public.lead_bank_lists where id = b.list_id)));
      v_created := v_created + 1;
    end if;

    update public.lead_bank
       set status = 'in_leads', lead_id = v_lead, times_pulled = times_pulled + 1,
           last_pulled_at = now(), last_pulled_by = auth.uid()
     where id = b.id;
  end loop;
  perform set_config('app.bank', '', true);

  return jsonb_build_object('created', v_created, 'back', v_back,
                            'skipped', coalesce(array_length(p_ids, 1), 0) - v_created - v_back);
end;
$$;
revoke all on function public.bank_pull(uuid[], uuid, uuid[], uuid) from public, anon;
grant execute on function public.bank_pull(uuid[], uuid, uuid[], uuid) to authenticated;

-- ---------------------------------------------------------------------
-- ↩️ Leads back to the bank (with a reason; resting for some days)
--   Admitted students never go. The lead is hidden, not deleted.
-- ---------------------------------------------------------------------
create or replace function public.bank_return(p_lead_ids uuid[], p_reason text default null, p_rest_days integer default 30)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  l        public.leads;
  v_key    text;
  v_row    uuid;
  v_done   int := 0;
  v_skip   int := 0;
  v_reason text := nullif(left(trim(coalesce(p_reason, '')), 200), '');
  v_rest   timestamptz := case when coalesce(p_rest_days, 0) > 0
                               then now() + make_interval(days => least(p_rest_days, 365)) end;
begin
  if not public.bank_can() then raise exception 'Only an admin can do this.'; end if;
  if coalesce(array_length(p_lead_ids, 1), 0) = 0 then raise exception 'Choose the leads.'; end if;
  if array_length(p_lead_ids, 1) > 2000 then raise exception 'At most 2000 at a time.'; end if;

  for l in select * from public.leads where id = any (p_lead_ids) and deleted_at is null for update
  loop
    v_key := coalesce(nullif(public.normalize_bd_phone(l.phone), ''), nullif(public.normalize_bd_phone(l.whatsapp_number), ''));
    -- 🎓 admitted students stay; a lead with no number can't be kept in the bank
    if v_key is null or (l.admitted_at is not null and l.cancelled_at is null) then
      v_skip := v_skip + 1;
      continue;
    end if;

    -- its bank row: the one tied to this lead, else a free one with this number
    v_row := null;
    select b.id into v_row from public.lead_bank b where b.lead_id = l.id
     order by (b.phone = v_key) desc, b.updated_at desc limit 1;
    if v_row is null then
      select b.id into v_row from public.lead_bank b
       where b.phone = v_key
         -- never another live lead's number
         and not (b.status = 'in_leads' and b.lead_id is not null
                  and exists (select 1 from public.leads x where x.id = b.lead_id and x.deleted_at is null));
    end if;

    if v_row is not null then
      -- the same number twice in the bank (e.g. imported again): keep one
      delete from public.lead_bank b
       where b.id <> v_row and b.status <> 'in_leads' and (b.lead_id is null or b.lead_id = l.id)
         and (b.phone = v_key or b.lead_id = l.id);
      update public.lead_bank b
         set status = 'returned', lead_id = l.id, name = coalesce(l.name, b.name),
             -- the lead's number now (unless another row has it)
             phone = case when exists (select 1 from public.lead_bank x where x.phone = v_key and x.id <> b.id)
                          then b.phone else v_key end,
             returned_at = now(), returned_by = auth.uid(), return_reason = v_reason, cooldown_until = v_rest
       where b.id = v_row;
    else
      insert into public.lead_bank (name, phone, whatsapp_number, area, status, lead_id,
                                    returned_at, returned_by, return_reason, cooldown_until)
      values (l.name, v_key, l.whatsapp_number, l.area, 'returned', l.id, now(), auth.uid(), v_reason, v_rest)
      on conflict (phone) do nothing;
      if not found then
        -- another live lead has this number in the bank: this one stays a lead
        v_skip := v_skip + 1;
        continue;
      end if;
    end if;

    insert into public.lead_activity (lead_id, user_id, action, details)
    values (l.id, auth.uid(), 'bank_returned', jsonb_build_object('reason', v_reason, 'rest_days',
            case when v_rest is null then 0 else least(p_rest_days, 365) end));
    -- its waiting calls are not anyone's job now
    update public.follow_ups
       set status = 'cancelled', completed_at = now(), completed_by = auth.uid()
     where lead_id = l.id and status = 'pending';
    perform set_config('app.bank', 'on', true);
    update public.leads set deleted_at = now(), banked_at = now() where id = l.id;
    perform set_config('app.bank', '', true);
    v_done := v_done + 1;
  end loop;
  return jsonb_build_object('returned', v_done, 'skipped', coalesce(array_length(p_lead_ids, 1), 0) - v_done);
end;
$$;
revoke all on function public.bank_return(uuid[], text, integer) from public, anon;
grant execute on function public.bank_return(uuid[], text, integer) to authenticated;

-- ---------------------------------------------------------------------
-- 📊 The numbers (one request): tabs, lists, how each list did
-- ---------------------------------------------------------------------
create or replace function public.bank_summary()
returns jsonb
language plpgsql
stable
security definer
set search_path = public
set jit = off
as $$
begin
  if not public.bank_can() then return null; end if;
  return jsonb_build_object(
    'new', (select count(*) from public.lead_bank where status = 'new'),
    'returned', (select count(*) from public.lead_bank where status = 'returned'),
    'in_leads', (select count(*) from public.lead_bank where status = 'in_leads'),
    'resting', (select count(*) from public.lead_bank where status <> 'in_leads' and cooldown_until > now()),
    'do_not_call', (select count(*) from public.lead_bank where do_not_call),
    'lists', coalesce((select jsonb_agg(x order by x.name) from (
        select li.id, li.name, li.note,
               count(b.id) filter (where b.status = 'new') as new,
               count(b.id) filter (where b.status = 'returned') as returned,
               count(b.id) filter (where b.status = 'in_leads') as in_leads,
               count(b.id) filter (where b.times_pulled > 0) as pulled,
               count(l.id) filter (where l.admitted_at is not null and l.cancelled_at is null) as admitted
        from public.lead_bank_lists li
        left join public.lead_bank b on b.list_id = li.id
        left join public.leads l on l.id = b.lead_id and l.deleted_at is null
        group by li.id) x), '[]'::jsonb),
    'no_list', (select count(*) from public.lead_bank where list_id is null and status <> 'in_leads')
  );
end;
$$;
revoke all on function public.bank_summary() from public, anon;
grant execute on function public.bank_summary() to authenticated;

-- ---------------------------------------------------------------------
-- 🗑 A returned number deleted from the bank: its hidden lead is deleted
--   too (a normal deleted lead now, with "Lead deleted" on its timeline)
-- ---------------------------------------------------------------------
create or replace function public.lead_bank_after_delete()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if old.lead_id is not null then
    update public.leads set banked_at = null
     where id = old.lead_id and banked_at is not null and deleted_at is not null;
    if found then
      insert into public.lead_activity (lead_id, user_id, action, details)
      values (old.lead_id, auth.uid(), 'deleted', jsonb_build_object('from', 'lead_bank'));
    end if;
  end if;
  return null;
end;
$$;
drop trigger if exists lead_bank_after_delete on public.lead_bank;
create trigger lead_bank_after_delete after delete on public.lead_bank
  for each row execute function public.lead_bank_after_delete();

-- The caller card's bank part: every active user's phone knows these numbers
-- (only a name and the list, never the details: the bank stays admins-only)
create or replace function public.bank_directory()
returns table(hash text, id uuid, name text, stage text, note text)
language sql
stable
security definer
set search_path = public
as $$
  select bk.phone_hash, bk.id,
         -- 🏦 in front: a WhatsApp contact name never matches a bank number
         '🏦 ' || coalesce(bk.name, 'Lead Bank'),
         '🏦 Lead Bank' || coalesce(' · ' || li.name, '') ||
           case when bk.status = 'returned' then ' · returned' else '' end,
         bk.return_reason
  from (select b.phone_hash, b.id, b.name, b.list_id, b.status, b.return_reason
        from public.lead_bank b
        where b.status <> 'in_leads' and not b.do_not_call and b.phone_hash is not null
        order by b.updated_at desc limit 5000) bk
  left join public.lead_bank_lists li on li.id = bk.list_id
  where public.is_active_user();
$$;
revoke all on function public.bank_directory() from public, anon;
grant execute on function public.bank_directory() to authenticated;

-- ---------------------------------------------------------------------
-- 📇 The phone's caller card: bank numbers too ("🏦 Lead Bank · list").
--   "Lost" shows as "Not Now". The bank rows bring their own hash.
-- ---------------------------------------------------------------------
create or replace function public.my_lead_directory()
returns table(hash text, lead_id uuid, name text, rating text, stage text, course text, last_note text,
              student_ref text, fee_due numeric, next_call timestamptz, owner text)
language sql
stable
set search_path = public, extensions
as $$
  with visible as (
    select
      l.id, l.name, l.rating, l.phone, l.alt_phone, l.whatsapp_number, l.whatsapp_username,
      l.student_ref, l.next_follow_up_at,
      case when s.kind = 'won' and coalesce(l.fee_due, 0) > 0 then l.fee_due end as fee_due,
      p.full_name as owner,
      case s.kind
        when 'won'       then '🎓 Admitted' || coalesce(' · ' || b.name, '')
        when 'lost'      then '✕ Not Now' || coalesce(' · ' || lr.name, '')
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
    left join public.profiles p on p.id = l.assigned_to
    where l.deleted_at is null
    order by l.updated_at desc nulls last
    limit 10000
  ),
  alum as (
    select a.id, a.name, a.phone, a.whatsapp_number, a.student_ref, a.next_contact_at, a.last_note,
           p.full_name as owner,
           '🎓 Alumni' || coalesce(' · ' || b.name, '') ||
             case when a.cnt_referrals > 0 then ' · ' || a.cnt_referrals || ' referral' ||
                    case when a.cnt_referrals > 1 then 's' else '' end else '' end as stage,
           c.name as course
    from public.alumni a
    left join public.batches b on b.id = a.batch_id
    left join public.courses c on c.id = a.course_id
    left join public.profiles p on p.id = a.owner_id
    where a.deleted_at is null and public.alumni_can('view')
    order by a.updated_at desc
    limit 5000
  ),
  keys as (
    select 1 as prio, v.id, v.name, v.rating, v.stage, v.course, v.last_note, v.student_ref, v.fee_due,
           v.next_follow_up_at as next_call, v.owner, encode(digest(k.key, 'sha256'), 'hex') as h
    from visible v
    cross join lateral (values
      (v.phone),
      (v.alt_phone),
      (v.whatsapp_number),
      ('u:' || v.whatsapp_username)
    ) as k(key)
    where k.key is not null
    union all
    select 2, a.id, a.name, null, a.stage, a.course, a.last_note, a.student_ref, null::numeric,
           a.next_contact_at, a.owner, encode(digest(k.key, 'sha256'), 'hex')
    from alum a
    cross join lateral (values (a.phone), (a.whatsapp_number)) as k(key)
    where k.key is not null
    union all
    -- 🏦 the bank (waiting numbers only; the hash is kept on the row)
    select 3, bd.id, bd.name, null, bd.stage, null, bd.note, null, null::numeric, null::timestamptz, null, bd.hash
    from public.bank_directory() bd
  )
  select distinct on (k.h)
         k.h, k.id, k.name, k.rating, k.stage, k.course, left(k.last_note, 120),
         k.student_ref, k.fee_due, k.next_call, k.owner
  from keys k
  order by k.h, k.prio;
$$;

-- ---------------------------------------------------------------------
-- "Lost" → "Not Now" (what people read; the keys stay "lost")
-- ---------------------------------------------------------------------
update public.pipeline_stages set name = 'Not Now' where key = 'lost' and name = 'Lost';

do $$
declare
  fixes constant text[][] := array[
    ['public.mark_lost(uuid,uuid,text,timestamp with time zone)', 'This lead is already lost.', 'This lead is already in Not Now.'],
    ['public.mark_lost(uuid,uuid,text,timestamp with time zone)', 'Please choose why the lead was lost.', 'Please choose the reason (Not Now).'],
    ['public.mark_lost(uuid,uuid,text,timestamp with time zone)', '''Lost: ''', '''Not Now: '''],
    ['public.mark_lost(uuid,uuid,text,timestamp with time zone)', '♻️ Revive: lost (', '♻️ Revive: Not Now ('],
    ['public.bulk_mark_lost(uuid[],uuid,text)', 'mark many leads lost at once', 'move many leads to Not Now at once'],
    ['public.after_call_logged()', 'This lost lead called you', 'This Not Now lead called you'],
    ['public.guard_lead_pipeline()', 'Mark lost', 'Not Now'],
    ['public.guard_pipeline_stage()', 'Admitted, Lost or Cancelled', 'Admitted, Not Now or Cancelled'],
    ['public.notify_lead_updates()', 'r.first_name || '' lost''', 'r.first_name || '': Not Now'''],
    ['public.notify_lead_updates()', 'r.n || '' leads lost''', 'r.n || '' leads: Not Now'''],
    ['public.ai_chance_request(uuid)', 'Only open leads (not admitted or lost).', 'Only open leads (not admitted or Not Now).'],
    -- to the bank and back: the timeline says so itself (bank_returned / bank_pulled)
    ['public.leads_log_activity()', 'if new.deleted_at is distinct from old.deleted_at then',
     'if new.deleted_at is distinct from old.deleted_at and coalesce(current_setting(''app.bank'', true), '''') <> ''on'' then']
  ];
  i   int;
  f   regprocedure;
  d   text;
begin
  for i in 1 .. array_length(fixes, 1) loop
    f := fixes[i][1]::regprocedure;
    d := pg_get_functiondef(f);
    if position(fixes[i][3] in d) > 0 and position(fixes[i][2] in d) = 0 then
      continue;   -- done before
    end if;
    if position(fixes[i][2] in d) = 0 then
      raise exception 'Not Now rename: "%" not found in %, update this migration', fixes[i][2], f;
    end if;
    execute replace(d, fixes[i][2], fixes[i][3]);
  end loop;
end $$;

notify pgrst, 'reload schema';
