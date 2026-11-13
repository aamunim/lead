-- =====================================================================
-- 📞 Phone numbers written any way → the right mobile number
--   One rule everywhere (saving a lead / alumnus / Lead Bank row, finding
--   duplicates, SMS): bd_mobiles() reads
--     • Bangla digits ০১৭১১… (they used to be dropped: the phone saved empty)
--     • +880 / 880 / +88 / 0088 / 00880 / just 1711… in front
--     • spaces, - . ( ), words like "WhatsApp"
--     • two numbers in one box ("01711…, 01819…", "… / …", "… or …", "… বা …",
--       or 22 digits run together) → the first one; on a lead the second
--       goes to Alt phone when that is empty
--   A mobile is 01 + 3–9 + 8 digits. Anything else (a landline…) is still
--   saved as before, it just gets no SMS.
--   SMS: a lead with no good mobile in Phone gets it on Alt phone (the
--   student's own; never the guardian's).
--   Old data is not changed in bulk: phone_format_report() lists what is
--   wrong and what could be fixed. A saved lead is tidied when it is saved
--   again (its phone hash follows), and no number is ever dropped: a second
--   one goes to Alt phone, any more to the notes ("Other number: …").
-- =====================================================================

-- one run of digits → 01XXXXXXXXX, or null
create or replace function public.bd_mobile_one(p_digits text)
returns text
language sql
immutable
as $$
  select case when x ~ '^01[3-9][0-9]{8}$' then x end
  from (select case
                 when d ~ '^8800?1[3-9][0-9]{8}$' then '0' || right(d, 10) -- 8801711…, +880 01711…, 00880…
                 when d ~ '^1[3-9][0-9]{8}$' then '0' || d                -- 1711…
                 else d end as x
        from (select regexp_replace(regexp_replace(coalesce(p_digits, ''), '[^0-9]', '', 'g'), '^00', '') as d) a) b;
$$;

-- every mobile number in a text, in order (01XXXXXXXXX)
create or replace function public.bd_mobiles(p text)
returns text[]
language plpgsql
immutable
as $$
declare
  t     text;
  part  text;
  d     text;
  res   text[] := '{}';
begin
  if p is null then return res; end if;
  -- Bangla digits → 0-9
  t := translate(p, '০১২৩৪৫৬৭৮৯', '0123456789');
  -- one box, many numbers: , / ; | new line, "or", "বা"
  for part in
    select x from regexp_split_to_table(t, '\s*(,|/|;|\||\n|\s+or\s+|\s+বা\s+)\s*', 'i') x
  loop
    d := regexp_replace(part, '[^0-9]', '', 'g');
    if d = '' then continue; end if;
    -- two numbers run together (22 digits)
    if length(d) = 22 and substr(d, 1, 2) = '01' and substr(d, 12, 2) = '01' then
      res := res || public.bd_mobile_one(substr(d, 1, 11)) || public.bd_mobile_one(substr(d, 12, 11));
    elsif length(d) = 26 and substr(d, 1, 4) = '8801' and substr(d, 14, 4) = '8801' then
      res := res || public.bd_mobile_one(substr(d, 1, 13)) || public.bd_mobile_one(substr(d, 14, 13));
    else
      res := res || public.bd_mobile_one(d);
    end if;
  end loop;
  res := array_remove(res, null);
  -- no number in the parts: one number with a mark inside ("01711/549594")
  if cardinality(res) = 0 then
    res := array_remove(array[public.bd_mobile_one(regexp_replace(t, '[^0-9]', '', 'g'))], null);
  end if;
  return res;
end;
$$;

-- the first mobile number in a text, or null
--   (a saved number is almost always 01XXXXXXXXX already: answered at once)
create or replace function public.bd_mobile(p text)
returns text
language sql
immutable
as $$
  select case when p ~ '^01[3-9][0-9]{8}$' then p else (public.bd_mobiles(p))[1] end;
