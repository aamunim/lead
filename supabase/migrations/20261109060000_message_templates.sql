-- =====================================================================
-- 💬 WhatsApp / SMS message templates
--   1. Settings (app_settings 'message_templates'): the whole feature on/off,
--      who may use it (everyone / some roles / some people), what the
--      WhatsApp / SMS button does, and the institute's details for templates
--   2. message_templates: shared ones (admins) and personal ones (anyone);
--      admins may change / delete any, everyone else only their own
--   3. SMS in the call log: channel 'sms' (a message sent)
--   4. log_template_sent(): "💬 WhatsApp message sent · Template: Fee list"
--      on the lead, and the template's use count
-- =====================================================================

-- ---------------------------------------------------------------------
-- 1. Settings
-- ---------------------------------------------------------------------
insert into public.app_settings (key, value)
values ('message_templates', jsonb_build_object(
  'enabled', true,
  'who', jsonb_build_object('mode', 'all', 'roles', '[]'::jsonb, 'user_ids', '[]'::jsonb),
  'tap', 'sheet',            -- 'sheet' = the button opens the templates; 'long_press' = only a long press does
  'institute', jsonb_build_object('name', '', 'address', '', 'map_link', '', 'phone', '')
))
on conflict (key) do nothing;

-- May this person use templates? (the feature on, and the "who" rule)
create or replace function public.can_use_templates(p_user uuid default auth.uid())
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  with s as (select value as v from public.app_settings where key = 'message_templates'),
       p as (select role_key from public.profiles where id = p_user and is_active)
  select exists (select 1 from p)
     and coalesce((select (v->>'enabled')::boolean from s), true)
     and case coalesce((select v->'who'->>'mode' from s), 'all')
           when 'roles' then (select role_key from p) in
                             (select jsonb_array_elements_text(coalesce((select v->'who'->'roles' from s), '[]')))
           when 'users' then p_user::text in
                             (select jsonb_array_elements_text(coalesce((select v->'who'->'user_ids' from s), '[]')))
           else true
         end;
$$;

grant execute on function public.can_use_templates(uuid) to authenticated;

-- ---------------------------------------------------------------------
-- 2. Templates
-- ---------------------------------------------------------------------
create table if not exists public.message_templates (
  id           uuid primary key default gen_random_uuid(),
  name         text not null check (length(trim(name)) between 1 and 60),
  body         text not null check (length(trim(body)) between 1 and 2000),
  channels     text not null default 'both' check (channels in ('whatsapp', 'sms', 'both')),
  category     text,
  course_ids   uuid[],                   -- null / empty = every course
  is_shared    boolean not null default false,
  owner_id     uuid references public.profiles(id) on delete cascade default auth.uid(),
  sort_order   integer not null default 0,
  is_active    boolean not null default true,
  use_count    integer not null default 0,
  last_used_at timestamptz,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);

create index if not exists message_templates_owner_idx on public.message_templates (owner_id);

drop trigger if exists message_templates_updated_at on public.message_templates;
create trigger message_templates_updated_at
  before update on public.message_templates
  for each row execute function public.set_updated_at();

alter table public.message_templates enable row level security;

-- See: shared ones and my own
drop policy if exists "message_templates: view" on public.message_templates;
create policy "message_templates: view"
  on public.message_templates for select
  to authenticated
  using (public.is_active_user() and (is_shared or owner_id = auth.uid()));

-- Add: my own personal ones; shared ones only admins
drop policy if exists "message_templates: add" on public.message_templates;
create policy "message_templates: add"
  on public.message_templates for insert
  to authenticated
  with check (
    public.is_active_user() and owner_id = auth.uid()
    and (not is_shared or public.has_permission('settings.manage'))
  );

-- Change / delete: admins any; everyone else only their own personal ones
drop policy if exists "message_templates: change" on public.message_templates;
create policy "message_templates: change"
  on public.message_templates for update
  to authenticated
  using (public.has_permission('settings.manage') or (owner_id = auth.uid() and not is_shared))
  with check (public.has_permission('settings.manage') or (owner_id = auth.uid() and not is_shared));

