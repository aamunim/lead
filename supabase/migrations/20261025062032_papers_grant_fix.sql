-- =====================================================================
-- Fix: "permission denied for function papers_for_lead"
--   lead_papers_status / lead_missing_papers / the admit check call
--   papers_for_lead as the signed-in user, so users need EXECUTE on it.
--   It only returns which papers apply to a lead (read-only).
-- =====================================================================
do $$
declare
  f regprocedure;
begin
  for f in
    select p.oid::regprocedure
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public'
      and p.proname = 'papers_for_lead'
  loop
    execute format('grant execute on function %s to authenticated', f);
  end loop;
end $$;