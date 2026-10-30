-- =====================================================================
-- 💵 Fee part 3: installment reminders, refunds, collection report
--   1. Settings (fees → payments → reminders): on/off, how many days
--      before, on the day, and after how many late days the Team Lead and
--      admins are told
--   2. fee_payments.kind: 'payment' | 'refund' (a refund has its own
--      number RFD-2026-00001 and takes money off "paid")
--   3. record_refund(): admitted-then-cancelled (or lost) students, by the
--      people who may void payments, with a reason
--   4. fee_payments_tick(): the reminders (pg_cron, every hour; each one
--      goes once)
--   5. collection_report(): money in / out, by method and person, what is
--      still due and late, discounts, void payments
-- =====================================================================

-- ---------------------------------------------------------------------
-- 1. Settings
-- ---------------------------------------------------------------------
update public.app_settings
   set value = jsonb_set(value, '{payments,reminders}', jsonb_build_object(
     'enabled', true,
     'days_before', 1,       -- 0 = no early reminder
     'on_day', true,
     'late_after', 3))       -- days late → Team Lead and admins (0 = never)
 where key = 'fees' and value ? 'payments' and not (value -> 'payments' ? 'reminders');

create or replace function public.payment_reminder_setting()
returns jsonb
language sql
stable
security definer
set search_path = public
as $$
  select jsonb_build_object('enabled', true, 'days_before', 1, 'on_day', true, 'late_after', 3)
         || coalesce(public.payment_setting() -> 'reminders', '{}'::jsonb);
$$;

-- ---------------------------------------------------------------------
-- 2. Refunds
-- ---------------------------------------------------------------------
alter table public.fee_payments
  add column if not exists kind text not null default 'payment';
alter table public.fee_payments drop constraint if exists fee_payments_kind_check;
alter table public.fee_payments add constraint fee_payments_kind_check check (kind in ('payment', 'refund'));

create table if not exists public.refund_counters (
  year integer primary key,
  last integer not null default 0
);
alter table public.refund_counters enable row level security;   -- only the functions use it

-- Paid = payments − refunds (void ones left out)
create or replace function public.lead_fee_numbers(p_lead_id uuid)
returns table (final_fee numeric, paid numeric, due numeric, next_due date)
language sql
stable
security definer
set search_path = public
as $$
  with f as (
    select n.final_total
    from public.leads l
    join public.lead_negotiations n on n.lead_id = l.id and n.course_id = l.admitted_course_id and n.status = 'locked'
    where l.id = p_lead_id
  ),
  p as (
    select coalesce(sum(case when kind = 'refund' then -amount else amount end), 0) as paid
    from public.fee_payments where lead_id = p_lead_id and voided_at is null
  ),
  i as (
    select due_date, sum(amount) over (order by seq) as upto
    from public.fee_installments where lead_id = p_lead_id
  )
  select (select final_total from f),
         (select paid from p),
         case when (select final_total from f) is null then null
              else greatest((select final_total from f) - (select paid from p), 0) end,
         (select min(due_date) from i where i.upto > (select paid from p));
$$;

-- ---------------------------------------------------------------------
-- 3. record_refund
-- ---------------------------------------------------------------------
create or replace function public.record_refund(
  p_lead_id uuid,
  p_amount  numeric,
  p_method  text,
  p_reason  text,
  p_txn_id  text default null
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_kind   text;
  v_paid   numeric;
  v_reason text := nullif(trim(coalesce(p_reason, '')), '');
  v_year   int := extract(year from (now() at time zone 'Asia/Dhaka'))::int;
  v_n      int;
  v_no     text;
  v_id     uuid;
  v_course uuid;
begin
  if not public.fee_can_see_lead(p_lead_id) then raise exception 'Lead not found.'; end if;
  if not public.can_void_payments() then raise exception 'You can''t give refunds. Ask an admin.'; end if;
  if p_amount is null or p_amount <= 0 then raise exception 'Please type the amount.'; end if;
  if v_reason is null then raise exception 'Please write why the money is returned.'; end if;
  if nullif(trim(coalesce(p_method, '')), '') is null then raise exception 'Please choose how it was returned.'; end if;

  select s.kind, l.admitted_course_id into v_kind, v_course
  from public.leads l join public.pipeline_stages s on s.id = l.stage_id
  where l.id = p_lead_id;
  if v_kind = 'won' then
    raise exception 'The student is still admitted. Cancel the admission first, or void a wrong payment.';
  end if;

  select coalesce(sum(case when kind = 'refund' then -amount else amount end), 0) into v_paid
  from public.fee_payments where lead_id = p_lead_id and voided_at is null;
  if p_amount > v_paid then
    raise exception 'That is more than what was paid (%).', public.fee_money(v_paid);
  end if;

  insert into public.refund_counters (year, last) values (v_year, 1)
  on conflict (year) do update set last = public.refund_counters.last + 1
  returning last into v_n;
  v_no := 'RFD-' || v_year || '-' || lpad(v_n::text, 5, '0');

  insert into public.fee_payments (lead_id, course_id, receipt_no, amount, method, txn_id, paid_at, note, received_by, kind)
  values (p_lead_id, v_course, v_no, p_amount, trim(p_method), nullif(trim(coalesce(p_txn_id, '')), ''), now(),
          v_reason, auth.uid(), 'refund')
  returning id into v_id;

  insert into public.lead_activity (lead_id, user_id, action, details)
  values (p_lead_id, auth.uid(), 'payment_refunded', jsonb_build_object(
    'payment_id', v_id, 'receipt_no', v_no, 'amount', p_amount, 'method', trim(p_method), 'reason', v_reason));

  return jsonb_build_object('id', v_id, 'receipt_no', v_no);
end;
$$;

grant execute on function public.record_refund(uuid, numeric, text, text, text) to authenticated;

-- Students tab totals: this month's money is payments − refunds
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
    'collected_month', coalesce((select sum(case when p.kind = 'refund' then -p.amount else p.amount end)
                                 from public.fee_payments p
                                 join s on s.id = p.lead_id
                                 where p.voided_at is null and p.paid_at >= (select t from month_start)), 0),
    'papers_missing',  (select count(*) from s where coalesce(papers_missing, 0) > 0)
  );
