-- =====================================================================
-- ⚡ Faster: the access rules (row level security) are worked out once
--   per request, not once per row.
--   Before: "may I see this lead?" ran a few lookups (my role, my team,
--   the settings) for every lead in every list, count and search, and
--   again for every course / tag / last call joined to it. With 600
--   leads a count took ~45 ms instead of ~1 ms.
--   Now:
--   • calls like is_active_user(), has_permission('…'), auth.uid() in
--     every rule are wrapped as (select …), so Postgres works them out
--     once and reuses the answer (Supabase's own advice);
--   • can_view_lead(x) / can_edit_lead(x) inside the rules are written
--     out with my team worked out once (my_team_ids()).
--   The rules mean exactly the same as before; only the speed changes.
-- =====================================================================

-- The people in my team (I am their Team Lead)
create or replace function public.my_team_ids()
returns uuid[]
language sql
stable
security definer
set search_path = public
as $$
  select coalesce(array_agg(id), '{}') from public.profiles where team_lead_id = auth.uid();
$$;
grant execute on function public.my_team_ids() to authenticated;

do $$
declare
  p      record;
  v_q    text;
  v_c    text;
  v_sql  text;
  v_view text := '((select public.has_permission(''leads.view_all'')) or (\1 = (select auth.uid()) and (select public.is_active_user())) or ((select public.has_permission(''leads.view_team'')) and \1 = any (coalesce((select public.my_team_ids()), ''{}''::uuid[]))))';
  v_edit text := '((select public.has_permission(''leads.edit_all'')) or (\1 = (select auth.uid()) and (select public.has_permission(''leads.edit_own''))) or ((select public.has_permission(''leads.edit_team'')) and (\1 = (select auth.uid()) or \1 = any (coalesce((select public.my_team_ids()), ''{}''::uuid[])))))';
begin
  for p in
    select schemaname, tablename, policyname, qual, with_check
    from pg_policies where schemaname = 'public'
  loop
    v_q := p.qual;
    v_c := p.with_check;
    -- 1. calls that don't depend on the row: once per request
    v_q := regexp_replace(v_q, '(?<!SELECT |select |public\.)(?:public\.)?(is_active_user|leads_shared_mode|is_developer|current_role_key|can_approve_admission|can_take_payments|can_void_payments)\(\)', '(select public.\1())', 'g');
    v_c := regexp_replace(v_c, '(?<!SELECT |select |public\.)(?:public\.)?(is_active_user|leads_shared_mode|is_developer|current_role_key|can_approve_admission|can_take_payments|can_void_payments)\(\)', '(select public.\1())', 'g');
    v_q := regexp_replace(v_q, '(?<!SELECT |select |public\.)(?:public\.)?has_permission\(''([a-z_.*]+)''(?:::text)?\)', '(select public.has_permission(''\1''))', 'g');
    v_c := regexp_replace(v_c, '(?<!SELECT |select |public\.)(?:public\.)?has_permission\(''([a-z_.*]+)''(?:::text)?\)', '(select public.has_permission(''\1''))', 'g');
    v_q := regexp_replace(v_q, '(?<!SELECT |select |public\.)auth\.uid\(\)', '(select auth.uid())', 'g');
    v_c := regexp_replace(v_c, '(?<!SELECT |select |public\.)auth\.uid\(\)', '(select auth.uid())', 'g');

    -- 2. the per-row lead checks, written out
    v_q := regexp_replace(v_q, '(?:public\.)?can_view_lead\(([a-z_.]+)\)', v_view, 'g');
    v_c := regexp_replace(v_c, '(?:public\.)?can_view_lead\(([a-z_.]+)\)', v_view, 'g');
    v_q := regexp_replace(v_q, '(?:public\.)?can_edit_lead\(([a-z_.]+)\)', v_edit, 'g');
    v_c := regexp_replace(v_c, '(?:public\.)?can_edit_lead\(([a-z_.]+)\)', v_edit, 'g');
    if v_q is distinct from p.qual or v_c is distinct from p.with_check then
      v_sql := format('alter policy %I on %I.%I', p.policyname, p.schemaname, p.tablename);
      if v_q is not null then v_sql := v_sql || format(' using (%s)', v_q); end if;
      if v_c is not null then v_sql := v_sql || format(' with check (%s)', v_c); end if;
      execute v_sql;
    end if;
  end loop;
end $$;

notify pgrst, 'reload schema';
