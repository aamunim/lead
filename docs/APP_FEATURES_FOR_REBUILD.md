# Admission Management App: full feature brief for a new multi-institution app

> **What this is.** A brief for an AI agent or developer who will build a **new, multi-institution
> (multi-tenant)** admission management app **from scratch**. No existing data is moved into it.
>
> It lists **every feature the app must have**, how each works, the business rules that matter, what
> must be configurable per institution, and lessons learned from an earlier single-institution version.
> Read it fully before planning.
>
> **বাংলা সারাংশ:** এই ফাইলে অ্যাপের সব ফিচার, নিয়ম, সেটিং, পারমিশন আর আগের অভিজ্ঞতা লেখা আছে।
> নতুন অ্যাপটা শূন্য থেকে বানানো হবে, কোনো পুরোনো ডাটা থাকবে না।
> এতে একাধিক কলেজ/স্কুল/ইনস্টিটিউট থাকবে। প্রতিটি প্রতিষ্ঠান সেটআপ স্ক্রিন থেকে খোলা হবে, লগইনের সময় প্রতিষ্ঠান বাছাই করতে হবে, আর সব প্রতিষ্ঠান দেখাশোনা করবেন "Master Admin"।

## Contents
1. [Product in one page](#1-product-in-one-page)
2. [Goals of the new app (multi-institution)](#2-goals-of-the-new-app-multi-institution)
3. [Current tech stack and architecture](#3-current-tech-stack-and-architecture)
4. [Users, roles, permissions, "who" rules](#4-users-roles-permissions-who-rules)
5. [Auth and account lifecycle](#5-auth-and-account-lifecycle)
6. [Leads](#6-leads)
7. [Leads list, board, search, filters](#7-leads-list-board-search-filters)
8. [Lead page and peek sheet](#8-lead-page-and-peek-sheet)
9. [Pipeline stages, admit, lost, reopen](#9-pipeline-stages-admit-lost-reopen)
10. [Follow-ups (next call) and reminders](#10-follow-ups-next-call-and-reminders)
11. [Calls, call-log sync, caller card, call lock](#11-calls-call-log-sync-caller-card-call-lock)
12. [WhatsApp](#12-whatsapp)
13. [Notes, voice notes, delete and restore](#13-notes-voice-notes-delete-and-restore)
14. [Campus visits, lead score, recent/starred](#14-campus-visits-lead-score-recentstarred)
15. [Phone contacts, import/export, message templates](#15-phone-contacts-importexport-message-templates)
16. [Courses, batches, sections, fees master data](#16-courses-batches-sections-fees-master-data)
17. [Admission papers, uploads, passport photo, Photo Studio](#17-admission-papers-uploads-passport-photo-photo-studio)
18. [Google Drive files](#18-google-drive-files)
19. [Student IDs](#19-student-ids)
20. [Fee negotiation, discounts, final fee](#20-fee-negotiation-discounts-final-fee)
21. [Payments, installments, receipts, refunds, reminders](#21-payments-installments-receipts-refunds-reminders)
22. [Students tab, placement, external board flow](#22-students-tab-placement-external-board-flow)
23. [AI features (Claude / Gemini)](#23-ai-features-claude--gemini)
24. [Admission Contribution](#24-admission-contribution)
25. [Notifications and push](#25-notifications-and-push)
26. [Team activity, change log, reports](#26-team-activity-change-log-reports)
27. [Credits, leaderboard, milestones, weekly scorecard](#27-credits-leaderboard-milestones-weekly-scorecard)
28. [Alumni, referrals, public forms](#28-alumni-referrals-public-forms)
29. [Feedback chat, crashes, speed check, app versions](#29-feedback-chat-crashes-speed-check-app-versions)
30. [Home, More, Settings hub](#30-home-more-settings-hub)
31. [Website (web version)](#31-website-web-version)
32. [Native Android module](#32-native-android-module)
33. [Background jobs (pg_cron)](#33-background-jobs-pg_cron)
34. [Theming, offline, caching, speed](#34-theming-offline-caching-speed)
35. [Build, release, deploy](#35-build-release-deploy)
36. [Everything that must be configurable per institution](#36-everything-that-must-be-configurable-per-institution)
37. [Lessons learned (do not repeat these mistakes)](#37-lessons-learned-do-not-repeat-these-mistakes)
38. [Open decisions for the owner](#38-open-decisions-for-the-owner)

---

## 1. Product in one page

The app is an **admission CRM for an education institution**. Callers and counsellors get leads (people
interested in a course), call them, log what happened, plan the next call, invite them to campus,
negotiate the fee and finally **admit** them. After admission the same app manages the **student**:
papers, fee payments, installments, receipts, student ID, section and the external-board (university)
submission steps. Managers watch team activity, reports and leaderboards. AI estimates each lead's
chance of admission, coaches the caller, and splits credit for each admission among staff.

- **Platforms:**
  - Android app: Expo / React Native, with a native module for call-log and WhatsApp sync.
  - Website: the same codebase exported for the web.
  - iOS is not targeted.
- **Language of the UI:** English labels. Bangla is used in AI output, message templates and public forms. Users are Bangladeshi.
- **Expected scale:** many institutions, each with tens of staff and thousands of leads.
- **Tabs (phone):** Home · Leads · Students · More.

## 2. Goals of the new app (multi-institution)

The owner's requirements:

1. **First screen: "Set up your institution".**
   - Institution name, address, **College Code** and **EIIN** (both optional, "if exist").
   - Then create the institution's **Super Admin** (name, email, phone, password).
2. **Login: pick the institution first** (college / institute / school), then email + password.
3. **New top role: "Master Admin".** Above every institution's Super Admin. Manages all institutions: list, approve, suspend, view usage, enter one to help (audited).
4. **Every feature in this file is per institution.** Settings, roles, courses, pipeline stages, templates, AI keys, Drive, receipts, ID series, reports and leaderboards.

### Must-haves for tenancy
- Put `institution_id` on **every** tenant table from day one, with an index that starts with it.
- **Row Level Security** must use the institution taken from the **JWT custom claim**. Do not look it up per row; that is fast and avoids extra queries.
- **Every server function must filter by institution.** The single-institution version had about 418 `SECURITY DEFINER` functions, which bypass RLS. In a multi-tenant app each one is a potential data leak.
  - Prefer `SECURITY INVOKER` plus RLS where possible.
  - Where DEFINER is needed, check the institution explicitly.
- Build an **automatic cross-tenant leak test** early. Create two institutions, call every RPC and select every table as a user of B, and assert nothing of A is visible.
- **Per-tenant uniqueness and counters:**
  - stage keys, receipt numbers, refund numbers, alumni ref codes, alumni field keys
  - student ID series, phone-duplicate checks, tag names, course names
- Settings must be per tenant, e.g. `app_settings(institution_id, key)` or typed settings tables.
- **Per-tenant integrations:** Claude/Gemini keys, Google Drive Apps Script URL and secret, iLovePDF and remove.bg accounts, receipt prefix, logo, institute details used in receipts and templates.
- **Per-tenant locale:** time zone (default `Asia/Dhaka`), currency (default ৳), phone country rules (default Bangladesh), week start (default Saturday), working days and holidays.
- **Public pages need the institution in the URL:** `/apply/<slug>`, `/refer/<code>`. Referral codes can stay globally unique.
- Storage paths and policies are prefixed by institution. Drive folders are per institution.
- Background jobs (pg_cron) must loop per institution and respect each one's time zone and settings.
- **Branding per institution:** name and logo on login, web shell, receipts and the Home top bar. The product needs a neutral app name.

## 3. Recommended tech stack and architecture

| Layer | Current choice |
|---|---|
| App | Expo SDK **58**, React Native 0.88, **expo-router** (file routes in `src/app`), React Compiler, typed routes |
| Backend | **Supabase**: Postgres, RLS, RPC functions, pg_cron, pg_net, Storage, Realtime, Edge Functions (Deno) |
| Native | Kotlin Expo module `modules/call-log` (call log, WhatsApp notification listener, caller overlay, contact groups, native crash capture) |
| Push | expo-notifications + FCM (`google-services.json`), sent from Postgres via pg_net to Expo push API |
| Updates | EAS Update (OTA), channels `preview` / `production`; runtimeVersion pinned |
| Web | `expo export --platform web` (single page), FTP to cPanel hosting |
| Files | Google Drive via an Apps Script web app (no Google login for staff) |
| AI | Anthropic Claude API (Sonnet 5.5 / Haiku 5.5) and Google Gemini (Flash) from Edge Functions |
| Other libs | xlsx (Excel), expo-print (PDF/receipts), react-native-view-shot, MediaPipe face detection (web), expo-audio (voice notes) |

**Patterns used**
- **Database:**
  - Tables are read through RLS. Most writes go through **RPCs** (SECURITY DEFINER) that check permissions.
  - Guard triggers block direct edits of important columns. Pipeline, admission and fee fields change only via RPCs, which set session flags such as `app.pipeline_action`.
  - `lead_activity` is an **append-only timeline**. Every action writes a line, and it feeds the lead's Changes, the global Change log and restore.
  - Denormalised columns on `leads` are kept by triggers so lists stay fast: fee status, paid, due, papers counts, visit status, last contact, score, course_ids, AI chance.
- **App:**
  - Settings are loaded once and cached.
  - Lists use small RPCs plus caching ("stale-while-revalidate": show last data instantly, then refresh).
- **Ask before risky actions:** dialogs warn before re-running costly AI or before deleting.

## 4. Users, roles, permissions, "who" rules

- **Seed roles:**

  | Role | Permissions | Rank |
  |---|---|---|
  | `super_admin` | `*` | 100 |
  | `admin` | | 80 |
  | `team_lead` | | 50 |
  | `caller` | | 10 |

- **Custom roles:**
  - Created by the Super Admin (Settings → Roles).
  - Each has a name, permissions, `acts_as` (caller / team_lead / admin) and optional `course_ids` (course restriction).
  - System roles can't be deleted. A role with people can't be deleted.
- **Permission keys:**

  | Area | Keys |
  |---|---|
  | Leads | `leads.view_own`, `leads.edit_own`, `leads.view_team`, `leads.edit_team`, `leads.view_all`, `leads.edit_all`, `leads.assign`, `leads.delete`, `leads.export`, `import.run` |
  | Reports | `reports.view_team`, `reports.view_all` |
  | Fees | `payments.manage`, `discounts.approve_limited`, `discounts.approve` |
  | Admin | `settings.manage` (also means "sees all courses"), `users.manage` |
  | Wildcard | `*` |

- **Teams:** `profiles.team_lead_id` links a person to their Team Lead.
- **Course restriction:**
  - A person's own `course_ids` override the role's.
  - Leads and students of other courses are hidden everywhere through restrictive RLS policies.
  - A lead with no course is seen only by admins and by the person who added it.
- **The "who" rule** is reused by many settings: `{mode: 'all'|'roles'|'users', roles: [], user_ids: []}`.
  - Admins (`settings.manage` or `*`) always pass.
  - Role pickers list every role except Super Admin.
- **"Admission Officer"** is not a role. It means anyone allowed by the Admission-flow "who" rule.
- **Developer:** a special user (by email setting) who receives everyone's feedback chats and crash reports.
  - In the new app this belongs to the **Master Admin / product owner** level, not per institution.

## 5. Auth and account lifecycle

- **First-run setup:**
  - Runs when no Super Admin exists.
  - Asks for name, email, phone, password and institution name.
  - Creates the account and makes it an active Super Admin.
  - **In the new app this becomes the per-institution setup screen.**
- **Login:**
  - Email and password, with a "remember my email" option.
  - No self-service password reset: an admin resets it.
  - The web login is a split page with the logo, show/hide password and a Caps Lock warning.
- **Sign up:**
  - Creates an **inactive** profile with role caller.
  - Users with `users.manage` get a "signup" notification and approve the person in Users.
- **App states:** loading / error / needs_setup / signed_out / pending_approval / must_change_password / active.
- **Pending screen:** check again, sign out, or delete my account. Wording differs if the account was deactivated.
- **Admin reset password** (Edge Function):
  - Sets a password, ends all of the person's sessions and can force "change password on next login".
  - Only a Super Admin can reset a Super Admin. You can't reset yourself.
  - The UI generates a password and shares it on WhatsApp.
- **Users screen:**
  - Lists pending / active / deactivated users, with search.
  - Detail screen: edit name, phone, email (immediate), role, team lead, course limits, list design.
  - "Call log sync required" (Super Admin only).
  - Actions: approve, deactivate or reactivate, reset password, view activity.
- **Profile:** edit name and phone, change email (with a confirm link), change password, photo (public bucket `avatars`).
- **Account deletion** (Google Play requirement):
  - Signed in: re-enter the password and type DELETE.
  - Signed out: sign in on the page, or send a deletion request (rate limited) for admins to handle.
  - Deletion **anonymises** the person but keeps the institution's records:
    - leads become unassigned
    - tokens, devices and chats are deleted
    - the profile becomes "Deleted user"
    - the auth email is scrambled and the account banned
  - The last Super Admin can't be deleted.
- **Privacy page:** static, with contact and site details.
- **Sign out:** unregisters push, clears caches and forgets the device.

## 6. Leads

**Fields**

| Group | Fields |
|---|---|
| Contact | name (required), phone (normalised BD mobile), alt_phone, guardian name / phone / relation, email, area |
| WhatsApp | whatsapp_number (BD or `+intl`), whatsapp_username |
| Classification | lead_type, source, campaign, referred_by |
| Pipeline | stage, rating (hot / warm / cold), score, lost_reason |
| Ownership | assigned_to, assignment_method, created_by |
| Dates and counters | next_follow_up_at, last_contacted_at, admitted_at, lost_at, closed_at, call_attempts, unreachable_at |
| Visit | visit_status / visit_at |
| Text and extra | notes, custom_fields (jsonb), import_batch_id, deleted_at (soft delete) |
| Courses and tags | interested **courses** (many), **tags** (many) |

**Rules**
- **Contact:** name is required. At least one of phone, WhatsApp number or WhatsApp username is required.
- **WhatsApp number:** if it equals phone it is cleared. Usernames are lower-cased, 3–35 characters.
- **Course:**
  - A new lead must have at least one interested course, if any course exists.
  - A lead's last course can't be removed.
  - `create_lead(row, course_ids, tag_ids)` saves everything in one transaction.
- **Source:** the original source can only be changed with `leads.edit_all`. Reassigning needs `leads.assign`; deleting needs `leads.delete`.
- **Duplicate check** (`find_leads_by_contact`):
  - Runs while typing.
  - Checks the phone against phone / alt / guardian / WhatsApp numbers of **all** leads, even ones the user can't see.
  - Shows up to 5 matches with name, stage and owner, plus "Open" (if allowed) or "Save anyway".
- **Add/Edit form:**
  - Cards: Who (pick from contacts or recent calls), Interested course, Quick details.
  - Folding sections: other contact, guardian, campaign / type / tags / notes.
  - Remembers the last source and course. "Save & next" keeps source, course and assignee.

**Assignment** (setting `assignment`)

| Option | Meaning |
|---|---|
| `enabled` | Assignment on / off |
| `visibility` | `assigned` / `everyone` |
| `admin_auto` | Admins' new leads go to a chosen user |
| `caller_self`, `team_lead_self` | Callers / team leads keep the leads they add |
| `team_lead_assign` | Team leads may assign leads |
| `handover` | Who may hand over to whom: anyone / team / managers / off |

- A trigger decides who gets a new lead.
- Admins can assign to anyone. Team leads can assign to themselves or their team.
- "Hand over" moves leads with a note and a notification.
- **Visibility:** own / team / all permissions. "Shared mode" (assignment off or visibility everyone) lets everyone see and edit all leads. The creator always sees what they added.

## 7. Leads list, board, search, filters

- **Search:**
  - Matches name, student ID, guardian, email, area, board ID and WhatsApp username.
  - 3 or more digits also match all phone numbers.
  - Closed leads are always included when searching.
  - A hint shows matches hidden by the current chip or filter, plus an "also matched in …" line.
  - The last 8 searches are kept.
- **Chips:** All, 🕘 Recent, ⭐ Starred, 🔮 AI Hot (if AI is on), 🆕 Not called. Counts are cached.
- **Added by / when:**
  - 👤 user picker (who added the lead).
  - Today / Yesterday / This week (starting Saturday) / This month / Custom.
- **Filters** (an admin chooses which show and their order):
  - next call, rating, AI chance, stage, tags, assignee (or unassigned), source, course, campaign, lead type
  - added, last contacted, admitted period, lost reason, papers, campus visit, contact type, fee / payment, batch
- **Saved filters:** private, or shared by admins.
- **Sorts:**
  - next call (default), newest / oldest, name, not contacted longest, recently contacted
  - visit date, papers missing, discount, fee, score
  - AI chance, AI "call first", AI rising, AI falling, AI lowest
  - The next-call sort can "group by time": Overdue / Today / Tomorrow / This week / Later / No call.
- **Closed leads:** hidden from the list by setting (`admission.closed_in_list`) unless a filter needs them.
- **Card designs:**
  - Per user: "New" (Material card) or "Classic". An admin can set it for everyone.
  - "Show the latest on cards" adds the last call and last note lines.
  - A stale card turns orange after N days without contact (`lead_cards.stale_days`).
  - On the card: score chip, AI chance chip, "📵 X is on a call" (call lock), Call / WhatsApp / SMS buttons (hold for SMS or a template), 👁 peek.
- **Bulk select:**
  - Long-press; "mark all matching" selects up to 2,000.
  - Actions: note, stage, tag, assign / hand over, next call, rating, fee, lost, placement, external board "received", course (admins), AI check.
  - Runs in chunks of 200; leads the user can't edit are skipped.
- **Quick menu (one or many):** rating, stage, tags, assign, follow-up, note.
- **Board view:**
  - One column per stage, using the same search, filters and sort. Columns load lazily.
  - Moving a card uses the same stage rules.
  - Setting `board`: enabled, show closed columns, who may use it.
- **Page size** is 30. "Keep in place" stops a card jumping after an edit.

## 8. Lead page and peek sheet

**Phone layout**
- Header: back, call, ⭐ star, edit.
- Round actions: Call, WhatsApp, SMS, Note, Next call.
- Cards in this order:
  1. next-call card
  2. **Pipeline** card (stage, move, admit, lost, reopen)
  3. 🔮 **AI chance** card
  4. **External board / admission flow** card
  5. **Admission credit** card
  6. **Visit** card
  7. **Fee** card
  8. **Papers** card
  9. **Files** card
  10. hand-over note
- Folds: Timeline (calls and notes, filter phone / WhatsApp), Admission, Info, Changes.
- At the bottom: + Note and + Log call.
- **Log a call** made from another phone. **Log WhatsApp** (call or message).
- **URL parameters:** `callNote` (open the add-note view from a notification), `waCall`, `dial` (call on open).
- Opening a lead records a "view" (used by Recent). Delete has an Undo toast.

**Wide / web layout:** Calls & notes, Interest, Details, Activity, Delete lead.

**Peek sheet:**
- Shows the last 5 calls, notes and voice notes in full, or all, without opening the lead.
- Actions: Open, Add note.
- Also shows the AI card for open leads.

## 9. Pipeline stages, admit, lost, reopen

**Stages**
- Fields: key, name, kind (open / won / lost / cancelled), color, order, active, course_ids (stage only for some courses).
- Per-stage rules:
  - `follow_up_days`: auto next call N days later.
  - `note_required`.
  - `ask_date` with `date_label`: the date becomes a follow-up.
- **Seed stages:** New, Contacted, Interested, Follow-up, Papers pending, Ready for admission, Admitted (won), Lost, Admission cancelled.
- **Guards:**
  - System stages can't be deleted or change kind; Admitted, Lost and Cancelled always exist.
  - A stage with leads can't be removed.
  - New stages go before the closed ones.
- **Moving:**
  - Only between open stages; a closed lead must be reopened.
  - Every move writes stage history with an optional note.

**Admit** (`mark_admitted`; who may: setting `admission.mark`)
- **Inputs:** course (active), batch (required by setting; must be in the course), section (required if the batch has sections), admission date, student ID, note.
- **Seats:** checked with a lock unless overbooking is allowed.
- **Papers check:** block / warn / allow.
- **Payment:** optional "pay now", with a minimum by setting.
- **Side effects:**
  - finishes the pending follow-up
  - locks the fee
  - assigns the student ID
  - resets the external-board flow
  - notifies officers
  - triggers AI credit

**Lost:** a reason is required, and "Other…" needs a note. Optional "♻️ Revive on date" follow-up.

**Cancel admission** (who: setting `admission.cancel`)
- A reason is required.
- Frees the seat, unlocks the fee and clears the board flow.
- Keeps the student ID, so a re-admission gets the same ID.

**Reopen:** works on lost or cancelled leads, to a chosen open stage. "Undo admission" = cancel, then reopen.

## 10. Follow-ups (next call) and reminders

- **Rules:**
  - One pending follow-up per lead, mirrored to `leads.next_follow_up_at`.
  - Statuses: pending / done / rescheduled / cancelled. Purpose `revive` for lost leads.
  - Scheduling a new one marks the old one "rescheduled".
- **Auto-done:** a reached call (any outgoing call, or any connected call) marks today's or an overdue follow-up done.
- **Presets:** In 2 hours, Tomorrow 10:00, In 3 days, Next week. They skip holidays; a holiday picked by hand shows a warning.
- **Default next call after each call result:**

  | Result | Next call |
  |---|---|
  | wrong number | none |
  | busy / no answer / call back | 2 h |
  | switched off | tomorrow |
  | connected | 3 days |

- **Home "Today" list:** due today and overdue, closed leads left out. Missed-call follow-ups first, then revive, then by time.
- **Reminders** (cron every minute):
  - early reminder N minutes before, then a repeat
  - **speed-to-lead escalation:** new lead not called in X minutes → the person, then the Team Lead after Y hours, then admins after Z hours
  - **quiet hours** (default 22:00–08:00) delay pushes; an option lets "assigned" come at once

## 11. Calls, call-log sync, caller card, call lock

**Call log** (`call_logs`)
- **Fields:** lead, user, time, outcome, duration, notes, direction, source (app / phone / whatsapp), channel (phone / whatsapp / sms), media (voice / video / message), device ids, SIM, template id, soft delete.
- **Outcomes:** connected, no_answer, busy, switched_off, wrong_number, call_back, missed, rejected, message.
- **Edits:** calls can't be edited, except adding a note once within 24 h.
- **After each call (trigger):**
  - updates last contacted and closes due follow-ups
  - counts unanswered attempts: after N (default 5) the lead is marked unreachable and gets a retry follow-up after N days
  - a missed call from a lead creates a "call back" follow-up and a notification
  - a missed call from a lost lead creates "♻️ Lost lead called you"
  - closed leads don't count attempts

**Call popup**
- Appears when the user returns to the app after calling from the list or lead page.
- Inputs: result, note, rating, next call, 🎙 voice note.
- **Auto mode:** if the call is in the phone's call log, result, duration and SIM are filled in.
- Offers to reopen a lost lead after talking to them.
- `save_phone_call` merges the popup result with the synced copy, so there are no duplicates.

**Call-log sync (Android)**
- **What the phone sends:** only a **SHA-256 hash** of each number, never the number itself. The server matches hashes to leads the user can see.
- **When it runs:** on app open and on returning to the front, plus a background worker after each call.
- **Results:**
  - outgoing ≥ N seconds → connected, otherwise no answer
  - incoming with talk time → connected, otherwise missed
- Matches a manual entry within ±10 minutes instead of saving it twice.
- **Held calls:** calls from numbers that are not leads yet are kept (default 15 days). When a lead gets that number, they appear in its history without alerts.
- **Phone lead directory:** the phone keeps hash → name / stage / course / last note / next call for up to 10k leads. It powers the offline **caller card** overlay and "add a note" notifications.
- **Sync health screen:** per phone: permission, sync on, SIM, pending count, last sync, errors. Worst first.
- **Nudges:** the Super Admin can send "turn on sync" reminders. They close automatically when sync is on.
- **"Sync required"** per person (Super Admin only): the Android app stays blocked until sync is set up.
- **Setting `call_sync`:** who, incoming, missed follow-up, connected minimum seconds, unreachable after / retry days, ask after WhatsApp, hold calls / days.

**Call lock** (setting `call_lock`)
- Stops two people calling the same lead at once.
- Options:
  - mode block or warn
  - lock length 3–60 min
  - override: none / admin / admin + team lead
  - also lock for WhatsApp; show on cards
- The phone marks answered incoming lead calls and clears the lock when the call ends.

**Double-call warning** (setting `double_call`)
- Before calling, warns if someone else contacted this lead within N minutes, e.g. "Rahim called 12 min ago. Call again?", with "read notes".
- Options: count attempts / notes / WhatsApp, include own contacts, log "call anyway".

**Reports:** talk time per person per day, and a weekday × hour heatmap.

## 12. WhatsApp

- **Opening:** WhatsApp opens by number (or the app for username-only leads), optionally with a filled template.
- **Manual log:** call or message, incoming or outgoing, voice or video.
- **Automatic log** (Android):
  - A notification listener sees WhatsApp and WhatsApp Business calls and messages from lead numbers.
  - It **never reads message text**.
  - Events sync without duplicates, skipping ones typed by hand within 15 minutes.
  - Needs Android "Notification access".
- **"Ask after WhatsApp":** after opening WhatsApp from the app, the app asks what happened.
- **WhatsApp calls screen:** today / 7 / 30 days; calls or messages. Delete your own within 24 h.
- **WhatsApp report:** shown separately in Reports and Team activity.

## 13. Notes, voice notes, delete and restore

- **Notes:**
  - Stored as one text on the lead, in stamped blocks such as "26 Oct 2026 · Rahim: …".
  - Bulk "add note" works on many leads.
  - The timeline splits the text into separate notes.
- **Voice notes:**
  - Recorded in the call popup or next to any note field. AAC 64 kbps, at most 1 hour.
  - Stored in Google Drive and linked to the call. Played with speed control.
- **Delete:**
  - admins: anything; the writer: within 24 h
  - only app-written entries, not synced calls
  - calls are soft-deleted
- **Restore:** the person who deleted can undo within 10 minutes; admins any time, from the Change log.
- **Leads:** soft-deleted with `leads.delete`. There is no restore UI yet.

## 14. Campus visits, lead score, recent/starred

**Campus visits**
- At most one planned visit per lead.
- Statuses: planned / visited / missed / cancelled. Walk-ins are allowed.
- A visit moves New or Contacted to Interested (by setting). A miss creates a next call after N days.
- Visit reminders: today from 9 am, and 1 h before.
- Home "Today's visits" card.
- Setting `campus_visit`.

**Lead score** (rule-based, 0–100; separate from AI)
- Base 30, plus points per signal: visited, visit planned, fee talk, answered, stage, referral, hot / cold.
- Minus points for: silent 7 / 30 days, 3 misses, wrong number.
- Admitted = 100; lost = 0. Reasons are stored.
- Recalculated on every change and nightly.
- Card chip: 🔥 70+, 🙂 40–69, ❄️ below 40. Points are editable in Settings.

**Recent and Starred**
- Star leads per user.
- "Recent" combines your calls, activity and opened leads.
- Home "Recent" card.

## 15. Phone contacts, import/export, message templates

**Phone contacts**
- Pick contacts (or a whole contact group) and save them as leads, with source "Phone contact", course (required), tags, rating and assignee.
- Undo within 24 h.
- Existing numbers are flagged.
- Who may use it: setting `contacts_import`.

**Import (Excel / CSV)**
- Needs `import.run`.
- Columns are mapped automatically, including Bangla aliases.
- Duplicate handling: skip / update (logs a "re-enquiry") / create.
- Assignment: none / user / round robin. Default source and course.
- Runs in chunks. Errors can be downloaded as Excel, and a template file is provided.
- Undo within 24 h.

**Export (Excel)**
- Needs `leads.export`.
- Uses the list filters and reads 1,000 rows per page.
- Each export is logged.
- Columns include contact, course, pipeline, fee, visit and admission-flow fields.

**Message templates (SMS / WhatsApp)**
- Shared (admins) or personal. Each has name, body, channel, category, courses and a use count.
- Six seed templates in Bangla.
- **Variables:** {name}, {first_name}, {course}, {batch}, {batch_start}, {fee}, {full_fee}, {discount}, {final_fee}, {paid}, {due}, {next_installment}, {next_due_date}, {visit_time}, {next_call}, {papers_missing}, {student_id}, {section}, {my_name}, {my_phone}, {institute}, {address}, {map_link}, {office_phone}, {today}.
- Missing values are flagged before sending.
- Sending logs a call-log entry and a timeline line.
- **Template report:** sends, edits, replies within 7 days, stage moves and admissions after a send.
- **Institute details** for templates and receipts: name, address, map link, office phone.

## 16. Courses, batches, sections, fees master data

- **Course:**
  - Fields: name, code (`{CODE}` in student IDs), category, duration, active, order.
  - **Fee lines:** e.g. Admission fee, Tuition; the full fee is their sum.
  - Optional **admission fee** threshold, used by the external-board flow.
- **Batch:**
  - Fields: name, start date, class time, **seat capacity**, status (open / closed / full).
  - Seats taken = admitted leads in the batch.
- **Sections** per batch: an in-use section is switched off, not deleted.
- **Fee sync:** changing fee lines re-calculates open negotiations.
- **Generic master lists** (Settings → list): lead_sources, campaigns, lost_reasons, call_results (unused, legacy), tags, lead_types, document_types (legacy duplicate of papers).

## 17. Admission papers, uploads, passport photo, Photo Studio

**Required papers**
- Fields: name, description, required, courses (or all), order.
- Per lead each paper is received or not needed, original or photocopy, with "kept at" (one shelf or file place per student) and "original returned".
- Lead counters: required, received, originals held, missing.
- Filters and sorts on these counters.
- Admit check: block / warn / allow.

**Upload rules (web)**
- Per paper: accepted type (any / image / pdf), exact picture size, KB limits. Defaults are set in settings.
- Pictures are resized and compressed in the browser.
- PDFs over the limit are compressed on the server through **iLovePDF** accounts, tried in order, with monthly counters.

**Passport photo**
- Per paper: on/off, background colour, face %.
- Browser pipeline: cut out the person (server `photo-cutout` → **remove.bg** accounts in order), find the head, auto-crop, render at the exact size.
- Editor: move, zoom, rotate, background, light.

**Photo Studio (web, officers)**
- Any photo in, face detection (MediaPipe), background removal.
- Presets come from paper sizes, shared presets (px / mm / in, dpi, face %, background, KB, format) or custom sizes.
- Output: download (JPG / PNG under a KB limit), a print sheet (4R / A4), or save to a student's photo paper.

## 18. Google Drive files

- **One Drive per institution, via an Apps Script web app.**
  - The admin deploys the script and pastes its URL and a secret.
  - Staff never sign in to Google. All access goes through Edge Functions, so the app's rules decide who sees what.
- **Folders:** `Lead Management/<Student ID Name | Name – Phone>/Papers | Voice notes`.
- **Edge functions:**
  - `drive-connect`: ping and save, create the root folder.
  - `drive-upload`: ≤ 35 MB. Checks the upload rule and compresses. Auto-ticks the paper as a received photocopy.
  - `drive-file`: streams the file; Drive links are never exposed.
  - `drive-delete`: moves to Drive trash.
  - `drive-zip`: a lead's files, ≤ 60 files / 60 MB.
- **Setting `files`:** enabled, and who sees everyone's files. By default you see the files you uploaded; admins see all.
- **UI:** Files card (list, open, delete, ZIP), camera or file upload.

## 19. Student IDs

- **Pattern tokens:** `{YYYY}`, `{YY}`, `{SESSION}` (e.g. 2027-28), `{CODE}`, `{000…}` (running number).
- **Number series:** one per year (if the pattern has a year) and per course code (if it has `{CODE}`).
- **Year source:** admission date or batch start.
- **Modes:** auto / manual / off.
- **Rules per course, batch or section:**
  - Each rule is a **pattern** or a **number range**; the most specific one wins.
  - Ranges can't overlap and hold at most 100k IDs. A full range blocks admission with a clear message.
  - "Fill section ranges" gives every section of a batch consecutive ranges.
  - An overview shows each range's usage, with a warning when two batches share a series.
- **Preview:** the next ID is shown in the Admit sheet without using it up.
- **Changes:**
  - Moving course, batch or section gives a new ID in auto mode; the old one is logged.
  - Typing an ID by hand must be unique, and is logged.
- **Renumber everyone:** admins only, with a preview.

## 20. Fee negotiation, discounts, final fee

- **Fee talk:**
  - One per lead and course. Starting it moves the lead to Interested.
  - Events: quoted, lead asked, offer, note.
- **Discounts:**
  - On one fee line or the whole fee, as an amount or a percent. A reason is required (setting).
  - Can't exceed the line, and all discounts can't exceed the full fee.
- **Approval:**
  - Within the requester's limit → approved at once.
  - Above it → approvers are notified; the **Discounts** queue shows Approve or "Not now" only to people whose limit fits.
- **Limits:** % per role (defaults: caller 0, team lead 10). `discounts.approve` or `*` = 100.
- **Expiry:** approved discounts expire after N days (cron).
- **On admission:** approved discounts become permanent; pending ones are cancelled.
- **Lead fee fields** (kept by triggers): fee status (negotiating / discount waiting / discount given / final), full, discount, final.
- **Fee lock at admission:**
  - The final fee is locked at admission.
  - **Change final fee** (officer or admin): a reason is required; 0 ≤ final ≤ full, and ≥ already paid.
  - A course change re-locks the fee.

## 21. Payments, installments, receipts, refunds, reminders

**Payments**
- **Who:** admitted students only, and people allowed by `payments.who`.
- **Methods:** from settings (Cash, bKash, Nagad, Rocket, Bank, Card). Some require a transaction ID.
- **Back-dating:** limited to N days (default 7); older needs admin. No future dates.
- Amount ≤ due.
- **Receipt number:** `<prefix>-YYYY-00001`, one series per year. Optional **college receipt number**: off / optional / required, unique.
- **Mistakes:** payments are never deleted; they are **voided** with a reason (`void_who`).

**Installments**
- Up to 24 lines that must sum to the final fee. Payments fill them earliest first.
- "Next due" is shown on the student.

**Printable receipt**
- Templates: classic / modern / minimal.
- Sizes: A4, A5, A4 with two copies (student and office), POS 80 mm.
- Options: accent colour, logo, title, header line, 0–3 signatures, amount in words, PAID / VOID stamp, chosen fields, footer.
- Settings has a live preview.
- Printed with expo-print, or an iframe on the web. Can also be shared as text.

**Refunds**
- For students no longer admitted. Amount ≤ net paid.
- Own series `RFD-YYYY-00001`.
- Net paid = payments − refunds.

**Reminders** (cron hourly from 9 am)
- To the assignee N days before and on the due day.
- After N days late: the assignee, their team lead and admins.
- Each reminder is sent once.

**Collection report**
- Collected, refunded, net, by method and by person.
- Due and late now, discounts given, recent voids.
- Visible according to report scope.

## 22. Students tab, placement, external board flow

**Students tab**
- Admitted students; on/off and "who" by setting.
- **Summary:** students, new this month, with due, due amount, overdue, collected this month, papers missing. Tap to filter.
- **Chips:** All, Mine, Due, Overdue, Paid, Papers missing, New this month, plus the board-flow chips.
- **Paid ranges:** ৳0, 1–999, 1,000+, 5,000+, 10,000+, custom, paid this week / month.
- **Sorts:** admitted newest / oldest, name, student ID, paid most / least, last paid, most due, next installment, papers missing, next call.
- **Search** also by student ID and board ID.
- The list total shows what the listed students paid.

**Placement**
- Change course, batch and section, with a seat check.
- Side effects: fee re-lock, new student ID, logged.
- **Bulk placement:** preview first (who moves, seats, new IDs, fee changes), then all-or-nothing.

**External board flow** (post-admission steps; configurable per institution)

Many colleges must register each admitted student with an affiliating university or board (for example,
National University in Bangladesh) and then record that the institution received the student. Default steps:

1. **📤 Submitted Online:** the student was submitted on the board's portal. The **board ID** (label set per
   institution, e.g. "NU Admission ID") is required and unique.
2. **🏛 Received by institution:** needs Submitted first, and **net paid ≥ the course's admission fee**
   (a default amount per institution, overridable per course).
   - The error says how much more is needed.
   - Officers are notified when a submitted student becomes "ready" (fee paid).
   - **Bulk received:** only ready students are marked; others are reported with the reason.
3. **Undo:** a reason is required; the later step must be undone before the earlier one.

- Officer Home card: not submitted / ready counts.
- Make the steps, their names, the board ID label and the money and paper conditions **configurable per
  institution**, and allow switching the whole flow off.

## 23. AI features (Claude / Gemini)

All AI runs **on the server**, in Edge Functions `ai-lead-chance` and `ai-admission-credit`, in the background.
- The app only reads saved answers, so lists stay fast.
- API keys are entered in Settings → AI and **stored only on the server**; the app sees a hint like `sk-ant-…abcd`.
- Names and phone numbers are **never sent**. People appear as codes P1, P2….

### 23.1 Chance of admission (open leads)
- **Input to the AI** (built by SQL `ai_chance_input`):
  - the lead's story: stage, age, days since contact, source, courses, area, rating, visit, fee talk, papers, previous chance
  - every event: calls (direction, answered, minutes, note), WhatsApp, notes, visits, fee offers, papers, hand-overs, next calls
  - per-person totals
  - **answer hours** (answered / not by Dhaka hour)
  - next-call stats
  - "like this before": admitted vs lost for the same course and source over the last year
  - today's date
- **Output** (JSON schema), in **Bangla**:
  - chance %, short summary, good signs, risks
  - objections (kind: fee / family / distance / time / other_college / job / doubt / documents / other, with detail)
  - 2–5 next actions with why
  - **script:** what to say, per situation, 1–3 polite lines
  - best time to call, next call in N days with why
- **Prompt rules:**
  - calibrate from history
  - notes are the strongest evidence
  - never promise discounts, scholarships or dates not in the data
  - the admin can add "what the AI should know about the college" (installments, class days…)
- **Level** from the chance: hot / warm / cold. The previous chance is kept, so the trend ▲▼ is shown.
- **Lead page card:**
  - chance, trend, summary, objection chips, numbered actions
  - best time plus "📅 set next call in N days" (creates a follow-up)
  - "💬 What to say" (hold to copy), "why" (good / risks)
  - "🔄 Look again", with a warning if already looked at today with nothing new
- **Queue (`lead_chances`):**
  - States: pending / working / done / failed.
  - It looks again automatically after a new call or note (once a day per lead).
  - "Check" is manual and always allowed.
  - Kinds: auto / manual / bulk. The daily limit counts **auto** only.
  - A lead stopped 3 times is given up. A failed credit try waits 5 minutes.
- **Daily run** at a chosen hour (Dhaka). Groups: changed since the last look / never looked at / older than N days.
- **Settings → AI:**
  - on/off, auto, daily run, daily auto limit (up to 1000)
  - **monthly budget ($)**: Claude stops when it is reached; "Check" still works
  - "who sees the chance"
  - run a group now (with count and cost first), progress, ⏹ stop
  - accuracy so far (by level: % of closed leads admitted)
- **Lists:**
  - 🔮 % chip on cards (tap: quick view sheet), AI Hot chip, AI sorts and filter
  - Home "Call these first" (my leads with a good chance)
  - web table column

### 23.2 AI admission credit
- When a lead is admitted, the AI reads the story (calls, minutes, notes, visits, fee talks, papers, hand-overs, who pressed Admitted) and **shares the admission among staff**.
- **Output:** shares (%, adding to 100, each with a reason in Bangla), the decisive moment, confidence.
- **Weighing:** real influence over clicks; work near the decision weighs most; bringing the lead earns a fair part; pressing Admitted is office work and earns a small part.
- **Lookback window:** 60 / 90 / 180 / 365 days.
- **Admins can:** re-run, or set the shares **by hand** with a reason.
- **Credits:** use these shares for "Admitted" when the feature is on.
- **"Work out past admissions"** runs once.

### 23.3 Providers, models, costs
- **Providers:** Claude and Gemini, each with its **own on/off switch** (off = never used, key never sent).
- **Per-feature mode:** `claude` | `gemini` | `gemini_then_claude` (fallback) | `compare` (both in parallel; lists use Claude's answer).
- **Answers are kept per provider** (`lead_chance_answers`, `admission_credit_answers`). One AI's answer is never deleted when the other answers. The lead page has tabs per AI.
- **Claude models:** **Haiku 5.5** (cheap: $0.10 / $0.50 per M tokens) or **Sonnet 5.5** ($2 / $10), chosen per feature.
  - Prompt caching on the system prompt.
  - Server-side refusal fallback for Sonnet; Haiku is asked plainly.
  - Structured output via JSON schema.
  - 75 s timeout, no SDK retries; a run starts new work for 45 s (the Edge Function has a 150 s limit).
- **Gemini (free tier):**
  - Flash models only; retired 1.x models are filtered out.
  - The server auto-switches to the best available model if the chosen one is gone (404).
  - Quota (429) → rest 15 min. Free-tier data may be used by Google, so the UI warns.
  - **Owner's verdict: the Gemini free tier was not useful in practice; Claude Haiku 5.5 is the cheap choice.**
- **Ledger `ai_usage_daily`:**
  - Rows are per day and feature (`chance`, `credit`, `haiku:<f>`, `gemini:<f>`).
  - The monthly budget counts Claude only, at each model's price.
- **Problem visibility:**
  - each AI's last problem is shown in Settings
  - a side note on the lead when one AI failed but the other answered
  - key status (refused / credit out)
- **Planned but not done:** the Batch API (50 % cheaper) for the daily run.

## 24. Admission Contribution

- A menu (phone More and web) built on AI admission credit.
- **Summary:** each person's share of admissions in a period.
- **Every student:** a coloured bar of who contributed.
- **Breakdowns:** by source and by course.
- **Drill-downs:** a student detail (who did what, when) and a person detail.
- **Export:** to Excel.

## 25. Notifications and push

**Inbox**
- Last 100, mark read, deep link to a lead or route.
- Unread badges on More, the Alerts tile and the web.

**Kinds** (each can be switched off by the admin; people can mute some)
- assigned, auto_assigned, follow_up, visit, speed_to_lead, outcome, signup, sync_nudge, missed_call, discount, payment
- leaderboard, scorecard, alumni, feedback, admission-flow steps, app_update
- AI, and the external board flow's "ready"

**Sending**
- `notify(user, kind, title, body, data, dedupe, urgent)`: dedupe per user, quiet hours, pushed via pg_net to the Expo push API.
- Receipts are checked every minute, and dead tokens removed.

**Push setup**
- Asks permission once and creates the Android channel `leads`.
- Registers the token with a timeout and "checks in" (the server knows the device's state).
- **Push check screen:** this phone's permission, channel and token; send a test push.
- **Push health (admins):** one row per person; Google pre-launch test devices are ignored.

**Device ownership**
- One person per phone install. Devices are forgotten on sign-out.
- Web sessions are labelled "🌐 Website" and get no push.

## 26. Team activity, change log, reports

**Team activity** (setting `activity`)
- **Sessions:** app time is counted while the app is in front and being touched, until N idle minutes. Offline queue.
- **Team list:** Today / Yesterday / This week / This month. Calls in / out / missed, talk time, WhatsApp, leads added and imported.
- **Person detail:**
  - calls and talk time, short calls, follow-ups on time or late
  - speed to first call, lost reasons
  - hourly chart
  - **gaps:** 60+ idle minutes in working hours
- **Lost section:** every move to Lost per person, with reason and note, and whether the lead is still lost.
- **Export work:** Excel or text.
- **Who sees it:** admins; team leads see their team (setting). Callers see no one.

**Change log**
- Paged global timeline with counts per kind.
- Restore deleted entries.
- Web version with Excel export.

**Reports** (setting `reports`: who, Home card, which sections)
- **Sections:** summary, funnel (pipeline now; tap a bar → those leads), visits, sources, team, WhatsApp, templates, collection, lost, call heatmap.
- **Scope:** reports run **as the viewer**, so each person counts only leads they can see. Managers can pick one person or a course.
- **Charts:** hand-built (no chart library). The web shows a dashboard grid.
- **Home card:** this month.

## 27. Credits, leaderboard, milestones, weekly scorecard

**Credits**
- **Rule sets:** points per activity with daily caps, versioned with `effective_from`.
- **Kinds:**
  - calls: call, connected, talk minute, incoming
  - WhatsApp and templates: wa_message, wa_call, template
  - notes and follow-ups: note, voice, follow-up set, follow-up on time
  - leads: lead added, imported, stage forward
  - visits and admission: visit planned / done, paper, admitted (AI share), payment (per ৳1,000)
  - app time, overdue penalty
- **Calculation:** worked out from the activity data already stored (no separate event table).
- **"retro" setting:** re-apply new rules to past days, or keep old days on the old rules.
- **Super Admin:** manual adjustments (logged); hide a person from the leaderboard.

**Leaderboard**
- Podium, own rank, streaks, levels; tap for a breakdown.
- **Winner announcement:** e.g. Friday 14:00.
- **Rank notices:** "You are now #2"; a nudge at 16:00 when close to the next rank.
- **Home:** Rank card and streak chip.

**Milestones**
- 10 levels: Starter 100 → Legend 100,000.
- **Badges** over the last 365 days: calls100, talk2h, early bird, fast responder, leads10, notes30, wa50, admit5, visits5, money50k…

**Weekly scorecard**
- Saturday–Friday week vs the previous week, per person.
- Metrics: leads, calls, connected, admissions, money, response time, missed follow-ups.
- Admins notified on Sunday.
- Phone: cards. Web: sortable table with Excel.

## 28. Alumni, referrals, public forms

**Alumni records**
- **Fields:**
  - contact: name, phone, WhatsApp, email, photo
  - study: course, batch, session, passing year, student ID
  - work and place: workplace, designation, district, upazila, address
  - other: tags, notes, owner, do-not-contact, link to the lead
  - **ref code:** 6 characters, without confusing letters
- **Custom fields:** text, long text, number, date, select, phone, email, url, yes/no; required, show in list, order.
- **Events:** notes, calls, messages.

**Screens**
- List: search, filters, select many, bulk course / batch, delete.
- Detail and edit.
- **Import:** from Students (by batch or course), from Excel / CSV (dedupe by phone), from phone contacts (groups).

**Referrals**
- An alumnus refers a friend into the **Referral inbox**.
- Inbox actions: import as a lead (course, assignee), credit to an existing lead, or reject.
- A referral can also be added from a lead page.

**Rewards**
- Created automatically when a referred lead is admitted; cancelled if the admission is cancelled.
- Amount: a default, or per course.
- Status, payment method, note.

**Public pages** (web, no login)
- `/refer/<code>`: a friend submits name, phone and course → referral inbox.
- `/apply`: a website application → a new lead (source "Website form"), or a line on an existing lead. With `?ref=` it counts as a referral.
- **Rate limits:** a number at most 3× per hour; the site at most 60 forms per 10 min.
- Each form can be switched on or off.
- Page text is in Bangla.

**Who:** view and manage, each a "who" rule.

## 29. Feedback chat, crashes, speed check, app versions

**Chat with the developer**
- One chat per person.
- **Topics:** problem / idea / question, with statuses.
- Replies, reactions, delete own within 5 min, seen ticks and typing (Realtime).
- **Attachments:** up to 3 pictures and 1 voice.
- **Three-finger tap:** screenshot → new problem report.
- **Solved topics:** files cleaned up after 90 days.
- **Developer inbox:** chats, topics, crashes.

**Crash reporting**
- JS global handler and error boundaries, plus native Android crashes.
- **Signature dedupe;** up to 20 queued offline, sent with the current screen.
- A solved crash reopens on a newer version.

**Speed check**
- Every request is timed; a test runs the usual requests.
- Shows average and slowest per request. Can send the result to the developer.

**App versions (admins)**
- Each person's phones: build, OTA update, channel, last opened.
- Flags old updates; "ask to update" sends a notification.

**OTA updates**
- **Banner:** "A new version is ready · Restart / Later". Checks on open and on returning, at most every 30 min.
- **What's new:** shown once per new entry; full list in More. Every change ships with an entry.
- **Old Play builds** without Firebase are told to reinstall from the Play Store.

## 30. Home, More, Settings hub

**Home (phone)**
- **Top bar:** logo, streak chip, 🔔, avatar.
- **Cards and banners, top to bottom:**
  1. store-update card
  2. **Today stats:** calls due, talk time, new leads, admitted, visits, money (team view for admins)
  3. rank card
  4. banners: sync nudge, sign-ups waiting, discount requests
  5. Today's visits, Today's calls, 🔮 Call these first, Recent
  6. Students summary, admission-flow card, report card
  7. quick actions
- **FAB:** "Add a lead".
- The **website** opens on Students instead.

**More**
- **Top:** profile card; tiles for Alerts, WhatsApp, Team activity / Templates, Discounts.
- **ALUMNI:** Alumni, Referral inbox.
- **REPORTS:** Reports, Admission Contribution, Leaderboard, Weekly scorecard.
- **TOOLS:** Call log sync, Phone contacts, Templates, Export my work, WhatsApp calls.
- **TEAM:** Team activity, Change log, Sync health.
- **ADMIN:** Users, Settings, Push health, App versions.
- **APP:** list design, Appearance, What's new, Version and update check.
- **HELP:** Contact developer, Speed check, Notification check.
- Sign out.

**Settings hub** (`settings.manage`)
- **ADMISSIONS:** Courses & batches, Students tab, Lead score, Alumni, Admission flow, Fee & discount (incl. payments, methods, receipt design, reminders), Admission rules, Student ID rules, Required papers, Paper types.
- **LEADS:** Pipeline stages, Credits & leaderboard, AI, Reports, Pipeline board, Campus visit, lists (sources, campaigns, lost reasons, call results, tags, lead types), Lead cards, Lead filters.
- **OFFICE:** Working days & holidays.
- **DATA:** Import, Export, Google Drive, Message templates, Phone contacts access.
- **TEAM:** Website access, Users, Roles (Super Admin), Lead assignment, Call log sync, Double-call warning, Call lock, Notifications, Team activity, Sync health.
- **Web only:** Upload rules, Photo Studio.

**`app_settings` keys** (all need to be per institution)

| Area | Keys |
|---|---|
| Team and reports | activity, reports, scorecard, credits, credit_extras, notifications, web |
| Admission and students | admission, admission_approval, students, files, upload_rules, photo_presets |
| Fees | fees (incl. payments, receipt, reminders), receipt_prefix |
| Leads | assignment, board, lead_cards, lead_filters, lead_score, campus_visit, message_templates |
| Calls and contacts | call_sync, call_lock, double_call, contacts_import |
| AI | ai_chance, ai_credit, ai_providers |
| Alumni and forms | alumni, public_forms |
| Office calendar | working_days, working_hours, quiet_hours |
| Single values | institution_name, developer_email, min_app_version, speed_to_lead_minutes, early_reminder_minutes, repeat_reminder_minutes, escalate_team_lead_hours, escalate_admin_hours |

- **Unused legacy:** max_call_attempts, call_log_lock_hours, activity_retention_days, and the `feature_flags` table.

## 31. Website (web version)

- **Same codebase** with a **WebShell**:
  - **Left menu** (narrowable, permission-based): Leads, Students, Alumni, Reports, Team activity, Change log, Admission Contribution, Leaderboard, Scorecard, Contact developer, Upload rules, Photo Studio.
  - **Top bar:** page title, **global search** (Ctrl+K or `/`), `?` for keyboard shortcuts, theme (System / Light / Dark), avatar menu (Speed check, Sign out).
- **Access:** setting `web` (who may use the website; admins always).
- **Leads / Students table:**
  - sortable columns, column chooser, density (comfortable / compact), board view, tick-many with bulk actions, Excel export
  - detail in a right-hand panel, name hover card, copy buttons
  - row ⋯ menu: payment, note, upload paper, flow steps, section, board ID, student ID, fee change, papers popup, all notes
  - KPI cards
- **Live approval toast:** officers see a badge and a note when students become ready.
- **Other web screens:** Team activity, Change log (restore, Excel), wide reports and scorecard, Photo Studio.
- **Stale build after deploy:** the page reloads by itself (chunk errors); missing assets return 404.
- **Hosting:** cPanel via FTP, deployed by a GitHub Action on push to main.

## 32. Native Android module

`modules/call-log` (Kotlin, Expo module):
- **Permissions:** READ_CALL_LOG, READ_PHONE_STATE, POST_NOTIFICATIONS, SYSTEM_ALERT_WINDOW, plus Notification access (WhatsApp).
- **Call-end receiver and worker:** captures calls about 6 s and 40 s after a call ends, plus a 15-min safety job.
- **Queue:** only BD mobile numbers, stored as SHA-256 hashes; SIM filter.
- **Lead directory:** on-phone, offline. Feeds the **caller card overlay** on the call screen (lead name, stage, last note…) and the "add a note" / "incoming lead" notifications. Deep link `leadmanagement://leads/<id>`.
- **Call lock:** device key.
- **WhatsApp listener:** WhatsApp and WhatsApp Business; never reads text.
- **Contact groups**, **native crash capture**.
- **JS API:**
  - device and permissions: getDeviceId, getPermissions
  - sync: setEnabled, getSims / setSimFilter, captureNow, getPending, removePending, recentCalls
  - directory: setLeadDirectory
  - caller card: get / setCallerCard, previewCallerCard
  - call lock: setCallLock
  - WhatsApp: getWhatsAppStatus, setWhatsAppEnabled, openNotificationAccess, getWhatsAppPending
  - contacts: getContactGroups
  - crashes: takeNativeCrashes
- **Google Play:** needs the call-log permission declaration and a Data Safety form.

## 33. Background jobs (pg_cron)

| Job | Every | Does |
|---|---|---|
| lead-notifications (`notifications_tick`) | 1 min | Pushes held by quiet hours, follow-up reminders, visit reminders, speed-to-lead escalation, cleanup (60 days) |
| push-followup | 1 min | Expo push receipts, remove dead tokens |
| fee-discounts | 15 min | Expire approved discounts |
| fee-payments | hourly | Installment reminders and late alerts |
| credit-tick / credit-level-tick | 15 min / hourly | Winners, rank notices, nudges, level-up notices |
| weekly-scorecard | hourly | Sends Sunday 9:00 |
| lead-scores-nightly | 02:10 | Recalculate scores |
| held-calls-cleanup, call-lock-clean | daily / periodic | Housekeeping |
| ai-* kicks | 2 min | Wake the AI Edge Functions when work is waiting (x-cron-secret header) |
| AI daily run | hourly check | Queue the daily AI run at the chosen hour |

**In the new app,** every job must run per institution, in that institution's time zone.

## 34. Theming, offline, caching, speed

- **Theme:**
  - Light and dark palettes; brand blue `#3557D4`; hot / warm / cold colours.
  - Material 3 tonal containers on Home, More and Alumni.
  - Phone: Appearance System / Light / Dark (restarts the app). Web: theme picker.
- **Offline:**
  - "No internet" strip, then "✓ Back online".
  - Activity, crash, call and WhatsApp queues work offline.
- **Caching:**
  - In-memory request memo with TTL.
  - Per-user AsyncStorage cache for **instant open** of Home, Leads and Students (stale-while-revalidate).
  - Cleared on sign-out or user switch.
- **Speed techniques that worked:**
  - RLS init-plans and child-policy fixes, indexes
  - one RPC for all Home numbers, a counts RPC for chips
  - page size 30, lazy board columns
  - lead page and peek loads trimmed
  - `set jit = off` on heavy report functions (JIT added about 800 ms)
- **Rule from the owner: the app must never get slower.** Measure before and after; benchmark with about 3,000 leads.

## 35. Build, release, deploy

- **App identity:**
  - A neutral product name, its own Android package and deep-link scheme.
  - `runtimeVersion` is pinned; changing it needs a new store build.
- **EAS profiles:**
  - development: dev client APK
  - preview: APK, channel `preview`
  - production: AAB, channel `production`
  - production-apk
- **GitHub Actions:**
  - `app-update.yml` (manual): choose Database + app / App only / Database only. Runs `supabase db push`, optionally `functions deploy <names>`, then `eas update --channel production`.
  - `build-android.yml`: local EAS build on GitHub runners. `google-services.json` comes from a base64 secret, and the job checks that Firebase is inside the build.
  - `deploy-web.yml`: web export plus MediaPipe assets, FTPS upload.
- **Secrets** (never in code or chat):
  - Expo token, Supabase access token, DB password, project ref
  - FTP credentials, the Firebase file, the keystore
  - AI keys (only in the app's Settings, stored server-side)
- **Release flow:** each change is one PR with a "What's new" entry. The deploy type is stated: database / Edge Functions / app update / new store build.

## 36. Everything that must be configurable per institution

Never hard-code any of these. The earlier version hard-coded them for one college, and each one had to be found later.

- **Branding:** institution name, short name, logo, colours. Used on login, web shell, Home top bar, receipts,
  tab titles, permission texts, public forms and the native WhatsApp listener label.
- **Product-level (not per institution):** app name, domain, privacy page contact, and the developer / feedback
  inbox owner (the Master Admin side).
- **External board flow:** step names, board ID label, admission-fee default, on/off.
- **Reset password format:** generic (no institution prefix), or based on the short name.
- **Locale:** defaults are for Bangladesh, but each must be a setting.
  - time zone `Asia/Dhaka`
  - currency ৳
  - phone rules (`880`, 01XXXXXXXXX)
  - week Saturday–Friday, Friday off, scorecard day Sunday
  - Bangla templates and public forms, payment methods bKash / Nagad / Rocket, address placeholders
- **Lead score:** rules must reference stage kinds or ids, not hard-coded stage keys.
- **Everything else per tenant:** settings, roles, setup, counters (receipts, refunds, student IDs), Drive
  connection, iLovePDF / remove.bg accounts, AI keys.

## 37. Lessons learned (do not repeat these mistakes)

1. **Invoker functions calling locked functions:**
   - A `SECURITY INVOKER` read function called a helper revoked from `authenticated`.
   - Result: "permission denied", and every AI card was **empty for every user**.
   - **Test every RPC as a real signed-in role**, not as the database owner.
   - Run a sweep that finds invoker functions or triggers calling functions the role can't execute.
   - Show load errors in the UI instead of rendering nothing.
2. **Queue bugs found in review:**
   - wrong daily-limit counting
   - a manual check while work was in progress being pushed to tomorrow
   - endless re-claiming of stuck items (billed every 10 min)
   - immediate retries
   - kicks that woke the server with nothing it could do
   - **Design queues with attempts, back-off, "given up", and kicks that check feasibility.**
3. **Edge Function time limit (150 s):**
   - Keep each AI call ≤ 75 s, start new work only for 45 s, and use no SDK retries.
   - Run compare-mode providers **in parallel**.
4. **Postgres JIT** made one report go from 15 ms to 900 ms. Set `jit = off` on heavy plpgsql functions.
5. **External AI providers:**
   - Model lists include **retired models**, so filter them out and self-heal on 404.
   - Free tiers have tight, unpublished quotas.
   - Record every provider problem where an admin can see it.
   - Never fall back silently without a note.
6. **Cost display:** estimates must use the **model actually chosen** (and $0 for free providers). Otherwise budgets stop work wrongly and admins are misled.
7. **Old app versions stay in the field after each update:**
   - Derive server decisions (e.g. institution, permissions) from the user's profile, not from what the client sends.
   - Keep RPC signatures backward compatible, or add new ones.
8. **Speed:**
   - Every new list badge or chip is a potential extra request per row. Batch into one RPC.
   - Denormalise counters with triggers.
   - Cache with stale-while-revalidate.
9. **Phone duplicates:** check across all leads, even invisible ones (via a DEFINER function), but only reveal name, stage and owner.
10. **Soft delete plus an append-only timeline** made "restore" and audits easy. Keep that pattern.
11. **Google Play:**
    - Call-log permission declaration and an account-deletion web path are required.
    - FCM needs `google-services.json` in the build.
    - Pre-launch test devices pollute push stats.
12. **Never commit secrets:**
    - Firebase JSON, google-services.json, .env, keystore, Apps Script secret, tokens.
    - API keys are entered by admins in the app and stored server-side; the app only sees a hint.

## 38. Open decisions for the owner

1. Can one person belong to **more than one institution**? Simplest: one email = one institution.
2. **Who may create an institution?** Self sign-up with Master Admin approval, or the Master Admin only?
3. **How to pick the institution at login:** search by name, College Code or EIIN (recommended, so the customer list stays private), or a list?
4. **AI keys and Google Drive:** each institution brings its own, or the platform's shared ones (who pays)?
5. **Product name, app name, domain:** e.g. one domain with `/<slug>`, or per-institution subdomains?
6. **Billing / subscription plans** for institutions, now or later? Keep a plan/expiry field from day one.
7. Should the **external board flow** be included from the start, and which languages should the UI support besides English and Bangla?
8. **Lead merge** (merging duplicate leads) was planned in the earlier version but never shipped. Include it?
