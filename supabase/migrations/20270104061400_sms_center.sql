-- =====================================================================
-- 📨 SMS Center: SMS to leads — Active, Not Now or Admitted — chosen with
--   every filter of the lead list (stages, tags, course, batch, person,
--   fee, papers, visit, AI chance…). The same SMS company, sender IDs,
--   queue and "who may send" as Settings → SMS.
--   • Only the leads the sender can see (the same rules as the lead list)
--   • The lead's own mobile number; one SMS per number
--   • {name} {first_name} {course} {stage} {student_id} {fee_due} {owner}
--     {owner_phone} filled for each
--   • Now, or at a time you choose
--   • A sent SMS shows on the lead's timeline
--   • Who got it / who didn't: open them in the lead list
-- =====================================================================

alter table public.sms_batches drop constraint if exists sms_batches_audience_check;
alter table public.sms_batches add constraint sms_batches_audience_check
  check (audience in ('alumni', 'test', 'leads'));
alter table public.sms_batches
  add column if not exists group_key text check (group_key is null or group_key in ('active', 'not_now', 'admitted')),
  add column if not exists filter_label text,
  add column if not exists scheduled_at timestamptz;

alter table public.sms_messages
  add column if not exists lead_id uuid references public.leads (id) on delete set null;
create index if not exists sms_messages_lead_idx on public.sms_messages (lead_id, created_at desc) where lead_id is not null;

-- ---------------------------------------------------------------------
-- 1. Can I see this lead? (the lead list's rules, for the server's own use)
--    = leads_read OR "shared mode / added by me", AND the course rule
-- ---------------------------------------------------------------------
create or replace function public.sms_lead_visible(p_assigned_to uuid, p_created_by uuid, p_course_ids uuid[])
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select
    (public.can_view_lead(p_assigned_to)
     or (public.is_active_user() and (public.leads_shared_mode() or p_created_by = auth.uid())))
    and (public.course_free()
         or case when cardinality(coalesce(p_course_ids, '{}')) = 0 then p_created_by = auth.uid()
                 else public.my_course_ids() is null or p_course_ids && public.my_course_ids() end);
$$;
revoke all on function public.sms_lead_visible(uuid, uuid, uuid[]) from public, anon, authenticated;

-- the leads of this send that I can see, in the group, with what the SMS needs
create or replace function public.sms_lead_rows(p_ids uuid[], p_group text)
returns table (lead_id uuid, name text, num text, in_group boolean, course text, stage text, student_ref text,
               fee_due numeric, owner text, owner_phone text, created_at timestamptz, got_before boolean)
language sql
stable
security definer
set search_path = public
as $$
  select l.id, l.name, public.sms_number(l.phone),
         case p_group when 'active' then st.kind = 'open' and l.closed_at is null
                      when 'not_now' then st.kind = 'lost'
                      when 'admitted' then st.kind = 'won' and l.admitted_at is not null
                      else false end,
         coalesce(ac.name, pc.name, (select c.name from public.courses c where c.id = any (l.course_ids) order by c.name limit 1)),
         st.name, l.student_ref, l.fee_due, o.full_name, o.phone, l.created_at,
         exists (select 1 from public.sms_messages m where m.lead_id = l.id and m.status = 'sent')
  from public.leads l
  join public.pipeline_stages st on st.id = l.stage_id
  left join public.courses ac on ac.id = l.admitted_course_id
  left join public.courses pc on pc.id = l.pipeline_course_id
  left join public.profiles o on o.id = l.assigned_to
  where l.id = any (coalesce(p_ids, '{}')) and l.deleted_at is null
    and public.sms_lead_visible(l.assigned_to, l.created_by, l.course_ids);
$$;
revoke all on function public.sms_lead_rows(uuid[], text) from public, anon, authenticated;

-- {name} {first_name} {course} {stage} {student_id} {fee_due} {owner} {owner_phone}
create or replace function public.sms_fill_lead(p_text text, p_name text, p_course text, p_stage text, p_ref text,
                                                p_fee_due numeric, p_owner text, p_owner_phone text)
