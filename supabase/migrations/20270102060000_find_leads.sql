-- =====================================================================
-- 🔎 Finding a lead again
--   🕘 Recent: the leads I worked on (calls — also the ones synced from
--      the phone's dialer —, notes, stage and other changes, and leads I
--      opened), newest first, for today or any days.
--   ⭐ Starred: my own short list.
--   Both are each person's own; the access rules still decide which
--   leads can be seen.
-- =====================================================================

-- ⭐ My stars
create table if not exists public.lead_stars (
  user_id    uuid not null default auth.uid() references public.profiles(id) on delete cascade,
  lead_id    uuid not null references public.leads(id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (user_id, lead_id)
);
create index if not exists lead_stars_lead_idx on public.lead_stars (lead_id);
alter table public.lead_stars enable row level security;
grant select, insert, delete on public.lead_stars to authenticated;
drop policy if exists "lead_stars: mine" on public.lead_stars;
create policy "lead_stars: mine" on public.lead_stars for select to authenticated using (user_id = (select auth.uid()));
drop policy if exists "lead_stars: add mine" on public.lead_stars;
create policy "lead_stars: add mine" on public.lead_stars for insert to authenticated
  with check (user_id = (select auth.uid()) and exists (select 1 from public.leads l where l.id = lead_id));
drop policy if exists "lead_stars: remove mine" on public.lead_stars;
create policy "lead_stars: remove mine" on public.lead_stars for delete to authenticated using (user_id = (select auth.uid()));

-- 👀 Leads I opened (the newest time for each)
create table if not exists public.lead_views (
  user_id   uuid not null references public.profiles(id) on delete cascade,
  lead_id   uuid not null references public.leads(id) on delete cascade,
  viewed_at timestamptz not null default now(),
  primary key (user_id, lead_id)
);
create index if not exists lead_views_user_idx on public.lead_views (user_id, viewed_at desc);
alter table public.lead_views enable row level security;
grant select on public.lead_views to authenticated;
drop policy if exists "lead_views: mine" on public.lead_views;
create policy "lead_views: mine" on public.lead_views for select to authenticated using (user_id = (select auth.uid()));

create or replace function public.touch_lead(p_lead uuid)
returns void
language sql
security definer
set search_path = public
as $$
  insert into public.lead_views (user_id, lead_id, viewed_at)
  select auth.uid(), p_lead, now()
  where auth.uid() is not null and exists (select 1 from public.leads where id = p_lead)
  on conflict (user_id, lead_id) do update set viewed_at = excluded.viewed_at;
$$;
grant execute on function public.touch_lead(uuid) to authenticated;

create index if not exists lead_activity_user_idx on public.lead_activity (user_id, created_at desc);

-- 🕘 What I worked on, newest first (one row per lead: the newest thing)
create or replace function public.my_recent_leads(p_from timestamptz, p_to timestamptz default now(), p_limit int default 200)
returns table (lead_id uuid, at timestamptz, kind text, detail jsonb)
language sql
stable
security invoker
set search_path = public
as $$
  with mine as (
    select a.lead_id, a.created_at as at, a.action as kind, a.details as detail
    from public.lead_activity a
    where a.user_id = (select auth.uid()) and a.created_at >= p_from and a.created_at <= p_to
    union all
    select c.lead_id, c.called_at, 'call', jsonb_build_object('outcome', c.outcome, 'sec', c.duration_sec, 'channel', c.channel)
    from public.call_logs c
    where c.user_id = (select auth.uid()) and c.called_at >= p_from and c.called_at <= p_to and c.deleted_at is null
    union all
    select v.lead_id, v.viewed_at, 'opened', '{}'::jsonb
    from public.lead_views v
    where v.user_id = (select auth.uid()) and v.viewed_at >= p_from and v.viewed_at <= p_to
  ),
  newest as (
    select distinct on (m.lead_id) m.lead_id, m.at, m.kind, m.detail
    from mine m
    join public.leads l on l.id = m.lead_id and l.deleted_at is null
    order by m.lead_id, m.at desc
  )
  select * from newest order by at desc limit least(greatest(coalesce(p_limit, 200), 1), 500);
$$;
grant execute on function public.my_recent_leads(timestamptz, timestamptz, int) to authenticated;

notify pgrst, 'reload schema';
