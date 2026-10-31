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
npx supabase functions deploy drive-delete
npx supabase functions deploy drive-zip
```

## 3. In the app (admin)
**Settings → Google Drive** → paste the **Web app URL** and the **same secret** → **Connect Google Drive**.
A **Lead Management** folder is made in that Drive: `Lead Management / <Student ID Name, or Name – phone> / Papers`.

## Who sees files
- Everyone sees the files **they** added (on leads they can see).
- **Admins** see all. **Settings → Google Drive → Who sees everyone's files** can add roles or people.
- Removing a file in the app moves it to Google Drive's **Trash** (Google empties it after 30 days; until then it can be restored from drive.google.com → Trash). Files removed before this change are still in Drive: delete them there by hand if you want.
- **⬇ All** on a lead's Files card downloads every file you may see as one ZIP (Papers / Voice notes / Others); save it to a folder or share it.

## 🎙 Voice notes and 📷 camera (app 2.6.0 and later)
- Every text note (call popup, quick note, next-call hand over, fee, discount, payment, refund, papers, campus visit, stage, admission, lost, reopen, cancel, lead edit) has a **🎙 Voice note** button. The recording (≈ 0.5 MB a minute, stops by itself after an hour) is saved straight to `<Lead> / Voice notes` and shows on the lead's timeline (tap to play, 1x / 1.5x / 2x).
- **＋ Upload** on the Files card asks **📷 Take a photo** or **📁 Choose a file**; one photo per page ("Another page?"). Audio files (e.g. call recordings) can be chosen too.
- These need the 2.6.0 build (microphone + camera). Older builds keep working; the 🎙 and 📷 buttons just don't show there.

## Updating the script
When `docs/drive-script.gs` changes (e.g. the Trash step), paste the new code over the old one in script.google.com but **keep your own `SECRET` line**, then **Deploy → Manage deployments → ✏️ → Version: New version → Deploy**. The URL stays the same, nothing changes in the app. Until then, removing a file leaves it in Drive.

## Limits
- One file up to ~35 MB (Apps Script's request size). Photos, PDFs and voice notes are far below.
- **⬇ All**: up to 60 files and 60 MB together in one ZIP; above that, open files one by one.
- A free Gmail has 15 GB (shared with Gmail and Photos).
