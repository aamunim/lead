-- =====================================================================
-- 💰 Fee & discount on the lead itself (for the list: badge, filter, sort,
-- export, templates). Kept up to date by the database, like visit_status.
--   fee_status   negotiating | discount_waiting | discount_given | final
--   fee_full     the course's full fee
--   fee_discount discounts in force
--   fee_final    what is left to pay (the locked fee after admission)
--   fee_updated_at  the last fee talk / discount change
--   The negotiation shown: the one locked at admission, else the latest one.
-- =====================================================================

alter table public.leads
  add column if not exists fee_status     text,
  add column if not exists fee_full       numeric(12,2),
  add column if not exists fee_discount   numeric(12,2),
  add column if not exists fee_final      numeric(12,2),
  add column if not exists fee_updated_at timestamptz;

create index if not exists leads_fee_status_idx on public.leads (fee_status) where fee_status is not null;

create or replace function public.refresh_lead_fee(p_lead_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  n          public.lead_negotiations;
  v_list     numeric;
  v_disc     numeric;
  v_status   text;
  v_waiting  boolean;
  v_updated  timestamptz;
begin
  select * into n from public.lead_negotiations
   where lead_id = p_lead_id
   order by (status = 'locked') desc, started_at desc
   limit 1;

  if n.id is null then
    update public.leads
       set fee_status = null, fee_full = null, fee_discount = null, fee_final = null, fee_updated_at = null
     where id = p_lead_id and fee_status is not null;
    return;
  end if;

  select t.list_total, t.discount into v_list, v_disc from public.negotiation_totals(n.id) t;

  select exists (select 1 from public.fee_discounts d
                 join public.lead_negotiations x on x.id = d.negotiation_id and x.status = 'open'
                 where d.lead_id = p_lead_id and d.status = 'pending')
    into v_waiting;

  select greatest(
           max(x.started_at), max(x.locked_at),
           (select max(e.created_at) from public.negotiation_events e where e.lead_id = p_lead_id),
           (select max(greatest(d.requested_at, coalesce(d.decided_at, d.requested_at)))
              from public.fee_discounts d where d.lead_id = p_lead_id))
    into v_updated
    from public.lead_negotiations x where x.lead_id = p_lead_id;

  if n.status = 'locked' then
    v_status := 'final';
  elsif v_waiting then
    v_status := 'discount_waiting';
  elsif v_disc > 0 then
    v_status := 'discount_given';
  else
    v_status := 'negotiating';
  end if;

  update public.leads
     set fee_status     = v_status,
         fee_full       = v_list,
         fee_discount   = case when n.status = 'locked' then greatest(v_list - coalesce(n.final_total, v_list), 0) else v_disc end,
         fee_final      = case when n.status = 'locked' then n.final_total else greatest(v_list - v_disc, 0) end,
         fee_updated_at = v_updated
   where id = p_lead_id
     and (fee_status, fee_full, fee_discount, fee_final, fee_updated_at)
         is distinct from
         (v_status, v_list,
          case when n.status = 'locked' then greatest(v_list - coalesce(n.final_total, v_list), 0) else v_disc end,
          case when n.status = 'locked' then n.final_total else greatest(v_list - v_disc, 0) end,
          v_updated);
end;
$$;

create or replace function public.sync_lead_fee()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  perform public.refresh_lead_fee(coalesce(new.lead_id, old.lead_id));
  return null;
end;
$$;

drop trigger if exists lead_negotiations_sync_fee on public.lead_negotiations;
create trigger lead_negotiations_sync_fee
  after insert or update or delete on public.lead_negotiations
  for each row execute function public.sync_lead_fee();

drop trigger if exists negotiation_events_sync_fee on public.negotiation_events;
create trigger negotiation_events_sync_fee
  after insert or delete on public.negotiation_events
  for each row execute function public.sync_lead_fee();

drop trigger if exists fee_discounts_sync_fee on public.fee_discounts;
create trigger fee_discounts_sync_fee
  after insert or update or delete on public.fee_discounts
  for each row execute function public.sync_lead_fee();

-- A course's fee list changed: the open negotiations' numbers change too
create or replace function public.sync_course_fee()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  r record;
begin
  for r in
    select distinct n.lead_id from public.lead_negotiations n
    where n.course_id = coalesce(new.course_id, old.course_id) and n.status = 'open'
  loop
    perform public.refresh_lead_fee(r.lead_id);
  end loop;
  return null;
end;
$$;

drop trigger if exists course_fees_sync_lead_fee on public.course_fees;
create trigger course_fees_sync_lead_fee
  after insert or update or delete on public.course_fees
  for each row execute function public.sync_course_fee();

-- Approved discounts that ran out: message (as before) and fix the lead's numbers
create or replace function public.fee_discounts_tick()
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  r record;
begin
  for r in
    select d.id, d.amount, d.fee_name, d.requested_by, l.id as lead_id, l.name
    from public.fee_discounts d
    join public.lead_negotiations n on n.id = d.negotiation_id and n.status = 'open'
    join public.leads l on l.id = d.lead_id and l.deleted_at is null
    where d.status = 'approved'
      and d.expires_at <= now() and d.expires_at > now() - interval '1 day'
  loop
    if r.requested_by is not null then
      perform public.notify(r.requested_by, 'discount', '⌛ Discount ran out: ' || r.name,
        public.fee_money(r.amount) || ' off ' || coalesce(r.fee_name, 'the fee') || ' is no longer valid. Ask again if needed.',
        jsonb_build_object('lead_id', r.lead_id), 'disc-exp:' || r.id);
    end if;
    perform public.refresh_lead_fee(r.lead_id);
  end loop;
end;
$$;

-- The ones already there
do $$
declare
  r record;
begin
  for r in select distinct lead_id from public.lead_negotiations loop
    perform public.refresh_lead_fee(r.lead_id);
  end loop;
end;
$$;

-- Waiting discount requests I may answer (Home card, More badge)
create or replace function public.discounts_to_answer()
returns integer
language sql
stable
security definer
set search_path = public
as $$
  select count(*)::int from public.discount_queue() q
  where q.can_approve and q.requested_by is distinct from auth.uid();
$$;

grant execute on function public.discounts_to_answer() to authenticated;

-- A ready-made message with the agreed fee ({final_fee}, {discount}, {full_fee})
insert into public.message_templates (name, category, channels, is_shared, owner_id, sort_order, body)
select '💰 Fee confirmed', 'Fee', 'both', true, null, 7,
       E'{first_name}, {course}-এর ফি:\nমোট ফি: {full_fee}\nছাড়: {discount}\nআপনাকে দিতে হবে: {final_fee}\n\nভর্তির জন্য যোগাযোগ করুন: {my_phone}\n— {my_name}, {institute}'
where not exists (select 1 from public.message_templates where name = '💰 Fee confirmed');

notify pgrst, 'reload schema';
