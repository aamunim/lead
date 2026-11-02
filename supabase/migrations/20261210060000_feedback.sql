-- =====================================================================
-- 💬 Contact developer: problems, ideas and questions from the app
--   Everyone sends (More → Contact developer) and sees their own, with
--   the developer's answer. The developer (app_settings.developer_email,
--   abamunim@gmail.com) sees all, sets the status, answers. Both sides
--   get a notification.
-- =====================================================================

insert into public.app_settings (key, value, description)
values ('developer_email', '"abamunim@gmail.com"', 'Who gets "Contact developer" messages')
on conflict (key) do nothing;

create or replace function public.developer_id()
returns uuid
language sql
stable
security definer
set search_path = public
as $$
  select u.id from auth.users u
  where lower(u.email) = lower((select value #>> '{}' from public.app_settings where key = 'developer_email'))
  limit 1;
$$;

create or replace function public.is_developer()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select auth.uid() is not null and auth.uid() = public.developer_id();
$$;

grant execute on function public.is_developer() to authenticated;

create table if not exists public.feedback (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null references public.profiles(id) on delete cascade,
  kind        text not null check (kind in ('bug', 'idea', 'question')),
  message     text not null check (length(trim(message)) between 3 and 4000),
  info        jsonb not null default '{}'::jsonb,     -- app version, update, phone
  status      text not null default 'new' check (status in ('new', 'seen', 'working', 'done', 'wont')),
  reply       text,
  replied_at  timestamptz,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

create index if not exists feedback_user_idx on public.feedback (user_id, created_at desc);
create index if not exists feedback_status_idx on public.feedback (status, created_at desc);

alter table public.feedback enable row level security;
grant select on public.feedback to authenticated;

drop policy if exists "feedback: own or developer" on public.feedback;
create policy "feedback: own or developer"
  on public.feedback for select
  to authenticated
  using (user_id = auth.uid() or public.is_developer());
-- written only through the functions below

create or replace function public.send_feedback(p_kind text, p_message text, p_info jsonb default '{}'::jsonb)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_id  uuid;
  v_dev uuid := public.developer_id();
begin
  if auth.uid() is null or not public.is_active_user() then raise exception 'Please sign in again.'; end if;
  if coalesce(length(trim(p_message)), 0) < 3 then raise exception 'Please write a little more.'; end if;
  if (select count(*) from public.feedback where user_id = auth.uid() and created_at > now() - interval '1 hour') >= 10 then
    raise exception 'Too many messages this hour. Please try again later.';
  end if;
  insert into public.feedback (user_id, kind, message, info)
  values (auth.uid(), p_kind, left(trim(p_message), 4000), coalesce(p_info, '{}'::jsonb))
  returning id into v_id;

  if v_dev is not null and v_dev <> auth.uid() then
    perform public.notify(
      v_dev, 'feedback',
      case p_kind when 'bug' then '🐞 Problem' when 'idea' then '💡 Idea' else '❓ Question' end
        || ' from ' || coalesce(public.person_name(auth.uid()), 'someone'),
      left(trim(p_message), 160),
      jsonb_build_object('route', '/feedback/inbox'));
  end if;
  return v_id;
end;
$$;

grant execute on function public.send_feedback(text, text, jsonb) to authenticated;

create or replace function public.answer_feedback(p_id uuid, p_status text, p_reply text)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_row public.feedback;
  v_reply text := nullif(trim(coalesce(p_reply, '')), '');
begin
  if not public.is_developer() then raise exception 'Only the developer can answer.'; end if;
  select * into v_row from public.feedback where id = p_id;
  if not found then raise exception 'Message not found.'; end if;

  update public.feedback
     set status     = coalesce(p_status, status),
         reply      = coalesce(v_reply, reply),
         replied_at = case when v_reply is not null and v_reply is distinct from v_row.reply then now() else replied_at end,
         updated_at = now()
   where id = p_id;

  -- Tell the sender when there is a new answer, or it is done / won't be done
  if v_row.user_id <> auth.uid()
     and ((v_reply is not null and v_reply is distinct from v_row.reply)
          or (p_status in ('done', 'wont') and p_status is distinct from v_row.status)) then
    perform public.notify(
      v_row.user_id, 'feedback',
      case coalesce(p_status, v_row.status)
        when 'done' then '✅ Your message: fixed'
        when 'wont' then '💬 Your message: answered'
        else '💬 The developer answered' end,
      left(coalesce(v_reply, v_row.message), 160),
      jsonb_build_object('route', '/feedback'));
  end if;
end;
$$;

grant execute on function public.answer_feedback(uuid, text, text) to authenticated;

-- The inbox, with the sender's name
create or replace function public.feedback_inbox()
returns table (id uuid, user_id uuid, sender text, role_name text, kind text, message text, info jsonb,
               status text, reply text, replied_at timestamptz, created_at timestamptz)
language plpgsql
stable
security definer
set search_path = public
as $$
begin
  if not public.is_developer() then raise exception 'Only the developer can see this.'; end if;
  return query
  select f.id, f.user_id, p.full_name, r.name, f.kind, f.message, f.info, f.status, f.reply, f.replied_at, f.created_at
  from public.feedback f
  left join public.profiles p on p.id = f.user_id
  left join public.roles r on r.key = p.role_key
  order by (f.status = 'new') desc, f.created_at desc
  limit 300;
end;
$$;

grant execute on function public.feedback_inbox() to authenticated;

notify pgrst, 'reload schema';
