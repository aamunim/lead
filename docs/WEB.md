# 🌐 Website: app.sparc.college

The same app in a browser, for a computer. Same accounts, same data, same rules
for who sees and changes what. Only some modules are on the website (now:
**Students**; next: Reports, Team activity, Import / Export, Discounts,
Templates, Notifications). Phone-only parts (call log, WhatsApp sync, camera,
voice recording, push) are not there.

Who may sign in: **Settings → Website** in the app (admins always; Team Leads by
default).

Every merge to `main` builds the website and uploads it to Namecheap by FTP
(GitHub Actions → **Deploy website**). Only changed files are sent.

## One-time setup (Namecheap shared hosting, cPanel)

### 1. The subdomain
cPanel → **Domains** → **Create A New Domain** →
- Domain: `app.sparc.college`
- Uncheck "Share document root", document root: `app.sparc.college`
  (i.e. `/home/<cpanel-user>/app.sparc.college`)

If sparc.college uses Namecheap's hosting nameservers, the DNS record is made by
itself. If the DNS is elsewhere, add an **A record** `app` → the server IP shown
in cPanel (right side, "Shared IP Address").

### 2. HTTPS
cPanel → **SSL/TLS Status** → tick `app.sparc.college` → **Run AutoSSL**
(takes a few minutes).

### 3. An FTP account only for this folder
cPanel → **FTP Accounts** → Add FTP Account:
- Log in: `deploy` (becomes `deploy@sparc.college`)
- Password: a long new password (use the generator)
- Directory: `app.sparc.college` (**only** this folder)

"Configure FTP Client" next to it shows the **FTP server** (e.g. `ftp.sparc.college`).

### 4. GitHub secrets
GitHub → the repository → **Settings → Secrets and variables → Actions → New repository secret**:

| Name | Value |
|---|---|
| `WEB_SUPABASE_URL` | the same as `EXPO_PUBLIC_SUPABASE_URL` in the app's `.env.local` |
| `WEB_SUPABASE_ANON_KEY` | the same as `EXPO_PUBLIC_SUPABASE_ANON_KEY` |
| `FTP_SERVER` | e.g. `ftp.sparc.college` |
| `FTP_USERNAME` | e.g. `deploy@sparc.college` |
| `FTP_PASSWORD` | the FTP password |

Never paste these in a chat or a screenshot.

### 5. First upload
GitHub → **Actions → Deploy website → Run workflow**. When it is green, open
**https://app.sparc.college** and sign in.

### 6. (Optional) Supabase
Supabase → **Authentication → URL Configuration** → add
`https://app.sparc.college` to **Redirect URLs** (used by "forgot password"
links).

## How it is built
- `npx expo export --platform web` → `dist/` (one page; `public/.htaccess`
  sends every address to it and forces HTTPS).
- `src/features/web/`: who may use it, and the frame (menu on the left).
- `src/shared/web/WebAlert.tsx`: pop-up questions ("Delete?"); a browser
  doesn't show React Native's own.
- `isWeb` hides phone-only buttons (Call, SMS).