drop policy if exists "message_templates: delete" on public.message_templates;
create policy "message_templates: delete"
  on public.message_templates for delete
  to authenticated
  using (public.has_permission('settings.manage') or (owner_id = auth.uid() and not is_shared));

-- A few to start with (only when there are none)
insert into public.message_templates (name, category, channels, is_shared, owner_id, sort_order, body)
select v.name, v.category, 'both', true, null, v.ord, v.body
from (values
  ('👋 Welcome', 'Welcome', 1,
   E'আসসালামু আলাইকুম {first_name},\n{institute}-এ আগ্রহ দেখানোর জন্য ধন্যবাদ। আমি {my_name}। {course} নিয়ে যেকোনো প্রশ্ন থাকলে এই নম্বরে জানাবেন: {my_phone}'),
  ('💰 Fee list', 'Fee', 2,
   E'{first_name}, {course}-এর খরচ:\n{fee}\n\nআরও জানতে কল করুন: {my_phone}'),
  ('📍 Campus address', 'Visit', 3,
   E'{institute}\nঠিকানা: {address}\nম্যাপ: {map_link}\nফোন: {office_phone}'),
  ('🏫 Visit reminder', 'Visit', 4,
   E'{first_name}, আপনার campus visit: {visit_time}\nঠিকানা: {address}\nম্যাপ: {map_link}'),
  ('📄 Papers needed', 'Papers', 5,
   E'{first_name}, ভর্তি সম্পূর্ণ করতে এই কাগজগুলো লাগবে:\n{papers_missing}'),
  ('⏰ Missed your call', 'Follow-up', 6,
   E'{first_name}, আপনাকে কল করেছিলাম। সুবিধামতো সময়ে কল দিন: {my_phone}\n— {my_name}, {institute}')
) as v(name, category, ord, body)
where not exists (select 1 from public.message_templates);

-- ---------------------------------------------------------------------
-- 3. SMS in the call log (a message sent from the app)
-- ---------------------------------------------------------------------
alter table public.call_logs
  add column if not exists template_id uuid references public.message_templates(id) on delete set null;

alter table public.call_logs drop constraint if exists call_logs_channel_check;
alter table public.call_logs add constraint call_logs_channel_check
  check (channel in ('phone', 'whatsapp', 'sms'));

alter table public.call_logs drop constraint if exists call_logs_media_check;
alter table public.call_logs add constraint call_logs_media_check
  check (
    (channel = 'phone' and media is null)
    or (channel = 'whatsapp' and media is not null and media in ('voice', 'video', 'message'))
    or (channel = 'sms' and media is not distinct from 'message')
  );

-- ---------------------------------------------------------------------
-- 4. A template was sent
--    p_channel: 'whatsapp' | 'sms'; p_edited: the text was changed before sending
-- ---------------------------------------------------------------------
create or replace function public.log_template_sent(
  p_lead_id     uuid,
  p_template_id uuid,
  p_channel     text,
  p_edited      boolean default false
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  t    public.message_templates;
  v_id uuid;
begin
  if not public.is_active_user() then raise exception 'Your account is not active.'; end if;
  if p_channel not in ('whatsapp', 'sms') then raise exception 'Unknown channel.'; end if;
  if not exists (select 1 from public.leads l where l.id = p_lead_id and l.deleted_at is null
                 and public.can_view_lead(l.assigned_to)) then
    raise exception 'Lead not found.';
  end if;
  select * into t from public.message_templates
   where id = p_template_id and (is_shared or owner_id = auth.uid());
  if not found then raise exception 'Template not found.'; end if;

  insert into public.call_logs (lead_id, user_id, outcome, direction, channel, media, notes, template_id)
  values (p_lead_id, auth.uid(), 'message', 'outgoing', p_channel, 'message',
          'Template: ' || t.name || case when p_edited then ' (edited)' else '' end, t.id)
  returning id into v_id;

  update public.message_templates
     set use_count = use_count + 1, last_used_at = now()
   where id = t.id;

  return v_id;
end;
$$;

grant execute on function public.log_template_sent(uuid, uuid, text, boolean) to authenticated;

notify pgrst, 'reload schema';
