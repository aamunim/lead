// =====================================================================
// 🆕 What's new: shown once to everyone after an update brings a new
//   entry (newest first). Add an entry with every update; the key only
//   has to be new (the date is fine).
// =====================================================================

export type WhatsNew = { key: string; date: string; title: string; items: string[] };

export const WHATS_NEW: WhatsNew[] = [
  {
    key: '2026-11-18-a',
    date: '18 Nov 2026',
    title: '🌙 Dark mode',
    items: [
      '🌗 More → Appearance: 📱 like the phone (System), ☀️ Light or 🌙 Dark',
      '📱 “System” follows the phone: when the phone turns dark, so does the app',
      '🖨 Exports and PDFs stay white, for printing',
    ],
  },
  {
    key: '2026-11-17-b',
    date: '17 Nov 2026',
    title: '📞 Call log sync can be required',
    items: [
      '🔒 The Super Admin can make Call log sync necessary for a person (Users → the person)',
      '📞 Then the app opens only after call log permission is given and Call log sync is on: the app shows the steps',
      '🩺 Sync health shows 🔒 Required next to those people',
    ],
  },
  {
    key: '2026-11-17-a',
    date: '17 Nov 2026',
    title: '📲 App 2.8.0',
    items: [
      '📵 Call lock: while someone is on a call with a lead, others can’t call it (“🚫 Rahim is on a call”); the cards show who is on a call',
      '👥 Phone contacts: pick a group or label from your phone (Family, Students 2025…) and save all of it as leads',
      '📕 Export my work as PDF',
      '📸 Tap any screen with three fingers to send a picture of it to the developer',
      '💥 Crashes in the phone part of the app now reach the developer too',
    ],
  },
  {
    key: '2026-11-16-a',
    date: '16 Nov 2026',
    title: '💬 Contact developer: pictures, voice and crashes',
    items: [
      '🖼 Add up to 3 screenshots or photos to a message, and 🎙 a voice message (up to 3 minutes)',
      '✅ “It’s solved”: mark your own message solved when it works again',
      '💥 If the app breaks, the developer is told by itself; you can add a few words about what happened',
    ],
  },
  {
    key: '2026-11-15-a',
    date: '15 Nov 2026',
    title: '📌 Keep in place',
    items: [
      '📌 After a call, WhatsApp, note or stage change the lead stays where it is in the list, and the card shows what changed',
      '✓ A lead that no longer fits the list (e.g. “Not called” after you call) stays dimmed until you sort again',
      '↻ Re-sort, or pull down, to sort the list again',
      '⇅ Sort → Keep in place turns it off on your phone',
    ],
  },
  {
    key: '2026-11-14-a',
    date: '14 Nov 2026',
    title: '🏅 Levels, 14 badges and your streak on Home',
    items: [
      '🔥 Your streak and level at the very top of Home (tap = the leaderboard), even when you are left out of the leaderboard',
      '🏅 10 levels by all your credits: 🌱 Starter 100 · 🥉 Bronze 500 · 🥈 Silver 1,000 · 🥇 Gold 2,500 · 💎 Platinum 5,000 · 💠 Diamond 10,000 · 🏅 Master 20,000 · 🎖 Grand Master 35,000 · 👑 Champion 50,000 · 🏆 Legend 100,000',
      '📈 Home shows how far you are to the next level, and you get a notice when you reach one',
      '🎖 9 new badges: 🎯 50 talked a day · ⚡ new lead called in 10 min · 🆕 10 leads · 📝 30 notes · 💬 50 WhatsApp · 🏫 5 visits a week · 💵 ৳50,000 a week · 🔥 7 and ☄️ 30 days in a row',
      '⚙️ Admins: Settings → Credits & leaderboard → Milestones to change the levels',
    ],
  },
  {
    key: '2026-11-13-a',
    date: '13 Nov 2026',
    title: '🔥 Streaks, badges and leaderboard news',
    items: [
      '👑 Every Friday at 2 PM: the winner of the week, and your own place',
      '🥇 “You are now #2!” when you get into the top 3 · 💪 “Only 25 credits to #3” in the afternoon',
      '🔥 Days in a row with enough credits, next to your name on the leaderboard',
      '🎖 Badges: 💯 100 calls a day · 🎓 5 admitted a week · ⏱ 2 hours of talk · 🌅 first call before 9 AM · 👑 winner',
      '⭐ Credits in Team activity',
    ],
  },
  {
    key: '2026-11-12-a',
    date: '12 Nov 2026',
    title: '🏆 Credits and the leaderboard',
    items: [
      '⭐ Every kind of work earns credits: calls, talk time, WhatsApp, notes, next calls, new leads, visits, papers, admissions, money taken, app time',
      '🏆 More → Leaderboard: everyone’s place today, this week, this month or all time; the top three on a podium',
      '🙋 Tap yourself to see where your credits came from; Home shows your place this week',
      '⚙️ Admins: Settings → Credits & leaderboard sets how many credits each kind of work is worth',
    ],
  },
  {
    key: '2026-11-11-a',
    date: '11 Nov 2026',
    title: 'Export your work',
    items: [
      '📤 More → Export my work: your calls, notes, changes and leads added as Excel, text or CSV',
      '📅 Today, yesterday, this week, this month, last month or any dates you choose',
      '👥 Admins and Team Leads: Team activity → ⬇ Export (one file for everyone, or a file for each person), or on a person’s page',
    ],
  },
  {
    key: '2026-11-10-a',
    date: '10 Nov 2026',
    title: 'Double-call warning',
    items: [
      '⚠️ Tap Call on a lead someone else talked to a moment ago: “Rahim called 12 minutes ago. Call anyway?”',
      '📝 “Read notes” shows the last calls and notes first',
      '⚙️ Admins: Settings → Double-call warning (on/off, how many minutes, what counts, change log)',
    ],
  },
  {
    key: '2026-11-09-build-2-7',
    date: '9 Nov 2026',
    title: 'Caller card · version 2.7',
    items: [
      '📲 When a lead calls, a card shows over the call screen: name, stage, money due, last note, next call',
      '➕ An unknown number calling: “Add as lead” in one tap',
      '⚙️ Turn it on once: More → Call log sync → Caller card → Allow display over other apps (then “Try it”)',
      '📇 New lead: pick the number from your contacts (the app’s list or the phone’s own picker)',
      '🕘 New lead: or from your recent calls (✓ shows numbers that are already leads)',
      '🏷 The app is now called “ITTC Admission” on your phone',
    ],
  },
  {
    key: '2026-11-08-a',
    date: '8 Nov 2026',
    title: 'A new look for the lead page',
    items: [
      '👤 On top: the name (tap the number to copy it), stage, rating, owner, course · source',
      '📞 Five buttons: Call · WhatsApp · SMS · Note · Next call',
      '⏰ The next call in one line (red when late, orange today) with Change',
      '📂 Below, in folds: Timeline (open), Admission (visit, fee, papers, files), Info, Changes',
      '➕ “+ Note” and “+ Log call” at the bottom; scroll down and the name and 📞 stay on top',
    ],
  },
  {
    key: '2026-11-07-b',
    date: '7 Nov 2026',
    title: 'Last note: Add note first',
    items: ['📝 In the last-note sheet (tap the note on a lead card), “Add note” is now the blue button and “Open lead” the white one'],
  },
  {
    key: '2026-11-07-a',
    date: '7 Nov 2026',
    title: 'Fixed: popups under the phone’s buttons',
    items: [
      '🔧 Every popup and sheet (last note, call result, filters, sort, fee, payment, stage, papers, voice note…) now sits above the ◁ ○ □ buttons',
    ],
  },
  {
    key: '2026-11-06-a',
    date: '6 Nov 2026',
    title: 'A new look for More',
    items: [
      '👤 Your profile on top (🔑 changes the password)',
      '⚡ Quick tiles: Alerts, WhatsApp, Team activity (or Templates), Discounts, with how many are waiting',
      '🗂 Every page in neat groups, with what needs you on the right (ON, waiting, problems)',
      '📱 List design, What’s new and the update check together under APP',
    ],
  },
  {
    key: '2026-11-05-a',
    date: '5 Nov 2026',
    title: 'A new look for Leads and Students',
    items: [
      '✨ New lists: a clean top bar, a round search box, and chips that show how many (Mine, 🔥 Hot, 🆕 Not called…)',
      '⏱ Sorted by next call: leads come in Overdue · Today · Tomorrow groups (the “Groups” button turns them off)',
      '🗂 Smaller cards: rating ring, stage, course · source · owner, the latest note or call, the next-call time',
      '✅ Press and hold to mark: “N selected” on top, and Note / Next call / Stage / Give to / Tag / Rating / Fee / Lost below',
      '📋 Pipeline board: the board icon at the top · 📞 hold the Call button for SMS',
      '↩ Like the old look better? More → List design → Classic (or ⋮ on the list)',
    ],
  },
  {
    key: '2026-11-04-a',
    date: '4 Nov 2026',
    title: 'Fixed: tabs under the phone’s buttons',
    items: ['🔧 On phones with ◁ ○ □ buttons, the tabs (and the bottom of other pages) now sit above the buttons'],
  },
  {
    key: '2026-11-03-e',
    date: '3 Nov 2026',
    title: 'Today on Home',
    items: [
      '📊 Today: calls due, call time, new leads, admitted, visits and money taken (admins see the whole team)',
      '↔️ Switching tabs now slides the whole page',
    ],
  },
  {
    key: '2026-11-03-d',
    date: '3 Nov 2026',
    title: 'A tidier Home',
    items: [
      '🧹 Home is smaller: one row of today’s numbers, short lines',
      '📂 Visits, Students and This month open when you tap them (the phone remembers)',
      '📞 Next calls shows 3 first: “Show all” for the rest',
      '✨ A new animation when you switch tabs',
    ],
  },
  {
    key: '2026-11-03-c',
    date: '3 Nov 2026',
    title: 'A new Home',
    items: [
      '🏠 A cleaner Home: today’s calls, overdue, visits and money at a glance',
      '📞 Next calls: tap the green button to call straight away',
      '➕ “Add lead” button at the bottom right, quick actions below',
      '✨ New tab bar with a smooth slide when you switch tabs',
    ],
  },
  {
    key: '2026-11-03-b',
    date: '3 Nov 2026',
    title: 'Weekly scorecard',
    items: [
      '🏁 More → Weekly scorecard: your week (Sat–Fri) next to the week before: leads, calls, admissions, money, first-call time, missed follow-ups',
      '👥 Team Leads see their team, admins everyone; 🥇🥈🥉 for the top three',
      '🔔 Admins get the totals every Sunday morning (Settings → Reports to change)',
    ],
  },
  {
    key: '2026-11-03-a',
    date: '3 Nov 2026',
    title: 'Contact the developer',
    items: [
      '💬 More → Contact developer: send a problem, an idea or a question',
      '🔔 You get a notification when the developer answers; see the answer and the status there',
    ],
  },
  {
    key: '2026-11-02-b',
    date: '2 Nov 2026',
    title: 'Quick payment from the Students list',
    items: [
      '💵 A green cash button on each student card (when something is due): take a payment without opening the student',
      '⚡ Quick amounts ৳1,000 and ৳5,000 in the payment form (everywhere)',
    ],
  },
  {
    key: '2026-11-02-a',
    date: '2 Nov 2026',
    title: 'New look and app versions',
    items: [
      '🔐 A new sign-in screen; it can remember your email',
      "🎓 The app is now “Ideal Teachers' Training College · Admission Tracker”, on Home too",
      '🆕 This window: after each update you see what changed (again any time: More → What’s new)',
      '📱 Admins: More → App versions shows who runs which update, and can ask people to update',
    ],
  },
];
