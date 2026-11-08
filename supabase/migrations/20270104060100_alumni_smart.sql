-- =====================================================================
-- 🎓 Alumni, smarter: day-to-day work like on leads
--   · search everywhere (workplace, designation, place, tags, custom fields)
--   · counts kept on the row (referrals, leads, admitted) so the list can
--     sort and filter by them quickly
--   · next contact (date + note) with a reminder, and birthdays
--   · notes: pin, delete (24 h) / restore (10 min), calls and WhatsApp
--     logged with result, direction and length
--   · call log sync: a call with an alumnus' number lands on the alumnus;
--     WhatsApp calls too; the caller card knows alumni
--   · saved filters for the alumni list
--   (Dated after 20270104060000_lead_merge so both can go in any order.)
-- =====================================================================

-- ---------------------------------------------------------------------
-- 1. New columns on alumni
-- ---------------------------------------------------------------------
alter table public.alumni add column if not exists next_contact_at   timestamptz;
alter table public.alumni add column if not exists next_contact_note text;
alter table public.alumni add column if not exists next_contact_by   uuid references public.profiles (id) on delete set null;
alter table public.alumni add column if not exists birth_date        date;
-- month*100 + day of the birthday (so the list can filter "this week / this month")
alter table public.alumni add column if not exists birth_md          smallint;
alter table public.alumni add column if not exists last_note         text;
alter table public.alumni add column if not exists last_note_at      timestamptz;
alter table public.alumni add column if not exists search_text       text;
alter table public.alumni add column if not exists phone_hash        text;
alter table public.alumni add column if not exists wa_hash           text;
alter table public.alumni add column if not exists cnt_referrals     integer not null default 0;
alter table public.alumni add column if not exists cnt_waiting       integer not null default 0;
alter table public.alumni add column if not exists cnt_leads         integer not null default 0;
alter table public.alumni add column if not exists cnt_admitted      integer not null default 0;
alter table public.alumni add column if not exists last_referral_at  timestamptz;

create index if not exists alumni_next_contact_idx on public.alumni (next_contact_at) where deleted_at is null and next_contact_at is not null;
create index if not exists alumni_phone_hash_idx on public.alumni (phone_hash) where deleted_at is null and phone_hash is not null;
create index if not exists alumni_wa_hash_idx on public.alumni (wa_hash) where deleted_at is null and wa_hash is not null;
create index if not exists alumni_owner_idx on public.alumni (owner_id) where deleted_at is null;
create index if not exists alumni_tags_idx on public.alumni using gin (tags);

-- Clean the row; keep the search text and the number hashes (for call sync)
create or replace function public.alumni_before_write()
returns trigger
language plpgsql
set search_path = public, extensions
as $$
begin
  new.name := trim(new.name);
  new.phone := nullif(public.normalize_bd_phone(nullif(trim(coalesce(new.phone, '')), '')), '');
  new.whatsapp_number := nullif(public.normalize_bd_phone(nullif(trim(coalesce(new.whatsapp_number, '')), '')), '');
  new.email := nullif(lower(trim(coalesce(new.email, ''))), '');
  new.custom := coalesce(new.custom, '{}'::jsonb);
  new.tags := coalesce(new.tags, '{}');
  new.phone_hash := case when new.phone is null then null else encode(digest(new.phone, 'sha256'), 'hex') end;
  new.wa_hash := case when new.whatsapp_number is null or new.whatsapp_number = new.phone then null
                      else encode(digest(new.whatsapp_number, 'sha256'), 'hex') end;
  new.search_text := lower(concat_ws(' ', new.name, new.phone, new.whatsapp_number, new.email, new.student_ref,
                                     new.ref_code, new.workplace, new.designation, new.district, new.upazila,
                                     new.address, new.session, new.passing_year::text,
                                     array_to_string(new.tags, ' '),
                                     (select string_agg(v, ' ') from jsonb_each_text(new.custom) as c(k, v))));
  new.birth_md := case when new.birth_date is null then null
                       else (extract(month from new.birth_date) * 100 + extract(day from new.birth_date))::smallint end;
  if tg_op = 'UPDATE' then new.updated_at := now(); end if;
  return new;
end;
$$;

-- fill the new columns for everyone already there (the trigger does the work)
update public.alumni set name = name;

-- ---------------------------------------------------------------------
-- 2. Counts on the row (referrals, leads, admitted), kept by triggers
-- ---------------------------------------------------------------------
create or replace function public.alumni_recount(p_alumni uuid)
returns void
language sql
security definer
set search_path = public
as $$
  update public.alumni a set
    cnt_referrals    = r.n,
    cnt_waiting      = r.waiting,
    last_referral_at = r.last_at,
    cnt_leads        = l.leads,
    cnt_admitted     = l.admitted
  from (select count(*) as n, count(*) filter (where status = 'new') as waiting, max(created_at) as last_at
        from public.alumni_referrals where alumni_id = p_alumni) r,
       (select count(*) as leads,
               count(*) filter (where admitted_at is not null and cancelled_at is null) as admitted
        from public.leads where referred_by_alumni_id = p_alumni and deleted_at is null) l
  where a.id = p_alumni
    and (a.cnt_referrals, a.cnt_waiting, a.last_referral_at, a.cnt_leads, a.cnt_admitted)
        is distinct from (r.n, r.waiting, r.last_at, l.leads, l.admitted);
$$;
revoke all on function public.alumni_recount(uuid) from public, anon, authenticated;

create or replace function public.alumni_referrals_recount()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if tg_op <> 'INSERT' then perform public.alumni_recount(old.alumni_id); end if;
  if tg_op <> 'DELETE' and (tg_op = 'INSERT' or new.alumni_id is distinct from old.alumni_id) then
    perform public.alumni_recount(new.alumni_id);
  end if;
  return null;
end;
$$;
drop trigger if exists alumni_referrals_recount on public.alumni_referrals;
create trigger alumni_referrals_recount after insert or update or delete on public.alumni_referrals
  for each row execute function public.alumni_referrals_recount();