$$;
grant execute on function public.bd_mobile(text) to authenticated;

-- why a number gets no SMS (null = it is fine)
create or replace function public.bd_phone_problem(p text)
returns text
language sql
immutable
as $$
  select case
    when nullif(trim(coalesce(p, '')), '') is null then 'No number'
    when public.bd_mobile(p) is not null then null
    when d = '' then 'No digits'
    when d !~ '^0?1' and length(d) between 6 and 10 then 'Landline (no SMS)'
    when d ~ '^0?1[0-2]' then 'Wrong operator code'
    when length(d) < 11 then 'Too short (' || length(d) || ' digits)'
    when length(d) > 11 then 'Too long (' || length(d) || ' digits)'
    else 'Not a Bangladesh mobile number'
  end
  from (select regexp_replace(
                 regexp_replace(regexp_replace(translate(coalesce(p, ''), '০১২৩৪৫৬৭৮৯', '0123456789'), '[^0-9]', '', 'g'),
                                '^00', ''),
                 '^880?(?=1[3-9])', '0') as d) x;
$$;
grant execute on function public.bd_phone_problem(text) to authenticated;

-- 💾 saving: the same rule (a mobile → 01XXXXXXXXX; anything else → its digits as before)
create or replace function public.normalize_bd_phone(p text)
returns text
language plpgsql
immutable
as $$
declare
  d text;
  m text;
begin
  if p is null then return null; end if;
  m := public.bd_mobile(p);
  if m is not null then return m; end if;

  d := regexp_replace(translate(p, '০১২৩৪৫৬৭৮৯', '0123456789'), '\D', '', 'g');   -- keep digits only
  if d = '' then
    return null;
  elsif length(d) = 13 and d like '880%' then
    d := '0' || substr(d, 4);              -- 8801711… → 01711…
  elsif length(d) = 10 and d like '1%' then
    d := '0' || d;                         -- 1711… → 01711…
  end if;
  return d;
end;
$$;

-- WhatsApp numbers: Bangla digits too
create or replace function public.normalize_wa_number(p text)
returns text
language plpgsql
immutable
as $$
declare
  d  text;
  bd text;
  t  text := translate(p, '০১২৩৪৫৬৭৮৯', '0123456789');
begin
  if p is null then return null; end if;
  d := regexp_replace(t, '\D', '', 'g');
  if d = '' then return null; end if;

  bd := public.normalize_bd_phone(t);
  if bd ~ '^01[3-9][0-9]{8}$' and not (trim(t) like '+%' and d not like '880%') then
    return bd;
  end if;

  if d like '00%' then d := substr(d, 3); end if;
  return '+' || d;
end;
$$;

-- the other numbers written in a box besides the first mobile (more mobiles,
-- landlines…), each tidied; [] when there is only one number
create or replace function public.phone_extras(p text)
returns text[]
language plpgsql
immutable
as $$
declare
  first text := public.bd_mobile(p);
  part  text;
  m     text[];
  res   text[] := '{}';
begin
  if p is null or first is null or p ~ '^01[3-9][0-9]{8}$' then return res; end if;
  for part in
    select x from regexp_split_to_table(translate(p, '০১২৩৪৫৬৭৮৯', '0123456789'),
                                        '\s*(,|/|;|\||\n|\s+or\s+|\s+বা\s+)\s*', 'i') x
  loop
    m := public.bd_mobiles(part);
    if cardinality(m) > 0 then
      res := res || m;
    elsif length(regexp_replace(part, '[^0-9]', '', 'g')) >= 5 then
      res := res || public.normalize_bd_phone(part);
    end if;
  end loop;
  -- the first mobile stays in Phone; the rest, once each
  return array(select distinct on (x) x from unnest(array_remove(res, first)) with ordinality t(x, i)
               where x is not null order by x, i);
end;
$$;