returns text
language sql
immutable
as $$
  select replace(replace(replace(replace(replace(replace(
           public.sms_fill(p_text, p_name),
           '{course}', coalesce(p_course, '')),
           '{stage}', coalesce(p_stage, '')),
           '{student_id}', coalesce(p_ref, '')),
           '{fee_due}', coalesce(to_char(round(coalesce(p_fee_due, 0)), 'FM999,999,999'), '0')),
           '{owner_phone}', coalesce(p_owner_phone, '')),
           '{owner}', coalesce(p_owner, ''));
$$;
grant execute on function public.sms_fill_lead(text, text, text, text, text, numeric, text, text) to authenticated;

-- ---------------------------------------------------------------------
-- 2. Before sending: how many of these leads can get it
-- ---------------------------------------------------------------------
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
    'will_get', count(distinct r.num) filter (where r.in_group and r.num is not null))
  into v
  from public.sms_lead_rows(p_ids, p_group) r;
  return v;
end;
$$;
revoke all on function public.lead_sms_preview(uuid[], text) from public, anon;
grant execute on function public.lead_sms_preview(uuid[], text) to authenticated;

-- ---------------------------------------------------------------------
-- 3. Send (in the queue now, or at p_at)
-- ---------------------------------------------------------------------
create or replace function public.lead_sms_send(
  p_ids uuid[], p_group text, p_message text, p_sender uuid,
  p_name text default null, p_filter_label text default null, p_at timestamptz default null)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_max    int := coalesce((public.sms_setting() ->> 'max_per_send')::int, 5000);
  v_prov   public.sms_providers;
  v_sender public.sms_senders;
  v_msg    text := trim(coalesce(p_message, ''));
  v_batch  uuid;
  v_n      int;
begin
  if not public.sms_can_send() then raise exception 'You can''t send SMS. (Settings → SMS)'; end if;
  if p_group not in ('active', 'not_now', 'admitted') then raise exception 'Choose Active, Not Now or Admitted.'; end if;
  if v_msg = '' then raise exception 'Write the message.'; end if;
  if char_length(v_msg) > 1000 then raise exception 'The message is too long (at most 1,000 letters).'; end if;
  if coalesce(array_length(p_ids, 1), 0) = 0 then raise exception 'Choose who gets it.'; end if;
  if array_length(p_ids, 1) > v_max then raise exception 'At most % people in one send.', v_max; end if;
  if p_at is not null and p_at > now() + interval '60 days' then
    raise exception 'Choose a time within the next 60 days.';
  end if;
  select * into v_prov from public.sms_providers where is_active;
  select * into v_sender from public.sms_senders where id = p_sender and provider_id = v_prov.id and is_active;
  if v_sender.id is null then raise exception 'Choose a sender ID (Settings → SMS).'; end if;

  insert into public.sms_batches (audience, group_key, name, filter_label, message, sender_id, sender_text,
                                  sender_kind, provider_id, created_by, scheduled_at)
  values ('leads', p_group, nullif(trim(coalesce(p_name, '')), ''), left(nullif(trim(coalesce(p_filter_label, '')), ''), 300),
          v_msg, v_sender.id, v_sender.sender_id, v_sender.kind, v_prov.id, auth.uid(),
          case when p_at > now() then p_at end)
  returning id into v_batch;

  insert into public.sms_messages (batch_id, lead_id, name, phone, body, parts)
  select v_batch, x.lead_id, x.name, x.num, x.body, public.sms_parts(x.body)
  from (
    select distinct on (r.num) r.lead_id, r.name, r.num,
           public.sms_fill_lead(v_msg, r.name, r.course, r.stage, r.student_ref, r.fee_due, r.owner, r.owner_phone) as body
    from public.sms_lead_rows(p_ids, p_group) r
    where r.in_group and r.num is not null
    order by r.num, r.created_at desc
  ) x;
  get diagnostics v_n = row_count;

  if v_n = 0 then
    delete from public.sms_batches where id = v_batch;
    raise exception 'Nobody here can get an SMS (no mobile number, or not in this group).';
  end if;
  update public.sms_batches set total = v_n where id = v_batch;
  return jsonb_build_object('batch_id', v_batch, 'queued', v_n,
                            'parts', (select sum(parts) from public.sms_messages where batch_id = v_batch),
                            'scheduled_at', case when p_at > now() then p_at end);
