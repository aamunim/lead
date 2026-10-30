-- =====================================================================
-- 📎 Google Drive through Google Apps Script (no Google Cloud project)
--   A personal Gmail could not publish a Google Cloud OAuth app, so files
--   now go through a small Apps Script web app the admin deploys in their
--   own Google account (docs/drive-script.gs). The server keeps its
--   address and secret key here (server only, as before).
-- =====================================================================
alter table public.google_drive_connection
  add column if not exists script_url    text,
  add column if not exists script_secret text;

alter table public.google_drive_connection alter column refresh_token drop not null;

-- No more Google sign-in round trips
drop table if exists public.drive_oauth_states;

notify pgrst, 'reload schema';