-- a lead: Phone keeps the first mobile; the next number goes to Alt phone (when
-- empty) and any more to the notes — nothing is dropped. Runs before
-- leads_before_write (which then tidies both) on every save of a Phone that
-- is not already a clean 01XXXXXXXXX (so old rows saved again are covered too).
create or replace function public.leads_split_phone()
returns trigger
language plpgsql
as $$
declare
  extra text[];
begin
  if new.phone is null or new.phone ~ '^01[3-9][0-9]{8}$' then return new; end if;
  extra := public.phone_extras(new.phone);
  if cardinality(extra) = 0 then return new; end if;
  new.phone := public.bd_mobile(new.phone);
  if nullif(trim(coalesce(new.alt_phone, '')), '') is null then
    new.alt_phone := extra[1];
    extra := extra[2:];
  else
    extra := array_remove(extra, public.normalize_bd_phone(new.alt_phone));
  end if;
  if cardinality(extra) > 0 then
    new.notes := concat_ws(E'\n', nullif(trim(coalesce(new.notes, '')), ''),
                           'Other number: ' || array_to_string(extra, ', '));
  end if;
  return new;
end;
$$;
drop trigger if exists leads_0_split_phone on public.leads;
create trigger leads_0_split_phone before insert or update on public.leads
  for each row execute function public.leads_split_phone();

-- the phone hashes follow the saved numbers even when a trigger (not the
-- SET list) changed them
create or replace function public.leads_phone_hashes()
returns trigger
language plpgsql
set search_path = public, extensions
as $$
begin
  if tg_op = 'INSERT' or new.phone is distinct from old.phone or new.phone_hash is null then
    new.phone_hash := case when new.phone is null then null else encode(digest(new.phone, 'sha256'), 'hex') end;
  end if;
  if tg_op = 'INSERT' or new.alt_phone is distinct from old.alt_phone or new.alt_phone_hash is null then
    new.alt_phone_hash := case when new.alt_phone is null then null else encode(digest(new.alt_phone, 'sha256'), 'hex') end;
  end if;
  return new;
end;
$$;
drop trigger if exists leads_phone_hashes on public.leads;
create trigger leads_phone_hashes before insert or update on public.leads
  for each row execute function public.leads_phone_hashes();

-- import and "save phone contacts as leads": the number goes in as it was
-- written, so the trigger above keeps a second number (it used to be dropped)
do $$
declare
  src text;
