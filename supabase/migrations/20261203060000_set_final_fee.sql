-- =====================================================================
-- 💰 The Admission Officer changes an admitted student's final fee
--   (= full fee − total discount), before or after approving.
--   Who: the Admission Officer (Settings → Admission approval) or an admin.
--   A reason is needed. Not below what is already paid (refund first),
--   not above the full fee, not for a cancelled admission. The due and
--   everything built on it follow by themselves. An installment plan is
--   left as it is (the answer says if it no longer adds up).
-- =====================================================================

create or replace function public.set_final_fee(p_lead uuid, p_final numeric, p_reason text)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  l        public.leads := public.admitted_lead(p_lead);
  n        public.lead_negotiations;
  v_list   numeric;
  v_paid   numeric;
  v_final  numeric := round(coalesce(p_final, -1), 2);
  v_reason text := nullif(trim(coalesce(p_reason, '')), '');
  v_plan   numeric;
begin
  if not public.can_approve_admission() then
    raise exception 'Only the Admission Officer (or an admin) can change the fee.';
  end if;
  if l.cancelled_at is not null then raise exception 'This admission is cancelled.'; end if;
  if v_reason is null then raise exception 'Please write why the fee changes.'; end if;

  select * into n from public.lead_negotiations
   where lead_id = l.id and course_id = l.admitted_course_id and status = 'locked';
  if n.id is null then raise exception 'This course has no fee list. Add it in Settings → Courses first.'; end if;

  select t.list_total into v_list from public.negotiation_totals(n.id) t;
  select coalesce(paid, 0) into v_paid from public.lead_fee_numbers(l.id);

  if v_final < 0 then raise exception 'The final fee can''t be less than ৳0.'; end if;
  if v_final > v_list then
    raise exception 'The final fee can''t be more than the full fee (%).', public.fee_money(v_list);
  end if;
  if v_final < v_paid then
    raise exception 'The final fee can''t be less than what is paid (%). Refund first.', public.fee_money(v_paid);
  end if;
  if v_final = n.final_total then
    return jsonb_build_object('changed', false);
  end if;

  update public.lead_negotiations set final_total = v_final where id = n.id;

  insert into public.lead_activity (lead_id, user_id, action, details)
  values (l.id, auth.uid(), 'final_fee_changed', jsonb_build_object(
    'from', n.final_total, 'to', v_final,
    'discount_from', greatest(v_list - coalesce(n.final_total, v_list), 0),
    'discount_to', v_list - v_final,
    'full', v_list, 'reason', v_reason));

  select sum(amount) into v_plan from public.fee_installments where lead_id = l.id;
  return jsonb_build_object(
    'changed', true,
    'installments_off', v_plan is not null and abs(v_plan - v_final) > 0.5);
end;
$$;

grant execute on function public.set_final_fee(uuid, numeric, text) to authenticated;

notify pgrst, 'reload schema';
