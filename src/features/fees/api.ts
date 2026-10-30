import type { MyProfile } from '@/features/auth/api';
import type { WhoRule } from '@/features/pipeline/api';
import { getSetting, updateSetting } from '@/features/settings/api';
import { supabase } from '@/shared/lib/supabase';
import type { Json } from '@/shared/types/database';

// =====================================================================
// 💰 Fee negotiation and discounts (before admission)
//   Settings → Fee & discount: on/off, who, each role's discount limit,
//   how long an approved discount stays valid, the reasons.
//   One negotiation per lead + course; locked with the final fee at admission.
// =====================================================================

export type FeeSettings = {
  enabled: boolean;
  who: WhoRule;
  /** role key → % of the course fee they may give (or approve) without asking */
  limits: Record<string, number>;
  /** days an approved discount stays valid; 0 = never runs out */
  valid_days: number;
  reasons: string[];
  reason_required: boolean;
};

export const DEFAULT_FEE_SETTINGS: FeeSettings = {
  enabled: true,
  who: { mode: 'all', roles: [], user_ids: [] },
  limits: { caller: 0, team_lead: 10 },
  valid_days: 7,
  reasons: ['Financial problem', 'Sibling', 'Early bird', 'Referral', 'Merit', 'Other'],
  reason_required: true,
};

export type CourseFeeItem = { id: string; name: string; amount: number; sort_order: number };

export type NegotiationEvent = {
  id: string;
  kind: 'quoted' | 'lead_asked' | 'offer' | 'note';
  amount: number | null;
  note: string | null;
  created_by: string | null;
  created_at: string;
};

export type Discount = {
  id: string;
  fee_id: string | null;
  fee_name: string | null;
  kind: 'amount' | 'percent';
  value: number;
  amount: number;
  reason: string | null;
  note: string | null;
  status: 'pending' | 'approved' | 'rejected' | 'cancelled';
  requested_by: string | null;
  requested_at: string;
  decided_by: string | null;
  decided_at: string | null;
  decision_note: string | null;
  expires_at: string | null;
};

export type Negotiation = {
  id: string;
  lead_id: string;
  course_id: string;
  status: 'open' | 'locked';
  final_total: number | null;
  locked_at: string | null;
  started_by: string | null;
  started_at: string;
  course: { id: string; name: string; course_fees: CourseFeeItem[] } | null;
  negotiation_events: NegotiationEvent[];
  fee_discounts: Discount[];
};

export const EVENT_LABELS: Record<NegotiationEvent['kind'], string> = {
  quoted: 'We told the fee',
  lead_asked: 'Lead asked for',
  offer: 'We offered',
  note: 'Note',
};

export const money = (n: number) => `৳${Math.round(n).toLocaleString('en-IN')}`;

function toError(error: { message: string }): Error {
  const m = error.message.toLowerCase();
  if (m.includes('network request failed') || m.includes('fetch')) {
    return new Error('No internet connection. Please try again.');
  }
  return new Error(error.message);
}

// ---------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------
export async function getFeeSettings(): Promise<FeeSettings> {
  try {
    const saved = await getSetting<Partial<FeeSettings>>('fees');
    return {
      ...DEFAULT_FEE_SETTINGS,
      ...(saved ?? {}),
      who: { ...DEFAULT_FEE_SETTINGS.who, ...(saved?.who ?? {}) },
      limits: { ...DEFAULT_FEE_SETTINGS.limits, ...(saved?.limits ?? {}) },
      reasons: saved?.reasons ?? DEFAULT_FEE_SETTINGS.reasons,
    };
  } catch {
    return DEFAULT_FEE_SETTINGS;
  }
}

export async function saveFeeSettings(s: FeeSettings): Promise<void> {
  await updateSetting('fees', s as unknown as Json);
}

/** May this person use fee negotiation? (same rule as the database's can_use_fees; admins always may) */
export function canUseFees(s: FeeSettings, profile: MyProfile | null, isAdmin: boolean): boolean {
  if (!profile || !s.enabled) return false;
  if (isAdmin) return true;
  if (s.who.mode === 'roles') return s.who.roles.includes(profile.role_key);
  if (s.who.mode === 'users') return s.who.user_ids.includes(profile.id);
  return true;
}

/** My discount limit, % of the course fee (100 = no limit) */
export async function getMyDiscountLimit(): Promise<number> {
  const { data, error } = await supabase.rpc('discount_limit', {});
  if (error) throw toError(error);
  return Number(data ?? 0);
}

