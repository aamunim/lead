-- =====================================================================
-- 💬 Contact developer, step 2:
--   📸 up to 3 screenshots / photos and 🎙 a voice message with each
--      message (Supabase Storage, private bucket "feedback")
--   ✅ Solved: the developer or the sender marks a message solved; the
--      files of messages solved 90+ days ago are cleaned up
--   💥 Crash reports: errors in the app are sent by themselves, the same
--      error is counted on one row; the developer marks it solved, and it
--      opens again if it comes back on a newer version
-- =====================================================================

-- ---------------------------------------------------------------------
-- 1. Files with a message
-- ---------------------------------------------------------------------
alter table public.feedback
  add column if not exists attachments jsonb not null default '[]'::jsonb, -- [{path, kind: image|voice, sec}]
  add column if not exists solved_at timestamptz,
  add column if not exists solved_by uuid references public.profiles(id) on delete set null,
  add column if not exists files_removed_at timestamptz;

-- The private bucket and who may use it (skipped where there is no Storage, e.g. tests)
do $$
begin
  if exists (select 1 from information_schema.tables where table_schema = 'storage' and table_name = 'buckets') then
    insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
    values ('feedback', 'feedback', false, 10485760, array['image/jpeg', 'image/png', 'image/webp', 'audio/mp4', 'audio/m4a', 'audio/mpeg', 'audio/aac'])
    on conflict (id) do nothing;

    execute 'drop policy if exists "feedback files: own upload" on storage.objects';
    execute $p$create policy "feedback files: own upload" on storage.objects for insert to authenticated
      with check (bucket_id = 'feedback' and (storage.foldername(name))[1] = auth.uid()::text)$p$;
    execute 'drop policy if exists "feedback files: own or developer" on storage.objects';
    execute $p$create policy "feedback files: own or developer" on storage.objects for select to authenticated
      using (bucket_id = 'feedback' and ((storage.foldername(name))[1] = auth.uid()::text or public.is_developer()))$p$;
    execute 'drop policy if exists "feedback files: remove" on storage.objects';
    execute $p$create policy "feedback files: remove" on storage.objects for delete to authenticated
      using (bucket_id = 'feedback' and ((storage.foldername(name))[1] = auth.uid()::text or public.is_developer()))$p$;
  end if;
end $$;

