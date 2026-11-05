-- =====================================================================
-- ⚡ Home in one request: today's numbers and the little counts
--   (talk time, new leads, admitted, money taken, unread 🔔, discounts
--   to answer, people waiting to be let in, the officer's ITTC work).
--   It runs as the person (security invoker), so the same access rules
--   decide what is counted, exactly like the separate requests did.
--   p_me: count only my own (null = the whole team, as Home shows it)
-- =====================================================================

create or replace function public.home_summary(p_me uuid default null, p_start timestamptz default null)
returns jsonb
language plpgsql
stable
security invoker
set search_path = public
as $$
declare
  v_start timestamptz := coalesce(p_start, date_trunc('day', now()));
  v_talk  numeric;
  v_leads int;
  v_adm   int;
  v_taken numeric;
  v_unread int;
  v_disc  int := 0;
  v_pending int := 0;
  v_not_sub int := 0;
  v_ready int := 0;
begin
  select coalesce(sum(duration_sec), 0) into v_talk
  from public.call_logs
  where outcome = 'connected' and called_at >= v_start and (p_me is null or user_id = p_me);

  select count(*) into v_leads from public.leads
  where deleted_at is null and created_at >= v_start and (p_me is null or created_by = p_me);

  select count(*) into v_adm from public.leads
  where deleted_at is null and admitted_at >= v_start and (p_me is null or admitted_by = p_me);

  select coalesce(sum(case when kind = 'refund' then -amount else amount end), 0) into v_taken
  from public.fee_payments where voided_at is null and paid_at >= v_start;

  select count(*) into v_unread from public.notifications where read_at is null;

  begin
    v_disc := coalesce(public.discounts_to_answer(), 0);
  exception when others then v_disc := 0;
  end;

  if public.has_permission('users.manage') then
    select count(*) into v_pending from public.profiles where not is_active and deactivated_at is null;
  end if;

  if public.can_approve_admission() then
    select count(*) filter (where submitted_at is null),
           count(*) filter (where submitted_at is not null and received_at is null and admission_fee_ok)
      into v_not_sub, v_ready
    from public.leads
    where admitted_at is not null and deleted_at is null and cancelled_at is null;
  end if;

  return jsonb_build_object(
    'talk_min', round(v_talk / 60),
    'leads_today', v_leads,
    'admitted_today', v_adm,
    'taken_today', v_taken,
    'unread', v_unread,
    'discounts', v_disc,
    'pending_users', v_pending,
    'ittc_not_submitted', v_not_sub,
    'ittc_ready', v_ready);
end;
$$;
grant execute on function public.home_summary(uuid, timestamptz) to authenticated;

notify pgrst, 'reload schema';
