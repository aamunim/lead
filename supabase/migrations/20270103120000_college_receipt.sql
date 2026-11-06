-- =====================================================================
-- 🧾 College receipt no.: the number on the college's own (paper) receipt,
--   kept with each payment and printed on our receipt.
--   * typed when taking the payment, or added / changed later
--   * one number is used once (void payments aside)
-- =====================================================================

alter table public.fee_payments add column if not exists college_receipt_no text;

create index if not exists fee_payments_college_receipt_idx
  on public.fee_payments (lower(college_receipt_no))
  where college_receipt_no is not null and voided_at is null;

-- The same number on two live payments?
create or replace function public.college_receipt_taken(p_no text, p_except uuid default null)
returns text
language sql
stable
security definer
set search_path = public
as $$
  select p.receipt_no
  from public.fee_payments p
  where p.college_receipt_no is not null
    and lower(p.college_receipt_no) = lower(trim(p_no))
    and p.voided_at is null
    and (p_except is null or p.id <> p_except)
  limit 1;
$$;

-- ---------------------------------------------------------------------
-- record_payment: + p_college_receipt (optional)
-- ---------------------------------------------------------------------
drop function if exists public.record_payment(uuid, numeric, text, text, timestamptz, text);

create or replace function public.record_payment(
  p_lead_id uuid,
  p_amount  numeric,
  p_method  text,
  p_txn_id  text default null,
  p_paid_at timestamptz default null,
  p_note    text default null,
  p_college_receipt text default null
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
  v_college text := nullif(trim(coalesce(p_college_receipt, '')), '');
  v_taken  text;
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

  if v_college is not null then
    v_taken := public.college_receipt_taken(v_college);
    if v_taken is not null then
      raise exception 'College receipt no. % is already on %.', v_college, v_taken;
    end if;
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

  insert into public.fee_payments (lead_id, course_id, receipt_no, amount, method, txn_id, paid_at, note, received_by, college_receipt_no)
  values (l.id, l.admitted_course_id, v_no, p_amount, v_method ->> 'name', v_txn, v_at,
          nullif(trim(coalesce(p_note, '')), ''), auth.uid(), v_college)
  returning id into v_id;

  insert into public.lead_activity (lead_id, user_id, action, details)
  values (l.id, auth.uid(), 'payment_received', jsonb_strip_nulls(jsonb_build_object(
    'payment_id', v_id, 'receipt_no', v_no, 'amount', p_amount, 'method', v_method ->> 'name',
    'college_receipt_no', v_college)));

  return jsonb_build_object('id', v_id, 'receipt_no', v_no, 'due', v_due - p_amount);
end;
$$;

revoke all on function public.record_payment(uuid, numeric, text, text, timestamptz, text, text) from public;
grant execute on function public.record_payment(uuid, numeric, text, text, timestamptz, text, text) to authenticated;

-- ---------------------------------------------------------------------
-- Add or change it later (the people who take payments)
-- ---------------------------------------------------------------------
create or replace function public.set_college_receipt(p_payment_id uuid, p_no text)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  p       public.fee_payments;
  v_no    text := nullif(trim(coalesce(p_no, '')), '');
  v_taken text;
begin
  select * into p from public.fee_payments where id = p_payment_id for update;
  if p.id is null or not public.fee_can_see_lead(p.lead_id) then raise exception 'Not found.'; end if;
  if not public.can_take_payments() then raise exception 'You can''t take payments. Ask an admin.'; end if;
  if p.voided_at is not null then raise exception 'This payment is void.'; end if;
  if v_no is not distinct from p.college_receipt_no then return; end if;

  if v_no is not null then
    v_taken := public.college_receipt_taken(v_no, p.id);
    if v_taken is not null then
      raise exception 'College receipt no. % is already on %.', v_no, v_taken;
    end if;
  end if;

  update public.fee_payments set college_receipt_no = v_no where id = p.id;

  insert into public.lead_activity (lead_id, user_id, action, details)
  values (p.lead_id, auth.uid(), 'college_receipt_set', jsonb_build_object(
    'receipt_no', p.receipt_no, 'from', p.college_receipt_no, 'to', v_no));
end;
$$;

revoke all on function public.set_college_receipt(uuid, text) from public;
grant execute on function public.set_college_receipt(uuid, text) to authenticated;
