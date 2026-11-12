-- =====================================================================
-- 💰 An admitted student's fee list stays as it was at admission
--   Before: the "full fee" of an admitted student was always worked out
--   from the course's fee list as it is NOW, while the final fee was
--   fixed at admission. A fee added to the course later (e.g. "Online
--   Application ৳1,000") showed up as a discount nobody gave
--   (৳0 → ৳1,000, ৳5,000 → ৳6,000), on the student's card, the list,
--   exports, templates and reports.
--   Now: at admission the course's fee list is kept with the student
--   (list_total + list_items). Students admitted earlier get the full fee
--   of their admission day (the final fee then + the discounts then). A fee changed on the course later
--   does not touch them, unless the Admission Officer / an admin applies
--   the new list to a student (fee_apply_course_list).
-- =====================================================================

alter table public.lead_negotiations
  add column if not exists list_total numeric(12,2),
  add column if not exists list_items jsonb;

-- the course's fee list now: [{id, name, amount, sort_order}] and its total
create or replace function public.fee_course_list(p_course uuid)
returns jsonb
language sql
stable
security definer
set search_path = public
as $$
  select coalesce(jsonb_agg(jsonb_build_object('id', f.id, 'name', f.name, 'amount', f.amount,
                                               'sort_order', f.sort_order) order by f.sort_order, f.created_at), '[]'::jsonb)
  from public.course_fees f where f.course_id = p_course;
$$;
revoke all on function public.fee_course_list(uuid) from public, anon, authenticated;

-- 1. kept when a fee talk is locked (admission), dropped when it opens again
create or replace function public.fee_snapshot_on_lock()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if new.status = 'locked' then
    if tg_op = 'INSERT' or old.status is distinct from 'locked' or new.course_id is distinct from old.course_id
       or new.list_total is null then
      new.list_items := public.fee_course_list(new.course_id);
      new.list_total := coalesce((select sum((x ->> 'amount')::numeric) from jsonb_array_elements(new.list_items) x), 0);
    end if;
  else
    new.list_total := null;
    new.list_items := null;
  end if;
  return new;
end;
$$;

drop trigger if exists lead_negotiations_fee_snapshot on public.lead_negotiations;
create trigger lead_negotiations_fee_snapshot
  before insert or update on public.lead_negotiations
  for each row execute function public.fee_snapshot_on_lock();

-- 2. the full fee: the kept one once admitted, else the course's list now
create or replace function public.negotiation_totals(p_negotiation_id uuid)
returns table (list_total numeric, discount numeric)
language sql
stable
security definer
set search_path = public
as $$
  select
    case when n.status = 'locked' and n.list_total is not null then n.list_total
         else coalesce((select sum(f.amount) from public.course_fees f where f.course_id = n.course_id), 0) end,
    coalesce((select sum(d.amount) from public.fee_discounts d
              where d.negotiation_id = n.id and d.status = 'approved'
                and (d.expires_at is null or d.expires_at > now())), 0)
  from public.lead_negotiations n
  where n.id = p_negotiation_id;
$$;
grant execute on function public.negotiation_totals(uuid) to authenticated;

-- 3. students admitted before this: the list as it was on their admission day
--    The full fee at admission is known for sure: the final fee set then (before any
--    "Change fee" of THIS admission) + the discounts in force then. The fee rows shown:
--    the rows that existed then, if they add up to it; else the rows now, if they do;
--    else one "Course fee" line with that amount.
--    (the lead's own fee numbers are worked out once at the end; one odd lead row does
--    not stop the others)
alter table public.lead_negotiations disable trigger lead_negotiations_sync_fee;
do $$
declare
  n        record;
  v_items  jsonb;
  v_then   numeric;
  v_now_i  jsonb;
  v_now    numeric;
  v_first  numeric;
  v_disc   numeric;
  v_list   numeric;
begin
  for n in select * from public.lead_negotiations where status = 'locked' and list_total is null loop
    select coalesce(jsonb_agg(jsonb_build_object('id', f.id, 'name', f.name, 'amount', f.amount, 'sort_order', f.sort_order)
                              order by f.sort_order, f.created_at), '[]'::jsonb),
           coalesce(sum(f.amount), 0)
      into v_items, v_then
      from public.course_fees f
     where f.course_id = n.course_id and f.created_at <= coalesce(n.locked_at, now());
    v_now_i := public.fee_course_list(n.course_id);
    v_now := coalesce((select sum((x ->> 'amount')::numeric) from jsonb_array_elements(v_now_i) x), 0);

    -- the final fee set at THIS admission (before a "Change fee" after it)
    select (a.details ->> 'from')::numeric into v_first
      from public.lead_activity a
     where a.lead_id = n.lead_id and a.action = 'final_fee_changed' and a.details ? 'from'
       and a.created_at >= coalesce(n.locked_at, '-infinity'::timestamptz)
     order by a.created_at limit 1;
    v_first := coalesce(v_first, n.final_total, 0);
    select coalesce(sum(d.amount), 0) into v_disc
      from public.fee_discounts d
     where d.negotiation_id = n.id and d.status = 'approved'
       and (d.expires_at is null or d.expires_at > coalesce(n.locked_at, now()));

    -- never below the final fee (a discount can't be negative)
    v_list := greatest(v_first + v_disc, coalesce(n.final_total, 0));

    update public.lead_negotiations
       set list_total = v_list,
           list_items = case when abs(v_then - v_list) < 0.5 and jsonb_array_length(v_items) > 0 then v_items
                             when abs(v_now - v_list) < 0.5 and jsonb_array_length(v_now_i) > 0 then v_now_i
                             else jsonb_build_array(jsonb_build_object('id', null, 'name', 'Course fee',
                                                                       'amount', v_list, 'sort_order', 0)) end
     where id = n.id;
  end loop;
end;
$$;
alter table public.lead_negotiations enable trigger lead_negotiations_sync_fee;

-- every admitted student's fee on the list (badge, filter, export, templates) again
do $$
declare r record;
begin
  for r in select distinct lead_id from public.lead_negotiations where status = 'locked' loop
    begin
      perform public.refresh_lead_fee(r.lead_id);
    exception when others then
      raise notice 'fee of lead % not refreshed: %', r.lead_id, sqlerrm;
    end;
  end loop;
end;
$$;

-- 4. the Admission Officer / an admin puts a student on the course's NEW fee list
--    (e.g. a fee every student should pay was added after they were admitted).
--    The discount stays the same amount; not below what is paid.
create or replace function public.fee_apply_course_list(p_lead uuid, p_reason text default null)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  l        public.leads := public.admitted_lead(p_lead);
  n        public.lead_negotiations;
  v_items  jsonb;
  v_new    numeric;
  v_disc   numeric;
  v_final  numeric;
  v_paid   numeric;
begin
  if not public.can_approve_admission() then
    raise exception 'Only the Admission Officer (or an admin) can change the fee.';
  end if;
  if l.cancelled_at is not null then raise exception 'This admission is cancelled.'; end if;
  select * into n from public.lead_negotiations
   where lead_id = l.id and course_id = l.admitted_course_id and status = 'locked';
  if n.id is null then raise exception 'This course has no fee list. Add it in Settings → Courses first.'; end if;

  v_items := public.fee_course_list(n.course_id);
  v_new := coalesce((select sum((x ->> 'amount')::numeric) from jsonb_array_elements(v_items) x), 0);
  if jsonb_array_length(v_items) = 0 then
    raise exception 'This course has no fee list now. Add it in Settings → Courses first.';
  end if;
  if v_new = coalesce(n.list_total, -1) then return jsonb_build_object('changed', false); end if;

  v_disc := greatest(coalesce(n.list_total, v_new) - coalesce(n.final_total, 0), 0);
  v_final := greatest(v_new - v_disc, 0);
  select coalesce(paid, 0) into v_paid from public.lead_fee_numbers(l.id);
  if v_final < v_paid then
    raise exception 'The new final fee (%) would be less than what is paid (%). Refund first.',
      public.fee_money(v_final), public.fee_money(v_paid);
  end if;

  update public.lead_negotiations
     set list_items = v_items, list_total = v_new, final_total = v_final
   where id = n.id;

  insert into public.lead_activity (lead_id, user_id, action, details)
  values (l.id, auth.uid(), 'final_fee_changed', jsonb_build_object(
    'from', n.final_total, 'to', v_final,
    'discount_from', v_disc, 'discount_to', v_disc,
    'full', v_new, 'full_from', n.list_total,
    'reason', coalesce(nullif(trim(p_reason), ''), 'কোর্সের নতুন ফি তালিকা')));

  return jsonb_build_object('changed', true, 'full', v_new, 'final', v_final,
    'installments_off', exists (select 1 from public.fee_installments where lead_id = l.id)
                        and abs(coalesce((select sum(amount) from public.fee_installments where lead_id = l.id), 0) - v_final) > 0.5);
end;
$$;
revoke all on function public.fee_apply_course_list(uuid, text) from public, anon;
grant execute on function public.fee_apply_course_list(uuid, text) to authenticated;

notify pgrst, 'reload schema';