begin
  src := pg_get_functiondef('public.import_leads'::regproc);
  if position('      v_name, v_phone,' in src) = 0 or position('        phone             = coalesce(phone, v_phone),' in src) = 0 then
    raise exception 'import_leads is not as expected; update this migration';
  end if;
  src := replace(src, '      v_name, v_phone,',
                 '      v_name, case when cardinality(public.phone_extras(r ->> ''phone'')) > 0 then r ->> ''phone'' else v_phone end,');
  src := replace(src, '        phone             = coalesce(phone, v_phone),',
                 '        phone             = coalesce(phone, case when cardinality(public.phone_extras(r ->> ''phone'')) > 0 then r ->> ''phone'' else v_phone end),');
  execute src;

  src := pg_get_functiondef('public.save_contacts_as_leads'::regproc);
  if position('      coalesce(v_name, v_phone),
      v_phone,' in src) = 0 then
    raise exception 'save_contacts_as_leads is not as expected; update this migration';
  end if;
  src := replace(src, '      coalesce(v_name, v_phone),
      v_phone,', '      coalesce(v_name, v_phone),
      case when cardinality(public.phone_extras(v_row ->> ''phone'')) > 0 then v_row ->> ''phone'' else v_phone end,');
  execute src;
end $$;

-- 📨 SMS: the same rule
create or replace function public.sms_number(p_phone text, p_format text default '0')
returns text
language sql
immutable
as $$
  select case when m is null then null
              when p_format = '880' then '88' || m
              when p_format = '+880' then '+88' || m
              else m end
  from (select public.bd_mobile(p_phone) as m) x;
$$;
grant execute on function public.sms_number(text, text) to authenticated;

-- SMS to leads: Phone, else Alt phone (the student's own); the preview counts it
drop function if exists public.sms_lead_rows(uuid[], text);
create or replace function public.sms_lead_rows(p_ids uuid[], p_group text)
returns table (lead_id uuid, name text, num text, in_group boolean, course text, stage text, student_ref text,
               fee_due numeric, owner text, owner_phone text, created_at timestamptz, got_before boolean,
               alt_used boolean)
language sql
stable
security definer
set search_path = public
as $$
  select l.id, l.name, coalesce(public.sms_number(l.phone), public.sms_number(l.alt_phone)),
         case p_group when 'active' then st.kind = 'open' and l.closed_at is null
                      when 'not_now' then st.kind = 'lost'
                      when 'admitted' then st.kind = 'won' and l.admitted_at is not null
                      else false end,
         coalesce(ac.name, pc.name, (select c.name from public.courses c where c.id = any (l.course_ids) order by c.name limit 1)),
         st.name, l.student_ref, l.fee_due, o.full_name, o.phone, l.created_at,
         exists (select 1 from public.sms_messages m where m.lead_id = l.id and m.status = 'sent'),
         public.sms_number(l.phone) is null and public.sms_number(l.alt_phone) is not null
  from public.leads l
  join public.pipeline_stages st on st.id = l.stage_id
  left join public.courses ac on ac.id = l.admitted_course_id
  left join public.courses pc on pc.id = l.pipeline_course_id
  left join public.profiles o on o.id = l.assigned_to
  where l.id in (select v.id from public.sms_visible_ids(p_ids) v);
$$;

create or replace function public.lead_sms_preview(p_ids uuid[], p_group text)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v jsonb;
begin
  if not public.sms_can_send() then raise exception 'You can''t send SMS. (Settings → SMS)'; end if;
  if p_group not in ('active', 'not_now', 'admitted') then raise exception 'Choose Active, Not Now or Admitted.'; end if;
  select jsonb_build_object(
    'selected', coalesce(array_length(p_ids, 1), 0),
    'visible', count(*),
    'other_group', count(*) filter (where not r.in_group),
    'no_number', count(*) filter (where r.in_group and r.num is null),
    'same_number', count(*) filter (where r.in_group and r.num is not null)
                   - count(distinct r.num) filter (where r.in_group and r.num is not null),
    'got_sms_before', count(*) filter (where r.in_group and r.got_before),
    'alt_used', count(*) filter (where r.in_group and r.alt_used),
    'will_get', count(distinct r.num) filter (where r.in_group and r.num is not null))
  into v
  from public.sms_lead_rows(p_ids, p_group) r;
  return v;
end;
$$;

create or replace function public.sms_ai_segments(p_skip_days int default 3)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
set jit = off
as $$
declare
  v_today date := (now() at time zone 'Asia/Dhaka')::date;
  v_res   jsonb;
begin
  if not public.sms_can_send() then raise exception 'You can''t send SMS. (Settings → SMS)'; end if;

  with
  v as (
    select l.id, st.kind, l.closed_at, l.created_at, l.last_contacted_at, l.next_follow_up_at, l.visit_status,
           l.visit_at, l.admitted_at, l.fee_due, l.fee_next_due, l.papers_missing, l.lost_at, l.rating,
           coalesce(ac.name, pc.name) as course,
           exists (select 1 from public.sms_messages m
                   where m.lead_id = l.id and m.status in ('sent', 'queued', 'sending')
                     and m.created_at > now() - make_interval(days => greatest(coalesce(p_skip_days, 3), 0))) as recent_sms
    from public.leads l
    join public.pipeline_stages st on st.id = l.stage_id
    left join public.courses ac on ac.id = l.admitted_course_id
    left join public.courses pc on pc.id = l.pipeline_course_id
    where l.id in (select vi.id from public.sms_visible_ids(null) vi)
      and coalesce(public.sms_number(l.phone), public.sms_number(l.alt_phone)) is not null
  ),
  seg as (
    -- Active
    select 'call_today' as key, 'active' as grp, 'Next call is today' as title, v.* from v
     where v.kind = 'open' and v.closed_at is null
       and (v.next_follow_up_at at time zone 'Asia/Dhaka')::date = v_today
    union all
    select 'call_late', 'active', 'Next call is late (missed)', v.* from v
     where v.kind = 'open' and v.closed_at is null
       and (v.next_follow_up_at at time zone 'Asia/Dhaka')::date < v_today
    union all
    select 'new_not_called', 'active', 'New in the last 3 days, not talked to yet', v.* from v
     where v.kind = 'open' and v.closed_at is null and v.last_contacted_at is null
       and v.created_at > now() - interval '3 days'
    union all
    select 'quiet_14', 'active', 'No contact for 14+ days', v.* from v
     where v.kind = 'open' and v.closed_at is null
       and coalesce(v.last_contacted_at, v.created_at) < now() - interval '14 days'
    union all
    select 'visit_soon', 'active', 'Campus visit today or tomorrow', v.* from v
     where v.kind = 'open' and v.visit_status = 'planned'
       and (v.visit_at at time zone 'Asia/Dhaka')::date between v_today and v_today + 1
    union all
    select 'hot', 'active', 'Hot leads (rating or AI chance)', v.* from v
     where v.kind = 'open' and v.closed_at is null
       and (v.rating = 'hot' or exists (select 1 from public.lead_chances c where c.lead_id = v.id and c.level = 'hot'))
    -- Admitted
    union all
    select 'fee_overdue', 'admitted', 'Fee installment overdue', v.* from v
     where v.admitted_at is not null and coalesce(v.fee_due, 0) > 0 and v.fee_next_due < v_today
    union all
    select 'fee_due_week', 'admitted', 'Fee installment due in the next 7 days', v.* from v
     where v.admitted_at is not null and coalesce(v.fee_due, 0) > 0
       and v.fee_next_due between v_today and v_today + 7
    union all
    select 'papers_missing', 'admitted', 'Papers still missing', v.* from v
     where v.admitted_at is not null and coalesce(v.papers_missing, 0) > 0
    union all
    select 'new_students', 'admitted', 'Admitted in the last 7 days (welcome)', v.* from v
     where v.admitted_at > now() - interval '7 days'
    -- Not Now
    union all
    select 'not_now_1_6m', 'not_now', 'Said “not now” 1–6 months ago', v.* from v
     where v.kind = 'lost' and v.lost_at between now() - interval '180 days' and now() - interval '30 days'
  ),
  agg as (
    select s.key, s.grp, s.title,
           count(*) filter (where not s.recent_sms) as n,
           count(*) filter (where s.recent_sms) as skipped,
           array_agg(s.id order by s.created_at desc) filter (where not s.recent_sms) as ids
    from seg s
    group by s.key, s.grp, s.title
  ),
  courses as (
    select key, jsonb_agg(jsonb_build_object('course', course, 'n', n) order by n desc) as list
    from (select s.key, coalesce(s.course, 'No course') as course, count(*) as n
          from seg s where not s.recent_sms group by 1, 2) c
    group by key
  )
  select coalesce(jsonb_agg(jsonb_build_object(
           'key', a.key, 'group', a.grp, 'title', a.title, 'count', a.n, 'skipped_recent_sms', a.skipped,
           'courses', coalesce(c.list, '[]'::jsonb),
           'lead_ids', to_jsonb(coalesce(a.ids[1:3000], '{}'::uuid[]))) order by a.n desc), '[]'::jsonb)
  into v_res
  from agg a left join courses c on c.key = a.key
  where a.n > 0;
  return v_res;
end;
$$;
revoke all on function public.sms_lead_rows(uuid[], text) from public, anon, authenticated;


-- 📵 the leads of a send that get no SMS, and why (SMS Center: tap the pill)
create or replace function public.lead_sms_bad_numbers(p_ids uuid[], p_group text)
returns jsonb
language sql
stable
security definer
set search_path = public
set jit = off
as $$
  select coalesce(jsonb_agg(jsonb_build_object(
           'id', b.id, 'name', b.name, 'phone', b.phone, 'alt_phone', b.alt_phone,
           'why', public.bd_phone_problem(coalesce(nullif(trim(coalesce(b.phone, '')), ''), b.alt_phone)))
           order by b.name), '[]'::jsonb)
  from (
    select l.id, l.name, l.phone, l.alt_phone
    from public.leads l
    join public.sms_lead_rows(p_ids, p_group) r on r.lead_id = l.id
    where r.in_group and r.num is null and public.sms_can_send()
    order by l.name
    limit 200
  ) b;
$$;
revoke all on function public.lead_sms_bad_numbers(uuid[], text) from public, anon;
grant execute on function public.lead_sms_bad_numbers(uuid[], text) to authenticated;

-- 🔎 Old data (nothing is changed): how many numbers are not a good mobile,
--   which the new rule could fix, and a sample of each (admins)
create or replace function public.phone_format_report()
returns jsonb
language plpgsql
stable
security definer
set search_path = public
set jit = off
as $$
declare
  v jsonb;
begin
  if not public.has_permission('settings.manage') then raise exception 'Only an admin can see this.'; end if;
  with
  x as (
    select 'leads.phone' as box, id, name, phone as val from public.leads where deleted_at is null and phone is not null
    union all
    select 'leads.alt_phone', id, name, alt_phone from public.leads where deleted_at is null and alt_phone is not null
    union all
    select 'alumni.phone', id, name, phone from public.alumni where deleted_at is null and phone is not null
    union all
    select 'lead_bank.phone', id, name, phone from public.lead_bank where phone is not null
  ),
  y as (
    select x.*,
           case when val ~ '^01[3-9][0-9]{8}$' then array[val] else public.bd_mobiles(val) end as mobs,
           case when val ~ '^01[3-9][0-9]{8}$' then null else public.bd_phone_problem(val) end as why
    from x
  ),
  z as (
    select y.*, mobs[1] as good,
           case when mobs[1] is null then 'cannot_fix' when mobs[1] = val then 'ok' else 'can_fix' end as state
    from y
  )
  select jsonb_build_object(
    'boxes', (select coalesce(jsonb_agg(jsonb_build_object('box', box, 'total', n, 'ok', ok, 'can_fix', fix,
                                                           'cannot_fix', bad, 'two_numbers', two) order by box), '[]')
              from (select box, count(*) n, count(*) filter (where state = 'ok') ok,
                           count(*) filter (where state = 'can_fix') fix,
                           count(*) filter (where state = 'cannot_fix') bad,
                           count(*) filter (where cardinality(mobs) >= 2) two
                    from z group by box) s),
    'can_fix_sample', (select coalesce(jsonb_agg(jsonb_build_object('box', box, 'id', id, 'name', name, 'now', val,
                                                                    'would_be', good, 'second', mobs[2])), '[]')
                       from (select * from z where state = 'can_fix' order by box, name limit 100) s),
    'cannot_fix_sample', (select coalesce(jsonb_agg(jsonb_build_object('box', box, 'id', id, 'name', name, 'now', val,
                                                                       'why', why)), '[]')
                          from (select * from z where state = 'cannot_fix' order by box, name limit 100) s))
  into v;
  return v;
end;
$$;
revoke all on function public.phone_format_report() from public, anon;
grant execute on function public.phone_format_report() to authenticated;

notify pgrst, 'reload schema';
