-- =====================================================================
-- Who can see and work on leads
--   The existing rules (own / team / all by role) stay exactly as they are.
--   These rules are ADDED next to them:
--     • Assignment switch Off, or "Everyone sees all leads"
--         → every active user can see and work on every lead
--     • The person who added a lead can always see it
-- =====================================================================

-- Is the app in "everyone works on everything" mode?
create or replace function public.leads_shared_mode()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select not coalesce((s->>'enabled')::boolean, true)
         or coalesce(s->>'visibility', 'assigned') = 'everyone'
  from (select public.assignment_setting() as s) x;
$$;

grant execute on function public.leads_shared_mode() to authenticated;

-- ---------------------------------------------------------------------
-- leads
-- ---------------------------------------------------------------------
create policy "leads: see all in shared mode, or ones you added"
  on public.leads for select
  to authenticated
  using (
    public.is_active_user()
    and (public.leads_shared_mode() or created_by = auth.uid())
  );

create policy "leads: work on all in shared mode"
  on public.leads for update
  to authenticated
  using (public.is_active_user() and public.leads_shared_mode())
  with check (public.is_active_user() and public.leads_shared_mode());

-- ---------------------------------------------------------------------
-- Tags and courses on a lead (so "work on" includes changing them)
-- ---------------------------------------------------------------------
create policy "lead_tags: see in shared mode"
  on public.lead_tags for select
  to authenticated
  using (public.is_active_user() and public.leads_shared_mode());

create policy "lead_tags: add in shared mode"
  on public.lead_tags for insert
  to authenticated
  with check (public.is_active_user() and public.leads_shared_mode());

create policy "lead_tags: remove in shared mode"
  on public.lead_tags for delete
  to authenticated
  using (public.is_active_user() and public.leads_shared_mode());

create policy "lead_courses: see in shared mode"
  on public.lead_courses for select
  to authenticated
  using (public.is_active_user() and public.leads_shared_mode());

create policy "lead_courses: add in shared mode"
  on public.lead_courses for insert
  to authenticated
  with check (public.is_active_user() and public.leads_shared_mode());

create policy "lead_courses: remove in shared mode"
  on public.lead_courses for delete
  to authenticated
  using (public.is_active_user() and public.leads_shared_mode());

-- Timeline: visible on every lead you can see
create policy "lead_activity: see in shared mode"
  on public.lead_activity for select
  to authenticated
  using (public.is_active_user() and public.leads_shared_mode());

-- ---------------------------------------------------------------------
-- Safety: deleting / restoring a lead still needs the delete permission,
-- even when everyone can work on every lead.
-- ---------------------------------------------------------------------
create or replace function public.check_lead_delete_permission()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if new.deleted_at is distinct from old.deleted_at
     and auth.uid() is not null
     and not public.has_permission('leads.delete') then
    raise exception 'You do not have permission to delete or restore leads.';
  end if;
  return new;
end;
$$;

drop trigger if exists leads_check_delete on public.leads;
create trigger leads_check_delete
  before update of deleted_at on public.leads
  for each row execute function public.check_lead_delete_permission();

notify pgrst, 'reload schema';