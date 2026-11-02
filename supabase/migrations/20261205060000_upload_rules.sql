-- =====================================================================
-- 📎 Upload rules: picture size and weight, PDF weight (website)
--   1. Each paper: picture width × height (exact: the picture is made
--      exactly that size, nothing cut off), picture KB, PDF KB, what may
--      be uploaded (any / picture / PDF)
--   2. Defaults for papers without their own rule and for other files
--   3. iLovePDF accounts: a PDF over its limit is compressed on the server
--      with them (one after another when an account runs out); if it is
--      still too big the person is asked to make it smaller by hand
--   Who changes them: admins and the Admission Officer.
-- =====================================================================

-- ---------------------------------------------------------------------
-- 1. Per paper
-- ---------------------------------------------------------------------
alter table public.admission_papers
  add column if not exists img_width  integer check (img_width  is null or img_width  between 50 and 6000),
  add column if not exists img_height integer check (img_height is null or img_height between 50 and 6000),
  add column if not exists img_max_kb integer check (img_max_kb is null or img_max_kb between 10 and 20000),
  add column if not exists pdf_max_kb integer check (pdf_max_kb is null or pdf_max_kb between 20 and 30000),
  add column if not exists accept     text not null default 'any' check (accept in ('any', 'image', 'pdf'));

-- ---------------------------------------------------------------------
-- 2. Defaults
-- ---------------------------------------------------------------------
insert into public.app_settings (key, value)
values ('upload_rules', jsonb_build_object('img_max_side', 1600, 'img_max_kb', 500, 'pdf_max_kb', 2048))
on conflict (key) do nothing;

create or replace function public.upload_rules_setting()
returns jsonb
language sql
stable
security definer
set search_path = public
as $$
  select jsonb_build_object('img_max_side', 1600, 'img_max_kb', 500, 'pdf_max_kb', 2048)
         || coalesce((select value from public.app_settings where key = 'upload_rules'), '{}'::jsonb);
$$;

grant execute on function public.upload_rules_setting() to authenticated;

create or replace function public.can_edit_upload_rules()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select public.has_permission('settings.manage') or public.can_approve_admission();
$$;

grant execute on function public.can_edit_upload_rules() to authenticated;

create or replace function public.set_upload_defaults(p_img_max_side int, p_img_max_kb int, p_pdf_max_kb int)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if not public.can_edit_upload_rules() then raise exception 'Only admins and the Admission Officer can change this.'; end if;
  if coalesce(p_img_max_side, 0) not between 200 and 6000 then raise exception 'Picture size: 200 to 6000 px.'; end if;
  if coalesce(p_img_max_kb, 0) not between 10 and 20000 then raise exception 'Picture weight: 10 to 20000 KB.'; end if;
  if coalesce(p_pdf_max_kb, 0) not between 20 and 30000 then raise exception 'PDF weight: 20 to 30000 KB.'; end if;
  insert into public.app_settings (key, value)
  values ('upload_rules', jsonb_build_object('img_max_side', p_img_max_side, 'img_max_kb', p_img_max_kb, 'pdf_max_kb', p_pdf_max_kb))
  on conflict (key) do update set value = excluded.value;
end;
$$;

grant execute on function public.set_upload_defaults(int, int, int) to authenticated;

create or replace function public.set_paper_upload_rule(
  p_paper uuid, p_accept text, p_img_width int, p_img_height int, p_img_max_kb int, p_pdf_max_kb int
)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if not public.can_edit_upload_rules() then raise exception 'Only admins and the Admission Officer can change this.'; end if;
  if (p_img_width is null) <> (p_img_height is null) then
    raise exception 'Give both the width and the height (or neither).';
  end if;
  update public.admission_papers
     set accept = coalesce(p_accept, 'any'), img_width = p_img_width, img_height = p_img_height,
         img_max_kb = p_img_max_kb, pdf_max_kb = p_pdf_max_kb, updated_at = now()
   where id = p_paper;
  if not found then raise exception 'Paper not found.'; end if;
end;
$$;

grant execute on function public.set_paper_upload_rule(uuid, text, int, int, int, int) to authenticated;

-- ---------------------------------------------------------------------
-- 3. iLovePDF accounts (the keys never leave the server)
-- ---------------------------------------------------------------------
create table if not exists public.ilovepdf_accounts (
  id            uuid primary key default gen_random_uuid(),
  label         text not null default '',
  public_key    text not null,
  is_active     boolean not null default true,
  sort_order    integer not null default 0,
  month         text,                -- 'YYYY-MM' of the count below
  files_month   integer not null default 0,
  last_used_at  timestamptz,
  last_error    text,
  last_error_at timestamptz,
  created_at    timestamptz not null default now()
);

alter table public.ilovepdf_accounts enable row level security;   -- no policies: only the functions and the server
revoke all on public.ilovepdf_accounts from anon, authenticated;

-- The list for Settings (keys shown as "project_public_9c…a1f2")
create or replace function public.list_ilovepdf_accounts()
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
  select a.id, a.label,
         left(a.public_key, 16) || '…' || right(a.public_key, 4),
         a.is_active, a.sort_order,
         case when a.month = to_char(now(), 'YYYY-MM') then a.files_month else 0 end,
         a.last_used_at, a.last_error, a.last_error_at
  from public.ilovepdf_accounts a
  order by a.sort_order, a.created_at;
end;
$$;

create or replace function public.add_ilovepdf_account(p_label text, p_public_key text)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_key text := trim(coalesce(p_public_key, ''));
  v_id  uuid;
begin
  if not public.can_edit_upload_rules() then raise exception 'Only admins and the Admission Officer can change this.'; end if;
  if length(v_key) < 20 then raise exception 'Please paste the project''s public key.'; end if;
  if exists (select 1 from public.ilovepdf_accounts where public_key = v_key) then raise exception 'This key is already added.'; end if;
  insert into public.ilovepdf_accounts (label, public_key, sort_order)
  values (coalesce(nullif(trim(p_label), ''), 'Account'), v_key,
          coalesce((select max(sort_order) + 1 from public.ilovepdf_accounts), 1))
  returning id into v_id;
  return v_id;
end;
$$;

create or replace function public.update_ilovepdf_account(p_id uuid, p_label text, p_is_active boolean, p_sort_order int)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if not public.can_edit_upload_rules() then raise exception 'Only admins and the Admission Officer can change this.'; end if;
  update public.ilovepdf_accounts
     set label = coalesce(nullif(trim(p_label), ''), label),
         is_active = coalesce(p_is_active, is_active),
         sort_order = coalesce(p_sort_order, sort_order),
         last_error = case when p_is_active then null else last_error end
   where id = p_id;
end;
$$;

create or replace function public.delete_ilovepdf_account(p_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if not public.can_edit_upload_rules() then raise exception 'Only admins and the Admission Officer can change this.'; end if;
  delete from public.ilovepdf_accounts where id = p_id;
end;
$$;

grant execute on function public.list_ilovepdf_accounts() to authenticated;
grant execute on function public.add_ilovepdf_account(text, text) to authenticated;
grant execute on function public.update_ilovepdf_account(uuid, text, boolean, int) to authenticated;
grant execute on function public.delete_ilovepdf_account(uuid) to authenticated;

notify pgrst, 'reload schema';