$$;

-- ---------------------------------------------------------------------
-- 4. Reminders (each goes once: the notification's dedupe key)
-- ---------------------------------------------------------------------
create or replace function public.fee_payments_tick()
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  s        jsonb := public.payment_reminder_setting();
  v_today  date := (now() at time zone 'Asia/Dhaka')::date;
  v_before int := coalesce((s ->> 'days_before')::int, 1);
  v_late   int := coalesce((s ->> 'late_after')::int, 3);
  r        record;
  v_to     uuid;
begin
  if not coalesce((s ->> 'enabled')::boolean, true) then return; end if;
  if not coalesce((public.payment_setting() ->> 'enabled')::boolean, true) then return; end if;
  -- Morning only (9 am Bangladesh time onwards)
  if (now() at time zone 'Asia/Dhaka')::time < '09:00' then return; end if;

  for r in
    with st as (
      select l.id, l.name, l.phone, l.assigned_to, l.fee_due, l.fee_next_due,
             p.team_lead_id,
             -- what is left of the next installment
             (select least(l.fee_due, x.upto - coalesce(l.fee_paid, 0))
                from (select seq, sum(amount) over (order by seq) as upto from public.fee_installments where lead_id = l.id) x
               where x.upto > coalesce(l.fee_paid, 0) order by x.seq limit 1) as left_now
      from public.leads l
      left join public.profiles p on p.id = l.assigned_to
      join public.pipeline_stages sg on sg.id = l.stage_id and sg.kind = 'won'
      where l.deleted_at is null and l.fee_due > 0 and l.fee_next_due is not null
    )
    select * from st
    where (v_before > 0 and fee_next_due = v_today + v_before)
       or (coalesce((s ->> 'on_day')::boolean, true) and fee_next_due = v_today)
       or (v_late > 0 and fee_next_due = v_today - v_late)
  loop
    if r.fee_next_due > v_today then
      perform public.notify(r.assigned_to, 'payment',
        '📅 Installment ' || case when r.fee_next_due = v_today + 1 then 'tomorrow' else 'in ' || (r.fee_next_due - v_today) || ' days' end
          || ': ' || r.name,
        public.fee_money(coalesce(r.left_now, r.fee_due)) || ' by ' || to_char(r.fee_next_due, 'DD Mon') || coalesce(' · ' || r.phone, ''),
        jsonb_build_object('lead_id', r.id), 'inst-before:' || r.id || ':' || r.fee_next_due);
    elsif r.fee_next_due = v_today then
      perform public.notify(r.assigned_to, 'payment', '📅 Installment due today: ' || r.name,
        public.fee_money(coalesce(r.left_now, r.fee_due)) || coalesce(' · ' || r.phone, ''),
        jsonb_build_object('lead_id', r.id), 'inst-day:' || r.id || ':' || r.fee_next_due);
    else
      -- Late: the person, their Team Lead and the admins
      for v_to in
        select distinct u from (
          select r.assigned_to as u
          union select r.team_lead_id
          union select a from public.admin_ids() a
        ) x where u is not null
      loop
        perform public.notify(v_to, 'payment', '⚠ Installment ' || v_late || ' days late: ' || r.name,
          public.fee_money(coalesce(r.left_now, r.fee_due)) || ' was due ' || to_char(r.fee_next_due, 'DD Mon')
            || ' · total due ' || public.fee_money(r.fee_due),
          jsonb_build_object('lead_id', r.id), 'inst-late:' || r.id || ':' || r.fee_next_due);
      end loop;
    end if;
  end loop;
end;
$$;

do $$
begin
  perform cron.schedule('fee-payments', '7 * * * *', 'select public.fee_payments_tick()');
exception when others then
  raise notice 'pg_cron is not available: run fee_payments_tick() for installment reminders';
end;
$$;

-- ---------------------------------------------------------------------
-- 5. Collection report
-- ---------------------------------------------------------------------
create or replace function public.collection_report(p_from date, p_to date, p_user_id uuid default null)
returns jsonb
language sql
stable
security definer
set search_path = public
as $$
  with seen as (
    -- Leads this person may see in reports (same rule as the other reports)
    select l.id, l.name, l.assigned_to, l.admitted_at, l.fee_due, l.fee_next_due, l.deleted_at
    from public.leads l
    left join public.profiles p on p.id = l.assigned_to
    where public.is_active_user()
      and (public.has_permission('settings.manage') or public.has_permission('leads.view_all')
           or l.assigned_to = auth.uid()
           or (public.has_permission('leads.view_team') and p.team_lead_id = auth.uid()))
  ),
  pay as (
    select fp.*, s.name as lead_name
    from public.fee_payments fp
    join seen s on s.id = fp.lead_id
    where (fp.paid_at at time zone 'Asia/Dhaka')::date between p_from and p_to
      and (p_user_id is null or fp.received_by = p_user_id)
  ),
  ok as (select * from pay where voided_at is null),
  totals as (
    select coalesce(sum(amount) filter (where kind = 'payment'), 0) as collected,
           coalesce(sum(amount) filter (where kind = 'refund'), 0)  as refunded,
           count(*) filter (where kind = 'payment')                 as receipts,
           count(distinct lead_id) filter (where kind = 'payment')  as students
    from ok
  ),
  by_method as (
    select method, sum(amount) as amount, count(*) as receipts
    from ok where kind = 'payment' group by method
  ),
  by_person as (
    select ok.received_by as user_id, pr.full_name, sum(ok.amount) as amount, count(*) as receipts
    from ok left join public.profiles pr on pr.id = ok.received_by
    where ok.kind = 'payment' group by ok.received_by, pr.full_name
  ),
  due_now as (
    select count(*) filter (where fee_due > 0)                                            as with_due,
           coalesce(sum(fee_due) filter (where fee_due > 0), 0)                            as due,
           count(*) filter (where fee_due > 0 and fee_next_due < (now() at time zone 'Asia/Dhaka')::date) as late,
           coalesce(sum(fee_due) filter (where fee_due > 0 and fee_next_due < (now() at time zone 'Asia/Dhaka')::date), 0) as late_amount
    from seen
    where admitted_at is not null and deleted_at is null
      and (p_user_id is null or assigned_to = p_user_id)
  ),
  disc as (
    select d.*, (select l.admitted_at from public.leads l where l.id = d.lead_id) as admitted_at
    from public.fee_discounts d
    join seen s on s.id = d.lead_id
    where d.status = 'approved'
      and (d.decided_at at time zone 'Asia/Dhaka')::date between p_from and p_to
      and (p_user_id is null or d.requested_by = p_user_id)
  ),
  disc_tot as (
    select count(*) as given, coalesce(sum(amount), 0) as amount,
           count(distinct lead_id) as leads,
           count(distinct lead_id) filter (where admitted_at is not null) as admitted
    from disc
  ),
  disc_by as (
    select d.decided_by as user_id, pr.full_name, count(*) as given, sum(d.amount) as amount
    from disc d left join public.profiles pr on pr.id = d.decided_by
    group by d.decided_by, pr.full_name
  ),
  voided as (
    select pay.receipt_no, pay.amount, pay.kind, pay.lead_id, pay.lead_name, pay.void_reason, pay.voided_at,
           pr.full_name as voided_by
    from pay left join public.profiles pr on pr.id = pay.voided_by
    where pay.voided_at is not null
    order by pay.voided_at desc
    limit 20
  )
  select jsonb_build_object(
    'totals',    (select to_jsonb(t) || jsonb_build_object('net', t.collected - t.refunded) from totals t),
    'by_method', coalesce((select jsonb_agg(to_jsonb(x) order by x.amount desc) from by_method x), '[]'::jsonb),
    'by_person', coalesce((select jsonb_agg(to_jsonb(x) order by x.amount desc) from by_person x), '[]'::jsonb),
    'due_now',   (select to_jsonb(d) from due_now d),
    'discounts', (select to_jsonb(d) from disc_tot d),
    'discount_by', coalesce((select jsonb_agg(to_jsonb(x) order by x.amount desc) from disc_by x), '[]'::jsonb),
    'voided',    coalesce((select jsonb_agg(to_jsonb(x)) from voided x), '[]'::jsonb)
  );
$$;

grant execute on function public.collection_report(date, date, uuid) to authenticated;

-- ---------------------------------------------------------------------
-- A ready-made reminder ({due}, {next_installment}, {next_due_date}, {paid})
-- ---------------------------------------------------------------------
insert into public.message_templates (name, category, channels, is_shared, owner_id, sort_order, body)
select '⏰ Payment reminder', 'Fee', 'both', true, null, 8,
       E'{first_name}, {course}-এর কিস্তির কথা মনে করিয়ে দিচ্ছি:\nএই কিস্তি: {next_installment} — {next_due_date}-এর মধ্যে\nমোট বাকি: {due}\n\nপেমেন্ট করে জানাবেন। — {my_name}, {institute}'
where not exists (select 1 from public.message_templates where name = '⏰ Payment reminder');

notify pgrst, 'reload schema';
