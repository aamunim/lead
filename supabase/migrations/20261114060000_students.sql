-- =====================================================================
-- 🎓 Students tab
--   1. Setting 'students': the tab on/off and who sees it (admins always)
--   2. students_summary(): totals over the admitted students this person
--      can see (row security on leads and payments decides that)
-- =====================================================================

insert into public.app_settings (key, value)
values ('students', jsonb_build_object(
  'enabled', true,
  'who', jsonb_build_object('mode', 'all', 'roles', '[]'::jsonb, 'user_ids', '[]'::jsonb)
))
on conflict (key) do nothing;

create index if not exists leads_admitted_at_idx on public.leads (admitted_at) where admitted_at is not null and deleted_at is null;

create or replace function public.students_summary()
returns jsonb
language sql
stable
security invoker
set search_path = public
as $$
  with s as (
    select l.id, l.admitted_at, l.fee_due, l.fee_next_due, l.papers_missing
    from public.leads l
    where l.admitted_at is not null and l.deleted_at is null
  ),
  month_start as (
    select (date_trunc('month', now() at time zone 'Asia/Dhaka') at time zone 'Asia/Dhaka') as t
  ),
  today as (select (now() at time zone 'Asia/Dhaka')::date as d)
  select jsonb_build_object(
    'students',        (select count(*) from s),
    'new_this_month',  (select count(*) from s where admitted_at >= (select t from month_start)),
    'with_due',        (select count(*) from s where fee_due > 0),
    'due',             coalesce((select sum(fee_due) from s where fee_due > 0), 0),
    'overdue',         (select count(*) from s where fee_due > 0 and fee_next_due < (select d from today)),
    'overdue_amount',  coalesce((select sum(fee_due) from s where fee_due > 0 and fee_next_due < (select d from today)), 0),
    'collected_month', coalesce((select sum(p.amount) from public.fee_payments p
                                 join s on s.id = p.lead_id
                                 where p.voided_at is null and p.paid_at >= (select t from month_start)), 0),
    'papers_missing',  (select count(*) from s where coalesce(papers_missing, 0) > 0)
  );
$$;

grant execute on function public.students_summary() to authenticated;

notify pgrst, 'reload schema';
