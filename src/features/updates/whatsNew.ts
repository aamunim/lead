// =====================================================================
// 🆕 What's new: shown once to everyone after an update brings a new
//   entry (newest first). Add an entry with every update; the key only
//   has to be new (the date is fine).
// =====================================================================

export type WhatsNew = { key: string; date: string; title: string; items: string[] };

export const WHATS_NEW: WhatsNew[] = [
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
