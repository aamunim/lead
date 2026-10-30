-- =====================================================================
-- 💰 Fee negotiation and discounts (before admission)
--   1. Settings (app_settings 'fees'): on/off, who may use it, how much
--      discount each role may give (% of the course fee), how long an
--      approved discount stays valid, discount reasons
--   2. lead_negotiations: one per lead + course; locked at admission with
--      the final fee, open again if the admission is cancelled
--   3. negotiation_events: "We quoted ৳35,000 → Lead asked ৳30,000 → …"
--   4. fee_discounts: on one fee item or the whole fee, in taka or %;
--      within the person's limit → approved at once, else it waits for a
--      Team Lead / admin with a high enough limit
--   5. Functions: start_negotiation (moves New / Contacted → Interested),
--      add_negotiation_event, request_discount, decide_discount,
--      cancel_discount, discount_queue
--   6. Notifications: request → approvers, decision → the requester,
--      an approved discount running out → the requester
--   Only open leads: discounts can't be given after admission.
-- =====================================================================

-- ---------------------------------------------------------------------
-- 1. Settings
-- ---------------------------------------------------------------------
insert into public.app_settings (key, value)
values ('fees', jsonb_build_object(
  'enabled', true,
  'who', jsonb_build_object('mode', 'all', 'roles', '[]'::jsonb, 'user_ids', '[]'::jsonb),
  -- % of the course fee each role may give without asking (admins: no limit)
  'limits', jsonb_build_object('caller', 0, 'team_lead', 10),
  'valid_days', 7,                   -- 0 = an approved discount never runs out
  'reasons', jsonb_build_array('Financial problem', 'Sibling', 'Early bird', 'Referral', 'Merit', 'Other'),
  'reason_required', true
))
on conflict (key) do nothing;

create or replace function public.fee_setting()
returns jsonb
language sql
stable
security definer
set search_path = public
as $$
  select jsonb_build_object(
           'enabled', true,
           'who', jsonb_build_object('mode', 'all', 'roles', '[]'::jsonb, 'user_ids', '[]'::jsonb),
           'limits', jsonb_build_object('caller', 0, 'team_lead', 10),
           'valid_days', 7,
           'reasons', '[]'::jsonb,
           'reason_required', true
         ) || coalesce((select value from public.app_settings where key = 'fees'), '{}'::jsonb);
$$;

-- May this person use fee negotiation? (the feature on, and the "who" rule;
-- admins always may)
create or replace function public.can_use_fees(p_user uuid default auth.uid())
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  with s as (select public.fee_setting() as v),
       p as (select pr.role_key, r.permissions from public.profiles pr
             join public.roles r on r.key = pr.role_key
             where pr.id = p_user and pr.is_active)
  select exists (select 1 from p)
     and coalesce((select (v->>'enabled')::boolean from s), true)
     and case
           when (select '*' = any (permissions) or 'settings.manage' = any (permissions)
                        or 'discounts.approve' = any (permissions) from p) then true
           else case coalesce((select v->'who'->>'mode' from s), 'all')
           when 'roles' then (select role_key from p) in
                             (select jsonb_array_elements_text(coalesce((select v->'who'->'roles' from s), '[]')))
           when 'users' then p_user::text in
                             (select jsonb_array_elements_text(coalesce((select v->'who'->'user_ids' from s), '[]')))
           else true
         end
         end;
$$;

grant execute on function public.can_use_fees(uuid) to authenticated;

-- How much discount (% of the course fee) a person may give or approve.
--   Super Admin / discounts.approve: 100 (no limit); others: the setting for their role.
create or replace function public.discount_limit(p_user uuid default auth.uid())
returns numeric
language sql
stable
security definer
set search_path = public
as $$
  select case
           when r.key is null then 0
           when '*' = any (r.permissions) or 'discounts.approve' = any (r.permissions) then 100
           else least(100, greatest(0, coalesce((public.fee_setting() -> 'limits' ->> r.key)::numeric, 0)))
         end
  from (select 1) one
  left join public.profiles p on p.id = p_user and p.is_active
  left join public.roles r on r.key = p.role_key;
$$;

grant execute on function public.discount_limit(uuid) to authenticated;

