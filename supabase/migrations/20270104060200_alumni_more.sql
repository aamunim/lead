-- =====================================================================
-- 🎓 Alumni, more (phases 2–4)
--   2 · referral link opens (the funnel: opened → referred → lead →
--       admitted), Top referrers, bonus rewards at 3 / 5 … admitted,
--       campaigns (a message to many, sent one by one on WhatsApp),
--       "say thanks" when a referral is admitted, voice notes
--   3 · schools: the workplace of alumni and leads (leads get a
--       workplace too), refer score (who is likely to refer), the
--       dashboard, the text for an AI message
--   4 · a personal link for an alumnus to update their own details
--       (office approves), students become alumni when their batch is
--       closed (setting), duplicates and merging
-- =====================================================================

-- ---------------------------------------------------------------------
-- 0. Small helpers
-- ---------------------------------------------------------------------
-- "Mirpur Ideal School (Main)" → "mirpuridealschoolmain": the same school written a little differently
-- (spaces and punctuation out; Bangla letters stay whatever the server's locale)
create or replace function public.school_key(p_name text)
returns text
language sql
immutable
parallel safe
as $$
  select nullif(lower(regexp_replace(coalesce(p_name, ''), '[[:space:][:punct:]]+', '', 'g')), '');
$$;

-- ---------------------------------------------------------------------
-- 2a. 🔗 Referral link opens, per alumnus per day
-- ---------------------------------------------------------------------
create table if not exists public.alumni_link_opens (
  alumni_id uuid not null references public.alumni (id) on delete cascade,
  day       date not null,
  opens     integer not null default 0,
  primary key (alumni_id, day)
);
alter table public.alumni_link_opens enable row level security;
drop policy if exists "alumni link opens: read" on public.alumni_link_opens;
create policy "alumni link opens: read" on public.alumni_link_opens
  for select to authenticated using ((select public.alumni_can('view')));
grant select on public.alumni_link_opens to authenticated;

alter table public.alumni add column if not exists cnt_opens integer not null default 0;

-- The refer page opened (no sign-in). At most 500 counted a day per link.
create or replace function public.public_refer_open(p_code text)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_alum uuid;
  v_day  date := (now() at time zone 'Asia/Dhaka')::date;
begin
  select id into v_alum from public.alumni
  where ref_code = upper(trim(coalesce(p_code, ''))) and deleted_at is null;
  if v_alum is null then return; end if;
  insert into public.alumni_link_opens as o (alumni_id, day, opens) values (v_alum, v_day, 1)
  on conflict (alumni_id, day) do update set opens = o.opens + 1 where o.opens < 500;
  if found then
    update public.alumni set cnt_opens = cnt_opens + 1 where id = v_alum;
  end if;
end;
$$;
revoke all on function public.public_refer_open(text) from public;
grant execute on function public.public_refer_open(text) to anon, authenticated;

-- ---------------------------------------------------------------------
-- 2b. 🏆 Top referrers (a period: month / year / all)
-- ---------------------------------------------------------------------
create or replace function public.alumni_top(p_period text default 'month', p_limit integer default 30)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
set jit = off
as $$
declare
  v_from timestamptz := case p_period
    when 'month' then date_trunc('month', now() at time zone 'Asia/Dhaka') at time zone 'Asia/Dhaka'
    when 'year'  then date_trunc('year', now() at time zone 'Asia/Dhaka') at time zone 'Asia/Dhaka'
    else '-infinity'::timestamptz end;
begin
  if not public.alumni_can('view') then return null; end if;
  return coalesce((select jsonb_agg(x order by x.admitted desc, x.referrals desc, x.leads desc, x.name) from (
    select a.id, a.name, b.name as batch_name, a.workplace,
           (select count(*) from public.alumni_referrals r where r.alumni_id = a.id and r.created_at >= v_from) as referrals,
           (select count(*) from public.leads l where l.referred_by_alumni_id = a.id and l.deleted_at is null
              and l.created_at >= v_from) as leads,
           (select count(*) from public.leads l where l.referred_by_alumni_id = a.id and l.deleted_at is null
              and l.admitted_at >= v_from and l.cancelled_at is null) as admitted,
           (select coalesce(sum(o.opens), 0) from public.alumni_link_opens o where o.alumni_id = a.id
              and o.day >= (v_from at time zone 'Asia/Dhaka')::date) as opens
    from public.alumni a
    left join public.batches b on b.id = a.batch_id
    where a.deleted_at is null and (a.cnt_referrals > 0 or a.cnt_leads > 0 or a.cnt_opens > 0)
  ) x where x.referrals + x.leads + x.admitted + x.opens > 0
  limit greatest(1, least(coalesce(p_limit, 30), 100))), '[]'::jsonb);
end;
$$;
revoke all on function public.alumni_top(text, integer) from public, anon;
grant execute on function public.alumni_top(text, integer) to authenticated;

-- ---------------------------------------------------------------------
-- 2c. 🎁 Bonus rewards: Settings → Alumni → rewards.tiers [{count, amount}]
--     (at 3 admitted: ৳1000 extra …). Taken back while still due when the
--     count drops below (an admission cancelled).
-- ---------------------------------------------------------------------
alter table public.alumni_rewards add column if not exists tier integer;
create unique index if not exists alumni_rewards_one_per_tier
  on public.alumni_rewards (alumni_id, tier) where tier is not null and status <> 'cancelled';

create or replace function public.alumni_check_tiers(p_alumni uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_cfg   jsonb := public.alumni_setting() -> 'rewards';
  v_count int;
  t       jsonb;
  v_n     int;
  v_amt   numeric;
begin
  if p_alumni is null then return; end if;
  select count(*) into v_count from public.leads
  where referred_by_alumni_id = p_alumni and deleted_at is null and admitted_at is not null and cancelled_at is null;

  -- below a tier now: a bonus not paid yet is cancelled
  update public.alumni_rewards set status = 'cancelled', updated_at = now(),
         note = coalesce(note || ' · ', '') || 'fewer admitted now'
  where alumni_id = p_alumni and tier is not null and status = 'due' and tier > v_count;

  if not coalesce((v_cfg ->> 'enabled')::boolean, false) then return; end if;
  for t in select * from jsonb_array_elements(coalesce(v_cfg -> 'tiers', '[]'::jsonb))
  loop
    begin
      v_n := (t ->> 'count')::int;
      v_amt := (t ->> 'amount')::numeric;
    exception when others then
      continue;
    end;
    if v_n is null or v_n < 1 or coalesce(v_amt, 0) <= 0 or v_count < v_n then continue; end if;
    if exists (select 1 from public.alumni_rewards where alumni_id = p_alumni and tier = v_n and status <> 'cancelled') then
      continue;
    end if;
    insert into public.alumni_rewards (alumni_id, amount, tier, note)
    values (p_alumni, v_amt, v_n, 'Bonus: ' || v_n || ' admitted');
    perform public.alumni_log(p_alumni, 'reward', '🏅 Bonus for ' || v_n || ' admitted: ৳' || v_amt,
                              jsonb_build_object('tier', v_n, 'amount', v_amt));
  end loop;
end;
$$;
revoke all on function public.alumni_check_tiers(uuid) from public, anon, authenticated;

create or replace function public.alumni_on_admission()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_cfg    jsonb := public.alumni_setting() -> 'rewards';
  v_amount numeric;
  v_name   text;
  m        uuid;
begin
  if new.referred_by_alumni_id is null then return null; end if;

  if new.admitted_at is not null and new.cancelled_at is null
     and (old.admitted_at is null or old.cancelled_at is not null) then
    select name into v_name from public.alumni where id = new.referred_by_alumni_id;
    perform public.alumni_log(new.referred_by_alumni_id, 'admitted', new.name, jsonb_build_object('lead_id', new.id));

    if coalesce((v_cfg ->> 'enabled')::boolean, false) then
      v_amount := coalesce((v_cfg -> 'by_course' ->> new.admitted_course_id::text)::numeric,
                           (v_cfg ->> 'default_amount')::numeric, 0);
      if v_amount > 0 and not exists (select 1 from public.alumni_rewards where lead_id = new.id and status <> 'cancelled') then
        insert into public.alumni_rewards (alumni_id, lead_id, course_id, amount)
        values (new.referred_by_alumni_id, new.id, new.admitted_course_id, v_amount);
        perform public.alumni_log(new.referred_by_alumni_id, 'reward', 'Reward due: ৳' || v_amount,
                                  jsonb_build_object('lead_id', new.id, 'amount', v_amount));
      end if;
    end if;
    perform public.alumni_check_tiers(new.referred_by_alumni_id);

    -- 🙏 the alert opens the alumnus with "say thanks" for this student
    for m in select public.alumni_managers() loop
      perform public.notify(m, 'alumni', '🎉 Admitted by referral',
        new.name || ' · referred by ' || coalesce(v_name, 'an alumnus') || '. Say thanks?',
        jsonb_build_object('route', '/alumni/' || new.referred_by_alumni_id || '?thank=' || new.id),
        'alumni-adm:' || new.id, false);
    end loop;

  elsif (new.cancelled_at is not null and old.cancelled_at is null)
        or (new.admitted_at is null and old.admitted_at is not null) then
    update public.alumni_rewards set status = 'cancelled', updated_at = now(),
           note = coalesce(note || ' · ', '') || 'admission cancelled'
    where lead_id = new.id and status = 'due';
    perform public.alumni_check_tiers(new.referred_by_alumni_id);
  end if;
  return null;
end;
$$;

-- ---------------------------------------------------------------------
-- 2d. 📣 Campaigns: one message to many alumni, sent one by one
-- ---------------------------------------------------------------------
create table if not exists public.alumni_campaigns (
  id         uuid primary key default gen_random_uuid(),
  name       text not null check (length(trim(name)) between 1 and 80),
  message    text not null check (length(trim(message)) between 1 and 2000),
  created_by uuid references public.profiles (id) on delete set null default auth.uid(),
  created_at timestamptz not null default now(),
  closed_at  timestamptz
);
create table if not exists public.alumni_campaign_items (
  campaign_id uuid not null references public.alumni_campaigns (id) on delete cascade,
  alumni_id   uuid not null references public.alumni (id) on delete cascade,
  sent_at     timestamptz,
  sent_by     uuid references public.profiles (id) on delete set null,
  skipped     boolean not null default false,
  primary key (campaign_id, alumni_id)
);
create index if not exists alumni_campaign_items_alumni_idx on public.alumni_campaign_items (alumni_id);
alter table public.alumni_campaigns enable row level security;
alter table public.alumni_campaign_items enable row level security;
drop policy if exists "alumni campaigns: read" on public.alumni_campaigns;
create policy "alumni campaigns: read" on public.alumni_campaigns
  for select to authenticated using ((select public.alumni_can('view')));
drop policy if exists "alumni campaign items: read" on public.alumni_campaign_items;
create policy "alumni campaign items: read" on public.alumni_campaign_items
  for select to authenticated using ((select public.alumni_can('view')));
grant select on public.alumni_campaigns, public.alumni_campaign_items to authenticated;

create or replace function public.create_alumni_campaign(p_name text, p_message text, p_ids uuid[])
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_id uuid;
begin
  if not public.alumni_can('view') then raise exception 'You cannot see alumni.'; end if;
  if nullif(trim(coalesce(p_name, '')), '') is null then raise exception 'Give the campaign a name.'; end if;
  if nullif(trim(coalesce(p_message, '')), '') is null then raise exception 'Type the message.'; end if;
  if coalesce(array_length(p_ids, 1), 0) = 0 then raise exception 'Choose who gets it.'; end if;
  if array_length(p_ids, 1) > 2000 then raise exception 'At most 2000 alumni in one campaign.'; end if;
  insert into public.alumni_campaigns (name, message) values (left(trim(p_name), 80), left(p_message, 2000))
  returning id into v_id;
  -- not the ones who asked not to be contacted, and no number to send to
  insert into public.alumni_campaign_items (campaign_id, alumni_id)
  select v_id, a.id from public.alumni a
  where a.id = any (p_ids) and a.deleted_at is null and not a.do_not_contact
    and coalesce(a.whatsapp_number, a.phone) is not null
  on conflict do nothing;
  if not exists (select 1 from public.alumni_campaign_items where campaign_id = v_id) then
    raise exception 'None of them can get it (do not contact, or no number).';
  end if;
  return v_id;
end;
$$;
revoke all on function public.create_alumni_campaign(text, text, uuid[]) from public, anon;
grant execute on function public.create_alumni_campaign(text, text, uuid[]) to authenticated;

-- Sent (or skipped) to one alumnus: the message goes into their history
create or replace function public.mark_alumni_campaign(p_campaign uuid, p_alumni uuid, p_sent boolean default true)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_name text;
begin
  if not public.alumni_can('view') then raise exception 'You cannot see alumni.'; end if;
  select name into v_name from public.alumni_campaigns where id = p_campaign;
  if v_name is null then raise exception 'Campaign not found.'; end if;
  update public.alumni_campaign_items
     set sent_at = case when p_sent then now() end, sent_by = case when p_sent then auth.uid() end,
         skipped = not coalesce(p_sent, true)
   where campaign_id = p_campaign and alumni_id = p_alumni and sent_at is null;
  if found and p_sent then
    insert into public.alumni_events (alumni_id, kind, body, data, by_user, outcome, direction, channel, media, source)
    values (p_alumni, 'whatsapp', '📣 ' || v_name, jsonb_build_object('campaign_id', p_campaign), auth.uid(),
            'message', 'outgoing', 'whatsapp', 'message', 'app');
  end if;
end;
$$;
revoke all on function public.mark_alumni_campaign(uuid, uuid, boolean) from public, anon;
grant execute on function public.mark_alumni_campaign(uuid, uuid, boolean) to authenticated;

-- The campaigns with their numbers (referrals / admitted from those alumni since it began)
create or replace function public.alumni_campaign_list()
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
begin
  if not public.alumni_can('view') then return null; end if;
  return coalesce((select jsonb_agg(x order by x.created_at desc) from (
    select c.id, c.name, c.message, c.created_at, c.closed_at, public.person_name(c.created_by) as by_name,
           count(i.alumni_id) as total,
           count(i.sent_at) as sent,
           count(*) filter (where i.skipped) as skipped,
           (select count(*) from public.alumni_referrals r join public.alumni_campaign_items j
              on j.alumni_id = r.alumni_id and j.campaign_id = c.id and j.sent_at is not null
            where r.created_at >= c.created_at) as referrals,
           (select count(*) from public.leads l join public.alumni_campaign_items j
              on j.alumni_id = l.referred_by_alumni_id and j.campaign_id = c.id and j.sent_at is not null
            where l.deleted_at is null and l.admitted_at >= c.created_at and l.cancelled_at is null) as admitted
    from public.alumni_campaigns c
    left join public.alumni_campaign_items i on i.campaign_id = c.id
    group by c.id
    limit 100) x), '[]'::jsonb);
end;
$$;
revoke all on function public.alumni_campaign_list() from public, anon;
grant execute on function public.alumni_campaign_list() to authenticated;

-- ---------------------------------------------------------------------
-- 2e. 🙏 Say thanks: admitted referrals not thanked yet
-- ---------------------------------------------------------------------
create or replace function public.alumni_thanks_due(p_alumni uuid)
returns jsonb
language sql
stable
security definer
set search_path = public
as $$
  select case when not public.alumni_can('view') then '[]'::jsonb else
    coalesce((select jsonb_agg(jsonb_build_object('lead_id', l.id, 'name', l.name, 'admitted_at', l.admitted_at,
                                                  'course', c.name) order by l.admitted_at desc)
              from public.leads l
              left join public.courses c on c.id = l.admitted_course_id
              where l.referred_by_alumni_id = p_alumni and l.deleted_at is null
                and l.admitted_at is not null and l.cancelled_at is null
                and l.admitted_at > now() - interval '180 days'
                and not exists (select 1 from public.alumni_events e
                                where e.alumni_id = p_alumni and e.data ->> 'thanks_lead' = l.id::text
                                  and e.deleted_at is null)), '[]'::jsonb) end;
$$;
revoke all on function public.alumni_thanks_due(uuid) from public, anon;
grant execute on function public.alumni_thanks_due(uuid) to authenticated;

create or replace function public.mark_alumni_thanked(p_alumni uuid, p_lead uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_name text;
begin
  if not public.alumni_can('view') then raise exception 'You cannot see alumni.'; end if;
  select name into v_name from public.leads where id = p_lead and referred_by_alumni_id = p_alumni;
  if v_name is null then raise exception 'That student was not referred by this alumnus.'; end if;
  insert into public.alumni_events (alumni_id, kind, body, data, by_user, outcome, direction, channel, media, source)
  values (p_alumni, 'whatsapp', '🙏 Thanked for ' || v_name, jsonb_build_object('thanks_lead', p_lead), auth.uid(),
          'message', 'outgoing', 'whatsapp', 'message', 'app');
end;
$$;
revoke all on function public.mark_alumni_thanked(uuid, uuid) from public, anon;
grant execute on function public.mark_alumni_thanked(uuid, uuid) to authenticated;

-- ---------------------------------------------------------------------
-- 2f. 🎙 Voice notes on alumni (Google Drive: Lead Management / Alumni / <name>)
-- ---------------------------------------------------------------------
create table if not exists public.alumni_files (
  id            uuid primary key default gen_random_uuid(),
  alumni_id     uuid not null references public.alumni (id) on delete cascade,
  event_id      uuid references public.alumni_events (id) on delete set null,
  kind          text not null default 'voice' check (kind in ('voice')),
  name          text not null,
  mime_type     text,
  size_bytes    bigint,
  duration_sec  integer,
  drive_file_id text not null,
  uploaded_by   uuid references public.profiles (id) on delete set null,
  created_at    timestamptz not null default now()
);
create index if not exists alumni_files_alumni_idx on public.alumni_files (alumni_id);
alter table public.alumni_files enable row level security;
drop policy if exists "alumni files: read" on public.alumni_files;
create policy "alumni files: read" on public.alumni_files
  for select to authenticated using ((select public.alumni_can('view')));
grant select on public.alumni_files to authenticated;

create table if not exists public.alumni_drive_folders (
  alumni_id uuid not null,   -- an alumnus, or the zero id for the "Alumni" folder itself
  kind      text not null,
  folder_id text not null,
  primary key (alumni_id, kind)
);
alter table public.alumni_drive_folders enable row level security;   -- the server only

-- ---------------------------------------------------------------------
-- 3a. 🏫 Schools: the workplace of alumni and of leads
-- ---------------------------------------------------------------------
alter table public.leads add column if not exists workplace text;
alter table public.leads add column if not exists workplace_key text generated always as (public.school_key(workplace)) stored;
alter table public.alumni add column if not exists workplace_key text generated always as (public.school_key(workplace)) stored;
create index if not exists leads_workplace_key_idx on public.leads (workplace_key) where workplace_key is not null and deleted_at is null;
create index if not exists alumni_workplace_key_idx on public.alumni (workplace_key) where workplace_key is not null and deleted_at is null;

-- The schools, with alumni / leads / admitted
create or replace function public.alumni_schools(p_search text default null)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
set jit = off
as $$
declare
  v_q text := public.school_key(p_search);
begin
  if not public.alumni_can('view') then return null; end if;
  return coalesce((select jsonb_agg(x order by x.alumni desc, x.leads desc, x.name) from (
    select k.key,
           (select mode() within group (order by a.workplace) from public.alumni a
             where a.workplace_key = k.key and a.deleted_at is null) as name,
           (select mode() within group (order by a.district) from public.alumni a
             where a.workplace_key = k.key and a.deleted_at is null) as district,
           (select count(*) from public.alumni a where a.workplace_key = k.key and a.deleted_at is null) as alumni,
           (select coalesce(sum(a.cnt_referrals), 0) from public.alumni a
             where a.workplace_key = k.key and a.deleted_at is null) as referrals,
           (select count(*) from public.leads l where l.workplace_key = k.key and l.deleted_at is null) as leads,
           (select count(*) from public.leads l where l.workplace_key = k.key and l.deleted_at is null
              and l.admitted_at is not null and l.cancelled_at is null) as admitted
    from (select distinct workplace_key as key from public.alumni
          where workplace_key is not null and deleted_at is null
            and (v_q is null or workplace_key like '%' || v_q || '%')) k
    limit 300) x), '[]'::jsonb);
end;
$$;
revoke all on function public.alumni_schools(text) from public, anon;
grant execute on function public.alumni_schools(text) to authenticated;

-- A lead's workplace: the alumni who work there (the lead page)
create or replace function public.school_alumni(p_workplace text)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_key text := public.school_key(p_workplace);
begin
  if v_key is null or not public.alumni_can('view') then return null; end if;
  return jsonb_build_object(
    'key', v_key,
    'count', (select count(*) from public.alumni where workplace_key = v_key and deleted_at is null),
    'list', coalesce((select jsonb_agg(jsonb_build_object('id', a.id, 'name', a.name, 'designation', a.designation,
                                                          'referrals', a.cnt_referrals) order by a.cnt_admitted desc,
                                                          a.cnt_referrals desc, a.name)
                      from (select * from public.alumni where workplace_key = v_key and deleted_at is null
                            order by cnt_admitted desc, cnt_referrals desc, name limit 5) a), '[]'::jsonb));
end;
$$;
revoke all on function public.school_alumni(text) from public, anon;
grant execute on function public.school_alumni(text) to authenticated;

-- ---------------------------------------------------------------------
-- 3b. 🎯 Refer score: who is likely to refer (0–100, rules, no AI)
-- ---------------------------------------------------------------------
alter table public.alumni add column if not exists refer_score smallint;

create or replace function public.alumni_score(p_alumni uuid)
returns void
language sql
security definer
set search_path = public
as $$
  with v as (select a.id, (case when a.do_not_contact then 0 else greatest(0, least(100,
      20
    + least(a.cnt_referrals * 15, 45)
    + case when a.cnt_admitted > 0 then 20 else 0 end
    + case when a.last_referral_at > now() - interval '180 days' then 10 else 0 end
    + case when a.workplace is not null then 10 else 0 end
    + case when a.designation ~* '(teacher|head|principal|শিক্ষক|প্রধান)' then 5 else 0 end
    + case when exists (select 1 from public.alumni_events e where e.alumni_id = a.id and e.deleted_at is null
                          and e.outcome = 'connected' and e.happened_at > now() - interval '90 days') then 10 else 0 end
    + case when a.passing_year >= extract(year from now())::int - 3 then 10 else 0 end
    - case when a.last_contacted_at is null or a.last_contacted_at < now() - interval '365 days' then 15 else 0 end
  )) end)::smallint as score
    from public.alumni a where a.id = p_alumni)
  update public.alumni a set refer_score = v.score
  from v where a.id = v.id and a.refer_score is distinct from v.score;
$$;
revoke all on function public.alumni_score(uuid) from public, anon, authenticated;

-- the score follows the counts and contacts (the existing helpers end with it)
create or replace function public.alumni_score_after()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if pg_trigger_depth() > 2 then return null; end if;
  perform public.alumni_score(new.id);
  return null;
end;
$$;
drop trigger if exists alumni_score_after on public.alumni;
create trigger alumni_score_after after insert or update of cnt_referrals, cnt_admitted, last_referral_at,
  last_contacted_at, workplace, designation, passing_year, do_not_contact on public.alumni
  for each row execute function public.alumni_score_after();

create index if not exists alumni_refer_score_idx on public.alumni (refer_score desc) where deleted_at is null;

do $$
begin
  perform public.alumni_score(id) from public.alumni;
  if exists (select 1 from pg_extension where extname = 'pg_cron') then
    perform cron.unschedule('alumni-scores-nightly') where exists (select 1 from cron.job where jobname = 'alumni-scores-nightly');
    perform cron.schedule('alumni-scores-nightly', '25 20 * * *',
      'select public.alumni_score(id) from public.alumni where deleted_at is null');
  end if;
end $$;

-- ---------------------------------------------------------------------
-- 3c. 📊 Dashboard
-- ---------------------------------------------------------------------
create or replace function public.alumni_dashboard()
returns jsonb
language plpgsql
stable
security definer
set search_path = public
set jit = off
as $$
declare
  v_start date := (date_trunc('month', now() at time zone 'Asia/Dhaka') - interval '5 months')::date;
  v_manage boolean := public.alumni_can('manage');
begin
  if not public.alumni_can('view') then return null; end if;
  return jsonb_build_object(
    'alumni', (select count(*) from public.alumni where deleted_at is null),
    'with_workplace', (select count(*) from public.alumni where deleted_at is null and workplace is not null),
    'contacted_90', (select count(*) from public.alumni where deleted_at is null
                       and last_contacted_at > now() - interval '90 days'),
    'never_contacted', (select count(*) from public.alumni where deleted_at is null and last_contacted_at is null),
    'referrers', (select count(*) from public.alumni where deleted_at is null and cnt_referrals > 0),
    'funnel', jsonb_build_object(
      'opens', (select coalesce(sum(opens), 0) from public.alumni_link_opens),
      'referrals', (select count(*) from public.alumni_referrals),
      'leads', (select count(*) from public.leads where referred_by_alumni_id is not null and deleted_at is null),
      'admitted', (select count(*) from public.leads where referred_by_alumni_id is not null and deleted_at is null
                     and admitted_at is not null and cancelled_at is null)),
    'months', coalesce((select jsonb_agg(m order by m.month) from (
        select to_char(g.d, 'YYYY-MM') as month,
               (select coalesce(sum(o.opens), 0) from public.alumni_link_opens o
                 where o.day >= g.d and o.day < (g.d + interval '1 month')) as opens,
               (select count(*) from public.alumni_referrals r
                 where (r.created_at at time zone 'Asia/Dhaka')::date >= g.d
                   and (r.created_at at time zone 'Asia/Dhaka')::date < (g.d + interval '1 month')) as referrals,
               (select count(*) from public.leads l where l.referred_by_alumni_id is not null and l.deleted_at is null
                   and l.admitted_at is not null and l.cancelled_at is null
                   and (l.admitted_at at time zone 'Asia/Dhaka')::date >= g.d
                   and (l.admitted_at at time zone 'Asia/Dhaka')::date < (g.d + interval '1 month')) as admitted
        from generate_series(v_start, v_start + interval '5 months', interval '1 month') g(d)) m), '[]'::jsonb),
    'districts', coalesce((select jsonb_agg(d) from (
        select district as name, count(*) as alumni, sum(cnt_referrals) as referrals, sum(cnt_admitted) as admitted
        from public.alumni where deleted_at is null and district is not null
        group by district order by sum(cnt_admitted) desc, sum(cnt_referrals) desc, count(*) desc limit 8) d), '[]'::jsonb),
    'rewards_due', case when v_manage then (select coalesce(sum(amount), 0) from public.alumni_rewards where status = 'due') end,
    'rewards_paid', case when v_manage then (select coalesce(sum(amount), 0) from public.alumni_rewards where status = 'paid') end,
    'campaigns', (select count(*) from public.alumni_campaigns),
    'updates_waiting', case when v_manage then (select count(*) from public.alumni_update_requests where status = 'pending') end
  );
end;
$$;

-- ---------------------------------------------------------------------
-- 3d. 🤖 What the AI gets to write a message (the server only; no numbers)
-- ---------------------------------------------------------------------
create or replace function public.alumni_ai_input(p_alumni uuid)
returns jsonb
language sql
stable
security definer
set search_path = public
as $$
  select jsonb_build_object(
    'first_name', split_part(trim(a.name), ' ', 1),
    'course', c.name, 'batch', b.name, 'session', a.session, 'passing_year', a.passing_year,
    'workplace', a.workplace, 'designation', a.designation, 'district', a.district,
    'referrals', a.cnt_referrals, 'referred_leads', a.cnt_leads, 'admitted', a.cnt_admitted,
    'last_contact_days', case when a.last_contacted_at is not null
                              then extract(day from now() - a.last_contacted_at)::int end,
    'birthday_today', a.birth_md = (extract(month from now() at time zone 'Asia/Dhaka') * 100
                                    + extract(day from now() at time zone 'Asia/Dhaka'))::int,
    'notes', coalesce((select jsonb_agg(left(e.body, 300)) from (
                select body from public.alumni_events
                where alumni_id = a.id and deleted_at is null and body is not null
                  and kind in ('note', 'call', 'whatsapp', 'message')
                order by happened_at desc limit 6) e), '[]'::jsonb),
    'institute', (select value -> 'institute' ->> 'name' from public.app_settings where key = 'message_templates'))
  from public.alumni a
  left join public.courses c on c.id = a.course_id
  left join public.batches b on b.id = a.batch_id
  where a.id = p_alumni and a.deleted_at is null;
$$;
revoke all on function public.alumni_ai_input(uuid) from public, anon, authenticated;
grant execute on function public.alumni_ai_input(uuid) to service_role;

-- ---------------------------------------------------------------------
-- 4a. ✍️ A personal link to update their own details (office approves)
-- ---------------------------------------------------------------------
alter table public.alumni add column if not exists update_token text;
update public.alumni set update_token = replace(gen_random_uuid()::text, '-', '') where update_token is null;
alter table public.alumni alter column update_token set default replace(gen_random_uuid()::text, '-', '');
create unique index if not exists alumni_update_token_key on public.alumni (update_token);

create table if not exists public.alumni_update_requests (
  id          uuid primary key default gen_random_uuid(),
  alumni_id   uuid not null references public.alumni (id) on delete cascade,
  data        jsonb not null,
  status      text not null default 'pending' check (status in ('pending', 'approved', 'rejected')),
  created_at  timestamptz not null default now(),
  handled_by  uuid references public.profiles (id) on delete set null,
  handled_at  timestamptz,
  note        text
);
create index if not exists alumni_update_requests_status_idx on public.alumni_update_requests (status, created_at desc);
alter table public.alumni_update_requests enable row level security;
drop policy if exists "alumni update requests: read" on public.alumni_update_requests;
create policy "alumni update requests: read" on public.alumni_update_requests
  for select to authenticated using ((select public.alumni_can('manage')));
grant select on public.alumni_update_requests to authenticated;

-- now that the table is there
revoke all on function public.alumni_dashboard() from public, anon;
grant execute on function public.alumni_dashboard() to authenticated;

-- What the page shows (no sign-in): first name and the details they can change; the number only partly
create or replace function public.public_alumni_update_info(p_token text)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  a public.alumni;
begin
  if length(coalesce(p_token, '')) < 16 then return null; end if;
  select * into a from public.alumni where update_token = p_token and deleted_at is null;
  if a.id is null then return null; end if;
  return jsonb_build_object(
    'first_name', split_part(trim(a.name), ' ', 1),
    'phone_hint', case when a.phone is not null then '•••' || right(a.phone, 3) end,
    'whatsapp_hint', case when a.whatsapp_number is not null then '•••' || right(a.whatsapp_number, 3) end,
    'email', a.email, 'workplace', a.workplace, 'designation', a.designation,
    'district', a.district, 'upazila', a.upazila, 'address', a.address,
    'institute', (select value -> 'institute' ->> 'name' from public.app_settings where key = 'message_templates'),
    'pending', exists (select 1 from public.alumni_update_requests where alumni_id = a.id and status = 'pending'));
end;
$$;
revoke all on function public.public_alumni_update_info(text) from public;
grant execute on function public.public_alumni_update_info(text) to anon, authenticated;

create or replace function public.public_alumni_update_submit(p_token text, p_data jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  a      public.alumni;
  v_data jsonb := '{}'::jsonb;
  k      text;
  v      text;
  m      uuid;
begin
  if length(coalesce(p_token, '')) < 16 then raise exception 'This link is not valid.'; end if;
  select * into a from public.alumni where update_token = p_token and deleted_at is null;
  if a.id is null then raise exception 'This link is not valid any more.'; end if;
  perform public.public_form_guard('alumni_update', p_token);
  foreach k in array array['phone', 'whatsapp_number', 'email', 'workplace', 'designation', 'district', 'upazila', 'address']
  loop
    v := nullif(trim(coalesce(p_data ->> k, '')), '');
    if v is not null then v_data := v_data || jsonb_build_object(k, left(v, 200)); end if;
  end loop;
  if v_data = '{}'::jsonb then raise exception 'Nothing to change.'; end if;
  if v_data ? 'phone' and length(regexp_replace(v_data ->> 'phone', '\D', '', 'g')) < 10 then
    raise exception 'Please type a correct mobile number.';
  end if;
  -- one waiting request per alumnus: the newest replaces it
  delete from public.alumni_update_requests where alumni_id = a.id and status = 'pending';
  insert into public.alumni_update_requests (alumni_id, data) values (a.id, v_data);
  for m in select unnest(case when a.owner_id is not null then array[a.owner_id]
                              else array(select public.alumni_managers()) end)
  loop
    perform public.notify(m, 'alumni', '✍️ ' || a.name || ' updated their details',
      'Check and approve the changes.', jsonb_build_object('route', '/alumni/updates'), 'alumni-upd:' || a.id, false);
  end loop;
  return jsonb_build_object('ok', true);
end;
$$;
revoke all on function public.public_alumni_update_submit(text, jsonb) from public;
grant execute on function public.public_alumni_update_submit(text, jsonb) to anon, authenticated;

-- Approve (the office): the changes are saved on the alumnus
create or replace function public.handle_alumni_update(p_request uuid, p_approve boolean, p_note text default null)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  r      public.alumni_update_requests;
  v_phone text;
  v_dup  text;
begin
  if not public.alumni_can('manage') then raise exception 'You cannot change alumni.'; end if;
  select * into r from public.alumni_update_requests where id = p_request and status = 'pending' for update;
  if r.id is null then raise exception 'Not found (already handled?).'; end if;
  if p_approve then
    if r.data ? 'phone' then
      v_phone := nullif(public.normalize_bd_phone(r.data ->> 'phone'), '');
      select name into v_dup from public.alumni
      where phone = v_phone and id <> r.alumni_id and deleted_at is null limit 1;
      if v_dup is not null then raise exception '% already has the number %.', v_dup, v_phone; end if;
    end if;
    update public.alumni set
      phone           = case when r.data ? 'phone' then r.data ->> 'phone' else phone end,
      whatsapp_number = case when r.data ? 'whatsapp_number' then r.data ->> 'whatsapp_number' else whatsapp_number end,
      email           = case when r.data ? 'email' then r.data ->> 'email' else email end,
      workplace       = case when r.data ? 'workplace' then r.data ->> 'workplace' else workplace end,
      designation     = case when r.data ? 'designation' then r.data ->> 'designation' else designation end,
      district        = case when r.data ? 'district' then r.data ->> 'district' else district end,
      upazila         = case when r.data ? 'upazila' then r.data ->> 'upazila' else upazila end,
      address         = case when r.data ? 'address' then r.data ->> 'address' else address end
    where id = r.alumni_id and deleted_at is null;
    perform public.alumni_log(r.alumni_id, 'edited', 'Updated by the alumnus (link): ' ||
      (select string_agg(k, ', ') from jsonb_object_keys(r.data) k));
  end if;
  update public.alumni_update_requests
     set status = case when p_approve then 'approved' else 'rejected' end,
         handled_by = auth.uid(), handled_at = now(), note = nullif(trim(coalesce(p_note, '')), '')
   where id = p_request;
end;
$$;
revoke all on function public.handle_alumni_update(uuid, boolean, text) from public, anon;
grant execute on function public.handle_alumni_update(uuid, boolean, text) to authenticated;

-- A new link (the old one stops working)
create or replace function public.new_alumni_update_link(p_alumni uuid)
returns text
language plpgsql
security definer
set search_path = public
as $$
declare
  v text := replace(gen_random_uuid()::text, '-', '');
begin
  if not public.alumni_can('manage') then raise exception 'You cannot change alumni.'; end if;
  update public.alumni set update_token = v where id = p_alumni and deleted_at is null;
  if not found then raise exception 'Alumnus not found.'; end if;
  return v;
end;
$$;
revoke all on function public.new_alumni_update_link(uuid) from public, anon;
grant execute on function public.new_alumni_update_link(uuid) to authenticated;

-- The token is shown only to people who see alumni (the column is read through the view;
-- callers without access see no rows at all)

-- ---------------------------------------------------------------------
-- 4b. 🎓 A batch is closed → its students become alumni (Settings → Alumni)
-- ---------------------------------------------------------------------
create or replace function public.alumni_from_closed_batch()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_n int;
  m   uuid;
begin
  if new.status <> 'closed' or old.status = 'closed' then return null; end if;
  if not coalesce((public.alumni_setting() ->> 'auto_from_batch')::boolean, false) then return null; end if;
  with ins as (
    insert into public.alumni (name, phone, whatsapp_number, email, course_id, batch_id, student_ref, district, lead_id, created_by)
    select l.name, coalesce(l.phone, l.whatsapp_number), l.whatsapp_number, l.email, l.admitted_course_id,
           l.admitted_batch_id, l.student_ref, l.area, l.id, auth.uid()
    from public.leads l
    where l.admitted_batch_id = new.id and l.deleted_at is null and l.admitted_at is not null and l.cancelled_at is null
      and not exists (select 1 from public.alumni a where a.lead_id = l.id and a.deleted_at is null)
      and not exists (select 1 from public.alumni a where a.phone = public.normalize_bd_phone(coalesce(l.phone, l.whatsapp_number))
                        and a.deleted_at is null)
    on conflict do nothing
    returning id),
  ev as (
    insert into public.alumni_events (alumni_id, kind, body, by_user)
    select ins.id, 'created', 'From the closed batch ' || new.name, auth.uid() from ins)
  select count(*) into v_n from ins;
  if v_n > 0 then
    for m in select public.alumni_managers() loop
      perform public.notify(m, 'alumni', '🎓 ' || v_n || ' students of ' || new.name || ' are alumni now',
        'The batch was closed.', jsonb_build_object('route', '/alumni'), 'alumni-batch:' || new.id, false);
    end loop;
  end if;
  return null;
end;
$$;
drop trigger if exists alumni_from_closed_batch on public.batches;
create trigger alumni_from_closed_batch after update of status on public.batches
  for each row execute function public.alumni_from_closed_batch();

-- ---------------------------------------------------------------------
-- 4c. 👥 Duplicates and merging
-- ---------------------------------------------------------------------
create or replace function public.alumni_duplicates()
returns jsonb
language plpgsql
stable
security definer
set search_path = public
set jit = off
as $$
begin
  if not public.alumni_can('manage') then raise exception 'You cannot change alumni.'; end if;
  return coalesce((select jsonb_agg(g) from (
    select jsonb_agg(jsonb_build_object('id', a.id, 'name', a.name, 'phone', a.phone, 'whatsapp', a.whatsapp_number,
                                        'batch', b.name, 'passing_year', a.passing_year, 'workplace', a.workplace,
                                        'referrals', a.cnt_referrals, 'created_at', a.created_at)
                     order by a.created_at) as g
    from public.alumni a
    left join public.batches b on b.id = a.batch_id
    join (
      -- the same name in the same batch / passing year
      select array_agg(x.id) as ids from public.alumni x
      where x.deleted_at is null
      group by lower(regexp_replace(trim(x.name), '\s+', ' ', 'g')), coalesce(x.batch_id::text, x.passing_year::text, '')
      having count(*) > 1
      union all
      -- one's phone is another's WhatsApp
      select array[x.id, y.id] from public.alumni x join public.alumni y
        on y.whatsapp_number = x.phone and y.id <> x.id
      where x.deleted_at is null and y.deleted_at is null and x.phone is not null and x.id < y.id
    ) d on a.id = any (d.ids)
    group by d.ids
    limit 200) z), '[]'::jsonb);
end;
$$;
revoke all on function public.alumni_duplicates() from public, anon;
grant execute on function public.alumni_duplicates() to authenticated;

-- Keep one, move everything of the others to it, then remove the others
create or replace function public.alumni_merge(p_keep uuid, p_others uuid[])
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  k   public.alumni;
  o   public.alumni;
  v_names text := '';
begin
  if not public.alumni_can('manage') then raise exception 'You cannot change alumni.'; end if;
  select * into k from public.alumni where id = p_keep and deleted_at is null for update;
  if k.id is null then raise exception 'The one to keep was not found.'; end if;
  if coalesce(array_length(p_others, 1), 0) = 0 or p_keep = any (p_others) then raise exception 'Choose the others.'; end if;

  for o in select * from public.alumni where id = any (p_others) and deleted_at is null for update
  loop
    v_names := v_names || case when v_names = '' then '' else ', ' end || o.name;
    -- out of the way first (a phone is unique among alumni)
    update public.alumni set deleted_at = now() where id = o.id;
    update public.alumni_events set alumni_id = k.id where alumni_id = o.id;
    update public.alumni_referrals set alumni_id = k.id where alumni_id = o.id;
    update public.alumni_rewards set alumni_id = k.id where alumni_id = o.id and tier is null;
    update public.alumni_rewards set status = 'cancelled', note = coalesce(note || ' · ', '') || 'merged'
      where alumni_id = o.id and tier is not null and status = 'due';
    update public.leads set referred_by_alumni_id = k.id where referred_by_alumni_id = o.id;
    update public.alumni_files set alumni_id = k.id where alumni_id = o.id;
    insert into public.alumni_link_opens as l (alumni_id, day, opens)
      select k.id, day, opens from public.alumni_link_opens where alumni_id = o.id
      on conflict (alumni_id, day) do update set opens = l.opens + excluded.opens;
    delete from public.alumni_link_opens where alumni_id = o.id;
    insert into public.alumni_campaign_items (campaign_id, alumni_id, sent_at, sent_by, skipped)
      select campaign_id, k.id, sent_at, sent_by, skipped from public.alumni_campaign_items where alumni_id = o.id
      on conflict do nothing;
    delete from public.alumni_campaign_items where alumni_id = o.id;
    update public.alumni_update_requests set alumni_id = k.id where alumni_id = o.id;

    -- what the kept one doesn't have
    update public.alumni set
      phone = coalesce(phone, o.phone),
      whatsapp_number = coalesce(whatsapp_number, o.whatsapp_number),
      email = coalesce(email, o.email),
      course_id = coalesce(course_id, o.course_id),
      batch_id = coalesce(batch_id, o.batch_id),
      session = coalesce(session, o.session),
      passing_year = coalesce(passing_year, o.passing_year),
      student_ref = coalesce(student_ref, o.student_ref),
      workplace = coalesce(workplace, o.workplace),
      designation = coalesce(designation, o.designation),
      district = coalesce(district, o.district),
      upazila = coalesce(upazila, o.upazila),
      address = coalesce(address, o.address),
      birth_date = coalesce(birth_date, o.birth_date),
      owner_id = coalesce(owner_id, o.owner_id),
      lead_id = coalesce(lead_id, o.lead_id),
      custom = o.custom || custom,
      tags = (select coalesce(array_agg(distinct t), '{}') from unnest(tags || o.tags) t),
      notes = nullif(concat_ws(E'\n', notes, o.notes), ''),
      do_not_contact = do_not_contact or o.do_not_contact,
      next_contact_at = case when next_contact_at is null then o.next_contact_at
                             when o.next_contact_at is null then next_contact_at
                             else least(next_contact_at, o.next_contact_at) end
    where id = k.id;
    insert into public.alumni_events (alumni_id, kind, body, by_user)
      values (o.id, 'deleted', 'Merged into ' || k.name, auth.uid());
  end loop;
  if v_names = '' then raise exception 'The others were not found.'; end if;
  perform public.alumni_log(k.id, 'edited', 'Merged: ' || v_names);
  perform public.alumni_recount(k.id);
  perform public.alumni_touch(k.id);
  perform public.alumni_check_tiers(k.id);
end;
$$;
revoke all on function public.alumni_merge(uuid, uuid[]) from public, anon;
grant execute on function public.alumni_merge(uuid, uuid[]) to authenticated;

-- ---------------------------------------------------------------------
-- The list view: + opens, refer score, schools (same columns before; new ones at the end)
-- ---------------------------------------------------------------------
drop view if exists public.alumni_overview;
create view public.alumni_overview with (security_invoker = true) as
select a.*,
  c.name as course_name,
  b.name as batch_name,
  o.full_name as owner_name,
  a.cnt_referrals as referrals,
  a.cnt_waiting   as referrals_waiting,
  a.cnt_leads     as referred_leads,
  a.cnt_admitted  as referred_admitted,
  coalesce((select sum(rw.amount) from public.alumni_rewards rw
            where rw.alumni_id = a.id and rw.status = 'due'), 0) as reward_due
from public.alumni a
left join public.courses c on c.id = a.course_id
left join public.batches b on b.id = a.batch_id
left join public.profiles o on o.id = a.owner_id
where a.deleted_at is null;
grant select on public.alumni_overview to authenticated;

notify pgrst, 'reload schema';
