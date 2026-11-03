// =====================================================================
// 🆕 What's new: shown once to everyone after an update brings a new
//   entry (newest first). Add an entry with every update; the key only
//   has to be new (the date is fine).
// =====================================================================

export type WhatsNew = { key: string; date: string; title: string; items: string[] };

export const WHATS_NEW: WhatsNew[] = [
  {
    key: '2026-11-03-build-2-7',
    date: '3 Nov 2026',
    title: 'Caller card · version 2.7',
    items: [
      '📲 When a lead calls, a card shows over the call screen: name, stage, money due, last note, next call',
      '➕ An unknown number calling: “Add as lead” in one tap',
      '⚙️ Turn it on once: More → Call log sync → Caller card → Allow display over other apps (then “Try it”)',
      '🏷 The app is now called “ITTC Admission” on your phone',
    ],
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