-- Send: the same as before, with the files (paths in the sender's own folder)
drop function if exists public.send_feedback(text, text, jsonb);
create or replace function public.send_feedback(
  p_kind text, p_message text, p_info jsonb default '{}'::jsonb, p_attachments jsonb default '[]'::jsonb)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_id    uuid;
  v_dev   uuid := public.developer_id();
  v_files jsonb := '[]'::jsonb;
  v_n     int := 0;
begin
  if auth.uid() is null or not public.is_active_user() then raise exception 'Please sign in again.'; end if;
  if coalesce(length(trim(p_message)), 0) < 3 and jsonb_array_length(coalesce(p_attachments, '[]'::jsonb)) = 0 then
    raise exception 'Please write a little more.';
  end if;
  if (select count(*) from public.feedback where user_id = auth.uid() and created_at > now() - interval '1 hour') >= 10 then
    raise exception 'Too many messages this hour. Please try again later.';
  end if;

  if jsonb_typeof(coalesce(p_attachments, '[]'::jsonb)) = 'array' then
    select coalesce(jsonb_agg(jsonb_build_object(
             'path', a->>'path',
             'kind', case when a->>'kind' = 'voice' then 'voice' else 'image' end,
             'sec', nullif(a->>'sec', '')::int)), '[]'::jsonb),
           count(*)
      into v_files, v_n
    from jsonb_array_elements(p_attachments) a
    where a->>'path' like auth.uid()::text || '/%';
  end if;
  if v_n > 4 then raise exception 'At most 3 pictures and one voice message.'; end if;

  insert into public.feedback (user_id, kind, message, info, attachments)
  values (auth.uid(), p_kind,
          left(coalesce(nullif(trim(p_message), ''), case when v_n > 0 then '(see the files)' else '' end), 4000),
          coalesce(p_info, '{}'::jsonb), v_files)
  returning id into v_id;

  if v_dev is not null and v_dev <> auth.uid() then
    perform public.notify(
      v_dev, 'feedback',
      case p_kind when 'bug' then '🐞 Problem' when 'idea' then '💡 Idea' else '❓ Question' end
        || ' from ' || coalesce(public.person_name(auth.uid()), 'someone')
        || case when v_n > 0 then ' 📎' else '' end,
      left(coalesce(nullif(trim(p_message), ''), 'Files only'), 160),
      jsonb_build_object('route', '/feedback/inbox'));
  end if;
  return v_id;
end;
$$;
grant execute on function public.send_feedback(text, text, jsonb, jsonb) to authenticated;

-- ---------------------------------------------------------------------
-- 2. ✅ Solved (the developer, or the sender for their own message)
-- ---------------------------------------------------------------------
create or replace function public.solve_feedback(p_id uuid, p_solved boolean default true)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_row public.feedback;
  v_dev boolean := public.is_developer();
begin
  select * into v_row from public.feedback where id = p_id;
  if not found then raise exception 'Message not found.'; end if;
  if not v_dev and v_row.user_id is distinct from auth.uid() then raise exception 'Not your message.'; end if;

  update public.feedback
     set status = case when p_solved then 'done' else 'seen' end,
         solved_at = case when p_solved then now() else null end,
         solved_by = case when p_solved then auth.uid() else null end,
         updated_at = now()
   where id = p_id;

  if p_solved and v_row.status <> 'done' then
    if v_dev and v_row.user_id <> auth.uid() then
      perform public.notify(v_row.user_id, 'feedback', '✅ Your message: solved',
        left(v_row.message, 160), jsonb_build_object('route', '/feedback'));
    elsif not v_dev and public.developer_id() is not null and public.developer_id() <> auth.uid() then
      perform public.notify(public.developer_id(), 'feedback',
        '✅ ' || coalesce(public.person_name(auth.uid()), 'Someone') || ' marked it solved',
        left(v_row.message, 160), jsonb_build_object('route', '/feedback/inbox'));
    end if;
  end if;
end;
$$;
grant execute on function public.solve_feedback(uuid, boolean) to authenticated;

-- "Done" from the answer box counts as solved too
create or replace function public.feedback_solved_stamp()
returns trigger
language plpgsql
as $$
begin
  if new.status = 'done' and old.status is distinct from 'done' and new.solved_at is null then
    new.solved_at := now();
    new.solved_by := auth.uid();
  elsif new.status <> 'done' and old.status = 'done' then
    new.solved_at := null;
    new.solved_by := null;
  end if;
  return new;
end;
$$;
drop trigger if exists feedback_solved_stamp on public.feedback;
create trigger feedback_solved_stamp before update of status on public.feedback
  for each row execute function public.feedback_solved_stamp();

-- The inbox now has the files and when it was solved
drop function if exists public.feedback_inbox();
create or replace function public.feedback_inbox()
returns table (id uuid, user_id uuid, sender text, role_name text, kind text, message text, info jsonb,
               status text, reply text, replied_at timestamptz, created_at timestamptz,
               attachments jsonb, solved_at timestamptz, solved_by_name text)
language plpgsql
stable
security definer
set search_path = public
as $$
begin
  if not public.is_developer() then raise exception 'Only the developer can see this.'; end if;
  return query
  select f.id, f.user_id, p.full_name, r.name, f.kind, f.message, f.info, f.status, f.reply, f.replied_at, f.created_at,
         case when f.files_removed_at is null then f.attachments else '[]'::jsonb end,
         f.solved_at, sp.full_name
  from public.feedback f
  left join public.profiles p on p.id = f.user_id
  left join public.roles r on r.key = p.role_key
  left join public.profiles sp on sp.id = f.solved_by
  order by (f.status = 'new') desc, f.created_at desc
  limit 300;
end;
$$;
grant execute on function public.feedback_inbox() to authenticated;

-- 🧹 Files of messages solved 90+ days ago: the developer's app removes
--   them through Storage, then marks them removed here
create or replace function public.feedback_old_files()
returns table (id uuid, paths text[])
language sql
stable
security definer
set search_path = public
as $$
  select f.id, array(select a->>'path' from jsonb_array_elements(f.attachments) a)
  from public.feedback f
  where public.is_developer()
    and f.status = 'done' and f.solved_at < now() - interval '90 days'
    and f.files_removed_at is null and jsonb_array_length(f.attachments) > 0
  limit 50;
$$;
grant execute on function public.feedback_old_files() to authenticated;

create or replace function public.feedback_files_removed(p_ids uuid[])
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if not public.is_developer() then raise exception 'Only the developer can do this.'; end if;
  update public.feedback set files_removed_at = now() where id = any(p_ids);
end;
$$;
grant execute on function public.feedback_files_removed(uuid[]) to authenticated;

-- ---------------------------------------------------------------------
-- 3. 💥 Crash reports (one row per kind of error)
-- ---------------------------------------------------------------------
create table if not exists public.crash_reports (
  id             uuid primary key default gen_random_uuid(),
  signature      text not null unique,          -- the same error = the same signature
  name           text,
  message        text,
  stack          text,
  screen         text,
  fatal          boolean not null default false,
  count          int not null default 1,
  users          uuid[] not null default '{}',
  versions       text[] not null default '{}',  -- "2.7.0 · 1a2b3c4d"
  last_info      jsonb not null default '{}'::jsonb,
  last_user      uuid references public.profiles(id) on delete set null,
  first_at       timestamptz not null default now(),
  last_at        timestamptz not null default now(),
  status         text not null default 'open' check (status in ('open', 'solved')),
  solved_at      timestamptz,
  solved_version text,                          -- the newest version seen when it was solved
  notified_at    timestamptz
);
create index if not exists crash_reports_status_idx on public.crash_reports (status, last_at desc);
alter table public.crash_reports enable row level security;
-- read and written only through the functions below

create or replace function public.report_crash(
  p_signature text, p_name text, p_message text, p_stack text, p_screen text,
  p_info jsonb default '{}'::jsonb, p_fatal boolean default false, p_at timestamptz default now())
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_ver text := concat_ws(' · ', p_info->>'app', p_info->>'update');
  v_row public.crash_reports;
  v_new boolean := false;
  v_back boolean := false;
  v_dev uuid := public.developer_id();
  v_at timestamptz := least(coalesce(p_at, now()), now());
begin
  if auth.uid() is null then return; end if;
  if coalesce(trim(p_signature), '') = '' then return; end if;

  select * into v_row from public.crash_reports where signature = left(p_signature, 200) for update;
  if not found then
    insert into public.crash_reports (signature, name, message, stack, screen, fatal, users, versions,
                                      last_info, last_user, first_at, last_at)
    values (left(p_signature, 200), left(p_name, 200), left(p_message, 1000), left(p_stack, 4000), left(p_screen, 200),
            coalesce(p_fatal, false), array[auth.uid()], case when v_ver <> '' then array[v_ver] else '{}' end,
            coalesce(p_info, '{}'::jsonb), auth.uid(), v_at, v_at)
    returning * into v_row;
    v_new := true;
  else
    -- Solved, but it came back on a version not seen when it was solved: open again
    v_back := v_row.status = 'solved' and v_ver <> '' and v_ver is distinct from v_row.solved_version
              and not (v_ver = any(v_row.versions));
    update public.crash_reports
       set count = count + 1,
           users = case when auth.uid() = any(users) then users else (users || auth.uid())[1:500] end,
           versions = case when v_ver = '' or v_ver = any(versions) then versions else (versions || v_ver)[1:50] end,
           last_info = coalesce(p_info, '{}'::jsonb),
           last_user = auth.uid(),
           last_at = greatest(last_at, v_at),
           stack = coalesce(left(p_stack, 4000), stack),
           screen = coalesce(left(p_screen, 200), screen),
           fatal = fatal or coalesce(p_fatal, false),
           status = case when v_back then 'open' else status end,
           solved_at = case when v_back then null else solved_at end
     where id = v_row.id
     returning * into v_row;
  end if;

  -- Tell the developer: a new error, one that came back, else at most once an hour
  if v_dev is not null and v_row.status = 'open'
     and (v_new or v_back or v_row.notified_at is null or v_row.notified_at < now() - interval '1 hour') then
    update public.crash_reports set notified_at = now() where id = v_row.id;
    perform public.notify(
      v_dev, 'feedback',
      case when v_new then '💥 New crash' when v_back then '💥 Crash is back' else '💥 Crash again' end
        || ' · ' || coalesce(public.person_name(auth.uid()), 'someone'),
      left(coalesce(p_name, 'Error') || ': ' || coalesce(p_message, ''), 160)
        || case when v_row.count > 1 then format(' (×%s, %s people)', v_row.count, cardinality(v_row.users)) else '' end,
      jsonb_build_object('route', '/feedback/inbox?tab=crashes'),
      case when v_back then 'crash-back:' || v_row.id::text || ':' || v_ver
           else 'crash:' || v_row.id::text || ':' || to_char(now(), 'YYYYMMDDHH24') end, false);
  end if;
end;
$$;
grant execute on function public.report_crash(text, text, text, text, text, jsonb, boolean, timestamptz) to authenticated;

create or replace function public.crash_inbox()
returns table (id uuid, name text, message text, stack text, screen text, fatal boolean, count int,
               people int, versions text[], last_info jsonb, last_user_name text,
               first_at timestamptz, last_at timestamptz, status text, solved_at timestamptz)
language plpgsql
stable
security definer
set search_path = public
as $$
begin
  if not public.is_developer() then raise exception 'Only the developer can see this.'; end if;
  return query
  select c.id, c.name, c.message, c.stack, c.screen, c.fatal, c.count, cardinality(c.users),
         c.versions, c.last_info, p.full_name, c.first_at, c.last_at, c.status, c.solved_at
  from public.crash_reports c
  left join public.profiles p on p.id = c.last_user
  order by (c.status = 'open') desc, c.last_at desc
  limit 300;
end;
$$;
grant execute on function public.crash_inbox() to authenticated;

create or replace function public.solve_crash(p_id uuid, p_solved boolean default true)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if not public.is_developer() then raise exception 'Only the developer can do this.'; end if;
  update public.crash_reports
     set status = case when p_solved then 'solved' else 'open' end,
         solved_at = case when p_solved then now() else null end,
         -- the newest version it was seen on: the same version again does not open it
         solved_version = case when p_solved then versions[cardinality(versions)] else null end
   where id = p_id;
end;
$$;
grant execute on function public.solve_crash(uuid, boolean) to authenticated;

notify pgrst, 'reload schema';
