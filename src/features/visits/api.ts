import { getSetting, updateSetting } from '@/features/settings/api';
import { supabase } from '@/shared/lib/supabase';
import type { Json, Tables } from '@/shared/types/database';

// =====================================================================
// 🏫 Campus visits (separate from the pipeline)
//   planned → visited / missed (or cancelled). One planned visit at a time.
// =====================================================================

export type VisitStatus = 'planned' | 'visited' | 'missed' | 'cancelled';

export type Visit = Omit<Tables<'lead_visits'>, 'status'> & {
  status: VisitStatus;
  creator: { id: string; full_name: string | null } | null;
  updater: { id: string; full_name: string | null } | null;
};

/** The lead's visit state as kept on the lead (list badge, filter) */
export type LeadVisitState = 'planned' | 'visited' | 'missed' | null;

export type CampusVisitSettings = {
  enabled: boolean;
  /** New / Contacted leads move to Interested when they visit */
  visited_moves_to_interested: boolean;
  /** "Didn't come" sets a next call this many days later (null = no call) */
  missed_follow_up_days: number | null;
};

export const DEFAULT_CAMPUS_VISIT: CampusVisitSettings = {
  enabled: true,
  visited_moves_to_interested: true,
  missed_follow_up_days: 1,
};

function toError(error: { message: string }): Error {
  const m = error.message.toLowerCase();
  if (m.includes('network request failed') || m.includes('fetch')) {
    return new Error('No internet connection. Please try again.');
  }
  return new Error(error.message);
}

// =====================================================================
// Settings
// =====================================================================
export async function getCampusVisitSettings(): Promise<CampusVisitSettings> {
  try {
    const saved = await getSetting<Partial<CampusVisitSettings>>('campus_visit');
    return { ...DEFAULT_CAMPUS_VISIT, ...(saved ?? {}) };
  } catch {
    return DEFAULT_CAMPUS_VISIT;
  }
}

export async function saveCampusVisitSettings(settings: CampusVisitSettings): Promise<void> {
  await updateSetting('campus_visit', settings as unknown as Json);
}

// =====================================================================
// Read
// =====================================================================
const VISIT_SELECT = `
  *,
  creator:created_by(id, full_name),
  updater:updated_by(id, full_name)
`;

/** All visits of a lead, newest first */
export async function listLeadVisits(leadId: string): Promise<Visit[]> {
  const { data, error } = await supabase
    .from('lead_visits')
    .select(VISIT_SELECT)
    .eq('lead_id', leadId)
    .order('created_at', { ascending: false });
  if (error) throw toError(error);
  return (data ?? []) as unknown as Visit[];
}

export type TodayVisit = {
  id: string;
  plannedAt: string;
  lead: { id: string; name: string; phone: string | null; whatsapp_number: string | null; whatsapp_username: string | null };
};

/** Planned visits from the start of today until the end of today (overdue ones too) */
export async function listTodayVisits(): Promise<TodayVisit[]> {
  const end = new Date();
  end.setHours(23, 59, 59, 999);
  const { data, error } = await supabase
    .from('lead_visits')
    .select('id, planned_at, lead:leads!inner(id, name, phone, whatsapp_number, whatsapp_username, deleted_at)')
    .eq('status', 'planned')
    .lte('planned_at', end.toISOString())
    .is('lead.deleted_at', null)
    .order('planned_at');
  if (error) throw toError(error);
  return ((data ?? []) as unknown as { id: string; planned_at: string; lead: TodayVisit['lead'] }[]).map((v) => ({
    id: v.id,
    plannedAt: v.planned_at,
    lead: v.lead,
  }));
}

// =====================================================================
// Write (all checks are done by the database)
// =====================================================================
/** Plan a visit, or move the planned one */
export async function planVisit(leadId: string, at: Date, note?: string): Promise<void> {
  const { error } = await supabase.rpc('plan_visit', {
    p_lead_id: leadId,
    p_at: at.toISOString(),
    p_note: note?.trim() || undefined,
  });
  if (error) throw toError(error);
}

export type FinishResult = { movedTo: string | null; followUpAt: Date | null };

/** The student came (visited, also walk-ins) or didn't come (missed) */
export async function finishVisit(
  leadId: string,
  status: 'visited' | 'missed',
  note?: string,
  visitedAt?: Date,
): Promise<FinishResult> {
  const { data, error } = await supabase.rpc('finish_visit', {
    p_lead_id: leadId,
    p_status: status,
    p_note: note?.trim() || undefined,
    p_visited_at: visitedAt ? visitedAt.toISOString() : undefined,
  });
  if (error) throw toError(error);
  const r = (data ?? {}) as { moved_to?: string | null; follow_up_at?: string | null };
  return { movedTo: r.moved_to ?? null, followUpAt: r.follow_up_at ? new Date(r.follow_up_at) : null };
}

export async function cancelVisit(leadId: string): Promise<void> {
  const { error } = await supabase.rpc('cancel_visit', { p_lead_id: leadId });
  if (error) throw toError(error);
}

// =====================================================================
// Text
// =====================================================================
export function formatVisitTime(iso: string): string {
  const d = new Date(iso);
  return `${d.toLocaleDateString([], { day: 'numeric', month: 'short' })}, ${d.toLocaleTimeString([], {
    hour: 'numeric',
    minute: '2-digit',
  })}`;
}

const sameDay = (a: Date, b: Date) =>
  a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();

/** Short badge for the leads list, e.g. "🏫 Today 11:00 AM", "🏫 Visited" */
export function visitBadge(state: LeadVisitState | string | null, at: string | null): string | null {
  if (state === 'visited') return '🏫 Visited';
  if (state === 'missed') return "🏫 Didn't come";
  if (state !== 'planned') return null;
  if (!at) return '🏫 Visit planned';

  const d = new Date(at);
  const now = new Date();
  const time = d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  if (sameDay(d, now)) return `🏫 Today ${time}`;
  if (d < now) return '🏫 Visit overdue';
  const tomorrow = new Date(now);
  tomorrow.setDate(now.getDate() + 1);
  if (sameDay(d, tomorrow)) return `🏫 Tomorrow ${time}`;
  return `🏫 ${d.toLocaleDateString([], { day: 'numeric', month: 'short' })}`;
}
