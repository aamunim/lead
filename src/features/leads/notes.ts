import type { ActivityItem } from '@/features/leads/api';

// =====================================================================
// Lead notes, split into separate notes for the "Calls & notes" list
//   leads.notes holds all notes as one text, separated by blank lines.
//   Notes added with the Note option start with a stamp (see add_lead_note):
//     26 Oct 2026 · Rahim: Asked for the fee list
//   Anything else was typed on the edit screen and has no date.
// =====================================================================

export type LeadNote = {
  key: string;
  text: string;
  /** The note exactly as stored in leads.notes (to delete it) */
  raw: string;
  /** Who added it with the Note option (null for notes typed on the edit screen) */
  userId: string | null;
  author: string | null;
  /** When the note was added (ISO); for notes without a date, when the lead was added */
  at: string;
  /** exact = time known · day = only the date · none = typed on the edit screen */
  when: 'exact' | 'day' | 'none';
};

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const STAMP = /^(\d{1,2}) ([A-Z][a-z]{2}) (\d{4}) · ([^:\n]+): ([\s\S]+)$/;

/**
 * @param notes     leads.notes
 * @param createdAt when the lead was added (used for notes without a date)
 * @param activity  the lead's timeline; "note_added" lines give the exact time
 */
export function splitLeadNotes(notes: string | null, createdAt: string, activity: ActivityItem[]): LeadNote[] {
  if (!notes?.trim()) return [];

  // Timeline lines for notes, oldest first, each used once
  const noteLines = activity
    .filter((a) => a.action === 'note_added')
    .map((a) => ({
      at: a.created_at,
      userId: a.user_id,
      note: (a.details as { note?: string } | null)?.note ?? '',
    }))
    .reverse();
  const used = new Set<number>();

  return notes
    .split(/\n\s*\n/)
    .map((block) => block.trim())
    .filter(Boolean)
    .map((block, i): LeadNote => {
      const m = STAMP.exec(block);
      const month = m ? MONTHS.indexOf(m[2]) : -1;
      if (!m || month < 0) {
        return { key: `note-${i}`, text: block, raw: block, userId: null, author: null, at: createdAt, when: 'none' };
      }

      const text = m[5].trim();
      const match = noteLines.findIndex((l, j) => !used.has(j) && l.note === text);
      if (match >= 0) {
        used.add(match);
        return {
          key: `note-${i}`,
          text,
          raw: block,
          userId: noteLines[match].userId,
          author: m[4].trim(),
          at: noteLines[match].at,
          when: 'exact',
        };
      }
      // Only the date is known: put it at the end of that day
      const day = new Date(Number(m[3]), month, Number(m[1]), 23, 59);
      return { key: `note-${i}`, text, raw: block, userId: null, author: m[4].trim(), at: day.toISOString(), when: 'day' };
    });
}
