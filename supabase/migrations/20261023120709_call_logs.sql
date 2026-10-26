-- =====================================================================
-- Call log: every call a user makes to a lead
-- =====================================================================
create table public.call_logs (
  id            uuid primary key default gen_random_uuid(),
  lead_id       uuid not null references public.leads(id) on delete cascade,
  user_id       uuid not null default auth.uid() references public.profiles(id),
  called_at     timestamptz not null default now(),
  outcome       text not null check (outcome in (
                  'connected', 'no_answer', 'busy', 'switched_off',
                  'wrong_number', 'call_back'
                )),
  duration_sec  integer check (duration_sec is null or duration_sec >= 0),
  notes         text,
  created_at    timestamptz not null default now()
);

create index call_logs_lead_idx on public.call_logs (lead_id, called_at desc);
create index call_logs_user_idx on public.call_logs (user_id, called_at desc);

-- =====================================================================
-- Security
--   - You can see calls of leads you can see
--   - You can add a call only as yourself, on a lead you can see
--   - Nobody edits or deletes calls from the app (history stays honest)
-- =====================================================================
alter table public.call_logs enable row level security;

create policy "call_logs: view for visible leads"
  on public.call_logs for select
  to authenticated
  using (
    public.is_active_user()
    and exists (select 1 from public.leads l where l.id = call_logs.lead_id)
  );

create policy "call_logs: add own calls"
  on public.call_logs for insert
  to authenticated
  with check (
    public.is_active_user()
    and user_id = auth.uid()
    and exists (select 1 from public.leads l where l.id = call_logs.lead_id and l.deleted_at is null)
  );

-- =====================================================================
-- After a call: update the lead's "last contacted" time and the timeline
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

  return new;
end;
$$;

create trigger call_logs_after_insert
  after insert on public.call_logs
  for each row execute function public.after_call_logged();

notify pgrst, 'reload schema';