# 🌐 Website: lead.ittc.edu.bd

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

### 1. The address
The website lives on the Namecheap hosting (the same cPanel as sparc.college),
but the address is under **ittc.edu.bd**, whose DNS is managed elsewhere (where
ittc.edu.bd was registered / its DNS panel).

a) **DNS of ittc.edu.bd** (its own DNS panel): add an **A record**
   - Name / Host: `lead`
   - Value / Points to: the Namecheap server IP (cPanel, right side,
     "Shared IP Address")
   - TTL: default. It can take from minutes up to a few hours to work.

b) **Namecheap cPanel** → **Domains** → **Create A New Domain** →
   - Domain: `lead.ittc.edu.bd`
   - Uncheck "Share document root", document root: `lead.ittc.edu.bd`
     (i.e. `/home/<cpanel-user>/lead.ittc.edu.bd`)

### 2. HTTPS
cPanel → **SSL/TLS Status** → tick `lead.ittc.edu.bd` → **Run AutoSSL**
(takes a few minutes; works only after the DNS record in 1a is live).

### 3. An FTP account only for this folder
cPanel → **FTP Accounts** → Add FTP Account:
- Log in: `deploy` (becomes `deploy@sparc.college`: FTP accounts carry the
  hosting's main domain)
- Password: a long new password (use the generator)
- Directory: `lead.ittc.edu.bd` (**only** this folder)

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
**https://lead.ittc.edu.bd** and sign in.

### 6. (Optional) Supabase
Supabase → **Authentication → URL Configuration** → add
`https://lead.ittc.edu.bd` to **Redirect URLs** (used by "forgot password"
links).

## How it is built
- `npx expo export --platform web` → `dist/` (one page; `public/.htaccess`
  sends every address to it and forces HTTPS).
- `src/features/web/`: who may use it, and the frame (menu on the left).
- `src/shared/web/WebAlert.tsx`: pop-up questions ("Delete?"); a browser
  doesn't show React Native's own.
- `isWeb` hides phone-only buttons (Call, SMS).

## Students on a computer screen

- **Table**: click a column name to sort (College ID, Name, Fee, Next installment,
  Papers, Admitted). **▦ Columns** picks the columns (remembered in this browser).
  Tick rows → **⬇ Export** (Excel of the ticked ones; nothing ticked = everyone matching).
- **Panel**: a click on a row opens the student on the right; the table keeps
  the main columns. **↗ Full page** opens the whole page. Smaller screens: the
  panel slides over the table.
- **Search** (top bar): name, phone, College ID, NU Admission ID.
- **Reload / links**: the address keeps the open page and student
  (`/students?open=<id>`), so a reload or a shared link opens the same thing.
- **Keyboard**: `Ctrl+K` or `/` search · `J`/`K` or `↓`/`↑` next/previous ·
  `Enter` full page · `X` tick · `Esc` close · `?` all shortcuts.
- Sheets from the phone open as a dialog in the middle of the screen.
- **From the row** (no need to open the student):
  - **Papers**: click → which papers are in / missing, originals, where kept.
  - **✅ Approve / ↩** (Admission Officer, waiting students): the approve dialog
    with the check list, NU Admission ID and note.
  - **Last call / note**: click → every call and note of the student.
  - **Fee ✏️** (Admission Officer): change the total discount / final fee
    (reason needed; not below what is paid). Also on the Fee card in the app.

## ITTC look (website only)

- Name: **ITTC Admission Management System** (Ideal Teachers' Training College);
  the logo is in `assets/web/` (also the browser tab icon). The phone app keeps its name.
- **Sign-in page**: the college on the left, the sign-in card on the right
  (show / hide password, Caps Lock warning, remember my email — never the password).
- **🖥 / ☀️ / 🌙** in the top bar: System (like the computer), Light or Dark.
  The page reloads once with the new colours.
- **☰ Comfortable / Compact** rows; **📋** next to College ID, NU ID and phone on a hovered row.
- Admission Officer: the Students menu shows how many wait for approval; a note
  pops up when new ones come (checked every minute) → **Show** opens them.
