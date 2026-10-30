-- =====================================================================
-- 💵 Payments, installments and receipts (admitted students only)
--   1. Settings (inside app_settings 'fees' → 'payments'): on/off, who may
--      take payments, who may void them (admins always), payment methods
--      (and which need a transaction ID), the least payment at admission,
--      how many days back a payment date may go, what the receipt shows
--   2. Every admission gets a locked fee (from the negotiation, or the
--      course's full fee when there was no fee talk)
--   3. fee_payments: receipt number RCP-2026-00001 (one series per year),
--      never deleted: a wrong one is voided with a reason
--   4. fee_installments: an optional plan; payments fill the earliest first
--   5. leads.fee_paid / fee_due / fee_next_due for the list
--   6. Functions: record_payment, void_payment, set_installments
-- =====================================================================

-- ---------------------------------------------------------------------
-- 1. Settings
-- ---------------------------------------------------------------------
update public.app_settings
   set value = value || jsonb_build_object('payments', jsonb_build_object(
     'enabled', true,
     'who', jsonb_build_object('mode', 'all', 'roles', '[]'::jsonb, 'user_ids', '[]'::jsonb),
     'void_who', jsonb_build_object('mode', 'roles', 'roles', '[]'::jsonb, 'user_ids', '[]'::jsonb),
     'methods', jsonb_build_array(
       jsonb_build_object('name', 'Cash',   'txn', false),
       jsonb_build_object('name', 'bKash',  'txn', true),
       jsonb_build_object('name', 'Nagad',  'txn', true),
       jsonb_build_object('name', 'Rocket', 'txn', true),
       jsonb_build_object('name', 'Bank',   'txn', true),
       jsonb_build_object('name', 'Card',   'txn', false)),
     'min_on_admit', 0,          -- taka; 0 = admit without a payment
     'backdate_days', 7,         -- older dates: admins only
     'receipt', jsonb_build_object(
       'fields', jsonb_build_object('institute', true, 'address', true, 'phone', true, 'student_id', true,
                                    'course', true, 'batch', true, 'method', true, 'txn', true,
                                    'received_by', true, 'paid_due', true, 'note', true),
       'footer', 'Thank you.')))
 where key = 'fees' and not (value ? 'payments');

create or replace function public.payment_setting()
returns jsonb
language sql
stable
security definer
set search_path = public
as $$
  select jsonb_build_object(
           'enabled', true,
           'who', jsonb_build_object('mode', 'all', 'roles', '[]'::jsonb, 'user_ids', '[]'::jsonb),
           'void_who', jsonb_build_object('mode', 'roles', 'roles', '[]'::jsonb, 'user_ids', '[]'::jsonb),
           'methods', '[]'::jsonb,
           'min_on_admit', 0,
           'backdate_days', 7
         ) || coalesce(public.fee_setting() -> 'payments', '{}'::jsonb);
$$;

-- A "who" rule (everyone / some roles / some people); admins always pass
create or replace function public.fee_who_allows(p_rule jsonb, p_user uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  with p as (select pr.id, pr.role_key, r.permissions from public.profiles pr
             join public.roles r on r.key = pr.role_key
             where pr.id = p_user and pr.is_active)
  select exists (select 1 from p) and (
    (select '*' = any (permissions) or 'settings.manage' = any (permissions) or 'payments.manage' = any (permissions) from p)
    or case coalesce(p_rule ->> 'mode', 'all')
         when 'roles' then (select role_key from p) in (select jsonb_array_elements_text(coalesce(p_rule -> 'roles', '[]')))
         when 'users' then p_user::text in (select jsonb_array_elements_text(coalesce(p_rule -> 'user_ids', '[]')))
         else true
       end
  );
$$;

create or replace function public.can_take_payments(p_user uuid default auth.uid())
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select coalesce((public.fee_setting() ->> 'enabled')::boolean, true)
     and coalesce((public.payment_setting() ->> 'enabled')::boolean, true)
     and public.fee_who_allows(public.payment_setting() -> 'who', p_user);
$$;

create or replace function public.can_void_payments(p_user uuid default auth.uid())
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select public.fee_who_allows(public.payment_setting() -> 'void_who', p_user);
$$;

grant execute on function public.can_take_payments(uuid) to authenticated;
grant execute on function public.can_void_payments(uuid) to authenticated;

-- ---------------------------------------------------------------------
-- 2. Every admission gets a locked fee
-- ---------------------------------------------------------------------
create or replace function public.fee_on_admission()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_neg  uuid;
  v_list numeric;
  v_disc numeric;
begin
  if new.admitted_at is not null and old.admitted_at is null then
    select id into v_neg from public.lead_negotiations
     where lead_id = new.id and course_id = new.admitted_course_id and status = 'open';
    if v_neg is not null then
      select t.list_total, t.discount into v_list, v_disc from public.negotiation_totals(v_neg) t;
      -- Discounts in force stay for good; ones still waiting are dropped
      update public.fee_discounts set expires_at = null
       where negotiation_id = v_neg and status = 'approved' and (expires_at is null or expires_at > now());
      update public.fee_discounts
         set status = 'cancelled', decided_at = now(), decision_note = 'Admitted before an answer'
       where negotiation_id = v_neg and status = 'pending';
      update public.lead_negotiations
         set status = 'locked', final_total = greatest(v_list - v_disc, 0), locked_at = now()
       where id = v_neg;
    elsif new.admitted_course_id is not null
          and not exists (select 1 from public.lead_negotiations
                          where lead_id = new.id and course_id = new.admitted_course_id)
          and exists (select 1 from public.course_fees where course_id = new.admitted_course_id) then
      -- No fee talk: the full fee
      insert into public.lead_negotiations (lead_id, course_id, status, final_total, locked_at, started_by)
      values (new.id, new.admitted_course_id, 'locked',
              (select sum(amount) from public.course_fees where course_id = new.admitted_course_id),
              now(), auth.uid());
    end if;
  elsif new.admitted_at is null and old.admitted_at is not null then
    update public.lead_negotiations
       set status = 'open', final_total = null, locked_at = null
     where lead_id = new.id and status = 'locked';
  end if;
  return null;
end;
$$;

-- Students admitted before this: their fee too
insert into public.lead_negotiations (lead_id, course_id, status, final_total, locked_at, started_by)
select l.id, l.admitted_course_id, 'locked',
       (select sum(amount) from public.course_fees f where f.course_id = l.admitted_course_id),
       coalesce(l.admitted_at, now()), l.admitted_by
from public.leads l
join public.pipeline_stages s on s.id = l.stage_id and s.kind = 'won'
where l.deleted_at is null and l.admitted_course_id is not null and l.admitted_at is not null
  and exists (select 1 from public.course_fees f where f.course_id = l.admitted_course_id)
  and not exists (select 1 from public.lead_negotiations n where n.lead_id = l.id and n.course_id = l.admitted_course_id)
on conflict (lead_id, course_id) do nothing;

-- ---------------------------------------------------------------------
-- 3. Payments and receipt numbers
-- ---------------------------------------------------------------------
create table if not exists public.receipt_counters (
  year integer primary key,
  last integer not null default 0
);
alter table public.receipt_counters enable row level security;   -- only the functions use it

create table if not exists public.fee_payments (
  id           uuid primary key default gen_random_uuid(),
  lead_id      uuid not null references public.leads(id) on delete cascade,
  course_id    uuid references public.courses(id) on delete set null,
  receipt_no   text not null unique,
  amount       numeric(12,2) not null check (amount > 0),
  method       text not null,
  txn_id       text,
  paid_at      timestamptz not null default now(),
  note         text,
  received_by  uuid references public.profiles(id) on delete set null,
  created_at   timestamptz not null default now(),
  voided_at    timestamptz,
  voided_by    uuid references public.profiles(id) on delete set null,
  void_reason  text
);

create index if not exists fee_payments_lead_idx on public.fee_payments (lead_id, paid_at);
create index if not exists fee_payments_paid_idx on public.fee_payments (paid_at) where voided_at is null;

alter table public.fee_payments enable row level security;
drop policy if exists "fee_payments: view" on public.fee_payments;
create policy "fee_payments: view" on public.fee_payments for select to authenticated
  using (public.fee_can_see_lead(lead_id));

-- ---------------------------------------------------------------------
-- 4. Installments
-- ---------------------------------------------------------------------
create table if not exists public.fee_installments (
  id         uuid primary key default gen_random_uuid(),
  lead_id    uuid not null references public.leads(id) on delete cascade,
  course_id  uuid references public.courses(id) on delete set null,
  seq        integer not null check (seq > 0),
  due_date   date not null,
  amount     numeric(12,2) not null check (amount > 0),
  created_by uuid references public.profiles(id) on delete set null,
  created_at timestamptz not null default now(),
  unique (lead_id, seq)
);

alter table public.fee_installments enable row level security;
drop policy if exists "fee_installments: view" on public.fee_installments;
create policy "fee_installments: view" on public.fee_installments for select to authenticated
  using (public.fee_can_see_lead(lead_id));

-- ---------------------------------------------------------------------
-- 5. The lead's numbers (list, filters, export)
-- ---------------------------------------------------------------------
alter table public.leads
  add column if not exists fee_paid     numeric(12,2),
  add column if not exists fee_due      numeric(12,2),
  add column if not exists fee_next_due date;

-- The admitted student's fee, paid so far, and what's left
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
  p as (select coalesce(sum(amount), 0) as paid from public.fee_payments where lead_id = p_lead_id and voided_at is null),
  -- Installments filled from the earliest: the first one not fully paid
  i as (
    select due_date,
           sum(amount) over (order by seq) as upto
    from public.fee_installments where lead_id = p_lead_id
  )
  select (select final_total from f),
         (select paid from p),
         case when (select final_total from f) is null then null
              else greatest((select final_total from f) - (select paid from p), 0) end,
         (select min(due_date) from i where i.upto > (select paid from p));
$$;

grant execute on function public.lead_fee_numbers(uuid) to authenticated;

create or replace function public.refresh_lead_payments(p_lead_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v record;
begin
  select * into v from public.lead_fee_numbers(p_lead_id);
  update public.leads
     set fee_paid = nullif(v.paid, 0), fee_due = v.due, fee_next_due = v.next_due
   where id = p_lead_id
     and (fee_paid, fee_due, fee_next_due) is distinct from (nullif(v.paid, 0), v.due, v.next_due);
end;
$$;

create or replace function public.sync_lead_payments()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  perform public.refresh_lead_payments(coalesce(new.lead_id, old.lead_id));
  return null;
end;
$$;

drop trigger if exists fee_payments_sync on public.fee_payments;
create trigger fee_payments_sync after insert or update or delete on public.fee_payments
  for each row execute function public.sync_lead_payments();

drop trigger if exists fee_installments_sync on public.fee_installments;
create trigger fee_installments_sync after insert or update or delete on public.fee_installments
  for each row execute function public.sync_lead_payments();

-- The locked fee changes (admitted / cancelled): the due changes too
drop trigger if exists lead_negotiations_sync_payments on public.lead_negotiations;
create trigger lead_negotiations_sync_payments after insert or update or delete on public.lead_negotiations
  for each row execute function public.sync_lead_payments();

-- The ones already there
do $$
declare
  r record;
begin
  for r in select distinct lead_id from public.lead_negotiations where status = 'locked' loop
    perform public.refresh_lead_fee(r.lead_id);
    perform public.refresh_lead_payments(r.lead_id);
  end loop;
end;
$$;

-- ---------------------------------------------------------------------
-- 6. Functions
-- ---------------------------------------------------------------------
-- The admitted student I may take a payment for
create or replace function public.fee_admitted_lead(p_lead_id uuid)
returns public.leads
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  l      public.leads;
  v_kind text;
begin
  if not public.fee_can_see_lead(p_lead_id) then raise exception 'Lead not found.'; end if;
  select * into l from public.leads where id = p_lead_id;
  select kind into v_kind from public.pipeline_stages where id = l.stage_id;
  if v_kind <> 'won' or l.admitted_course_id is null then
    raise exception 'Payments are only for admitted students.';
  end if;
  if not exists (select 1 from public.lead_negotiations
                 where lead_id = l.id and course_id = l.admitted_course_id and status = 'locked') then
    raise exception 'This course has no fee list. Add it in Settings → Courses first.';
  end if;
  return l;
end;
$$;

create or replace function public.record_payment(
  p_lead_id uuid,
  p_amount  numeric,
  p_method  text,
  p_txn_id  text default null,
  p_paid_at timestamptz default null,
  p_note    text default null
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  l        public.leads := public.fee_admitted_lead(p_lead_id);
  s        jsonb := public.payment_setting();
  v_method jsonb;
  v_txn    text := nullif(trim(coalesce(p_txn_id, '')), '');
  v_at     timestamptz := coalesce(p_paid_at, now());
  v_days   int := coalesce((s ->> 'backdate_days')::int, 7);
  v_due    numeric;
  v_year   int := extract(year from (now() at time zone 'Asia/Dhaka'))::int;
  v_n      int;
  v_prefix text := coalesce(nullif(trim((select value #>> '{}' from public.app_settings where key = 'receipt_prefix')), ''), 'RCP');
  v_no     text;
  v_id     uuid;
begin
  if not public.can_take_payments() then raise exception 'You can''t take payments. Ask an admin.'; end if;
  if p_amount is null or p_amount <= 0 then raise exception 'Please type the amount.'; end if;

  select m into v_method from jsonb_array_elements(coalesce(s -> 'methods', '[]')) m
   where lower(m ->> 'name') = lower(trim(coalesce(p_method, ''))) limit 1;
  if v_method is null then raise exception 'Please choose how it was paid.'; end if;
  if coalesce((v_method ->> 'txn')::boolean, false) and v_txn is null then
    raise exception 'Please type the transaction ID for %.', v_method ->> 'name';
  end if;

  if v_at > now() + interval '5 minutes' then raise exception 'The payment date can''t be in the future.'; end if;
  if v_at < now() - make_interval(days => v_days) and not public.has_permission('settings.manage') then
    raise exception 'Only an admin can enter a payment older than % days.', v_days;
  end if;

  select n.due into v_due from public.lead_fee_numbers(l.id) n;
  if p_amount > v_due then
    raise exception 'That is more than the amount due (%).', public.fee_money(v_due);
  end if;

  insert into public.receipt_counters (year, last) values (v_year, 1)
  on conflict (year) do update set last = public.receipt_counters.last + 1
  returning last into v_n;
  v_no := v_prefix || '-' || v_year || '-' || lpad(v_n::text, 5, '0');

  insert into public.fee_payments (lead_id, course_id, receipt_no, amount, method, txn_id, paid_at, note, received_by)
  values (l.id, l.admitted_course_id, v_no, p_amount, v_method ->> 'name', v_txn, v_at,
          nullif(trim(coalesce(p_note, '')), ''), auth.uid())
  returning id into v_id;

  insert into public.lead_activity (lead_id, user_id, action, details)
  values (l.id, auth.uid(), 'payment_received', jsonb_build_object(
    'payment_id', v_id, 'receipt_no', v_no, 'amount', p_amount, 'method', v_method ->> 'name'));

  return jsonb_build_object('id', v_id, 'receipt_no', v_no, 'due', v_due - p_amount);
end;
$$;

grant execute on function public.record_payment(uuid, numeric, text, text, timestamptz, text) to authenticated;

create or replace function public.void_payment(p_payment_id uuid, p_reason text)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  p public.fee_payments;
  v_reason text := nullif(trim(coalesce(p_reason, '')), '');
begin
  select * into p from public.fee_payments where id = p_payment_id for update;
  if p.id is null or not public.fee_can_see_lead(p.lead_id) then raise exception 'Not found.'; end if;
  if not public.can_void_payments() then raise exception 'You can''t void payments. Ask an admin.'; end if;
  if p.voided_at is not null then raise exception 'This payment is already void.'; end if;
  if v_reason is null then raise exception 'Please write why it is void.'; end if;

  update public.fee_payments set voided_at = now(), voided_by = auth.uid(), void_reason = v_reason where id = p.id;

  insert into public.lead_activity (lead_id, user_id, action, details)
  values (p.lead_id, auth.uid(), 'payment_voided', jsonb_build_object(
    'payment_id', p.id, 'receipt_no', p.receipt_no, 'amount', p.amount, 'reason', v_reason));
end;
$$;

grant execute on function public.void_payment(uuid, text) to authenticated;

-- The installment plan: [{due_date, amount}, …] adding up to the fee; [] removes it
create or replace function public.set_installments(p_lead_id uuid, p_items jsonb)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  l       public.leads := public.fee_admitted_lead(p_lead_id);
  v_fee   numeric;
  v_sum   numeric;
  v_count int := jsonb_array_length(coalesce(p_items, '[]'::jsonb));
begin
  if not public.can_take_payments() then raise exception 'You can''t change payments. Ask an admin.'; end if;
  select n.final_fee into v_fee from public.lead_fee_numbers(l.id) n;

  if v_count > 0 then
    if v_count > 24 then raise exception 'At most 24 installments.'; end if;
    if exists (select 1 from jsonb_array_elements(p_items) x
               where (x ->> 'amount')::numeric is null or (x ->> 'amount')::numeric <= 0 or (x ->> 'due_date') is null) then
      raise exception 'Every installment needs a date and an amount.';
    end if;
    select sum((x ->> 'amount')::numeric) into v_sum from jsonb_array_elements(p_items) x;
    if abs(v_sum - v_fee) > 0.5 then
      raise exception 'The installments add up to %, but the fee is %.', public.fee_money(v_sum), public.fee_money(v_fee);
    end if;
  end if;

  delete from public.fee_installments where lead_id = l.id;
  insert into public.fee_installments (lead_id, course_id, seq, due_date, amount, created_by)
  select l.id, l.admitted_course_id, row_number() over (order by (x ->> 'due_date')::date, ord),
         (x ->> 'due_date')::date, (x ->> 'amount')::numeric, auth.uid()
  from jsonb_array_elements(coalesce(p_items, '[]'::jsonb)) with ordinality as t(x, ord);

  insert into public.lead_activity (lead_id, user_id, action, details)
  values (l.id, auth.uid(), 'installments_set', jsonb_build_object('count', v_count, 'total', v_sum));
end;
$$;

grant execute on function public.set_installments(uuid, jsonb) to authenticated;

notify pgrst, 'reload schema';
