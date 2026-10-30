-- =====================================================================
-- Deleting calls, WhatsApp entries and notes written by hand
--   Who: Admins (leads.edit_all) any; the person who wrote it, within 24 hours.
--   What: only entries written in the app (not calls read from the phone's
--   call log or from WhatsApp).
--   How: calls are hidden, not erased (deleted_at), so reports, the lead page
--   and the phone sync all leave them out; notes are taken out of the lead's
--   notes. Every delete is in the change log, with what was deleted.
--   Undo: the person who deleted, for 10 minutes; Admins any time (Restore).
-- =====================================================================

-- ---------------------------------------------------------------------
-- 1. Hidden calls
-- ---------------------------------------------------------------------
alter table public.call_logs
  add column if not exists deleted_at    timestamptz,
  add column if not exists deleted_by    uuid references public.profiles(id) on delete set null,
  add column if not exists delete_reason text;

-- Nobody sees a deleted call (lead page, reports, WhatsApp list, directory)
drop policy if exists "call_logs: view for visible leads" on public.call_logs;
create policy "call_logs: view for visible leads"
  on public.call_logs for select
  to authenticated
  using (
    public.is_active_user()
    and deleted_at is null
    and exists (select 1 from public.leads l where l.id = call_logs.lead_id)
  );

-- The delete / restore functions may change a call; the app itself still can't
-- (replaces the version in 20261024150515)
create or replace function public.guard_call_log_update()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  if auth.uid() is null then return new; end if;   -- database tools
  if coalesce(current_setting('app.call_admin', true), '') = 'on' then return new; end if;

  -- Never changes
  if new.lead_id    is distinct from old.lead_id
     or new.user_id    is distinct from old.user_id
     or new.outcome    is distinct from old.outcome
     or new.called_at  is distinct from old.called_at
     or new.created_at is distinct from old.created_at
     or new.deleted_at is distinct from old.deleted_at then
    raise exception 'Call history cannot be changed.';
  end if;

  -- Note: may be added once, within 24 hours of the call
  if new.notes is distinct from old.notes
     and (old.notes is not null or old.called_at < now() - interval '24 hours') then
    raise exception 'A note can only be added once, within 24 hours of the call.';
  end if;

  -- Phone details: only while the call isn't matched to the phone yet
  if old.device_call_id is not null and (
       new.device_id      is distinct from old.device_id
       or new.device_call_id is distinct from old.device_call_id
       or new.duration_sec   is distinct from old.duration_sec
       or new.direction      is distinct from old.direction
       or new.sim_label      is distinct from old.sim_label
       or new.phone_verified is distinct from old.phone_verified) then
    raise exception 'Call history cannot be changed.';
  end if;

  return new;
end;
$$;

-- ---------------------------------------------------------------------
-- 2. Helpers
-- ---------------------------------------------------------------------
-- May I delete this entry? (admins any; the writer within 24 hours)
create or replace function public.can_delete_entry(p_writer uuid, p_written_at timestamptz)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select public.is_active_user() and (
    public.has_permission('leads.edit_all')
    or (p_writer = auth.uid() and p_written_at > now() - interval '24 hours')
  );
$$;

grant execute on function public.can_delete_entry(uuid, timestamptz) to authenticated;

-- "Last contacted" again from the calls that are left
create or replace function public.refresh_last_contacted(p_lead_id uuid)
returns void
language sql
security definer
set search_path = public
as $$
  update public.leads l
     set last_contacted_at = (
       select max(c.called_at) from public.call_logs c
       where c.lead_id = l.id and c.deleted_at is null
         and (c.direction = 'outgoing' or c.outcome = 'connected')
     )
   where l.id = p_lead_id;
$$;

-- The text of a stamped note: "26 Oct 2026 · Rahim: Asked for the fee list" → "Asked for the fee list"
create or replace function public.note_text_of(p_block text)
returns text
language sql
immutable
as $$
  select coalesce(
    (regexp_match(p_block, '^\d{1,2} [A-Z][a-z]{2} \d{4} · [^:\n]+: (.*)$', 's'))[1],
    p_block
  );
$$;

