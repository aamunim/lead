-- =====================================================================
-- 💬 Contact developer as a chat (one chat per person, topics inside)
--   • Each person has one chat with the developer: plain messages any time.
--   • 🐞 Problem / 💡 Idea / ❓ Question start a "topic" (a card in the
--     chat, the feedback row); replies can belong to a topic; each topic
--     has its own status (🆕 👀 🔧 ✅ ❌), shown as lines in the chat.
--   • Reply to a message, 👍❤️😂😮🙏 reactions, delete your own within
--     5 minutes, ✓✓ seen, typing (realtime broadcast, no table).
--   • Only the person and the developer see a chat.
--   • The old feedback rows become topics; their answers become replies.
--   • Old apps still work: send_feedback makes a topic, and the developer's
--     newest reply in a topic is kept in feedback.reply.
-- =====================================================================

-- A topic can start with a short word ("ok") or only a picture
alter table public.feedback drop constraint if exists feedback_message_check;
alter table public.feedback add constraint feedback_message_check check (length(trim(message)) between 1 and 4000);

-- ---------------------------------------------------------------------
-- 1. Messages and who read up to when
-- ---------------------------------------------------------------------
create table if not exists public.feedback_messages (
  id          uuid primary key default gen_random_uuid(),
  chat_user   uuid not null references public.profiles(id) on delete cascade, -- whose chat
  sender      uuid not null references public.profiles(id) on delete cascade,
  kind        text not null default 'text' check (kind in ('text', 'topic', 'status')),
  topic_id    uuid references public.feedback(id) on delete set null,
  reply_to    uuid references public.feedback_messages(id) on delete set null,
  body        text,
  attachments jsonb not null default '[]'::jsonb,  -- [{path, kind: image|voice, sec}]
  reactions   jsonb not null default '{}'::jsonb,  -- {user id: emoji}
  info        jsonb not null default '{}'::jsonb,  -- a topic: app version, phone
  created_at  timestamptz not null default now(),
  deleted_at  timestamptz
);

create index if not exists feedback_messages_chat_idx on public.feedback_messages (chat_user, created_at desc);
create index if not exists feedback_messages_topic_idx on public.feedback_messages (topic_id, created_at) where topic_id is not null;

alter table public.feedback_messages enable row level security;
grant select on public.feedback_messages to authenticated;
drop policy if exists "feedback_messages: own chat or developer" on public.feedback_messages;
create policy "feedback_messages: own chat or developer" on public.feedback_messages for select to authenticated
  using (chat_user = auth.uid() or public.is_developer());

create table if not exists public.feedback_reads (
  chat_user uuid not null references public.profiles(id) on delete cascade,
  reader    uuid not null references public.profiles(id) on delete cascade,
  read_at   timestamptz not null default now(),
  primary key (chat_user, reader)
);
alter table public.feedback_reads enable row level security;
grant select on public.feedback_reads to authenticated;
drop policy if exists "feedback_reads: own chat or developer" on public.feedback_reads;
create policy "feedback_reads: own chat or developer" on public.feedback_reads for select to authenticated
  using (chat_user = auth.uid() or public.is_developer());

-- ⚡ New messages, reactions and "seen" arrive at once (Supabase Realtime)
do $$
begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    begin
      alter publication supabase_realtime add table public.feedback_messages;
    exception when duplicate_object then null;
    end;
    begin
      alter publication supabase_realtime add table public.feedback_reads;
    exception when duplicate_object then null;
    end;
  end if;
end $$;

-- 📎 Files in a chat: the person sees the developer's pictures / voice too
do $$
begin
  if exists (select 1 from information_schema.tables where table_schema = 'storage' and table_name = 'objects') then
    execute 'drop policy if exists "feedback files: in my chat" on storage.objects';
    execute $p$create policy "feedback files: in my chat" on storage.objects for select to authenticated
      using (bucket_id = 'feedback' and exists (
        select 1 from public.feedback_messages m
        where m.chat_user = auth.uid() and m.attachments @> jsonb_build_array(jsonb_build_object('path', name))))$p$;
  end if;
end $$;

-- ---------------------------------------------------------------------
-- 2. A topic (feedback row) always has its card in the chat
--    (also for old apps that still call send_feedback)
-- ---------------------------------------------------------------------
create or replace function public.feedback_topic_card()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.feedback_messages (chat_user, sender, kind, topic_id, body, attachments, info, created_at)
  values (new.user_id, new.user_id, 'topic', new.id,
          case when new.message = '(see the files)' then null else new.message end,
          new.attachments, new.info, new.created_at);
  return new;