create or replace function public.leads_alumni_recount()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if tg_op in ('UPDATE', 'DELETE') and old.referred_by_alumni_id is not null then
    perform public.alumni_recount(old.referred_by_alumni_id);
  end if;
  if tg_op in ('INSERT', 'UPDATE') and new.referred_by_alumni_id is not null
     and (tg_op = 'INSERT' or new.referred_by_alumni_id is distinct from old.referred_by_alumni_id) then
    perform public.alumni_recount(new.referred_by_alumni_id);
  end if;
  return null;
end;
$$;
drop trigger if exists leads_alumni_recount on public.leads;
drop trigger if exists leads_alumni_recount_ins on public.leads;
create trigger leads_alumni_recount_ins after insert on public.leads
  for each row when (new.referred_by_alumni_id is not null)
  execute function public.leads_alumni_recount();
drop trigger if exists leads_alumni_recount_del on public.leads;
create trigger leads_alumni_recount_del after delete on public.leads
  for each row when (old.referred_by_alumni_id is not null)
  execute function public.leads_alumni_recount();
-- (an update trigger only when something that is counted changes)
drop trigger if exists leads_alumni_recount_upd on public.leads;
create trigger leads_alumni_recount_upd after update of referred_by_alumni_id, admitted_at, cancelled_at, deleted_at on public.leads
  for each row when (new.referred_by_alumni_id is not null or old.referred_by_alumni_id is not null)
  execute function public.leads_alumni_recount();

select public.alumni_recount(id) from public.alumni;

-- ---------------------------------------------------------------------
-- 3. Notes, calls, messages: more detail
-- ---------------------------------------------------------------------
alter table public.alumni_events add column if not exists happened_at   timestamptz;
alter table public.alumni_events add column if not exists pinned        boolean not null default false;
alter table public.alumni_events add column if not exists deleted_at    timestamptz;
alter table public.alumni_events add column if not exists deleted_by    uuid references public.profiles (id) on delete set null;
alter table public.alumni_events add column if not exists delete_reason text;
alter table public.alumni_events add column if not exists outcome       text;
alter table public.alumni_events add column if not exists direction     text;
alter table public.alumni_events add column if not exists duration_sec  integer;
alter table public.alumni_events add column if not exists channel       text;
alter table public.alumni_events add column if not exists media         text;
alter table public.alumni_events add column if not exists source        text not null default 'app';
alter table public.alumni_events add column if not exists device_id     text;
alter table public.alumni_events add column if not exists device_call_id text;
alter table public.alumni_events add column if not exists sim_label     text;
update public.alumni_events set happened_at = created_at where happened_at is null;
alter table public.alumni_events alter column happened_at set default now();

alter table public.alumni_events drop constraint if exists alumni_events_kind_check;
alter table public.alumni_events add constraint alumni_events_kind_check
  check (kind in ('note', 'call', 'whatsapp', 'message', 'created', 'edited',
                  'referral', 'referral_imported', 'referral_credited', 'referral_rejected',
                  'admitted', 'reward', 'deleted', 'restored', 'next_contact'));
alter table public.alumni_events drop constraint if exists alumni_events_outcome_check;
alter table public.alumni_events add constraint alumni_events_outcome_check
  check (outcome is null or outcome in ('connected', 'no_answer', 'busy', 'switched_off', 'wrong_number',
                                         'call_back', 'missed', 'rejected', 'message'));
alter table public.alumni_events drop constraint if exists alumni_events_source_check;
alter table public.alumni_events add constraint alumni_events_source_check
  check (source in ('app', 'phone', 'whatsapp'));

-- one row per call from one phone
create unique index if not exists alumni_events_device_call_key
  on public.alumni_events (by_user, device_id, device_call_id) where device_call_id is not null;
create index if not exists alumni_events_pinned_idx on public.alumni_events (alumni_id) where pinned and deleted_at is null;

-- Last contact and last note on the row, from the notes / calls that are not deleted
create or replace function public.alumni_touch(p_alumni uuid)
returns void
language sql
security definer
set search_path = public
as $$
  update public.alumni a set
    last_contacted_at = coalesce(
      (select max(e.happened_at) from public.alumni_events e
        where e.alumni_id = a.id and e.deleted_at is null and e.kind in ('call', 'whatsapp', 'message')
          and coalesce(e.outcome, '') not in ('missed', 'rejected', 'wrong_number')),
      case when not exists (select 1 from public.alumni_events e
                             where e.alumni_id = a.id and e.kind in ('call', 'whatsapp', 'message'))
           then a.last_contacted_at end),
    last_note = n.body,
    last_note_at = n.at
  from (select null::text as body, null::timestamptz as at) d
  left join lateral (
    select e.body, e.happened_at as at from public.alumni_events e
    where e.alumni_id = p_alumni and e.deleted_at is null and e.body is not null
      and e.kind in ('note', 'call', 'whatsapp', 'message')
    order by e.happened_at desc limit 1) n on true
  where a.id = p_alumni;
$$;
revoke all on function public.alumni_touch(uuid) from public, anon, authenticated;

create or replace function public.alumni_events_touch()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if new.kind in ('note', 'call', 'whatsapp', 'message')
     and (tg_op = 'INSERT' or new.deleted_at is distinct from old.deleted_at or new.body is distinct from old.body
          or new.outcome is distinct from old.outcome or new.happened_at is distinct from old.happened_at) then
    perform public.alumni_touch(new.alumni_id);
  end if;
  return null;
end;
$$;
drop trigger if exists alumni_events_touch on public.alumni_events;
create trigger alumni_events_touch after insert or update on public.alumni_events
  for each row execute function public.alumni_events_touch();

select public.alumni_touch(id) from public.alumni;

-- ---------------------------------------------------------------------
-- 4. The list (counts from the row now: fast to sort and filter)
--    reward_due: what is still to be paid (only managers see rewards)
-- ---------------------------------------------------------------------
drop view if exists public.alumni_overview;
create view public.alumni_overview with (security_invoker = true) as
select a.*,
  c.name as course_name,
  b.name as batch_name,
  o.full_name as owner_name,
  a.cnt_referrals as referrals,
  a.cnt_waiting   as referrals_waiting,
  a.cnt_leads     as referred_leads,
  a.cnt_admitted  as referred_admitted,
  coalesce((select sum(rw.amount) from public.alumni_rewards rw
            where rw.alumni_id = a.id and rw.status = 'due'), 0) as reward_due
