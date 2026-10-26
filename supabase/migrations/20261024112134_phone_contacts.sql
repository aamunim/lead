-- =====================================================================
-- Phone contacts → leads
-- =====================================================================

-- 1. Who may use it (Settings → Phone contacts access)
--    mode: 'all'   → every active user
--          'roles' → only the roles in "roles"
--          'users' → only the users in "user_ids"
--    Admins (settings.manage) can always use it.
insert into public.app_settings (key, value)
values (
  'contacts_import',
  '{"mode": "all", "roles": ["admin", "team_lead"], "user_ids": []}'::jsonb
)
on conflict (key) do nothing;

create or replace function public.can_import_contacts()
returns boolean
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_uid  uuid := auth.uid();
  v_cfg  jsonb;
  v_role text;
begin
  if v_uid is null or not public.is_active_user() then
    return false;
  end if;
  if public.has_permission('settings.manage') then
    return true;
  end if;

  v_cfg := coalesce(
    (select value from public.app_settings where key = 'contacts_import'),
    '{"mode": "all"}'::jsonb
  );

  case coalesce(v_cfg->>'mode', 'all')
    when 'all' then
      return true;
    when 'roles' then
      select role_key into v_role from public.profiles where id = v_uid;
      return coalesce(v_cfg->'roles', '[]'::jsonb) ? v_role;
    when 'users' then
      return coalesce(v_cfg->'user_ids', '[]'::jsonb) ? v_uid::text;
    else
      return false;
  end case;
end;
$$;

grant execute on function public.can_import_contacts() to authenticated;

-- 2. Which of these phone numbers are already leads?
--    Checks ALL leads (even ones this user can't see), so nobody adds a
--    duplicate, but returns only the numbers — never any lead details.
create or replace function public.existing_lead_phones(p_phones text[])
returns setof text
language sql
stable
security definer
set search_path = public
as $$
  select distinct p.phone
  from unnest(p_phones) as p(phone)
  where public.is_active_user()
    and exists (
      select 1
      from public.leads l
      where l.deleted_at is null
        and (l.phone = public.normalize_bd_phone(p.phone)
             or l.alt_phone = public.normalize_bd_phone(p.phone))
    );
$$;

grant execute on function public.existing_lead_phones(text[]) to authenticated;

-- 3. A "Phone contact" lead source, if there isn't one yet
insert into public.lead_sources (name, sort_order)
select 'Phone contact', coalesce(max(sort_order), 0) + 1
from public.lead_sources
where not exists (
  select 1 from public.lead_sources where lower(name) = 'phone contact'
);

notify pgrst, 'reload schema';