end;
$$;
drop trigger if exists feedback_topic_card on public.feedback;
create trigger feedback_topic_card after insert on public.feedback
  for each row execute function public.feedback_topic_card();

-- Files from the sender's own folder only (at most 3 pictures + 1 voice)
create or replace function public.chat_clean_files(p_files jsonb)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_files jsonb := '[]'::jsonb;
  v_img   int;
  v_voice int;
begin
  if jsonb_typeof(coalesce(p_files, '[]'::jsonb)) <> 'array' then return '[]'::jsonb; end if;
  select coalesce(jsonb_agg(jsonb_build_object(
           'path', a->>'path',
           'kind', case when a->>'kind' = 'voice' then 'voice' else 'image' end,
           'sec', nullif(a->>'sec', '')::int)), '[]'::jsonb),
         count(*) filter (where a->>'kind' is distinct from 'voice'),
         count(*) filter (where a->>'kind' = 'voice')
    into v_files, v_img, v_voice
  from jsonb_array_elements(p_files) a
  where a->>'path' like auth.uid()::text || '/%';
  if v_img > 3 or v_voice > 1 then raise exception 'At most 3 pictures and one voice message.'; end if;
  return v_files;
end;
$$;
revoke execute on function public.chat_clean_files(jsonb) from public, anon, authenticated;

-- The other side of a chat
create or replace function public.chat_other(p_chat_user uuid)
returns uuid
language sql
stable
security definer
set search_path = public
as $$
  select case when auth.uid() = p_chat_user then public.developer_id() else p_chat_user end;
$$;
revoke execute on function public.chat_other(uuid) from public, anon, authenticated;