end;
$$;
revoke all on function public.lead_sms_send(uuid[], text, text, uuid, text, text, timestamptz) from public, anon;
grant execute on function public.lead_sms_send(uuid[], text, text, uuid, text, text, timestamptz) to authenticated;

-- ---------------------------------------------------------------------
-- 4. Who got it / who didn't (to open them in the lead list)
--    p_got: true = sent; false = failed / stopped / waiting
-- ---------------------------------------------------------------------
create or replace function public.sms_batch_lead_ids(p_batch uuid, p_got boolean)
returns uuid[]
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  b public.sms_batches;
begin
  select * into b from public.sms_batches where id = p_batch;
  if b.id is null or not public.sms_can_see_batch(b.created_by) then raise exception 'This send is not there.'; end if;
  return coalesce((select array_agg(m.lead_id) from public.sms_messages m
                   where m.batch_id = b.id and m.lead_id is not null
                     and (case when p_got then m.status = 'sent' else m.status <> 'sent' end)), '{}');
end;
$$;
revoke all on function public.sms_batch_lead_ids(uuid, boolean) from public, anon;
grant execute on function public.sms_batch_lead_ids(uuid, boolean) to authenticated;

-- one lead's SMS (its page)
create or replace function public.lead_sms_list(p_lead uuid)
returns jsonb
language sql
stable
security definer
set search_path = public
as $$
  select coalesce(jsonb_agg(jsonb_build_object(
           'id', m.id, 'batch_id', m.batch_id, 'body', m.body, 'status', m.status, 'error', m.error,
           'sender', b.sender_text, 'at', coalesce(m.sent_at, b.scheduled_at, m.created_at)) order by m.created_at desc), '[]'::jsonb)
  from public.sms_messages m
  join public.sms_batches b on b.id = m.batch_id
  join public.leads l on l.id = m.lead_id
  where m.lead_id = p_lead and public.sms_lead_visible(l.assigned_to, l.created_by, l.course_ids);
$$;
revoke all on function public.lead_sms_list(uuid) from public, anon;
grant execute on function public.lead_sms_list(uuid) to authenticated;

-- ---------------------------------------------------------------------
-- 5. The queue, the "sent" mark, the lists: + leads, + a later time
-- ---------------------------------------------------------------------
create or replace function public.sms_tick()
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_set  jsonb := public.sms_setting();
  v_rate int := greatest(1, least(coalesce((v_set ->> 'per_minute')::int, 60), 500));
  v_prov public.sms_providers;
  r      record;
  v_req  bigint;
begin
  -- 1. the company's answers
  perform public.sms_read_answers();

  -- 2. the next ones
  if coalesce((v_set ->> 'enabled')::boolean, false) then
    select * into v_prov from public.sms_providers where is_active and coalesce(api_key, '') <> '';
    if v_prov.id is not null then
      for r in
        select m.id, m.phone, m.body, b.sender_text
        from public.sms_messages m
        join public.sms_batches b on b.id = m.batch_id
        where m.status = 'queued'
          and (b.scheduled_at is null or b.scheduled_at <= now())   -- a later send waits for its time
        order by m.created_at
        limit v_rate
        for update of m skip locked
      loop
        v_req := public.sms_request(
          v_prov.method,
          public.sms_url(v_prov.send_url, v_prov.api_key, coalesce(r.sender_text, ''),
                         public.sms_number(r.phone, v_prov.number_format), r.body));
        if v_req is null then
          update public.sms_messages
             set status = 'failed', error = 'This server can''t make web requests (pg_net is off)', done_at = now(),
                 tries = tries + 1
           where id = r.id;
        else
          update public.sms_messages
             set status = 'sending', request_id = v_req, sent_at = now(), tries = tries + 1
           where id = r.id;
        end if;
      end loop;
    end if;
  end if;

  -- 3. sends with nothing left to do
  update public.sms_batches b
     set status = 'done', done_at = now()
   where b.status = 'sending'
     and not exists (select 1 from public.sms_messages m where m.batch_id = b.id and m.status in ('queued', 'sending'));