-- The lead's notes without one note (the first exact match):
-- null = not found, '' = found and nothing is left
create or replace function public.notes_without(p_notes text, p_block text)
returns text
language plpgsql
immutable
as $$
declare
  v_parts text[] := regexp_split_to_array(coalesce(p_notes, ''), '\n\s*\n');
  v_out   text[] := '{}';
  v_found boolean := false;
  v_part  text;
begin
  foreach v_part in array v_parts loop
    if not v_found and trim(v_part) = trim(p_block) then
      v_found := true;
    elsif trim(v_part) <> '' then
      v_out := v_out || trim(v_part);
    end if;
  end loop;
  if not v_found then return null; end if;
  return array_to_string(v_out, E'\n\n');
end;
$$;

-- Change the notes without the automatic "Notes edited" line
create or replace function public.set_notes_quietly(p_lead_id uuid, p_notes text)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  update public.leads set notes = p_notes where id = p_lead_id;
  delete from public.lead_activity
   where lead_id = p_lead_id and action = 'note_edited' and created_at = now();
end;
$$;

revoke all on function public.refresh_last_contacted(uuid) from public;
revoke all on function public.set_notes_quietly(uuid, text) from public;

-- ---------------------------------------------------------------------
-- 3. Delete
-- ---------------------------------------------------------------------
-- A call or WhatsApp entry written in the app
create or replace function public.delete_call_log(p_call_id uuid, p_reason text default null)
returns uuid   -- the change-log line (for Undo)
language plpgsql
security definer
set search_path = public
as $$
declare
  c     public.call_logs;
  v_act uuid;
begin
  select * into c from public.call_logs where id = p_call_id and deleted_at is null;
  if not found then raise exception 'This entry was not found.'; end if;
  if c.source <> 'app' or c.device_call_id is not null then
    raise exception 'Calls read from the phone or from WhatsApp can''t be deleted.';
  end if;
  if not public.can_delete_entry(c.user_id, c.created_at) then
    raise exception 'You can delete only your own entries, within 24 hours.';
  end if;

  perform set_config('app.call_admin', 'on', true);
  update public.call_logs
     set deleted_at = now(), deleted_by = auth.uid(), delete_reason = nullif(trim(coalesce(p_reason, '')), '')
   where id = c.id;
  perform set_config('app.call_admin', '', true);

  perform public.refresh_last_contacted(c.lead_id);

  insert into public.lead_activity (lead_id, user_id, action, details)
  values (c.lead_id, auth.uid(), 'call_deleted', jsonb_build_object(
    'call_id', c.id, 'outcome', c.outcome, 'direction', c.direction,
    'channel', c.channel, 'media', c.media, 'called_at', c.called_at,
    'note', left(c.notes, 300), 'by', c.user_id,
    'reason', nullif(trim(coalesce(p_reason, '')), '')))
  returning id into v_act;
  return v_act;
end;
$$;

-- Only the note of a call
create or replace function public.delete_call_note(p_call_id uuid, p_reason text default null)
returns uuid   -- the change-log line (for Undo)
language plpgsql
security definer
set search_path = public
as $$
declare
  c     public.call_logs;
  v_act uuid;
begin
  select * into c from public.call_logs where id = p_call_id and deleted_at is null;
  if not found or c.notes is null then raise exception 'This note was not found.'; end if;
  -- (a note is always written by hand, also on calls read from the phone)
  if not public.can_delete_entry(c.user_id, c.created_at) then
    raise exception 'You can delete only your own notes, within 24 hours.';
  end if;

  perform set_config('app.call_admin', 'on', true);
  update public.call_logs set notes = null where id = c.id;
  perform set_config('app.call_admin', '', true);

  insert into public.lead_activity (lead_id, user_id, action, details)
  values (c.lead_id, auth.uid(), 'call_note_deleted', jsonb_build_object(
    'call_id', c.id, 'note', c.notes, 'channel', c.channel,
    'reason', nullif(trim(coalesce(p_reason, '')), '')))
  returning id into v_act;
  return v_act;
end;
$$;

-- One note of the lead (as shown in "Calls & notes")
create or replace function public.delete_lead_note(p_lead_id uuid, p_block text, p_reason text default null)
returns uuid   -- the change-log line (for Undo)
language plpgsql
security definer
set search_path = public
as $$
declare
  l       public.leads;
  v_rest  text;
  v_text  text := public.note_text_of(trim(coalesce(p_block, '')));
  v_mine  boolean;
  v_act   uuid;
