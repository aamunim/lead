-- =====================================================================
-- 🎓 Student ID (College ID): short year + 3-digit number, by admission year
--   2026 → 26001, 26002 … 26100 …   2027 → 27001 …   (pattern {YY}{000})
--   Every student already given an ID gets a new one in the same style:
--   year = the year they were admitted, numbered in the order they were
--   admitted. The old ID stays in each student's history.
-- =====================================================================

-- 1. The pattern
update public.app_settings
set value = jsonb_set(
      value,
      '{student_id}',
      coalesce(value->'student_id', '{"mode":"auto"}'::jsonb) || jsonb_build_object('pattern', '{YY}{000}')
    )
where key = 'admission';

create or replace function public.admission_setting()
returns jsonb
language sql
stable
security definer
set search_path = public
as $$
  select jsonb_build_object(
           'mark',   jsonb_build_object('mode', 'all', 'roles', '[]'::jsonb, 'user_ids', '[]'::jsonb),
           'cancel', jsonb_build_object('mode', 'roles', 'roles', '["super_admin","admin"]'::jsonb, 'user_ids', '[]'::jsonb),
           'batch_required', false,
           'allow_overbooking', false,
           'student_id', jsonb_build_object('mode', 'auto', 'pattern', '{YY}{000}'),
           'closed_in_list', 'hide'
         )
         || coalesce((select value from public.app_settings where key = 'admission'), '{}'::jsonb);
$$;

-- 2. New IDs for everyone who has one
do $$
declare
  r       record;
  v_new   text;
  v_count int := 0;
begin
  perform set_config('app.pipeline_action', 'on', true);
  perform set_config('app.admission_approval', 'on', true);

  create temporary table tmp_student_ids on commit drop as
  select l.id,
         l.student_ref as old_ref,
         to_char(coalesce(l.admitted_at, l.cancelled_at, l.created_at) at time zone 'Asia/Dhaka', 'YYYY') as yr,
         row_number() over (
           partition by to_char(coalesce(l.admitted_at, l.cancelled_at, l.created_at) at time zone 'Asia/Dhaka', 'YYYY')
           order by coalesce(l.admitted_at, l.cancelled_at, l.created_at), l.created_at, l.id
         ) as n
  from public.leads l
  where l.student_ref is not null and l.deleted_at is null;

  -- first move them out of the way (the IDs must stay unique at every step)
  update public.leads l set student_ref = 'tmp-' || l.id::text
  from tmp_student_ids t where t.id = l.id;

  for r in select * from tmp_student_ids order by yr, n loop
    v_new := right(r.yr, 2) || lpad(r.n::text, 3, '0');
    -- a deleted lead could still hold this ID: skip ahead
    while exists (select 1 from public.leads where lower(student_ref) = lower(v_new)) loop
      r.n := r.n + 1;
      v_new := right(r.yr, 2) || lpad(r.n::text, 3, '0');
    end loop;

    update public.leads set student_ref = v_new where id = r.id;

    if r.old_ref is distinct from v_new then
      insert into public.lead_activity (lead_id, user_id, action, details)
      values (r.id, null, 'student_ref_changed', jsonb_build_object('from', r.old_ref, 'to', v_new));
    end if;
    v_count := v_count + 1;
  end loop;

  -- 3. The next admission continues after the last number of its year
  insert into public.admission_counters (scope, last_value)
  select yr, max(substring(student_ref from 3)::int)
  from (
    select l.student_ref,
           '20' || left(l.student_ref, 2) as yr
    from public.leads l
    where l.student_ref ~ '^\d{5,}$'
  ) x
  group by yr
  on conflict (scope) do update set last_value = excluded.last_value;

  raise notice 'Student IDs renumbered: %', v_count;
end;
$$;

notify pgrst, 'reload schema';
