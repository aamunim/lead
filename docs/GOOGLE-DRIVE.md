# 📎 Google Drive for lead files: one-time setup

Files (papers now, voice notes later) are saved in **one Google account** of the institute.
The app never shows Drive links: files open through the server, so the app's rules decide who sees them.

## 1. Google Cloud (once, ~10 minutes)
Sign in at https://console.cloud.google.com with the institute's Gmail.

1. **Create a project**, e.g. `Lead Management`.
2. **APIs & Services → Library → "Google Drive API" → Enable.**
3. **Google Auth Platform → Branding / OAuth consent screen**
   - User type: **External**
   - App name: `Lead Management`, support email and developer email: the institute's Gmail
   - **Data access / Scopes → Add:** `.../auth/drive.file` and `email`
   - **Audience → Publish app → In production.**
     (In "Testing" Google stops the connection after 7 days.)
     If Google says the app is not verified: when connecting, tap **Advanced → Go to Lead Management**. Only the admin does this, once.
4. **Clients (Credentials) → Create OAuth client**
   - Type: **Web application**
   - **Authorized redirect URI:**
     `https://<your-project-ref>.supabase.co/functions/v1/drive-callback`
     (the same address as `EXPO_PUBLIC_SUPABASE_URL`, plus `/functions/v1/drive-callback`)
   - Copy the **Client ID** and **Client secret**. Never commit them, never share them in chat.

## 2. Supabase (from the PC, in the project folder)
```
npx supabase secrets set GOOGLE_CLIENT_ID=xxxxxxxx.apps.googleusercontent.com GOOGLE_CLIENT_SECRET=xxxxxxxx
npx supabase db push
npx supabase functions deploy drive-connect
npx supabase functions deploy drive-upload
npx supabase functions deploy drive-file
npx supabase functions deploy drive-callback --no-verify-jwt
```

## 3. In the app (admin)
**Settings → Google Drive → Connect Google Drive** → choose the institute's Gmail → **Allow**.
A **Lead Management** folder is made in that Drive: `Lead Management / <Lead – phone> / Papers`.

## Who sees files
- Everyone sees the files **they** added (on leads they can see).
- **Admins** see all. **Settings → Google Drive → Who sees everyone's files** can add roles or people.
- Removing a file in the app hides it; it stays in Google Drive.

## Storage
A free Gmail has 15 GB (shared with Gmail and Photos). Compressed photos (~300 KB) and PDFs fit for years.
