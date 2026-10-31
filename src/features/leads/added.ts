import { supabase } from '@/shared/lib/supabase';

// =====================================================================
// ➕ Who added which leads, and when (Leads tab chips, Team activity,
//   Reports, Home)
//   Admins see everyone; Team Leads their team and themselves; everyone
//   else only themselves. The database checks this again (can_see_added).
// =====================================================================

export type AddedDay = 'today' | 'yesterday' | 'week' | 'month' | 'custom';

export const ADDED_DAYS: { value: Exclude<AddedDay, 'custom'>; label: string }[] = [
  { value: 'today', label: 'Today' },
  { value: 'yesterday', label: 'Yesterday' },
  { value: 'week', label: 'This week' },
  { value: 'month', label: 'This month' },
];

/** The Leads tab's choice: a person (null = everyone I may see) and a period */
export type AddedChoice = {
  userId: string | null;
  day: AddedDay | null;
  /** Custom period, YYYY-MM-DD */
  from?: string;
  to?: string;
};

export const NO_ADDED: AddedChoice = { userId: null, day: null };

/** For the lead query: who added them (null = anyone) and when (ISO, end not included) */
export type AddedQuery = { by: string[] | null; from: string | null; to: string | null };

export type LeadCreator = { id: string; name: string | null; is_active: boolean };

export type LeadsAddedRow = { user_id: string; name: string | null; total: number; imported: number };

export function dayText(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function parseDay(s: string): Date {
  const [y, m, d] = s.split('-').map(Number);
  return new Date(y, m - 1, d);
}

/** First and last day (YYYY-MM-DD) of a period; the week starts on Saturday */
export function addedRange(choice: AddedChoice, now = new Date()): { from: string; to: string } | null {
  switch (choice.day) {
    case 'today':
      return { from: dayText(now), to: dayText(now) };
    case 'yesterday': {
      const y = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1);
      return { from: dayText(y), to: dayText(y) };
    }
    case 'week': {
      const start = new Date(now.getFullYear(), now.getMonth(), now.getDate() - ((now.getDay() + 1) % 7));
      return { from: dayText(start), to: dayText(now) };
    }
    case 'month':
      return { from: dayText(new Date(now.getFullYear(), now.getMonth(), 1)), to: dayText(now) };
    case 'custom':
      return choice.from && choice.to ? { from: choice.from, to: choice.to } : null;
    default:
      return null;
  }
}

/**
 * The lead query for a choice, or null when nothing is chosen.
 *   everyone = may see everyone's (admins): no "added by" limit
 *   mine     = the people this user may pick (Team Lead: team; caller: self)
 */
export function addedQuery(choice: AddedChoice, everyone: boolean, mine: string[]): AddedQuery | null {
  if (!choice.userId && !choice.day) return null;
  const range = addedRange(choice);
  const end = range ? parseDay(range.to) : null;
  if (end) end.setDate(end.getDate() + 1);
  return {
    by: choice.userId ? [choice.userId] : everyone ? null : mine,
    from: range ? parseDay(range.from).toISOString() : null,
    to: end ? end.toISOString() : null,
  };
}

/** Short text for a custom period: "3 Oct – 9 Oct" */
export function rangeText(from: string, to: string): string {
  const f = (s: string) => parseDay(s).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' });
  return from === to ? f(from) : `${f(from)} – ${f(to)}`;
}

/** The people in the "👤 User" picker (myself first) */
export async function listLeadCreators(): Promise<LeadCreator[]> {
  const { data, error } = await supabase.rpc('lead_creators');
  if (error) throw new Error(error.message);
  return (data ?? []) as LeadCreator[];
}

/** Leads added per person, in a period (YYYY-MM-DD, both days counted) */
export async function getLeadsAdded(from: string, to: string): Promise<LeadsAddedRow[]> {
  const { data, error } = await supabase.rpc('leads_added', { p_from: from, p_to: to });
  if (error) throw new Error(error.message);
  return (data ?? []) as LeadsAddedRow[];
}
