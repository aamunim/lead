-- =====================================================================
-- Saved filters
--   - Each user can save their own filters ("My hot leads this week")
--   - Admins can share a filter with everyone
-- =====================================================================
create table public.saved_filters (
  id          uuid primary key default gen_random_uuid(),
  owner_id    uuid not null default auth.uid() references public.profiles(id) on delete cascade,
  name        text not null check (length(trim(name)) between 1 and 40),
  filters     jsonb not null default '{}'::jsonb,
  is_shared   boolean not null default false,
  sort_order  integer not null default 0,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

create index saved_filters_owner_idx on public.saved_filters (owner_id, sort_order);
create index saved_filters_shared_idx on public.saved_filters (is_shared) where is_shared;

create trigger saved_filters_updated_at
  before update on public.saved_filters
  for each row execute function public.set_updated_at();

alter table public.saved_filters enable row level security;

-- See your own filters and the shared ones
create policy "saved_filters: view own or shared"
  on public.saved_filters for select
  to authenticated
  using (
    public.is_active_user()
    and (owner_id = auth.uid() or is_shared)
  );

-- Add your own; only admins may share
create policy "saved_filters: add own"
  on public.saved_filters for insert
  to authenticated
  with check (
    public.is_active_user()
    and owner_id = auth.uid()
    and (not is_shared or public.has_permission('settings.manage'))
  );

-- Change / delete your own; admins can also manage shared ones
create policy "saved_filters: update own"
  on public.saved_filters for update
  to authenticated
  using (
    public.is_active_user()
    and (owner_id = auth.uid() or (is_shared and public.has_permission('settings.manage')))
  )
  with check (
    (not is_shared or public.has_permission('settings.manage'))
  );

create policy "saved_filters: delete own"
  on public.saved_filters for delete
  to authenticated
  using (
    public.is_active_user()
    and (owner_id = auth.uid() or (is_shared and public.has_permission('settings.manage')))
  );

-- =====================================================================
-- Admin setting: which filters users see, and in what order
-- =====================================================================
insert into public.app_settings (key, value)
values (
  'lead_filters',
  '{
    "fields": [
      {"key": "follow_up",      "enabled": true},
      {"key": "rating",         "enabled": true},
      {"key": "stage",          "enabled": true},
      {"key": "tags",           "enabled": true},
      {"key": "assigned",       "enabled": true},
      {"key": "source",         "enabled": true},
      {"key": "course",         "enabled": true},
      {"key": "campaign",       "enabled": false},
      {"key": "lead_type",      "enabled": false},
      {"key": "created",        "enabled": true},
      {"key": "last_contacted", "enabled": true}
    ]
  }'::jsonb
)
on conflict (key) do nothing;

notify pgrst, 'reload schema';