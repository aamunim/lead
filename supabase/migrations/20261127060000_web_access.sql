-- =====================================================================
-- 🌐 Website (app.sparc.college): who may use it
--   Settings → Website. Admins always; by default Team Leads too.
--   The website uses the same accounts and the same rules for what
--   everyone may see and change.
-- =====================================================================
insert into public.app_settings (key, value)
values ('web', jsonb_build_object(
  'enabled', true,
  'who', jsonb_build_object('mode', 'roles', 'roles', jsonb_build_array('team_lead'), 'user_ids', '[]'::jsonb)
))
on conflict (key) do nothing;

notify pgrst, 'reload schema';
