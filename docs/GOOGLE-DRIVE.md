# 📎 Google Drive for lead files: one-time setup (no Google Cloud, no card)

Files (papers now, voice notes later) are saved in **one Google account's Drive** (a personal Gmail is fine),
through a small **Google Apps Script** the admin deploys in that account.
The app never shows Drive links: files open through the server, so the app's rules decide who sees them.

## 1. The script (in the Gmail whose Drive will hold the files)
1. Open https://script.google.com → **New project**. Name it `Lead Management Drive`.
2. Delete what is in `Code.gs` and paste the whole of **`docs/drive-script.gs`**.
3. Change the line `const SECRET = 'PUT-A-LONG-RANDOM-TEXT-HERE';` to your own long random text
   (30+ letters and numbers). Keep it private. **Save** (💾).
4. At the top choose the function **`allowDrive`** → **▶ Run** → **Review permissions** → your Gmail →
   "Google hasn't verified this app" → **Advanced → Go to Lead Management Drive (unsafe)** → **Allow**.
   (It is your own script; this lets it use your Drive.)
5. **Deploy → New deployment** → ⚙ **Select type: Web app**
   - Description: `v1`
   - **Execute as: Me**
   - **Who has access: Anyone**
   - **Deploy** → copy the **Web app URL** (`https://script.google.com/macros/s/…/exec`).

If you change the script later: **Deploy → Manage deployments → ✏ → Version: New version → Deploy** (the URL stays the same).

## 2. Supabase (from the PC, in the project folder)
```
npx supabase db push
npx supabase functions deploy drive-connect
npx supabase functions deploy drive-upload
npx supabase functions deploy drive-file
```

## 3. In the app (admin)
**Settings → Google Drive** → paste the **Web app URL** and the **same secret** → **Connect Google Drive**.
A **Lead Management** folder is made in that Drive: `Lead Management / <Lead – phone> / Papers`.

## Who sees files
- Everyone sees the files **they** added (on leads they can see).
- **Admins** see all. **Settings → Google Drive → Who sees everyone's files** can add roles or people.
- Removing a file in the app hides it; it stays in Google Drive.

## Limits
- One file up to ~35 MB (Apps Script's request size). Photos, PDFs and voice notes are far below.
- A free Gmail has 15 GB (shared with Gmail and Photos).
