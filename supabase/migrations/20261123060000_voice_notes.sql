-- =====================================================================
-- 🎙 Voice notes next to every text note
--   lead_files.context: where it was recorded (call, note, fee, payment,
--   visit, admission, …), shown on the lead's timeline
-- =====================================================================
alter table public.lead_files add column if not exists context text;

notify pgrst, 'reload schema';
