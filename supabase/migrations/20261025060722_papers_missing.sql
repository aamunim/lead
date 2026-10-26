-- =====================================================================
-- Papers missing per lead (for the list badge and the "Papers" filter)
--   papers_missing = required papers not received yet (never below 0)
--   Kept up to date by Postgres itself whenever the counts change.
-- =====================================================================

alter table public.leads
  add column if not exists papers_missing integer
  generated always as (
    greatest(coalesce(papers_required, 0) - coalesce(papers_received, 0), 0)
  ) stored;

-- "Some missing" filter
create index if not exists leads_papers_missing_idx
  on public.leads (papers_missing)
  where deleted_at is null and papers_missing > 0;

-- "Originals with us" filter
create index if not exists leads_papers_originals_idx
  on public.leads (papers_originals_held)
  where deleted_at is null and papers_originals_held > 0;

comment on column public.leads.papers_missing is
  'Required admission papers not received yet (papers_required - papers_received, at least 0).';