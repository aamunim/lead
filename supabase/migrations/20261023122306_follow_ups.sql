-- =====================================================================
-- Follow-ups: when to call a lead next
--   - A lead has at most ONE pending follow-up at a time
--   - leads.next_follow_up_at always shows that pending time
-- =====================================================================
create table public.follow_ups (
  id             uuid primary key default gen_random_uuid(),
  lead_id        uuid not null references public.leads(id) on delete cascade,
  due_at         timestamptz not null,
  note           text,
  status         text not null default 'pending'
                   check (status in ('pending', 'done', 'rescheduled', 'cancelled')),
  created_by     uuid not null default auth.uid() references public.profiles(id),
  created_at     timestamptz not null default now(),
  completed_at   timestamptz,
  completed_by   uuid references public.profiles(id),
  call_id        uuid references public.call_logs(id) on delete set null
);

create unique index follow_ups_one_pending_per_lead
  on public.follow_ups (lead_id) where status = 'pending';
create index follow_ups_due_idx on public.follow_ups (due_at) where status = 'pending';
create index follow_ups_lead_idx on public.follow_ups (lead_id, created_at desc);

-- =====================================================================
-- Security: same people who can see the lead
-- =====================================================================
alter table public.follow_ups enable row level security;

create policy "follow_ups: view for visible leads"
  on public.follow_ups for select
  to authenticated
  using (
    public.is_active_user()
    and exists (select 1 from public.leads l where l.id = follow_ups.lead_id)
  );

create policy "follow_ups: add for visible leads"
  on public.follow_ups for insert
  to authenticated
  with check (
    public.is_active_user()
    and created_by = auth.uid()
    and exists (select 1 from public.leads l where l.id = follow_ups.lead_id and l.deleted_at is null)
  );

create policy "follow_ups: update for visible leads"
  on public.follow_ups for update
  to authenticated
  using (
    public.is_active_user()
    and exists (select 1 from public.leads l where l.id = follow_ups.lead_id)
  )
  with check (
    exists (select 1 from public.leads l where l.id = follow_ups.lead_id)
  );

-- =====================================================================
-- Keep leads.next_follow_up_at in sync
-- =====================================================================
create or replace function public.sync_next_follow_up()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_lead uuid := coalesce(new.lead_id, old.lead_id);
begin
  update public.leads
     set next_follow_up_at = (
       select f.due_at from public.follow_ups f
        where f.lead_id = v_lead and f.status = 'pending'
        limit 1
     )
   where id = v_lead;
  return null;
end;
$$;

create trigger follow_ups_sync_lead
  after insert or update or delete on public.follow_ups
  for each row execute function public.sync_next_follow_up();

-- =====================================================================
-- Set (or move) the next follow-up of a lead
--   Runs as the signed-in user, so all the security rules above apply.
-- =====================================================================
create or replace function public.schedule_follow_up(
  p_lead_id uuid,
  p_due_at  timestamptz,
  p_note    text default null
)
returns uuid
language plpgsql
security invoker
set search_path = public
as $$
declare
  v_id uuid;
begin
  if not public.is_active_user() then
    raise exception 'Your account is not active.';
  end if;

  update public.follow_ups
     set status = 'rescheduled', completed_at = now(), completed_by = auth.uid()
   where lead_id = p_lead_id and status = 'pending';

  insert into public.follow_ups (lead_id, due_at, note)
  values (p_lead_id, p_due_at, nullif(trim(p_note), ''))
  returning id into v_id;

  insert into public.lead_activity (lead_id, user_id, action, details)
  values (p_lead_id, auth.uid(), 'follow_up_set', jsonb_build_object('due_at', p_due_at));

  return v_id;
end;
$$;

-- Cancel the pending follow-up (e.g. "don't call again")
create or replace function public.cancel_follow_up(p_lead_id uuid)
returns void
language plpgsql
security invoker
set search_path = public
as $$
begin
  update public.follow_ups
     set status = 'cancelled', completed_at = now(), completed_by = auth.uid()
   where lead_id = p_lead_id and status = 'pending';

  if found then
    insert into public.lead_activity (lead_id, user_id, action, details)
    values (p_lead_id, auth.uid(), 'follow_up_cancelled', '{}'::jsonb);
  end if;
end;
$$;

grant execute on function public.schedule_follow_up(uuid, timestamptz, text) to authenticated;
grant execute on function public.cancel_follow_up(uuid) to authenticated;

-- =====================================================================
-- After a call (replaces the version from the call_logs migration):
--   1. update "last contacted"
--   2. add a timeline line
--   3. mark a follow-up that is due today or overdue as done
-- =====================================================================
create or replace function public.after_call_logged()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  update public.leads
     set last_contacted_at = greatest(coalesce(last_contacted_at, new.called_at), new.called_at)
   where id = new.lead_id;

  insert into public.lead_activity (lead_id, user_id, action, details)
  values (
    new.lead_id,
    new.user_id,
    'call_logged',
    jsonb_build_object('outcome', new.outcome, 'call_id', new.id)
  );

  update public.follow_ups
     set status = 'done',
         completed_at = new.called_at,
         completed_by = new.user_id,
         call_id = new.id
   where lead_id = new.lead_id
     and status = 'pending'
     and due_at < date_trunc('day', now() at time zone 'Asia/Dhaka') at time zone 'Asia/Dhaka' + interval '1 day';

  return new;
end;
$$;

notify pgrst, 'reload schema';