from public.alumni a
left join public.courses c on c.id = a.course_id
left join public.batches b on b.id = a.batch_id
left join public.profiles o on o.id = a.owner_id
where a.deleted_at is null;
grant select on public.alumni_overview to authenticated;

-- ---------------------------------------------------------------------
-- 5. Saving: birth date (an app that doesn't send it keeps it)
-- ---------------------------------------------------------------------
-- save_alumni stays as it was (old apps); the new app sends birth_date through this one
create or replace function public.save_alumni_v2(p_id uuid, p_row jsonb)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_id uuid;
  v_bd date;
begin
  if p_row ? 'birth_date' then
    begin
      v_bd := nullif(p_row ->> 'birth_date', '')::date;
    exception when others then
      raise exception 'The birth date looks wrong.';
    end;
    if v_bd is not null and (v_bd > current_date or v_bd < date '1930-01-01') then
      raise exception 'The birth date looks wrong.';
    end if;
  end if;
  v_id := public.save_alumni(p_id, p_row);
  if p_row ? 'birth_date' then
    update public.alumni set birth_date = v_bd where id = v_id;
  end if;
  return v_id;
end;
$$;
revoke all on function public.save_alumni_v2(uuid, jsonb) from public, anon;
grant execute on function public.save_alumni_v2(uuid, jsonb) to authenticated;

-- ---------------------------------------------------------------------
-- 6. Contacts: a call / WhatsApp / message with its result
--   p_device_call_id: the call on this phone (from the "add a note"
--   notification or the popup after a call) — the same call synced from
--   the phone becomes one row
-- ---------------------------------------------------------------------
create or replace function public.log_alumni_contact(
  p_alumni         uuid,
  p_channel        text,
  p_outcome        text,
  p_note           text default null,
  p_direction      text default 'outgoing',
  p_media          text default null,
  p_duration       integer default null,
  p_device_id      text default null,
  p_device_call_id text default null,
  p_called_at      timestamptz default null,
  p_next_at        timestamptz default null,
  p_next_note      text default null
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_kind text := case p_channel when 'phone' then 'call' when 'whatsapp' then 'whatsapp' when 'sms' then 'message' end;
  v_note text := nullif(trim(coalesce(p_note, '')), '');
  v_at   timestamptz := coalesce(p_called_at, now());
  v_id   uuid;
begin
  if not public.alumni_can('view') then raise exception 'You cannot see alumni.'; end if;
  if v_kind is null then raise exception 'Unknown channel.'; end if;
  if p_outcome is null or p_outcome not in ('connected', 'no_answer', 'busy', 'switched_off', 'wrong_number',
                                              'call_back', 'missed', 'rejected', 'message') then
    raise exception 'Choose what happened.';
  end if;
  if coalesce(p_direction, 'outgoing') not in ('outgoing', 'incoming', 'missed', 'rejected') then
    raise exception 'Unknown direction.';
  end if;
  if not exists (select 1 from public.alumni where id = p_alumni and deleted_at is null) then
    raise exception 'Alumnus not found.';
  end if;
  if p_next_at is not null and p_next_at < now() - interval '5 minutes' then
    raise exception 'The next contact is in the past.';
  end if;

  -- the same phone call, already synced (or saved before): fill it in
  if p_device_call_id is not null then
    update public.alumni_events e set
      outcome = p_outcome,
      body = case when v_note is null then e.body
                  when e.body is null then left(v_note, 2000)
                  else left(e.body || E'\n' || v_note, 2000) end
    where e.by_user = auth.uid() and e.device_id = p_device_id and e.device_call_id = p_device_call_id
      and e.alumni_id = p_alumni
    returning e.id into v_id;
  end if;

  if v_id is null then
    insert into public.alumni_events (alumni_id, kind, body, by_user, happened_at, outcome, direction,
                                      duration_sec, channel, media, source, device_id, device_call_id)
    values (p_alumni, v_kind, left(v_note, 2000), auth.uid(), v_at, p_outcome, coalesce(p_direction, 'outgoing'),
            p_duration, p_channel, p_media, 'app', p_device_id, p_device_call_id)
    returning id into v_id;
  end if;

  if p_next_at is not null then
    perform public.set_alumni_next_contact(array[p_alumni], p_next_at, p_next_note);
  elsif p_outcome in ('connected', 'message') then
    -- talked: a next contact that was due is done
    update public.alumni set next_contact_at = null, next_contact_note = null
    where id = p_alumni and next_contact_at <= now() + interval '12 hours';
  end if;
  return v_id;
end;
$$;
revoke all on function public.log_alumni_contact(uuid, text, text, text, text, text, integer, text, text, timestamptz, timestamptz, text) from public, anon;
grant execute on function public.log_alumni_contact(uuid, text, text, text, text, text, integer, text, text, timestamptz, timestamptz, text) to authenticated;

-- ⏰ Next contact for one or many (null = clear)
create or replace function public.set_alumni_next_contact(p_ids uuid[], p_at timestamptz, p_note text default null)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  v_ids uuid[];
begin
  if not public.alumni_can('view') then raise exception 'You cannot see alumni.'; end if;
  if coalesce(array_length(p_ids, 1), 0) = 0 then return 0; end if;
  if array_length(p_ids, 1) > 5000 then raise exception 'Mark at most 5000 at a time.'; end if;
  if p_at is not null and p_at < now() - interval '5 minutes' then raise exception 'Choose a time in the future.'; end if;
  with u as (
    update public.alumni set
      next_contact_at = p_at,
      next_contact_note = case when p_at is null then null else nullif(left(trim(coalesce(p_note, '')), 300), '') end,
      next_contact_by = case when p_at is null then null else auth.uid() end
    where id = any (p_ids) and deleted_at is null
    returning id)
  select array_agg(id) into v_ids from u;
  insert into public.alumni_events (alumni_id, kind, body, data, by_user)
  select x, 'next_contact', nullif(left(trim(coalesce(p_note, '')), 300), ''),
         jsonb_build_object('at', p_at), auth.uid()
  from unnest(coalesce(v_ids, '{}')) x;
  return coalesce(array_length(v_ids, 1), 0);
end;
$$;
revoke all on function public.set_alumni_next_contact(uuid[], timestamptz, text) from public, anon;
grant execute on function public.set_alumni_next_contact(uuid[], timestamptz, text) to authenticated;

-- 🗑 Delete a note / call written in the app (the writer within 24 h; managers any time)
create or replace function public.delete_alumni_event(p_event uuid, p_reason text default null)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  e public.alumni_events;
begin
  select * into e from public.alumni_events where id = p_event;
  if e.id is null or e.deleted_at is not null then raise exception 'Not found.'; end if;
  if e.kind not in ('note', 'call', 'whatsapp', 'message') then raise exception 'Only notes, calls and messages can be deleted.'; end if;
  if e.source <> 'app' then raise exception 'Calls synced from the phone cannot be deleted.'; end if;
  if not (public.alumni_can('manage')
          or (e.by_user = auth.uid() and public.alumni_can('view') and e.created_at > now() - interval '24 hours')) then
    raise exception 'You can delete your own notes for 24 hours; managers any time.';
  end if;
  update public.alumni_events
     set deleted_at = now(), deleted_by = auth.uid(), delete_reason = nullif(left(trim(coalesce(p_reason, '')), 300), ''),
         pinned = false
   where id = p_event;
end;
$$;
revoke all on function public.delete_alumni_event(uuid, text) from public, anon;
grant execute on function public.delete_alumni_event(uuid, text) to authenticated;

-- ↩ Undo a delete (whoever deleted within 10 minutes; managers any time)
create or replace function public.restore_alumni_event(p_event uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  e public.alumni_events;
begin
  select * into e from public.alumni_events where id = p_event;
  if e.id is null or e.deleted_at is null then raise exception 'Not found.'; end if;
  if not (public.alumni_can('manage')
          or (e.deleted_by = auth.uid() and e.deleted_at > now() - interval '10 minutes')) then
    raise exception 'Only a manager can bring this back now.';
  end if;
  update public.alumni_events set deleted_at = null, deleted_by = null, delete_reason = null where id = p_event;
end;
$$;
revoke all on function public.restore_alumni_event(uuid) from public, anon;
grant execute on function public.restore_alumni_event(uuid) to authenticated;

-- 📌 Pin a note to the top (its writer or a manager)
create or replace function public.pin_alumni_event(p_event uuid, p_pinned boolean)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  e public.alumni_events;
begin
  select * into e from public.alumni_events where id = p_event;
  if e.id is null or e.deleted_at is not null then raise exception 'Not found.'; end if;
  if e.kind not in ('note', 'call', 'whatsapp', 'message') or e.body is null then
    raise exception 'Only a note can be pinned.';
  end if;
  if not (public.alumni_can('manage') or (e.by_user = auth.uid() and public.alumni_can('view'))) then
    raise exception 'Only its writer or a manager can pin this.';
  end if;
  if coalesce(p_pinned, false)
     and (select count(*) from public.alumni_events where alumni_id = e.alumni_id and pinned and deleted_at is null) >= 5 then
    raise exception 'At most 5 pinned notes.';
  end if;
  update public.alumni_events set pinned = coalesce(p_pinned, false) where id = p_event;
end;
$$;
revoke all on function public.pin_alumni_event(uuid, boolean) from public, anon;
grant execute on function public.pin_alumni_event(uuid, boolean) to authenticated;

-- ---------------------------------------------------------------------
-- 7. Many at once: + note, tags, owner, do-not-contact
--   (notes: anyone who sees alumni; the rest: managers)
-- ---------------------------------------------------------------------
drop function if exists public.alumni_bulk(uuid[], text, uuid, uuid);
create or replace function public.alumni_bulk(p_ids uuid[], p_action text, p_course_id uuid default null,
                                             p_batch_id uuid default null, p_text text default null,
                                             p_owner uuid default null)
returns int
language plpgsql
security definer
set search_path = public
as $$
declare
  v_ids uuid[];
  v_c   text;
  v_t   text := nullif(trim(coalesce(p_text, '')), '');
begin
  if p_action = 'note' then
    if not public.alumni_can('view') then raise exception 'You cannot see alumni.'; end if;
  elsif not public.alumni_can('manage') then
    raise exception 'You cannot change alumni.';
  end if;
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
  elsif p_action = 'note' then
    if v_t is null then raise exception 'Please type the note.'; end if;
    select array_agg(id) into v_ids from public.alumni where id = any (p_ids) and deleted_at is null;
    insert into public.alumni_events (alumni_id, kind, body, by_user)
    select x, 'note', left(v_t, 2000), auth.uid() from unnest(coalesce(v_ids, '{}')) x;
  elsif p_action in ('tag_add', 'tag_remove') then
    if v_t is null then raise exception 'Type the tag.'; end if;
    v_t := left(v_t, 40);
    with u as (
      update public.alumni set tags = case when p_action = 'tag_add' then array_append(tags, v_t)
                                           else array_remove(tags, v_t) end
      where id = any (p_ids) and deleted_at is null
        and (case when p_action = 'tag_add' then not (v_t = any (tags)) else v_t = any (tags) end)
      returning id)
    select array_agg(id) into v_ids from u;
    insert into public.alumni_events (alumni_id, kind, body, by_user)
    select x, 'edited', case when p_action = 'tag_add' then 'Tag added: ' else 'Tag removed: ' end || v_t, auth.uid()
    from unnest(coalesce(v_ids, '{}')) x;
  elsif p_action = 'owner' then
    if p_owner is not null and not exists (select 1 from public.profiles where id = p_owner and is_active) then
      raise exception 'Choose an active person.';
    end if;
    with u as (
      update public.alumni set owner_id = p_owner
      where id = any (p_ids) and deleted_at is null and owner_id is distinct from p_owner
      returning id)
    select array_agg(id) into v_ids from u;
    insert into public.alumni_events (alumni_id, kind, body, by_user)
    select x, 'edited', 'Looked after by: ' || coalesce(public.person_name(p_owner), 'nobody'), auth.uid()
    from unnest(coalesce(v_ids, '{}')) x;
  elsif p_action in ('dnc_on', 'dnc_off') then
    with u as (
      update public.alumni set do_not_contact = (p_action = 'dnc_on')
      where id = any (p_ids) and deleted_at is null and do_not_contact is distinct from (p_action = 'dnc_on')
      returning id)
    select array_agg(id) into v_ids from u;
    insert into public.alumni_events (alumni_id, kind, body, by_user)
    select x, 'edited', case when p_action = 'dnc_on' then 'Do not contact: on' else 'Do not contact: off' end, auth.uid()
    from unnest(coalesce(v_ids, '{}')) x;
  else
    raise exception 'Unknown action.';
  end if;
  return coalesce(array_length(v_ids, 1), 0);
end;
$$;
revoke all on function public.alumni_bulk(uuid[], text, uuid, uuid, text, uuid) from public, anon;
grant execute on function public.alumni_bulk(uuid[], text, uuid, uuid, text, uuid) to authenticated;

-- ---------------------------------------------------------------------
-- 8. Filter choices (districts, workplaces, tags… that are in use)
-- ---------------------------------------------------------------------
create or replace function public.alumni_filter_values()
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
begin
  if not public.alumni_can('view') then return null; end if;
  return jsonb_build_object(
    'districts', coalesce((select jsonb_agg(v order by v) from (select distinct district v from public.alumni
                  where deleted_at is null and district is not null) x), '[]'::jsonb),
    'upazilas', coalesce((select jsonb_agg(v order by v) from (select distinct upazila v from public.alumni
                  where deleted_at is null and upazila is not null) x), '[]'::jsonb),
    'workplaces', coalesce((select jsonb_agg(v order by v) from (select distinct workplace v from public.alumni
                  where deleted_at is null and workplace is not null limit 500) x), '[]'::jsonb),
    'designations', coalesce((select jsonb_agg(v order by v) from (select distinct designation v from public.alumni
                  where deleted_at is null and designation is not null limit 300) x), '[]'::jsonb),
    'sessions', coalesce((select jsonb_agg(v order by v desc) from (select distinct session v from public.alumni
                  where deleted_at is null and session is not null) x), '[]'::jsonb),
    'years', coalesce((select jsonb_agg(v order by v desc) from (select distinct passing_year v from public.alumni
                  where deleted_at is null and passing_year is not null) x), '[]'::jsonb),
    'tags', coalesce((select jsonb_agg(v order by v) from (select distinct unnest(tags) v from public.alumni
                  where deleted_at is null) x), '[]'::jsonb));
end;
$$;
revoke all on function public.alumni_filter_values() from public, anon;
grant execute on function public.alumni_filter_values() to authenticated;

-- 💾 Saved filters for the alumni list (yours, and the ones managers share)
create table if not exists public.alumni_saved_filters (
  id         uuid primary key default gen_random_uuid(),
  owner_id   uuid not null default auth.uid() references public.profiles (id) on delete cascade,
  name       text not null check (length(trim(name)) between 1 and 40),
  filters    jsonb not null default '{}'::jsonb,
  is_shared  boolean not null default false,
  created_at timestamptz not null default now()
);
create index if not exists alumni_saved_filters_owner_idx on public.alumni_saved_filters (owner_id);
alter table public.alumni_saved_filters enable row level security;
drop policy if exists "alumni saved filters: read" on public.alumni_saved_filters;
create policy "alumni saved filters: read" on public.alumni_saved_filters
  for select to authenticated
  using ((select public.alumni_can('view')) and (owner_id = (select auth.uid()) or is_shared));
drop policy if exists "alumni saved filters: add" on public.alumni_saved_filters;
create policy "alumni saved filters: add" on public.alumni_saved_filters
  for insert to authenticated
  with check ((select public.alumni_can('view')) and owner_id = (select auth.uid())
              and (not is_shared or (select public.alumni_can('manage'))));
drop policy if exists "alumni saved filters: change" on public.alumni_saved_filters;
create policy "alumni saved filters: change" on public.alumni_saved_filters
  for update to authenticated
  using (owner_id = (select auth.uid()))
  with check (owner_id = (select auth.uid()) and (not is_shared or (select public.alumni_can('manage'))));
drop policy if exists "alumni saved filters: remove" on public.alumni_saved_filters;
create policy "alumni saved filters: remove" on public.alumni_saved_filters
  for delete to authenticated
  using (owner_id = (select auth.uid()) or (is_shared and (select public.alumni_can('manage'))));
grant select, insert, update, delete on public.alumni_saved_filters to authenticated;

-- ---------------------------------------------------------------------
-- 9. Home: my alumni to contact today (+ birthdays)
-- ---------------------------------------------------------------------
create or replace function public.alumni_today(p_limit integer default 5)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_end timestamptz := ((now() at time zone 'Asia/Dhaka')::date + 1)::timestamp at time zone 'Asia/Dhaka';
  v_today date := (now() at time zone 'Asia/Dhaka')::date;
  v_manage boolean := public.alumni_can('manage');
begin
  if not public.alumni_can('view') then return null; end if;
  return jsonb_build_object(
    'due', (select count(*) from public.alumni a
            where a.deleted_at is null and a.next_contact_at < v_end
              and (a.owner_id = auth.uid() or (a.owner_id is null and (a.next_contact_by = auth.uid() or v_manage)))),
    'list', coalesce((select jsonb_agg(x) from (
              select a.id, a.name, a.phone, a.next_contact_at, a.next_contact_note, b.name as batch_name,
                     a.next_contact_at < now() as late
              from public.alumni a left join public.batches b on b.id = a.batch_id
              where a.deleted_at is null and a.next_contact_at < v_end
                and (a.owner_id = auth.uid() or (a.owner_id is null and (a.next_contact_by = auth.uid() or v_manage)))
              order by a.next_contact_at
              limit greatest(1, least(coalesce(p_limit, 5), 50))) x), '[]'::jsonb),
    'birthdays', coalesce((select jsonb_agg(jsonb_build_object('id', a.id, 'name', a.name, 'phone', a.phone)) from public.alumni a
              where a.deleted_at is null and a.birth_date is not null and not a.do_not_contact
                and extract(month from a.birth_date) = extract(month from v_today)
                and extract(day from a.birth_date) = extract(day from v_today)
                and (a.owner_id = auth.uid() or (a.owner_id is null and v_manage))), '[]'::jsonb));
end;
$$;
revoke all on function public.alumni_today(integer) from public, anon;
grant execute on function public.alumni_today(integer) to authenticated;

-- ⏰ Reminders (every 5 minutes): a next contact that is due, and birthdays from 9 am
create or replace function public.alumni_reminders_tick()
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_set jsonb := coalesce(public.alumni_setting() -> 'reminders', '{}'::jsonb);
  v_now_dhaka timestamp := now() at time zone 'Asia/Dhaka';
  r record;
  m uuid;
begin
  if coalesce((v_set ->> 'next_contact')::boolean, true) then
    for r in
      select a.id, a.name, a.next_contact_at, a.next_contact_note, coalesce(a.owner_id, a.next_contact_by) as who
      from public.alumni a
      where a.deleted_at is null and a.next_contact_at <= now() and a.next_contact_at > now() - interval '1 day'
        and coalesce(a.owner_id, a.next_contact_by) is not null
    loop
      perform public.notify(r.who, 'alumni', '📞 Contact ' || r.name || ' now',
        coalesce(r.next_contact_note, 'The next contact you set for this alumnus is due.'),
        jsonb_build_object('route', '/alumni/' || r.id),
        'alumni_next:' || r.id || ':' || extract(epoch from r.next_contact_at)::bigint);
    end loop;
  end if;

  if coalesce((v_set ->> 'birthdays')::boolean, true) and extract(hour from v_now_dhaka) >= 9 then
    for r in
      select a.id, a.name, a.owner_id
      from public.alumni a
      where a.deleted_at is null and a.birth_date is not null and not a.do_not_contact
        and extract(month from a.birth_date) = extract(month from v_now_dhaka)
        and extract(day from a.birth_date) = extract(day from v_now_dhaka)
    loop
      for m in select unnest(case when r.owner_id is null then array(select public.alumni_managers())
                                  else array[r.owner_id] end)
      loop
        perform public.notify(m, 'alumni', '🎂 ' || r.name || '’s birthday today',
          'Send a wish? A warm word keeps alumni close.',
          jsonb_build_object('route', '/alumni/' || r.id),
          'alumni_bday:' || r.id || ':' || extract(year from v_now_dhaka)::int);
      end loop;
    end loop;
  end if;
end;
$$;
revoke all on function public.alumni_reminders_tick() from public, anon, authenticated;

do $$
begin
  if exists (select 1 from pg_extension where extname = 'pg_cron') then
    perform cron.unschedule('alumni-reminders') where exists (select 1 from cron.job where jobname = 'alumni-reminders');
    perform cron.schedule('alumni-reminders', '*/5 * * * *', 'select public.alumni_reminders_tick()');
  end if;
end $$;

-- ---------------------------------------------------------------------
-- 10. Call log sync: a call with an alumnus' number lands on the alumnus
--     (a lead with the same number comes first, as before)
-- ---------------------------------------------------------------------
-- Called by sync_phone_calls (security invoker), so it is executable by the app;
-- it checks who is asking and that the alumnus is visible
create or replace function public.alumni_record_phone_call(p_alumni uuid, p_device_id text, p_call jsonb, p_outcome text)
returns text
language plpgsql
security definer
set search_path = public
as $$
declare
  v_at    timestamptz := (p_call ->> 'called_at')::timestamptz;
  v_dir   text := coalesce(p_call ->> 'direction', 'outgoing');
  v_dur   int := greatest(coalesce((p_call ->> 'duration_sec')::int, 0), 0);
  v_match uuid;
  v_id    uuid;
begin
  if auth.uid() is null or not public.alumni_can('view') then return 'ignored'; end if;
  if not exists (select 1 from public.alumni where id = p_alumni and deleted_at is null) then return 'ignored'; end if;

  -- saved from the app popup a few minutes around this time? that row gets the phone's details
  select e.id into v_match
  from public.alumni_events e
  where e.alumni_id = p_alumni and e.by_user = auth.uid() and e.kind = 'call' and e.device_call_id is null
    and e.source = 'app'
    and e.happened_at between v_at - interval '10 minutes' and v_at + interval '10 minutes'
  order by abs(extract(epoch from (e.happened_at - v_at)))
  limit 1;
  if v_match is not null then
    update public.alumni_events set device_id = p_device_id, device_call_id = p_call ->> 'id',
      duration_sec = v_dur, direction = v_dir, sim_label = p_call ->> 'sim', happened_at = v_at
    where id = v_match;
    return 'matched';
  end if;

  insert into public.alumni_events (alumni_id, kind, by_user, happened_at, outcome, direction, duration_sec,
                                    channel, source, device_id, device_call_id, sim_label)
  values (p_alumni, 'call', auth.uid(), v_at, p_outcome, v_dir, v_dur, 'phone', 'phone', p_device_id,
          p_call ->> 'id', p_call ->> 'sim')
  on conflict (by_user, device_id, device_call_id) where device_call_id is not null do nothing
  returning id into v_id;
  return case when v_id is null then 'ignored' else 'added' end;
end;
$$;
revoke all on function public.alumni_record_phone_call(uuid, text, jsonb, text) from public, anon;
grant execute on function public.alumni_record_phone_call(uuid, text, jsonb, text) to authenticated;

create or replace function public.sync_phone_calls(p_device_id text, p_calls jsonb)
returns jsonb
language plpgsql
security invoker
set search_path = public, extensions
as $$
declare
  v_cfg      jsonb := public.call_sync_setting();
  v_min      int := coalesce((v_cfg->>'connected_min_sec')::int, 5);
  v_incoming boolean := coalesce((v_cfg->>'incoming')::boolean, true);
  v_alumni_on boolean := public.alumni_can('view');
  v_call     jsonb;
  v_hash     text;
  v_lead     uuid;
  v_alum     uuid;
  v_dir      text;
  v_dur      int;
  v_at       timestamptz;
  v_outcome  text;
  v_match    uuid;
  v_res      text;
  v_added    int := 0;
  v_matched  int := 0;
  v_ignored  int := 0;
begin
  if not public.can_sync_calls() then
    raise exception 'Call log sync is not turned on for you.';
  end if;

  for v_call in select * from jsonb_array_elements(coalesce(p_calls, '[]'::jsonb))
  loop
    v_dir  := coalesce(v_call->>'direction', 'outgoing');
    v_dur  := greatest(coalesce((v_call->>'duration_sec')::int, 0), 0);
    v_at   := (v_call->>'called_at')::timestamptz;
    v_hash := v_call->>'hash';

    -- Incoming / missed calls switched off in Settings
    if v_dir <> 'outgoing' and not v_incoming then
      v_ignored := v_ignored + 1;
      continue;
    end if;

    -- Already synced from this phone
    if exists (
      select 1 from public.call_logs
      where user_id = auth.uid() and device_id = p_device_id and device_call_id = v_call->>'id'
    ) then
      continue;
    end if;

    v_outcome := case
      when v_dir = 'outgoing' then case when v_dur >= v_min then 'connected' else 'no_answer' end
      when v_dir = 'incoming' then case when v_dur > 0 then 'connected' else 'missed' end
      else v_dir   -- missed / rejected
    end;

    -- A lead this user can see, with this number (row security decides what "can see" means)
    select x.id into v_lead
    from (
      select l.id, l.created_at from public.leads l
      where l.phone_hash = v_hash and l.deleted_at is null
      union all
      select l.id, l.created_at from public.leads l
      where l.alt_phone_hash = v_hash and l.deleted_at is null
    ) x
    order by x.created_at desc
    limit 1;

    if v_lead is null then
      -- 🎓 An alumnus with this number?
      v_alum := null;
      if v_alumni_on and v_hash is not null then
        select a.id into v_alum from public.alumni a
        where (a.phone_hash = v_hash or a.wa_hash = v_hash) and a.deleted_at is null
        order by a.created_at desc limit 1;
      end if;
      if v_alum is not null then
        v_res := public.alumni_record_phone_call(v_alum, p_device_id, v_call, v_outcome);
        if v_res = 'added' then v_added := v_added + 1;
        elsif v_res = 'matched' then v_matched := v_matched + 1;
        else v_ignored := v_ignored + 1; end if;
        continue;
      end if;

      -- Not a lead (yet): kept for a few days in case it is saved as a lead
      -- (only the number's hash, time and length; see hold_call)
      perform public.hold_call(p_device_id, v_call->>'id', v_hash, v_dir, v_dur, v_at, v_call->>'sim');
      v_ignored := v_ignored + 1;
      continue;
    end if;

    -- A call saved from the app popup a few minutes around this time? Match it instead.
    select c.id into v_match
    from public.call_logs c
    where c.user_id = auth.uid()
      and c.lead_id = v_lead
      and c.device_call_id is null
      and c.called_at between v_at - interval '10 minutes' and v_at + interval '10 minutes'
    order by abs(extract(epoch from (c.called_at - v_at)))
    limit 1;

    if v_match is not null then
      update public.call_logs
         set device_id = p_device_id,
             device_call_id = v_call->>'id',
             duration_sec = v_dur,
             direction = v_dir,
             sim_label = v_call->>'sim',
             phone_verified = true
       where id = v_match;
      v_matched := v_matched + 1;
      continue;
    end if;

    insert into public.call_logs (
      lead_id, user_id, called_at, outcome, duration_sec, notes,
      direction, source, device_id, device_call_id, sim_label, phone_verified
    )
    values (
      v_lead, auth.uid(), v_at, v_outcome, v_dur, null,
      v_dir, 'phone', p_device_id, v_call->>'id', v_call->>'sim', true
    )
    on conflict do nothing;

    v_added := v_added + 1;
  end loop;

  return jsonb_build_object('added', v_added, 'matched', v_matched, 'ignored', v_ignored);
end;
$$;
grant execute on function public.sync_phone_calls(text, jsonb) to authenticated;

-- 💬 WhatsApp calls / messages: the phone's directory also knows alumni (their id comes as lead_id)
create or replace function public.alumni_record_whatsapp(p_alumni uuid, p_device_id text, p_e jsonb)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  v_media   text := coalesce(p_e ->> 'media', 'voice');
  v_dir     text := coalesce(p_e ->> 'direction', 'incoming');
  v_dur     int := greatest(coalesce((p_e ->> 'duration_sec')::int, 0), 0);
  v_at      timestamptz := coalesce(nullif(p_e ->> 'called_at', '')::timestamptz, now());
  v_outcome text;
  v_id      uuid;
begin
  if auth.uid() is null or not public.alumni_can('view') then return false; end if;
  if not exists (select 1 from public.alumni where id = p_alumni and deleted_at is null) then return false; end if;
  if v_media not in ('voice', 'video', 'message') or v_dir not in ('outgoing', 'incoming', 'missed')
     or nullif(p_e ->> 'id', '') is null then
    return false;
  end if;
  v_outcome := case
    when v_media = 'message' then 'message'
    when v_dir = 'missed' then 'missed'
    when coalesce((p_e ->> 'connected')::boolean, false) then 'connected'
    when v_dir = 'incoming' then 'missed'
    else 'no_answer'
  end;
  if v_media <> 'message' and v_dir = 'incoming' and v_outcome = 'missed' then v_dir := 'missed'; end if;
  -- already written by hand in the app within 15 minutes
  if v_media <> 'message' and exists (
    select 1 from public.alumni_events e
    where e.alumni_id = p_alumni and e.by_user = auth.uid() and e.kind = 'whatsapp' and e.source = 'app'
      and coalesce(e.outcome, '') <> 'message'
      and e.happened_at between v_at - interval '15 minutes' and v_at + interval '15 minutes') then
    return false;
  end if;
  insert into public.alumni_events (alumni_id, kind, by_user, happened_at, outcome, direction, duration_sec,
                                    channel, media, source, device_id, device_call_id)
  values (p_alumni, 'whatsapp', auth.uid(), v_at, v_outcome,
          case when v_media = 'message' and v_dir = 'missed' then 'incoming' else v_dir end,
          case when v_outcome = 'connected' then v_dur end, 'whatsapp', v_media, 'whatsapp',
          p_device_id, 'wa:' || (p_e ->> 'id'))
  on conflict (by_user, device_id, device_call_id) where device_call_id is not null do nothing
  returning id into v_id;
  return v_id is not null;
end;
$$;
revoke all on function public.alumni_record_whatsapp(uuid, text, jsonb) from public, anon;
grant execute on function public.alumni_record_whatsapp(uuid, text, jsonb) to authenticated;

create or replace function public.sync_whatsapp_events(p_device_id text, p_events jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid     uuid := auth.uid();
  v_e       jsonb;
  v_lead    uuid;
  v_media   text;
  v_dir     text;
  v_outcome text;
  v_dur     int;
  v_id      uuid;
  v_added   int := 0;
  v_ignored int := 0;
begin
  if v_uid is null or not public.is_active_user() then
    raise exception 'Your account is not active.';
  end if;
  if not public.can_sync_calls() then
    raise exception 'Call sync is turned off for you.';
  end if;
  if nullif(trim(coalesce(p_device_id, '')), '') is null then
    raise exception 'Unknown phone.';
  end if;

  for v_e in select * from jsonb_array_elements(coalesce(p_events, '[]'::jsonb))
  loop
    begin
      v_lead  := nullif(v_e->>'lead_id', '')::uuid;
      v_media := coalesce(v_e->>'media', 'voice');
      v_dir   := coalesce(v_e->>'direction', 'incoming');
      v_dur   := greatest(coalesce((v_e->>'duration_sec')::int, 0), 0);
    exception when others then
      v_ignored := v_ignored + 1;
      continue;
    end;

    -- 🎓 the id is an alumnus (the directory has alumni too)
    if v_lead is not null and not exists (select 1 from public.leads where id = v_lead)
       and exists (select 1 from public.alumni where id = v_lead) then
      if public.alumni_record_whatsapp(v_lead, p_device_id, v_e) then v_added := v_added + 1;
      else v_ignored := v_ignored + 1; end if;
      continue;
    end if;

    if v_lead is null
       or v_media not in ('voice', 'video', 'message')
       or v_dir not in ('outgoing', 'incoming', 'missed')
       or nullif(v_e->>'id', '') is null
       or not exists (
         select 1 from public.leads l
         where l.id = v_lead and l.deleted_at is null and public.can_view_lead(l.assigned_to)
       ) then
      v_ignored := v_ignored + 1;
      continue;
    end if;

    v_outcome := case
      when v_media = 'message' then 'message'
      when v_dir = 'missed' then 'missed'
      when coalesce((v_e->>'connected')::boolean, false) then 'connected'
      when v_dir = 'incoming' then 'missed'
      else 'no_answer'
    end;
    -- An incoming call nobody answered is a missed call
    if v_media <> 'message' and v_dir = 'incoming' and v_outcome = 'missed' then
      v_dir := 'missed';
    end if;

    -- Already written by hand in the app (the "What happened on WhatsApp?" popup)
    -- within 15 minutes: keep that one, skip this
    if v_media <> 'message' and exists (
      select 1 from public.call_logs c
      where c.lead_id = v_lead and c.user_id = v_uid
        and c.channel = 'whatsapp' and c.source = 'app' and c.outcome <> 'message'
        and c.called_at between coalesce(nullif(v_e->>'called_at', '')::timestamptz, now()) - interval '15 minutes'
                            and coalesce(nullif(v_e->>'called_at', '')::timestamptz, now()) + interval '15 minutes'
    ) then
      v_ignored := v_ignored + 1;
      continue;
    end if;

    v_id := null;
    insert into public.call_logs (
      lead_id, user_id, called_at, outcome, duration_sec,
      direction, source, channel, media, device_id, device_call_id, phone_verified
    ) values (
      v_lead, v_uid,
      coalesce(nullif(v_e->>'called_at', '')::timestamptz, now()),
      v_outcome,
      case when v_outcome = 'connected' then v_dur else null end,
      case when v_media = 'message' and v_dir = 'missed' then 'incoming' else v_dir end,
      'whatsapp', 'whatsapp', v_media, p_device_id, 'wa:' || (v_e->>'id'), true
    )
    on conflict (user_id, device_id, device_call_id) where device_call_id is not null do nothing
    returning id into v_id;

    if v_id is not null then v_added := v_added + 1; else v_ignored := v_ignored + 1; end if;
  end loop;

  return jsonb_build_object('added', v_added, 'ignored', v_ignored);
end;
$$;
revoke all on function public.sync_whatsapp_events(text, jsonb) from public;
grant execute on function public.sync_whatsapp_events(text, jsonb) to authenticated;

-- 📇 The phone's directory (caller card, "add a note" alerts): alumni too.
--   An alumnus' id goes in lead_id; the app opens /leads/<id>, which sends it
--   on to the alumnus. A lead with the same number wins.
create or replace function public.my_lead_directory()
returns table (hash text, lead_id uuid, name text, rating text, stage text, course text, last_note text,
               student_ref text, fee_due numeric, next_call timestamptz, owner text)
language sql
stable
security invoker
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
           v.next_follow_up_at as next_call, v.owner, k.key
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
           a.next_contact_at, a.owner, k.key
    from alum a
    cross join lateral (values (a.phone), (a.whatsapp_number)) as k(key)
    where k.key is not null
  )
  select distinct on (encode(digest(k.key, 'sha256'), 'hex'))
         encode(digest(k.key, 'sha256'), 'hex'), k.id, k.name, k.rating, k.stage, k.course, left(k.last_note, 120),
         k.student_ref, k.fee_due, k.next_call, k.owner
  from keys k
  order by encode(digest(k.key, 'sha256'), 'hex'), k.prio;
$$;
grant execute on function public.my_lead_directory() to authenticated;

notify pgrst, 'reload schema';
