// =====================================================================
// 🆕 What's new: shown once to everyone after an update brings a new
//   entry (newest first). Add an entry with every update; the key only
//   has to be new (the date is fine).
// =====================================================================

export type WhatsNew = { key: string; date: string; title: string; items: string[] };

export const WHATS_NEW: WhatsNew[] = [
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