end;
$$;

create or replace function public.sms_on_sent()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if new.status = 'sent' and old.status is distinct from 'sent' and new.alumni_id is not null then
    update public.alumni
       set sms_count = sms_count + 1,
           last_sms_at = greatest(coalesce(last_sms_at, '-infinity'::timestamptz), coalesce(new.sent_at, now())),
           sms_batch_ids = case when new.batch_id = any (sms_batch_ids) then sms_batch_ids
                                else sms_batch_ids || new.batch_id end
     where id = new.alumni_id;
  end if;
  -- 📨 on the lead's timeline
  if new.status = 'sent' and old.status is distinct from 'sent' and new.lead_id is not null then
    insert into public.lead_activity (lead_id, user_id, action, details)
    select new.lead_id, b.created_by, 'sms_sent',
           jsonb_build_object('body', left(new.body, 500), 'sender', b.sender_text, 'batch_id', b.id,
                              'name', b.name)
    from public.sms_batches b
    where b.id = new.batch_id
      and exists (select 1 from public.leads l where l.id = new.lead_id);
  end if;
  return null;
end;
$$;

create or replace function public.sms_batches_list(p_limit int default 50, p_before timestamptz default null)
returns jsonb
language sql
stable
security definer
set search_path = public
as $$
  select coalesce(jsonb_agg(x order by x.created_at desc), '[]'::jsonb)
  from (
    select b.id, b.audience, b.name, b.message, b.sender_text, b.sender_kind, b.total, b.status, b.created_at,
           b.done_at, pr.full_name as by_name, b.group_key, b.filter_label, b.scheduled_at,
           count(*) filter (where m.status = 'sent') as sent,
           count(*) filter (where m.status = 'failed') as failed,
           count(*) filter (where m.status in ('queued', 'sending')) as waiting,
           count(*) filter (where m.status = 'cancelled') as cancelled,
           coalesce(sum(m.parts) filter (where m.status = 'sent'), 0) as parts_sent
    from public.sms_batches b
    left join public.sms_messages m on m.batch_id = b.id
    left join public.profiles pr on pr.id = b.created_by
    where public.sms_can_see_batch(b.created_by)
      and (p_before is null or b.created_at < p_before)
    group by b.id, pr.full_name
    order by b.created_at desc
    limit greatest(1, least(coalesce(p_limit, 50), 200))
  ) x;
$$;

create or replace function public.sms_batch_detail(p_batch uuid, p_status text default null)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  b public.sms_batches;
begin
  select * into b from public.sms_batches where id = p_batch;
  if b.id is null or not public.sms_can_see_batch(b.created_by) then raise exception 'This send is not there.'; end if;
  return jsonb_build_object(
    'batch', (select x from (select b.id, b.audience, b.name, b.message, b.sender_text, b.sender_kind, b.total,
                                    b.status, b.created_at, b.done_at, b.group_key, b.filter_label, b.scheduled_at,
                                    (select full_name from public.profiles where id = b.created_by) as by_name) x),
    'counts', (select jsonb_build_object(
                 'sent', count(*) filter (where status = 'sent'),
                 'failed', count(*) filter (where status = 'failed'),
                 'waiting', count(*) filter (where status in ('queued', 'sending')),
                 'cancelled', count(*) filter (where status = 'cancelled'),
                 'parts', coalesce(sum(parts) filter (where status = 'sent'), 0))
               from public.sms_messages where batch_id = b.id),
    'messages', coalesce((
      select jsonb_agg(jsonb_build_object(
               'id', m.id, 'alumni_id', m.alumni_id, 'lead_id', m.lead_id, 'name', m.name, 'phone', m.phone, 'status', m.status,
               'parts', m.parts, 'error', m.error, 'response', m.response, 'sent_at', m.sent_at,
               'done_at', m.done_at) order by m.status, m.name)
      from (select * from public.sms_messages m
            where m.batch_id = b.id
              and (p_status is null
                   or (p_status = 'waiting' and m.status in ('queued', 'sending'))
                   or m.status = p_status)
            order by m.name
            limit 5000) m), '[]'::jsonb));
end;
$$;

notify pgrst, 'reload schema';
