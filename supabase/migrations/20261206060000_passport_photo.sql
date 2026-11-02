-- =====================================================================
-- 🪪 Passport photo (website): the person cut out with remove.bg, the head
--   placed by the passport rule, a light-blue background, the paper's
--   exact size. The person checks it in a small editor before upload.
--   1. Each paper: passport on/off, background colour, face size (%)
--   2. remove.bg accounts (keys stay on the server; the next one is used
--      when one runs out of credits or fails)
--   Who changes them: admins and the Admission Officer (like the upload rules).
-- =====================================================================

alter table public.admission_papers
  add column if not exists passport boolean not null default false,
  add column if not exists bg_color text not null default '#CFE6FA' check (bg_color ~ '^#[0-9A-Fa-f]{6}$'),
  add column if not exists face_pct integer not null default 55 check (face_pct between 30 and 85);

-- "Photo" only, to start with
update public.admission_papers set passport = true where lower(trim(name)) = 'photo';

create or replace function public.set_paper_passport(p_paper uuid, p_passport boolean, p_bg_color text, p_face_pct int)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if not public.can_edit_upload_rules() then raise exception 'Only admins and the Admission Officer can change this.'; end if;
  update public.admission_papers
     set passport = coalesce(p_passport, passport),
         bg_color = coalesce(nullif(trim(p_bg_color), ''), bg_color),
         face_pct = coalesce(p_face_pct, face_pct),
         updated_at = now()
   where id = p_paper;
  if not found then raise exception 'Paper not found.'; end if;
end;
$$;

grant execute on function public.set_paper_passport(uuid, boolean, text, int) to authenticated;

-- ---------------------------------------------------------------------
-- remove.bg accounts
-- ---------------------------------------------------------------------
create table if not exists public.removebg_accounts (
  id            uuid primary key default gen_random_uuid(),
  label         text not null default '',
  api_key       text not null,
  is_active     boolean not null default true,
  sort_order    integer not null default 0,
  month         text,
  files_month   integer not null default 0,
  last_used_at  timestamptz,
  last_error    text,
  last_error_at timestamptz,
  created_at    timestamptz not null default now()
);

alter table public.removebg_accounts enable row level security;   -- no policies: only the functions and the server
revoke all on public.removebg_accounts from anon, authenticated;

create or replace function public.list_removebg_accounts()
returns table (id uuid, label text, key_hint text, is_active boolean, sort_order int, files_month int,
               last_used_at timestamptz, last_error text, last_error_at timestamptz)
language plpgsql
stable
security definer
set search_path = public
as $$
begin
  if not public.can_edit_upload_rules() then raise exception 'Only admins and the Admission Officer can see this.'; end if;
  return query
  select a.id, a.label, left(a.api_key, 4) || '…' || right(a.api_key, 4), a.is_active, a.sort_order,
         case when a.month = to_char(now(), 'YYYY-MM') then a.files_month else 0 end,
         a.last_used_at, a.last_error, a.last_error_at
  from public.removebg_accounts a
  order by a.sort_order, a.created_at;
end;
$$;

create or replace function public.add_removebg_account(p_label text, p_api_key text)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_key text := trim(coalesce(p_api_key, ''));
  v_id  uuid;
begin
  if not public.can_edit_upload_rules() then raise exception 'Only admins and the Admission Officer can change this.'; end if;
  if length(v_key) < 16 then raise exception 'Please paste the remove.bg API key.'; end if;
  if exists (select 1 from public.removebg_accounts where api_key = v_key) then raise exception 'This key is already added.'; end if;
  insert into public.removebg_accounts (label, api_key, sort_order)
  values (coalesce(nullif(trim(p_label), ''), 'Account'), v_key,
          coalesce((select max(sort_order) + 1 from public.removebg_accounts), 1))
  returning id into v_id;
  return v_id;
end;
$$;

create or replace function public.update_removebg_account(p_id uuid, p_label text, p_is_active boolean, p_sort_order int)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if not public.can_edit_upload_rules() then raise exception 'Only admins and the Admission Officer can change this.'; end if;
  update public.removebg_accounts
     set label = coalesce(nullif(trim(p_label), ''), label),
         is_active = coalesce(p_is_active, is_active),
         sort_order = coalesce(p_sort_order, sort_order),
         last_error = case when p_is_active then null else last_error end
   where id = p_id;
end;
$$;

create or replace function public.delete_removebg_account(p_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if not public.can_edit_upload_rules() then raise exception 'Only admins and the Admission Officer can change this.'; end if;
  delete from public.removebg_accounts where id = p_id;
end;
$$;

grant execute on function public.list_removebg_accounts() to authenticated;
grant execute on function public.add_removebg_account(text, text) to authenticated;
grant execute on function public.update_removebg_account(uuid, text, boolean, int) to authenticated;
grant execute on function public.delete_removebg_account(uuid) to authenticated;

notify pgrst, 'reload schema';