-- Whose chat this person may write in (their own; the developer: anyone's)
create or replace function public.chat_owner(p_chat_user uuid)
returns uuid
language plpgsql
stable
security definer
set search_path = public
as $$
begin
  if auth.uid() is null or not public.is_active_user() then raise exception 'Please sign in again.'; end if;
  if public.is_developer() then
    if p_chat_user is null then raise exception 'Choose the person.'; end if;
    return p_chat_user;
  end if;
  if p_chat_user is not null and p_chat_user <> auth.uid() then raise exception 'Not your chat.'; end if;
  return auth.uid();
end;
$$;
revoke execute on function public.chat_owner(uuid) from public, anon, authenticated;

-- ---------------------------------------------------------------------
-- 3. ➤ Send: a plain message, a reply, or a new topic (p_topic_kind)
-- ---------------------------------------------------------------------
create or replace function public.chat_send(
  p_chat_user uuid default null,
  p_body text default null,
  p_attachments jsonb default '[]'::jsonb,
  p_reply_to uuid default null,
  p_topic uuid default null,
  p_topic_kind text default null,
  p_info jsonb default '{}'::jsonb)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_chat   uuid := public.chat_owner(p_chat_user);
  v_dev    boolean := public.is_developer();
  v_body   text := nullif(trim(coalesce(p_body, '')), '');
  v_files  jsonb := public.chat_clean_files(p_attachments);
  v_topic  uuid := p_topic;
  v_reply  public.feedback_messages;
  v_t      public.feedback;
  v_id     uuid;
  v_other  uuid;
  v_title  text;
begin
  if v_body is null and jsonb_array_length(v_files) = 0 then raise exception 'Write something first.'; end if;
  if length(coalesce(v_body, '')) > 4000 then raise exception 'That is too long (4,000 letters at most).'; end if;
  if (select count(*) from public.feedback_messages where sender = auth.uid() and created_at > now() - interval '1 hour') >= 120 then
    raise exception 'Too many messages this hour. Please try again later.';
  end if;

  -- 🐞💡❓ A new topic: the feedback row, its card is made by the trigger
  if p_topic_kind is not null then
    if p_topic_kind not in ('bug', 'idea', 'question') then raise exception 'Unknown kind.'; end if;
    insert into public.feedback (user_id, kind, message, info, attachments)
    values (v_chat, p_topic_kind, coalesce(v_body, '(see the files)'), coalesce(p_info, '{}'::jsonb), v_files)
    returning id into v_topic;
    select id into v_id from public.feedback_messages where topic_id = v_topic and kind = 'topic' limit 1;
    -- a topic the developer opens for someone is still that person's
    if v_dev and v_chat <> auth.uid() then
      update public.feedback_messages set sender = auth.uid() where id = v_id;
    end if;
  else
    if p_reply_to is not null then
      select * into v_reply from public.feedback_messages where id = p_reply_to and chat_user = v_chat;
      if not found then raise exception 'That message is not in this chat.'; end if;
      v_topic := coalesce(v_reply.topic_id, v_topic);
    end if;
    if v_topic is not null and not exists (select 1 from public.feedback where id = v_topic and user_id = v_chat) then
      v_topic := null;
    end if;
    insert into public.feedback_messages (chat_user, sender, kind, topic_id, reply_to, body, attachments)
    values (v_chat, auth.uid(), 'text', v_topic, p_reply_to, v_body, v_files)
    returning id into v_id;

    if v_topic is not null then
      select * into v_t from public.feedback where id = v_topic;
      if v_dev then
        -- old apps show the newest answer
        update public.feedback
           set reply = coalesce(v_body, '📎'), replied_at = now(), updated_at = now(),
               status = case when status = 'new' then 'seen' else status end
         where id = v_topic;
      elsif v_t.status in ('done', 'wont') then
        -- a word in a closed topic opens it again
        update public.feedback set status = 'new', updated_at = now() where id = v_topic;
        insert into public.feedback_messages (chat_user, sender, kind, topic_id, body)
        values (v_chat, auth.uid(), 'status', v_topic, 'new');
      end if;
    end if;
  end if;

  -- I have read everything up to my own message
  insert into public.feedback_reads (chat_user, reader, read_at) values (v_chat, auth.uid(), now())
  on conflict (chat_user, reader) do update set read_at = excluded.read_at;

  -- 🔔 The other side
  v_other := public.chat_other(v_chat);
  if v_other is not null and v_other <> auth.uid() then
    v_title := case
      when p_topic_kind = 'bug' then '🐞 Problem from '
      when p_topic_kind = 'idea' then '💡 Idea from '
      when p_topic_kind = 'question' then '❓ Question from '
      else '💬 ' end || coalesce(public.person_name(auth.uid()), 'someone');
    perform public.notify(v_other, 'feedback', v_title,
      left(coalesce(v_body, case when v_files @> '[{"kind":"voice"}]' then '🎙 Voice message' else '📷 Picture' end), 160),
      jsonb_build_object('route', case when v_dev then '/feedback' else '/feedback/chat?u=' || v_chat end),
      null);
  end if;
  return v_id;
end;
$$;
grant execute on function public.chat_send(uuid, text, jsonb, uuid, uuid, text, jsonb) to authenticated;

-- ---------------------------------------------------------------------
-- 4. 👍 Reactions, 🗑 delete (own, within 5 minutes), ✓✓ read
-- ---------------------------------------------------------------------
create or replace function public.chat_react(p_message uuid, p_emoji text)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  m public.feedback_messages;
begin
  select * into m from public.feedback_messages where id = p_message;
  if not found or (m.chat_user <> auth.uid() and not public.is_developer()) then raise exception 'Message not found.'; end if;
  if m.deleted_at is not null then return; end if;
  if p_emoji is null or p_emoji = '' or m.reactions ->> auth.uid()::text = p_emoji then
    update public.feedback_messages set reactions = reactions - auth.uid()::text where id = p_message;
  else
    if p_emoji not in ('👍', '❤️', '😂', '😮', '😢', '🙏') then raise exception 'Unknown reaction.'; end if;
    update public.feedback_messages set reactions = reactions || jsonb_build_object(auth.uid()::text, p_emoji)
     where id = p_message;
  end if;
end;
$$;
grant execute on function public.chat_react(uuid, text) to authenticated;

create or replace function public.chat_delete(p_message uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  m public.feedback_messages;
begin
  select * into m from public.feedback_messages where id = p_message;
  if not found or m.sender <> auth.uid() then raise exception 'You can delete only your own message.'; end if;
  if m.kind = 'status' then raise exception 'This can''t be deleted.'; end if;
  if m.created_at < now() - interval '5 minutes' then raise exception 'Messages can be deleted only in the first 5 minutes.'; end if;
  update public.feedback_messages set deleted_at = now(), body = null, attachments = '[]'::jsonb, reactions = '{}'::jsonb
   where id = p_message;
  -- a topic card: the topic goes too (its replies stay as plain messages)
  if m.kind = 'topic' and m.topic_id is not null then
    delete from public.feedback_messages where topic_id = m.topic_id and kind = 'status';
    update public.feedback_messages set topic_id = null where topic_id = m.topic_id and id <> m.id;
    delete from public.feedback where id = m.topic_id;
  end if;
end;
$$;
grant execute on function public.chat_delete(uuid) to authenticated;

create or replace function public.chat_mark_read(p_chat_user uuid default null)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_chat uuid := public.chat_owner(p_chat_user);
begin
  insert into public.feedback_reads (chat_user, reader, read_at) values (v_chat, auth.uid(), now())
  on conflict (chat_user, reader) do update set read_at = excluded.read_at;
  -- the developer opened it: new topics are seen
  if public.is_developer() then
    update public.feedback set status = 'seen', updated_at = now() where user_id = v_chat and status = 'new';
  end if;
end;
$$;
grant execute on function public.chat_mark_read(uuid) to authenticated;

-- ---------------------------------------------------------------------
-- 5. A topic's status (the developer; the person: solved / open again)
-- ---------------------------------------------------------------------
create or replace function public.chat_topic_status(p_topic uuid, p_status text)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  t      public.feedback;
  v_dev  boolean := public.is_developer();
  v_other uuid;
  v_label text;
begin
  select * into t from public.feedback where id = p_topic;
  if not found or (t.user_id <> auth.uid() and not v_dev) then raise exception 'Topic not found.'; end if;
  if p_status not in ('new', 'seen', 'working', 'done', 'wont') then raise exception 'Unknown status.'; end if;
  if not v_dev and p_status not in ('done', 'new') then raise exception 'Only the developer can set this.'; end if;
  if t.status = p_status then return; end if;

  update public.feedback
     set status = p_status, updated_at = now(),
         solved_at = case when p_status = 'done' then now() else null end,
         solved_by = case when p_status = 'done' then auth.uid() else null end
   where id = p_topic;
  insert into public.feedback_messages (chat_user, sender, kind, topic_id, body)
  values (t.user_id, auth.uid(), 'status', p_topic, p_status);

  v_other := public.chat_other(t.user_id);
  v_label := case p_status when 'seen' then '👀 Seen' when 'working' then '🔧 Working on it'
                           when 'done' then '✅ Solved' when 'wont' then '❌ Won’t do' else '🆕 Open again' end;
  if v_other is not null and v_other <> auth.uid() then
    perform public.notify(v_other, 'feedback', v_label || ': ' || left(t.message, 60),
      coalesce(public.person_name(auth.uid()), ''),
      jsonb_build_object('route', case when v_dev then '/feedback' else '/feedback/chat?u=' || t.user_id end), null);
  end if;
end;
$$;
grant execute on function public.chat_topic_status(uuid, text) to authenticated;

-- The old "Solved" button (and old apps) write a line in the chat too
create or replace function public.solve_feedback(p_id uuid, p_solved boolean default true)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  perform public.chat_topic_status(p_id, case when p_solved then 'done' else 'new' end);
end;
$$;
grant execute on function public.solve_feedback(uuid, boolean) to authenticated;

-- ---------------------------------------------------------------------
-- 6. The developer's inbox: one row per person, and unread counts
-- ---------------------------------------------------------------------
create or replace function public.chat_inbox()
returns table (chat_user uuid, name text, role_name text, avatar_url text,
               last_body text, last_kind text, last_files int, last_sender uuid, last_at timestamptz,
               unread int, open_bug int, open_idea int, open_question int, their_read_at timestamptz)
language plpgsql
stable
security definer
set search_path = public
as $$
begin
  if not public.is_developer() then raise exception 'Only the developer can see this.'; end if;
  return query
  with last as (
    select distinct on (m.chat_user) m.chat_user, m.body, m.kind, jsonb_array_length(m.attachments) as files,
           m.sender, m.created_at, m.deleted_at
    from public.feedback_messages m
    order by m.chat_user, m.created_at desc
  )
  select l.chat_user, p.full_name, r.name, p.avatar_url,
         case when l.deleted_at is not null then '🗑 Deleted' else l.body end, l.kind, l.files, l.sender, l.created_at,
         (select count(*)::int from public.feedback_messages m
           where m.chat_user = l.chat_user and m.sender <> auth.uid() and m.deleted_at is null and m.kind <> 'status'
             and m.created_at > coalesce((select read_at from public.feedback_reads x
                                          where x.chat_user = l.chat_user and x.reader = auth.uid()), '-infinity')),
         (select count(*)::int from public.feedback f where f.user_id = l.chat_user and f.kind = 'bug' and f.status not in ('done', 'wont')),
         (select count(*)::int from public.feedback f where f.user_id = l.chat_user and f.kind = 'idea' and f.status not in ('done', 'wont')),
         (select count(*)::int from public.feedback f where f.user_id = l.chat_user and f.kind = 'question' and f.status not in ('done', 'wont')),
         (select read_at from public.feedback_reads x where x.chat_user = l.chat_user and x.reader = l.chat_user)
  from last l
  left join public.profiles p on p.id = l.chat_user
  left join public.roles r on r.key = p.role_key
  order by l.created_at desc
  limit 500;
end;
$$;
grant execute on function public.chat_inbox() to authenticated;

-- Unread: the person (their chat) or the developer (all chats)
create or replace function public.chat_unread()
returns int
language sql
stable
security definer
set search_path = public
as $$
  select count(*)::int
  from public.feedback_messages m
  where m.sender <> auth.uid() and m.deleted_at is null and m.kind <> 'status'
    and (m.chat_user = auth.uid() or public.is_developer())
    and m.created_at > coalesce((select read_at from public.feedback_reads x
                                 where x.chat_user = m.chat_user and x.reader = auth.uid()), '-infinity');
$$;
grant execute on function public.chat_unread() to authenticated;

-- The developer's "all open topics"
create or replace function public.chat_open_topics()
returns table (id uuid, chat_user uuid, name text, kind text, message text, status text,
               created_at timestamptz, updated_at timestamptz, replies int)
language plpgsql
stable
security definer
set search_path = public
as $$
begin
  if not public.is_developer() then raise exception 'Only the developer can see this.'; end if;
  return query
  select f.id, f.user_id, p.full_name, f.kind, f.message, f.status, f.created_at, f.updated_at,
         (select count(*)::int from public.feedback_messages m where m.topic_id = f.id and m.kind = 'text' and m.deleted_at is null)
  from public.feedback f
  left join public.profiles p on p.id = f.user_id
  order by (f.status in ('done', 'wont')), array_position(array['new', 'working', 'seen'], f.status), f.updated_at desc
  limit 500;
end;
$$;
grant execute on function public.chat_open_topics() to authenticated;

-- 🧹 Old files cleaned up: the topic card forgets them too
create or replace function public.feedback_files_removed(p_ids uuid[])
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if not public.is_developer() then raise exception 'Only the developer can do this.'; end if;
  update public.feedback set files_removed_at = now() where id = any(p_ids);
  update public.feedback_messages set attachments = '[]'::jsonb where topic_id = any(p_ids) and kind = 'topic';
end;
$$;
grant execute on function public.feedback_files_removed(uuid[]) to authenticated;

-- ---------------------------------------------------------------------
-- 7. The old messages: each one a topic card, its answer a reply
-- ---------------------------------------------------------------------
do $$
declare
  v_dev uuid := public.developer_id();
begin
  insert into public.feedback_messages (chat_user, sender, kind, topic_id, body, attachments, info, created_at)
  select f.user_id, f.user_id, 'topic', f.id,
         case when f.message = '(see the files)' then null else f.message end,
         case when f.files_removed_at is null then f.attachments else '[]'::jsonb end, f.info, f.created_at
  from public.feedback f
  where not exists (select 1 from public.feedback_messages m where m.topic_id = f.id and m.kind = 'topic');

  if v_dev is not null then
    insert into public.feedback_messages (chat_user, sender, kind, topic_id, body, created_at)
    select f.user_id, v_dev, 'text', f.id, f.reply, coalesce(f.replied_at, f.updated_at)
    from public.feedback f
    where nullif(trim(coalesce(f.reply, '')), '') is not null
      and not exists (select 1 from public.feedback_messages m where m.topic_id = f.id and m.kind = 'text');

    insert into public.feedback_messages (chat_user, sender, kind, topic_id, body, created_at)
    select f.user_id, coalesce(f.solved_by, v_dev), 'status', f.id, f.status,
           coalesce(f.solved_at, f.updated_at) + interval '1 second'
    from public.feedback f
    where f.status in ('done', 'wont', 'working')
      and not exists (select 1 from public.feedback_messages m where m.topic_id = f.id and m.kind = 'status');

    -- nothing old shows as unread
    insert into public.feedback_reads (chat_user, reader, read_at)
    select distinct f.user_id, v_dev, now() from public.feedback f
    on conflict (chat_user, reader) do nothing;
  end if;
  insert into public.feedback_reads (chat_user, reader, read_at)
  select distinct f.user_id, f.user_id, now() from public.feedback f
  on conflict (chat_user, reader) do nothing;
end $$;

notify pgrst, 'reload schema';
