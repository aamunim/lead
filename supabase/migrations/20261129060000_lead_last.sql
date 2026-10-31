-- =====================================================================
-- 📞📝 The last call and the last note of every lead, for the lists
--   lead_last: one row per lead, kept up to date by the database, so the
--   Leads / Students lists and the board show them without extra queries.
--   Last call: the newest call (phone or WhatsApp) that is not deleted.
--   Last note: the newest of a call's note, a note added to the lead (still
--   in its notes), and a 🎙 voice note. Only the first 200 letters are kept
--   here; the whole note is on the lead page.
--   Kept in its own table (not on leads) so the lead's own rules and change
--   log are never touched.
-- =====================================================================

create table if not exists public.lead_last (
  lead_id             uuid primary key references public.leads(id) on delete cascade,
  call_id             uuid,
  call_at             timestamptz,
  call_outcome        text,
  call_direction      text,
  call_channel        text,
  call_media          text,
  call_duration_sec   integer,
  call_by             uuid,
  note_at             timestamptz,
  note_text           text,          -- first 200 letters (null for a voice note)
  note_more           boolean not null default false,
  note_by             uuid,
  note_kind           text,          -- 'call' | 'note' | 'voice'
  note_voice_file     uuid,
  note_voice_sec      integer,
  updated_at          timestamptz not null default now()
);

alter table public.lead_last enable row level security;
grant select on public.lead_last to authenticated;

-- Same people who can see the lead (the lead's own row security decides)
drop policy if exists "lead_last: view for visible leads" on public.lead_last;
create policy "lead_last: view for visible leads" on public.lead_last for select to authenticated
  using (exists (select 1 from public.leads l where l.id = lead_last.lead_id));

-- ---------------------------------------------------------------------
-- Work it out again for one lead
-- ---------------------------------------------------------------------
create or replace function public.refresh_lead_last(p_lead uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  c record;
  n record;
begin
  if p_lead is null then return; end if;

  select id, called_at, outcome, direction, channel, media, duration_sec, user_id
    into c
  from public.call_logs
  where lead_id = p_lead and deleted_at is null
  order by called_at desc
  limit 1;

  select * into n from (
    select cl.called_at as at, cl.notes as body, cl.user_id as by_user, 'call'::text as kind,
           null::uuid as file_id, null::int as voice_sec
    from public.call_logs cl
    where cl.lead_id = p_lead and cl.deleted_at is null and nullif(trim(cl.notes), '') is not null
    union all
    select a.created_at, a.details->>'note', a.user_id, 'note', null, null
    from public.lead_activity a
    join public.leads l on l.id = a.lead_id
    where a.lead_id = p_lead and a.action = 'note_added'
      and nullif(trim(a.details->>'note'), '') is not null
      and position(a.details->>'note' in coalesce(l.notes, '')) > 0   -- not deleted since
    union all
    select f.created_at, null, f.uploaded_by, 'voice', f.id, f.duration_sec
    from public.lead_files f
    where f.lead_id = p_lead and f.kind = 'voice' and f.context is not null and f.deleted_at is null
  ) x
  order by at desc
  limit 1;

  insert into public.lead_last as t (
    lead_id, call_id, call_at, call_outcome, call_direction, call_channel, call_media, call_duration_sec, call_by,
    note_at, note_text, note_more, note_by, note_kind, note_voice_file, note_voice_sec, updated_at
  )
  values (
    p_lead, c.id, c.called_at, c.outcome, c.direction, c.channel, c.media, c.duration_sec, c.user_id,
    n.at, left(regexp_replace(trim(n.body), '\s+', ' ', 'g'), 200), coalesce(length(trim(n.body)) > 200, false),
    n.by_user, n.kind, n.file_id, n.voice_sec, now()
  )
  on conflict (lead_id) do update set
    call_id = excluded.call_id, call_at = excluded.call_at, call_outcome = excluded.call_outcome,
    call_direction = excluded.call_direction, call_channel = excluded.call_channel, call_media = excluded.call_media,
    call_duration_sec = excluded.call_duration_sec, call_by = excluded.call_by,
    note_at = excluded.note_at, note_text = excluded.note_text, note_more = excluded.note_more,
    note_by = excluded.note_by, note_kind = excluded.note_kind, note_voice_file = excluded.note_voice_file,
    note_voice_sec = excluded.note_voice_sec, updated_at = now();
end;
$$;

revoke execute on function public.refresh_lead_last(uuid) from public, anon, authenticated;

-- ---------------------------------------------------------------------
-- Triggers: calls, notes added / deleted / edited, voice notes, lead notes
-- ---------------------------------------------------------------------
create or replace function public.lead_last_from_call()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if tg_op = 'DELETE' then
    perform public.refresh_lead_last(old.lead_id);
    return null;
  end if;
  perform public.refresh_lead_last(new.lead_id);
  if tg_op = 'UPDATE' and old.lead_id is distinct from new.lead_id then
    perform public.refresh_lead_last(old.lead_id);
  end if;
  return null;
end;
$$;

drop trigger if exists lead_last_calls on public.call_logs;
create trigger lead_last_calls
  after insert or update of lead_id, called_at, outcome, direction, duration_sec, notes, deleted_at or delete
  on public.call_logs
  for each row execute function public.lead_last_from_call();

create or replace function public.lead_last_from_activity()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if new.action in ('note_added', 'note_deleted', 'note_edited', 'entry_restored') then
    perform public.refresh_lead_last(new.lead_id);
  end if;
  return null;
end;
$$;

drop trigger if exists lead_last_activity on public.lead_activity;
create trigger lead_last_activity
  after insert on public.lead_activity
  for each row execute function public.lead_last_from_activity();

create or replace function public.lead_last_from_file()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if new.kind = 'voice' then
    perform public.refresh_lead_last(new.lead_id);
  end if;
  return null;
end;
$$;

drop trigger if exists lead_last_files on public.lead_files;
create trigger lead_last_files
  after insert or update of deleted_at on public.lead_files
  for each row execute function public.lead_last_from_file();

-- A note typed or removed on the edit screen
create or replace function public.lead_last_from_lead()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  perform public.refresh_lead_last(new.id);
  return null;
end;
$$;

drop trigger if exists lead_last_lead_notes on public.leads;
create trigger lead_last_lead_notes
  after update of notes on public.leads
  for each row
  when (old.notes is distinct from new.notes)
  execute function public.lead_last_from_lead();

-- ---------------------------------------------------------------------
-- Fill it for the leads already there
-- ---------------------------------------------------------------------
do $$
declare
  v uuid;
begin
  for v in
    select distinct lead_id from public.call_logs
    union
    select distinct lead_id from public.lead_activity where action = 'note_added'
    union
    select distinct lead_id from public.lead_files where kind = 'voice'
  loop
    perform public.refresh_lead_last(v);
  end loop;
end;
$$;

-- ---------------------------------------------------------------------
-- Setting: after how many days without contact the card turns orange
-- ---------------------------------------------------------------------
insert into public.app_settings (key, value)
values ('lead_cards', jsonb_build_object('stale_days', 7))
on conflict (key) do nothing;

notify pgrst, 'reload schema';
