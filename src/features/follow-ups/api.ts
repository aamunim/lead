import { supabase } from '@/shared/lib/supabase';
import type { Tables } from '@/shared/types/database';

// =====================================================================
// Types
// =====================================================================
export type FollowUp = Tables<'follow_ups'>;

export type DueFollowUp = FollowUp & {
  lead: {
    id: string;
    name: string;
    phone: string;
    rating: string | null;
    assigned_to: string | null;
    closed_at: string | null;
    stage: { name: string; color: string; kind: string } | null;
  } | null;
};

/** A "♻️ Revive" call: try a lost lead again */
export const isReviveFollowUp = (f: Pick<FollowUp, 'purpose'>) => f.purpose === 'revive';

// =====================================================================
// Errors
// =====================================================================
function toError(error: { message: string }): Error {
  const m = error.message.toLowerCase();
  if (m.includes('network request failed') || m.includes('fetch')) {
    return new Error('No internet connection. Please try again.');
  }
  if (m.includes('follow_ups_one_pending_per_lead')) {
    return new Error('This lead already has a follow-up. Please try again.');
  }
  return new Error(error.message);
}

// =====================================================================
// Set / cancel
// =====================================================================
/** Set the next follow-up. Any older pending one becomes "rescheduled". */
export async function scheduleFollowUp(leadId: string, dueAt: Date, note?: string | null): Promise<string> {
  const { data, error } = await supabase.rpc('schedule_follow_up', {
    p_lead_id: leadId,
    p_due_at: dueAt.toISOString(),
    ...(note?.trim() ? { p_note: note.trim() } : {}),
  });
  if (error) throw toError(error);
  return data as string;
}

/** Remove the pending follow-up ("no need to call again"). */
export async function cancelFollowUp(leadId: string): Promise<void> {
  const { error } = await supabase.rpc('cancel_follow_up', { p_lead_id: leadId });
  if (error) throw toError(error);
}

// =====================================================================
// Read
// =====================================================================
/** The pending follow-up of one lead, if any. */
export async function getPendingFollowUp(leadId: string): Promise<FollowUp | null> {
  const { data, error } = await supabase
    .from('follow_ups')
    .select('*')
    .eq('lead_id', leadId)
    .eq('status', 'pending')
    .maybeSingle();
  if (error) throw toError(error);
  return data;
}

/**
 * Follow-ups due until the end of today (overdue ones included).
 *   userId:    only leads assigned to that person (assignment on)
 *   createdBy: only follow-ups that person set (assignment off)
 *   neither:   everything the user can see
 *
 * Closed leads (Admitted / Lost / Cancelled) are left out,
 * except "♻️ Revive" calls for lost leads.
 */
export async function listDueFollowUps(
  options: { userId?: string; createdBy?: string } = {},
): Promise<DueFollowUp[]> {
  let query = supabase
    .from('follow_ups')
    .select(
      `*,
       lead:lead_id!inner(id, name, phone, rating, assigned_to, deleted_at, closed_at,
         stage:pipeline_stages(name, color, kind))`,
    )
    .eq('status', 'pending')
    .lte('due_at', endOfDay(new Date()).toISOString())
    .is('lead.deleted_at', null)
    .order('due_at', { ascending: true })
    .limit(200);

  if (options.userId) query = query.eq('lead.assigned_to', options.userId);
  if (options.createdBy) query = query.eq('created_by', options.createdBy);

  const { data, error } = await query;
  if (error) throw toError(error);

  const rows = (data ?? []) as unknown as DueFollowUp[];
  return rows.filter((f) => !f.lead?.closed_at || isReviveFollowUp(f));
}

// =====================================================================
// Date helpers
// =====================================================================
export function startOfDay(d: Date): Date {
  const x = new Date(d);
  x.setHours(0, 0, 0, 0);
  return x;
}

export function endOfDay(d: Date): Date {
  const x = new Date(d);
  x.setHours(23, 59, 59, 999);
  return x;
}

function atTime(d: Date, hour: number, minute = 0): Date {
  const x = new Date(d);
  x.setHours(hour, minute, 0, 0);
  return x;
}

function addDays(d: Date, days: number): Date {
  const x = new Date(d);
  x.setDate(x.getDate() + days);
  return x;
}

/**
 * Move a date forward until it is not a holiday.
 * isHoliday is optional; without it the date is returned as it is.
 */
export function skipHolidays(d: Date, isHoliday?: (day: Date) => boolean): Date {
  if (!isHoliday) return d;
  let x = new Date(d);
  for (let i = 0; i < 30 && isHoliday(x); i++) x = addDays(x, 1);
  return x;
}

export type FollowUpPreset = { key: string; label: string; date: Date };

/** Quick choices shown in the call popup. */
export function followUpPresets(now = new Date(), isHoliday?: (day: Date) => boolean): FollowUpPreset[] {
  const presets: FollowUpPreset[] = [];

  // Same day only if there is still working time left
  const inTwoHours = new Date(now.getTime() + 2 * 60 * 60 * 1000);
  if (inTwoHours.getHours() < 20 && inTwoHours.getDate() === now.getDate()) {
    presets.push({ key: '2h', label: 'In 2 hours', date: inTwoHours });
  }

  presets.push(
    { key: 'tomorrow', label: 'Tomorrow', date: skipHolidays(atTime(addDays(now, 1), 10), isHoliday) },
    { key: '3d', label: 'In 3 days', date: skipHolidays(atTime(addDays(now, 3), 10), isHoliday) },
    { key: '1w', label: 'Next week', date: skipHolidays(atTime(addDays(now, 7), 10), isHoliday) },
  );

  return presets;
}

/** "Today, 5:00 PM" · "Tomorrow, 10:00 AM" · "Sat 25 Oct, 10:00 AM" */
export function formatDue(iso: string | Date, now = new Date()): string {
  const d = typeof iso === 'string' ? new Date(iso) : iso;
  const time = d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  const today = startOfDay(now).getTime();
  const day = startOfDay(d).getTime();
  const diff = Math.round((day - today) / 86_400_000);

  if (diff === 0) return `Today, ${time}`;
  if (diff === 1) return `Tomorrow, ${time}`;
  if (diff === -1) return `Yesterday, ${time}`;
  return `${d.toLocaleDateString([], { weekday: 'short', day: 'numeric', month: 'short' })}, ${time}`;
}

/** true if the time has already passed */
export function isOverdue(iso: string, now = new Date()): boolean {
  return new Date(iso).getTime() < now.getTime();
}