begin
  select * into l from public.leads where id = p_lead_id and deleted_at is null;
  if not found or not public.can_view_lead(l.assigned_to) then raise exception 'Lead not found.'; end if;

  v_rest := public.notes_without(l.notes, p_block);
  if v_rest is null then
    raise exception 'This note was not found. Pull down to refresh.';
  end if;

  -- Mine = I added it with the Note option in the last 24 hours
  v_mine := exists (
    select 1 from public.lead_activity a
    where a.lead_id = l.id and a.action = 'note_added' and a.user_id = auth.uid()
      and a.details->>'note' = v_text and a.created_at > now() - interval '24 hours'
  );
  if not (public.has_permission('leads.edit_all') or (public.is_active_user() and v_mine)) then
    raise exception 'You can delete only your own notes, within 24 hours.';
  end if;

  perform public.set_notes_quietly(l.id, nullif(v_rest, ''));

  insert into public.lead_activity (lead_id, user_id, action, details)
  values (l.id, auth.uid(), 'note_deleted', jsonb_build_object(
    'block', trim(p_block), 'note', left(v_text, 300),
    'reason', nullif(trim(coalesce(p_reason, '')), '')))
  returning id into v_act;
  return v_act;
end;
$$;

-- ---------------------------------------------------------------------
-- 4. Restore (Undo): the person who deleted, for 10 minutes; admins any time
--    p_activity_id: the change-log line of the delete
-- ---------------------------------------------------------------------
create or replace function public.restore_deleted(p_activity_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  a public.lead_activity;
  d jsonb;
begin
  select * into a from public.lead_activity where id = p_activity_id;
  if not found or a.action not in ('call_deleted', 'call_note_deleted', 'note_deleted') then
    raise exception 'Nothing to restore.';
  end if;
  d := a.details;
  if d ? 'restored_at' then raise exception 'Already restored.'; end if;
  if not (
    public.has_permission('leads.edit_all')
    or (a.user_id = auth.uid() and a.created_at > now() - interval '10 minutes' and public.is_active_user())
  ) then
    raise exception 'Only an admin can restore this.';
  end if;

  perform set_config('app.call_admin', 'on', true);
  if a.action = 'call_deleted' then
    update public.call_logs set deleted_at = null, deleted_by = null, delete_reason = null
     where id = (d->>'call_id')::uuid;
    perform public.refresh_last_contacted(a.lead_id);
  elsif a.action = 'call_note_deleted' then
    update public.call_logs set notes = coalesce(notes, d->>'note') where id = (d->>'call_id')::uuid;
  else
    perform public.set_notes_quietly(
      a.lead_id,
      (select concat_ws(E'\n\n', nullif(trim(notes), ''), d->>'block') from public.leads where id = a.lead_id)
    );
  end if;
  perform set_config('app.call_admin', '', true);

  update public.lead_activity
     set details = details || jsonb_build_object('restored_at', now(), 'restored_by', auth.uid())
   where id = a.id;

  insert into public.lead_activity (lead_id, user_id, action, details)
  values (a.lead_id, auth.uid(), 'entry_restored', jsonb_build_object('what', a.action, 'note', d->>'note'));
end;
$$;

grant execute on function public.delete_call_log(uuid, text) to authenticated;
grant execute on function public.delete_call_note(uuid, text) to authenticated;
grant execute on function public.delete_lead_note(uuid, text, text) to authenticated;
grant execute on function public.restore_deleted(uuid) to authenticated;

-- ---------------------------------------------------------------------
-- 5. Team activity leaves deleted calls out
--    (replaces the versions in 20261105060000; same columns)
-- ---------------------------------------------------------------------
create or replace function public.team_activity(p_from date, p_to date)
returns table (
  user_id uuid, name text, role_key text, last_seen_at timestamptz,
  app_sec int, sessions int, calls int, connected int, talk_sec int,
  actions int, admitted int, first_at timestamptz, last_at timestamptz,
  wa_calls int, wa_connected int, wa_messages int
)
language sql
stable
security definer
set search_path = public
as $$
  with people as (
    select p.id, p.full_name, p.role_key
    from public.profiles p
    where p.is_active and public.can_see_activity(p.id)
  ),
  ses as (
    select s.user_id, sum(s.active_sec)::int as app_sec, count(*)::int as n,
           min(s.started_at) as first_at, max(s.last_seen_at) as last_at
    from public.app_sessions s
    where (s.started_at at time zone 'Asia/Dhaka')::date between p_from and p_to
    group by s.user_id
  ),
  cl as (
    select c.user_id,
           count(*) filter (where c.channel = 'phone')::int as calls,
           count(*) filter (where c.channel = 'phone' and c.outcome = 'connected')::int as connected,
           coalesce(sum(c.duration_sec) filter (where c.channel = 'phone' and c.outcome = 'connected'), 0)::int as talk_sec,
           count(*) filter (where c.channel = 'whatsapp' and c.outcome <> 'message')::int as wa_calls,
           count(*) filter (where c.channel = 'whatsapp' and c.outcome = 'connected')::int as wa_connected,
           count(*) filter (where c.channel = 'whatsapp' and c.outcome = 'message')::int as wa_messages,
           min(c.called_at) as first_at, max(c.called_at) as last_at
    from public.call_logs c
    where c.deleted_at is null
      and (c.called_at at time zone 'Asia/Dhaka')::date between p_from and p_to
    group by c.user_id
  ),
  act as (
    select a.user_id, count(*)::int as actions, min(a.created_at) as first_at, max(a.created_at) as last_at
    from public.lead_activity a
    where a.action <> 'call_logged'
      and (a.created_at at time zone 'Asia/Dhaka')::date between p_from and p_to
    group by a.user_id
  ),
  adm as (
    select l.admitted_by as user_id, count(*)::int as admitted
    from public.leads l
    join public.pipeline_stages st on st.id = l.stage_id and st.kind = 'won'
    where l.deleted_at is null
      and (l.admitted_at at time zone 'Asia/Dhaka')::date between p_from and p_to
    group by l.admitted_by
  )
  select p.id, p.full_name, p.role_key,
         (select max(s.last_seen_at) from public.app_sessions s where s.user_id = p.id),
         coalesce(ses.app_sec, 0), coalesce(ses.n, 0),
         coalesce(cl.calls, 0), coalesce(cl.connected, 0), coalesce(cl.talk_sec, 0),
         coalesce(act.actions, 0), coalesce(adm.admitted, 0),
         least(ses.first_at, cl.first_at, act.first_at),
         greatest(ses.last_at, cl.last_at, act.last_at),
         coalesce(cl.wa_calls, 0), coalesce(cl.wa_connected, 0), coalesce(cl.wa_messages, 0)
  from people p
  left join ses on ses.user_id = p.id
  left join cl  on cl.user_id  = p.id
  left join act on act.user_id = p.id
  left join adm on adm.user_id = p.id
  order by p.full_name;
$$;

create or replace function public.user_activity_days(p_user_id uuid, p_days int default 14)
returns table (day date, app_sec int, actions int, calls int, wa int)
language sql
stable
security definer
set search_path = public
as $$
  with days as (
    select generate_series((now() at time zone 'Asia/Dhaka')::date - (least(greatest(p_days, 1), 90) - 1),
                           (now() at time zone 'Asia/Dhaka')::date, interval '1 day')::date as day
  )
  select d.day,
         coalesce((select sum(s.active_sec) from public.app_sessions s
                    where s.user_id = p_user_id and (s.started_at at time zone 'Asia/Dhaka')::date = d.day), 0)::int,
         (select count(*) from public.lead_activity a
           where a.user_id = p_user_id and a.action <> 'call_logged'
             and (a.created_at at time zone 'Asia/Dhaka')::date = d.day)::int,
         (select count(*) from public.call_logs c
           where c.user_id = p_user_id and c.channel = 'phone' and c.deleted_at is null
             and (c.called_at at time zone 'Asia/Dhaka')::date = d.day)::int,
         (select count(*) from public.call_logs c
           where c.user_id = p_user_id and c.channel = 'whatsapp' and c.deleted_at is null
             and (c.called_at at time zone 'Asia/Dhaka')::date = d.day)::int
  from days d
  where public.can_see_activity(p_user_id)
  order by d.day;
$$;

notify pgrst, 'reload schema';