// ---------------------------------------------------------------------
// One lead
// ---------------------------------------------------------------------
export async function listNegotiations(leadId: string): Promise<Negotiation[]> {
  const { data, error } = await supabase
    .from('lead_negotiations')
    .select(
      '*, course:courses(id, name, course_fees(id, name, amount, sort_order)), negotiation_events(*), fee_discounts(*)',
    )
    .eq('lead_id', leadId)
    .order('started_at');
  if (error) throw toError(error);
  return ((data ?? []) as unknown as Negotiation[]).map((n) => ({
    ...n,
    course: n.course
      ? { ...n.course, course_fees: [...n.course.course_fees].sort((a, b) => a.sort_order - b.sort_order) }
      : null,
    negotiation_events: [...n.negotiation_events].sort((a, b) => a.created_at.localeCompare(b.created_at)),
    fee_discounts: [...n.fee_discounts].sort((a, b) => a.requested_at.localeCompare(b.requested_at)),
  }));
}

/** An approved discount still counts (not run out) */
export const isActive = (d: Discount, n: Pick<Negotiation, 'status'>) =>
  d.status === 'approved' && (n.status === 'locked' || !d.expires_at || new Date(d.expires_at) > new Date());

/** The full fee, the discounts in force and what's left to pay */
export function totals(n: Negotiation) {
  const list = (n.course?.course_fees ?? []).reduce((t, f) => t + Number(f.amount), 0);
  const discount = n.fee_discounts.filter((d) => isActive(d, n)).reduce((t, d) => t + Number(d.amount), 0);
  const pending = n.fee_discounts.filter((d) => d.status === 'pending').reduce((t, d) => t + Number(d.amount), 0);
  const final = n.status === 'locked' && n.final_total != null ? Number(n.final_total) : Math.max(list - discount, 0);
  return { list, discount, pending, final };
}

export async function startNegotiation(leadId: string, courseId: string): Promise<string> {
  const { data, error } = await supabase.rpc('start_negotiation', { p_lead_id: leadId, p_course_id: courseId });
  if (error) throw toError(error);
  return data as string;
}

export async function addNegotiationEvent(
  negotiationId: string,
  kind: NegotiationEvent['kind'],
  amount: number | null,
  note: string,
): Promise<void> {
  const { error } = await supabase.rpc('add_negotiation_event', {
    p_negotiation_id: negotiationId,
    p_kind: kind,
    p_amount: amount ?? undefined,
    p_note: note.trim() || undefined,
  });
  if (error) throw toError(error);
}

export type DiscountResult = { id: string; status: 'pending' | 'approved'; amount: number; percent: number };

export async function requestDiscount(input: {
  negotiationId: string;
  feeId: string | null;
  kind: 'amount' | 'percent';
  value: number;
  reason: string | null;
  note: string;
}): Promise<DiscountResult> {
  const { data, error } = await supabase.rpc('request_discount', {
    p_negotiation_id: input.negotiationId,
    p_fee_id: input.feeId,
    p_kind: input.kind,
    p_value: input.value,
    p_reason: input.reason ?? undefined,
    p_note: input.note.trim() || undefined,
  });
  if (error) throw toError(error);
  return data as unknown as DiscountResult;
}

export async function decideDiscount(id: string, approve: boolean, note: string): Promise<void> {
  const { error } = await supabase.rpc('decide_discount', {
    p_discount_id: id,
    p_approve: approve,
    p_note: note.trim() || undefined,
  });
  if (error) throw toError(error);
}

export async function cancelDiscount(id: string, note = ''): Promise<void> {
  const { error } = await supabase.rpc('cancel_discount', { p_discount_id: id, p_note: note.trim() || undefined });
  if (error) throw toError(error);
}

// ---------------------------------------------------------------------
// Waiting requests (Discount requests screen)
// ---------------------------------------------------------------------
export type QueueItem = {
  id: string;
  lead_id: string;
  lead_name: string;
  course_name: string;
  fee_name: string;
  kind: 'amount' | 'percent';
  value: number;
  amount: number;
  list_total: number;
  percent_after: number;
  reason: string | null;
  note: string | null;
  requested_by: string | null;
  requester: string | null;
  requested_at: string;
  can_approve: boolean;
};

export async function discountQueue(): Promise<QueueItem[]> {
  const { data, error } = await supabase.rpc('discount_queue');
  if (error) throw toError(error);
  return (data ?? []) as unknown as QueueItem[];
}
