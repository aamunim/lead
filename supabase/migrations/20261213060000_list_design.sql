-- =====================================================================
-- 🎨 Leads / Students list design: each person's own choice
--   null = the new design (the default), 'classic' = the old one.
--   A person changes their own (profiles_update lets them), a user
--   manager can change anyone's, and an admin can set everyone at once.
-- =====================================================================

alter table public.profiles
  add column if not exists list_design text
  check (list_design in ('new', 'classic'));

comment on column public.profiles.list_design is
  'Leads / Students list design on the phone: new (default when null) or classic';

-- Everyone at once (Settings → Lead cards)
create or replace function public.set_list_design_all(p_design text)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  n integer;
begin
  if not public.has_permission('settings.manage') then
    raise exception 'Only an admin can change everyone''s list design.';
  end if;
  if p_design not in ('new', 'classic') then
    raise exception 'Unknown design: %', p_design;
  end if;
  update public.profiles set list_design = p_design where list_design is distinct from p_design;
  get diagnostics n = row_count;
  return n;
end;
$$;

revoke all on function public.set_list_design_all(text) from public, anon;
grant execute on function public.set_list_design_all(text) to authenticated;