-- Can I see this lead? (same as the leads list: my own, my team's, all, or shared mode)
create or replace function public.fee_can_see_lead(p_lead_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select public.is_active_user() and exists (
    select 1 from public.leads l
    where l.id = p_lead_id and l.deleted_at is null
      and (public.can_view_lead(l.assigned_to) or public.leads_shared_mode() or l.created_by = auth.uid())
  );
$$;

-- ---------------------------------------------------------------------
-- 2–4. Tables (read through row security; written only by the functions below)
-- ---------------------------------------------------------------------
create table if not exists public.lead_negotiations (
  id          uuid primary key default gen_random_uuid(),
  lead_id     uuid not null references public.leads(id) on delete cascade,
  course_id   uuid not null references public.courses(id) on delete cascade,
  status      text not null default 'open' check (status in ('open', 'locked')),
  final_total numeric(12,2),            -- set when the lead is admitted to this course
  locked_at   timestamptz,
  started_by  uuid references public.profiles(id) on delete set null,
  started_at  timestamptz not null default now(),
  unique (lead_id, course_id)
);

create table if not exists public.negotiation_events (
  id             uuid primary key default gen_random_uuid(),
  negotiation_id uuid not null references public.lead_negotiations(id) on delete cascade,
  lead_id        uuid not null references public.leads(id) on delete cascade,
  kind           text not null check (kind in ('quoted', 'lead_asked', 'offer', 'note')),
  amount         numeric(12,2) check (amount is null or amount >= 0),
  note           text,
  created_by     uuid references public.profiles(id) on delete set null,
  created_at     timestamptz not null default now()
);

create index if not exists negotiation_events_neg_idx on public.negotiation_events (negotiation_id, created_at);

create table if not exists public.fee_discounts (
  id             uuid primary key default gen_random_uuid(),
  negotiation_id uuid not null references public.lead_negotiations(id) on delete cascade,
  lead_id        uuid not null references public.leads(id) on delete cascade,
  fee_id         uuid references public.course_fees(id) on delete set null,   -- null = on the whole fee
  fee_name       text,                                                        -- kept in case the fee item is removed
  kind           text not null check (kind in ('amount', 'percent')),
  value          numeric(12,2) not null check (value > 0),
  amount         numeric(12,2) not null check (amount > 0),                   -- in taka
  reason         text,
  note           text,
  status         text not null default 'pending'
                 check (status in ('pending', 'approved', 'rejected', 'cancelled')),
  requested_by   uuid references public.profiles(id) on delete set null,
  requested_at   timestamptz not null default now(),
  decided_by     uuid references public.profiles(id) on delete set null,
  decided_at     timestamptz,
  decision_note  text,
  expires_at     timestamptz                                                  -- null = doesn't run out
);

create index if not exists fee_discounts_neg_idx on public.fee_discounts (negotiation_id);
create index if not exists fee_discounts_pending_idx on public.fee_discounts (requested_at) where status = 'pending';

alter table public.lead_negotiations  enable row level security;
alter table public.negotiation_events enable row level security;
alter table public.fee_discounts      enable row level security;

drop policy if exists "lead_negotiations: view" on public.lead_negotiations;
create policy "lead_negotiations: view" on public.lead_negotiations for select to authenticated
  using (public.fee_can_see_lead(lead_id));

drop policy if exists "negotiation_events: view" on public.negotiation_events;
create policy "negotiation_events: view" on public.negotiation_events for select to authenticated
  using (public.fee_can_see_lead(lead_id));

drop policy if exists "fee_discounts: view" on public.fee_discounts;
create policy "fee_discounts: view" on public.fee_discounts for select to authenticated
  using (public.fee_can_see_lead(lead_id));

-- ---------------------------------------------------------------------
-- Helpers
-- ---------------------------------------------------------------------
-- The course's full fee, and the discounts in force (approved, not run out)
create or replace function public.negotiation_totals(p_negotiation_id uuid)
returns table (list_total numeric, discount numeric)
language sql
stable
security definer
set search_path = public
as $$
  select
    coalesce((select sum(f.amount) from public.course_fees f where f.course_id = n.course_id), 0),
    coalesce((select sum(d.amount) from public.fee_discounts d
              where d.negotiation_id = n.id and d.status = 'approved'
                and (d.expires_at is null or d.expires_at > now())), 0)
  from public.lead_negotiations n
  where n.id = p_negotiation_id;
$$;

grant execute on function public.negotiation_totals(uuid) to authenticated;

-- The negotiation, if I may work on it now (open lead, open negotiation)
create or replace function public.fee_open_negotiation(p_negotiation_id uuid)
returns public.lead_negotiations
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  n      public.lead_negotiations;
  v_kind text;
begin
  if not public.can_use_fees() then raise exception 'Fee negotiation is off for you. Ask an admin.'; end if;
  select * into n from public.lead_negotiations where id = p_negotiation_id;
  if n.id is null or not public.fee_can_see_lead(n.lead_id) then raise exception 'Not found.'; end if;
  select s.kind into v_kind
  from public.leads l join public.pipeline_stages s on s.id = l.stage_id
  where l.id = n.lead_id;
  if v_kind = 'won' or n.status = 'locked' then
    raise exception 'This lead is admitted: the fee is final now.';
  end if;
  if v_kind <> 'open' then raise exception 'This lead is closed. Reopen it first.'; end if;
  return n;
end;
$$;

create or replace function public.fee_money(p numeric)
returns text
language sql
immutable
as $$
  select '৳' || to_char(round(p), 'FM99,99,99,999');
$$;

-- ---------------------------------------------------------------------
-- 5. Functions
-- ---------------------------------------------------------------------
-- Start (or open again) the negotiation for a course. New / Contacted → Interested.
create or replace function public.start_negotiation(p_lead_id uuid, p_course_id uuid)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_id         uuid;
  v_kind       text;
  v_stage_key  text;
  v_interested uuid;
  v_course     text;
begin
  if not public.can_use_fees() then raise exception 'Fee negotiation is off for you. Ask an admin.'; end if;
  if not public.fee_can_see_lead(p_lead_id) then raise exception 'Lead not found.'; end if;

  select s.kind, s.key into v_kind, v_stage_key
  from public.leads l join public.pipeline_stages s on s.id = l.stage_id
  where l.id = p_lead_id;
  if v_kind = 'won' then raise exception 'This lead is already admitted.'; end if;
  if v_kind <> 'open' then raise exception 'This lead is closed. Reopen it first.'; end if;

  select name into v_course from public.courses where id = p_course_id;
  if v_course is null then raise exception 'Course not found.'; end if;
  if not exists (select 1 from public.course_fees where course_id = p_course_id) then
    raise exception 'There is no fee list for %. Add it in Settings → Courses first.', v_course;
  end if;

  select id into v_id from public.lead_negotiations where lead_id = p_lead_id and course_id = p_course_id;
  if v_id is not null then return v_id; end if;

  insert into public.lead_negotiations (lead_id, course_id, started_by)
  values (p_lead_id, p_course_id, auth.uid())
  returning id into v_id;

  -- The course on the lead too (if it isn't there yet)
  insert into public.lead_courses (lead_id, course_id)
  select p_lead_id, p_course_id
  where not exists (select 1 from public.lead_courses where lead_id = p_lead_id and course_id = p_course_id);

  insert into public.lead_activity (lead_id, user_id, action, details)
  values (p_lead_id, auth.uid(), 'negotiation_started', jsonb_build_object('course', v_course));

  -- Talking about the fee = interested (only moves forward, never back)
  if v_stage_key in ('new', 'contacted') then
    select id into v_interested from public.pipeline_stages where key = 'interested' and kind = 'open' and is_active;
    if v_interested is not null then
      perform set_config('app.stage_note', 'Fee negotiation started', true);
      update public.leads set stage_id = v_interested where id = p_lead_id;
      perform set_config('app.stage_note', '', true);
    end if;
  end if;

  return v_id;
end;
$$;

grant execute on function public.start_negotiation(uuid, uuid) to authenticated;

-- "We quoted / Lead asked / We offered ৳…", or a note
create or replace function public.add_negotiation_event(
  p_negotiation_id uuid,
  p_kind           text,
  p_amount         numeric default null,
  p_note           text default null
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  n    public.lead_negotiations := public.fee_open_negotiation(p_negotiation_id);
  v_id uuid;
  v_note text := nullif(trim(coalesce(p_note, '')), '');
begin
  if p_kind not in ('quoted', 'lead_asked', 'offer', 'note') then raise exception 'Unknown entry.'; end if;
  if p_kind = 'note' and v_note is null then raise exception 'Please write the note.'; end if;
  if p_kind <> 'note' and (p_amount is null or p_amount <= 0) then raise exception 'Please type the amount.'; end if;

  insert into public.negotiation_events (negotiation_id, lead_id, kind, amount, note, created_by)
  values (n.id, n.lead_id, p_kind, case when p_kind = 'note' then null else p_amount end, v_note, auth.uid())
  returning id into v_id;

  insert into public.lead_activity (lead_id, user_id, action, details)
  values (n.lead_id, auth.uid(), 'negotiation_event', jsonb_build_object(
    'kind', p_kind, 'amount', case when p_kind = 'note' then null else p_amount end, 'note', v_note,
    'course', (select name from public.courses where id = n.course_id)));

  return v_id;
end;
$$;

grant execute on function public.add_negotiation_event(uuid, text, numeric, text) to authenticated;

-- Ask for a discount. Within my limit → approved now; else it waits for approval.
--   p_fee_id: one fee item, or null for the whole fee; p_kind: 'amount' (taka) | 'percent'
create or replace function public.request_discount(
  p_negotiation_id uuid,
  p_fee_id         uuid,
  p_kind           text,
  p_value          numeric,
  p_reason         text default null,
  p_note           text default null
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  n          public.lead_negotiations := public.fee_open_negotiation(p_negotiation_id);
  s          jsonb := public.fee_setting();
  v_list     numeric;
  v_active   numeric;
  v_base     numeric;
  v_fee_name text;
  v_amount   numeric;
  v_pct      numeric;
  v_status   text;
  v_days     int := coalesce((s ->> 'valid_days')::int, 7);
  v_expires  timestamptz;
  v_id       uuid;
  v_reason   text := nullif(trim(coalesce(p_reason, '')), '');
  v_note     text := nullif(trim(coalesce(p_note, '')), '');
  v_lead     record;
  v_course   text;
  v_body     text;
  r          record;
begin
  if p_kind not in ('amount', 'percent') then raise exception 'Choose taka or %%.'; end if;
  if p_value is null or p_value <= 0 then raise exception 'Please type the discount.'; end if;
  if p_kind = 'percent' and p_value > 100 then raise exception 'A discount can''t be more than 100%%.'; end if;
  if coalesce((s ->> 'reason_required')::boolean, true) and v_reason is null then
    raise exception 'Please choose a reason.';
  end if;

  select t.list_total, t.discount into v_list, v_active from public.negotiation_totals(n.id) t;

  if p_fee_id is null then
    v_base := v_list;
  else
    select amount, name into v_base, v_fee_name from public.course_fees where id = p_fee_id and course_id = n.course_id;
    if v_base is null then raise exception 'Fee item not found.'; end if;
  end if;

  v_amount := round(case when p_kind = 'percent' then v_base * p_value / 100 else p_value end, 2);
  if v_amount <= 0 then raise exception 'The discount comes to ৳0.'; end if;
  if v_amount > v_base then raise exception 'The discount is more than the fee (%).', public.fee_money(v_base); end if;
  if v_active + v_amount > v_list then
    raise exception 'All discounts together would be more than the full fee (%).', public.fee_money(v_list);
  end if;

  -- All discounts in force + this one, as % of the full fee
  v_pct := case when v_list > 0 then round((v_active + v_amount) * 100 / v_list, 2) else 100 end;

  if public.discount_limit() >= v_pct then
    v_status := 'approved';
    v_expires := case when v_days > 0 then now() + make_interval(days => v_days) end;
  else
    v_status := 'pending';
  end if;

  insert into public.fee_discounts (negotiation_id, lead_id, fee_id, fee_name, kind, value, amount, reason, note,
                                    status, requested_by, decided_by, decided_at, expires_at)
  values (n.id, n.lead_id, p_fee_id, v_fee_name, p_kind, p_value, v_amount, v_reason, v_note,
          v_status, auth.uid(),
          case when v_status = 'approved' then auth.uid() end,
          case when v_status = 'approved' then now() end,
          v_expires)
  returning id into v_id;

  select name into v_course from public.courses where id = n.course_id;

  insert into public.lead_activity (lead_id, user_id, action, details)
  values (n.lead_id, auth.uid(), case when v_status = 'approved' then 'discount_approved' else 'discount_requested' end,
          jsonb_build_object('discount_id', v_id, 'amount', v_amount, 'fee', coalesce(v_fee_name, 'Total'),
                             'course', v_course, 'reason', v_reason, 'auto', v_status = 'approved'));

  -- Waiting: tell the people who can approve it
  if v_status = 'pending' then
    select l.id, l.name, l.assigned_to, p.team_lead_id into v_lead
    from public.leads l left join public.profiles p on p.id = l.assigned_to
    where l.id = n.lead_id;

    v_body := public.fee_money(v_amount) || ' off ' || coalesce(v_fee_name, 'the fee') || ' · ' || v_course
              || coalesce(' · ' || v_reason, '') || ' · by ' || coalesce(public.person_name(auth.uid()), 'someone');

    for r in
      select distinct u.id from (
        select v_lead.team_lead_id as id where v_lead.team_lead_id is not null
        union
        select p.id from public.profiles p join public.roles ro on ro.key = p.role_key
        where p.is_active and ('*' = any (ro.permissions) or 'discounts.approve' = any (ro.permissions))
      ) u
      where u.id <> auth.uid() and public.discount_limit(u.id) >= v_pct
    loop
      perform public.notify(r.id, 'discount', '💰 Discount request: ' || v_lead.name, v_body,
                            jsonb_build_object('route', '/discounts'), 'disc-req:' || v_id);
    end loop;
  end if;

  return jsonb_build_object('id', v_id, 'status', v_status, 'amount', v_amount, 'percent', v_pct);
end;
$$;

grant execute on function public.request_discount(uuid, uuid, text, numeric, text, text) to authenticated;

-- Approve or turn down a waiting discount
create or replace function public.decide_discount(p_discount_id uuid, p_approve boolean, p_note text default null)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  d       public.fee_discounts;
  n       public.lead_negotiations;
  v_list  numeric;
  v_active numeric;
  v_pct   numeric;
  v_days  int := coalesce((public.fee_setting() ->> 'valid_days')::int, 7);
  v_note  text := nullif(trim(coalesce(p_note, '')), '');
  v_lead  text;
begin
  select * into d from public.fee_discounts where id = p_discount_id for update;
  if d.id is null then raise exception 'Not found.'; end if;
  n := public.fee_open_negotiation(d.negotiation_id);
  if d.status <> 'pending' then raise exception 'This request was already answered.'; end if;

  if p_approve then
    select t.list_total, t.discount into v_list, v_active from public.negotiation_totals(n.id) t;
    if v_active + d.amount > v_list then
      raise exception 'All discounts together would be more than the full fee.';
    end if;
    v_pct := case when v_list > 0 then round((v_active + d.amount) * 100 / v_list, 2) else 100 end;
    if public.discount_limit() < v_pct then
      raise exception '%', 'All discounts together come to ' || v_pct || '% of the fee; you may approve up to '
                           || public.discount_limit() || '%.';
    end if;
  elsif public.discount_limit() <= 0 then
    raise exception 'You can''t answer discount requests.';
  end if;

  update public.fee_discounts
     set status = case when p_approve then 'approved' else 'rejected' end,
         decided_by = auth.uid(), decided_at = now(), decision_note = v_note,
         expires_at = case when p_approve and v_days > 0 then now() + make_interval(days => v_days) end
   where id = d.id;

  select name into v_lead from public.leads where id = d.lead_id;

  insert into public.lead_activity (lead_id, user_id, action, details)
  values (d.lead_id, auth.uid(), case when p_approve then 'discount_approved' else 'discount_rejected' end,
          jsonb_build_object('discount_id', d.id, 'amount', d.amount, 'fee', coalesce(d.fee_name, 'Total'),
                             'course', (select name from public.courses where id = n.course_id),
                             'note', v_note, 'requested_by', d.requested_by));

  if d.requested_by is not null and d.requested_by <> auth.uid() then
    perform public.notify(d.requested_by, 'discount',
      case when p_approve then '✅ Discount approved: ' else '✕ Discount not approved: ' end || v_lead,
      public.fee_money(d.amount) || ' off ' || coalesce(d.fee_name, 'the fee') || coalesce(' · ' || v_note, '')
        || ' · by ' || coalesce(public.person_name(auth.uid()), 'someone'),
      jsonb_build_object('lead_id', d.lead_id), 'disc-dec:' || d.id);
  end if;
end;
$$;

grant execute on function public.decide_discount(uuid, boolean, text) to authenticated;

-- Take back a discount (waiting or approved): the person who asked, or anyone who may approve
create or replace function public.cancel_discount(p_discount_id uuid, p_note text default null)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  d public.fee_discounts;
  n public.lead_negotiations;
begin
  select * into d from public.fee_discounts where id = p_discount_id for update;
  if d.id is null then raise exception 'Not found.'; end if;
  n := public.fee_open_negotiation(d.negotiation_id);
  if d.status not in ('pending', 'approved') then raise exception 'This discount is already closed.'; end if;
  if d.requested_by is distinct from auth.uid() and public.discount_limit() <= 0 then
    raise exception 'Only the person who asked, or someone who approves discounts, can take it back.';
  end if;

  update public.fee_discounts
     set status = 'cancelled', decided_by = auth.uid(), decided_at = now(),
         decision_note = nullif(trim(coalesce(p_note, '')), '')
   where id = d.id;

  insert into public.lead_activity (lead_id, user_id, action, details)
  values (d.lead_id, auth.uid(), 'discount_cancelled',
          jsonb_build_object('discount_id', d.id, 'amount', d.amount, 'fee', coalesce(d.fee_name, 'Total'),
                             'course', (select name from public.courses where id = n.course_id)));
end;
$$;

grant execute on function public.cancel_discount(uuid, text) to authenticated;

-- Waiting requests I can see, and whether I may approve each
create or replace function public.discount_queue()
returns table (
  id            uuid,
  lead_id       uuid,
  lead_name     text,
  course_name   text,
  fee_name      text,
  kind          text,
  value         numeric,
  amount        numeric,
  list_total    numeric,
  percent_after numeric,
  reason        text,
  note          text,
  requested_by  uuid,
  requester     text,
  requested_at  timestamptz,
  can_approve   boolean
)
language sql
stable
security definer
set search_path = public
as $$
  select d.id, d.lead_id, l.name, c.name, coalesce(d.fee_name, 'Total'), d.kind, d.value, d.amount,
         t.list_total,
         case when t.list_total > 0 then round((t.discount + d.amount) * 100 / t.list_total, 2) else 100 end,
         d.reason, d.note, d.requested_by, pr.full_name, d.requested_at,
         public.discount_limit() >=
           case when t.list_total > 0 then round((t.discount + d.amount) * 100 / t.list_total, 2) else 100 end
  from public.fee_discounts d
  join public.lead_negotiations n on n.id = d.negotiation_id and n.status = 'open'
  join public.leads l on l.id = d.lead_id and l.deleted_at is null
  join public.pipeline_stages st on st.id = l.stage_id and st.kind = 'open'
  join public.courses c on c.id = n.course_id
  left join public.profiles pr on pr.id = d.requested_by
  cross join lateral public.negotiation_totals(n.id) t
  where d.status = 'pending'
    and public.fee_can_see_lead(d.lead_id)
  order by d.requested_at;
$$;

grant execute on function public.discount_queue() to authenticated;

-- ---------------------------------------------------------------------
-- Admission: lock the fee (and open it again if the admission is cancelled)
-- ---------------------------------------------------------------------
create or replace function public.fee_on_admission()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_neg uuid;
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
    end if;
  elsif new.admitted_at is null and old.admitted_at is not null then
    update public.lead_negotiations
       set status = 'open', final_total = null, locked_at = null
     where lead_id = new.id and status = 'locked';
  end if;
  return null;
end;
$$;

drop trigger if exists leads_fee_on_admission on public.leads;
create trigger leads_fee_on_admission
  after update of admitted_at on public.leads
  for each row execute function public.fee_on_admission();

-- ---------------------------------------------------------------------
-- 6. An approved discount ran out → tell the person who asked (every 15 minutes)
-- ---------------------------------------------------------------------
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
    where d.status = 'approved' and d.requested_by is not null
      and d.expires_at <= now() and d.expires_at > now() - interval '1 day'
  loop
    perform public.notify(r.requested_by, 'discount', '⌛ Discount ran out: ' || r.name,
      public.fee_money(r.amount) || ' off ' || coalesce(r.fee_name, 'the fee') || ' is no longer valid. Ask again if needed.',
      jsonb_build_object('lead_id', r.lead_id), 'disc-exp:' || r.id);
  end loop;
end;
$$;

do $$
begin
  perform cron.schedule('fee-discounts', '*/15 * * * *', 'select public.fee_discounts_tick()');
exception when others then
  raise notice 'pg_cron is not available: run fee_discounts_tick() to send "discount ran out" messages';
end;
$$;

notify pgrst, 'reload schema';
