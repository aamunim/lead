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

export type PaymentMethod = { name: string; /** a transaction ID is needed */ txn: boolean };

export type ReceiptField =
  | 'institute'
  | 'address'
  | 'phone'
  | 'student_id'
  | 'course'
  | 'batch'
  | 'method'
  | 'txn'
  | 'received_by'
  | 'paid_due'
  | 'note';

export const RECEIPT_FIELDS: { key: ReceiptField; label: string }[] = [
  { key: 'institute', label: 'Institute name' },
  { key: 'address', label: 'Address' },
  { key: 'phone', label: 'Office phone' },
  { key: 'student_id', label: 'Student ID' },
  { key: 'course', label: 'Course' },
  { key: 'batch', label: 'Batch' },
  { key: 'method', label: 'Paid by (method)' },
  { key: 'txn', label: 'Transaction ID' },
  { key: 'received_by', label: 'Received by' },
  { key: 'paid_due', label: 'Total paid & due' },
  { key: 'note', label: 'Note' },
];

export type PaymentSettings = {
  enabled: boolean;
  /** who may take payments (admins always) */
  who: WhoRule;
  /** who may void a payment (admins always) */
  void_who: WhoRule;
  methods: PaymentMethod[];
  /** least payment (taka) when admitting; 0 = admit without paying */
  min_on_admit: number;
  /** a payment date may go this many days back (admins: any) */
  backdate_days: number;
  receipt: { fields: Record<ReceiptField, boolean>; footer: string };
  /** Installment reminders (Settings → Fee & discount) */
  reminders: {
    enabled: boolean;
    /** days before the installment date (0 = no early reminder) */
    days_before: number;
    on_day: boolean;
    /** days late → the Team Lead and admins are told (0 = never) */
    late_after: number;
  };
};

export const DEFAULT_PAYMENT_SETTINGS: PaymentSettings = {
  enabled: true,
  who: { mode: 'all', roles: [], user_ids: [] },
  void_who: { mode: 'roles', roles: [], user_ids: [] },
  methods: [
    { name: 'Cash', txn: false },
    { name: 'bKash', txn: true },
    { name: 'Nagad', txn: true },
    { name: 'Rocket', txn: true },
    { name: 'Bank', txn: true },
    { name: 'Card', txn: false },
  ],
  min_on_admit: 0,
  backdate_days: 7,
  reminders: { enabled: true, days_before: 1, on_day: true, late_after: 3 },
  receipt: {
    fields: Object.fromEntries(RECEIPT_FIELDS.map((f) => [f.key, true])) as Record<ReceiptField, boolean>,
    footer: 'Thank you.',
  },
};

export type FeeSettings = {
  enabled: boolean;
  who: WhoRule;
  /** role key → % of the course fee they may give (or approve) without asking */
  limits: Record<string, number>;
  /** days an approved discount stays valid; 0 = never runs out */
  valid_days: number;
  reasons: string[];
  reason_required: boolean;
  payments: PaymentSettings;
};

export const DEFAULT_FEE_SETTINGS: FeeSettings = {
  enabled: true,
  who: { mode: 'all', roles: [], user_ids: [] },
  limits: { caller: 0, team_lead: 10 },
  valid_days: 7,
  reasons: ['Financial problem', 'Sibling', 'Early bird', 'Referral', 'Merit', 'Other'],
  reason_required: true,
  payments: DEFAULT_PAYMENT_SETTINGS,
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

/** The small badge on lead cards (list and board), from leads.fee_status */
export function feeBadge(lead: {
  fee_status?: string | null;
  fee_discount?: number | null;
  fee_paid?: number | null;
  fee_due?: number | null;
  fee_next_due?: string | null;
}): { text: string; tone: 'talk' | 'wait' | 'good' | 'bad' } | null {
  const off = Number(lead.fee_discount ?? 0);
  // Admitted: what is still to pay
  if (lead.fee_status === 'final' && lead.fee_due != null) {
    const due = Number(lead.fee_due);
    if (due <= 0) return Number(lead.fee_paid ?? 0) > 0 ? { text: '✓ Paid', tone: 'good' } : null;
    const late = !!lead.fee_next_due && lead.fee_next_due < new Date().toISOString().slice(0, 10);
    return { text: `${late ? '⚠' : '💵'} Due ${money(due)}`, tone: late ? 'bad' : 'wait' };
  }
  switch (lead.fee_status) {
    case 'negotiating':
      return { text: '💰 Negotiating', tone: 'talk' };
    case 'discount_waiting':
      return { text: '⏳ Discount', tone: 'wait' };
    case 'discount_given':
      return { text: `💰 −${money(off)}`, tone: 'good' };
    case 'final':
      return off > 0 ? { text: `💰 −${money(off)}`, tone: 'good' } : null;
    default:
      return null;
  }
}

/** Waiting discount requests I may answer (Home card, More badge) */
export async function countDiscountsToAnswer(): Promise<number> {
  const { data, error } = await supabase.rpc('discounts_to_answer');
  if (error) return 0;
  return Number(data ?? 0);
}

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
      payments: {
        ...DEFAULT_PAYMENT_SETTINGS,
        ...(saved?.payments ?? {}),
        who: { ...DEFAULT_PAYMENT_SETTINGS.who, ...(saved?.payments?.who ?? {}) },
        void_who: { ...DEFAULT_PAYMENT_SETTINGS.void_who, ...(saved?.payments?.void_who ?? {}) },
        methods: saved?.payments?.methods ?? DEFAULT_PAYMENT_SETTINGS.methods,
        reminders: { ...DEFAULT_PAYMENT_SETTINGS.reminders, ...(saved?.payments?.reminders ?? {}) },
        receipt: {
          fields: { ...DEFAULT_PAYMENT_SETTINGS.receipt.fields, ...(saved?.payments?.receipt?.fields ?? {}) },
          footer: saved?.payments?.receipt?.footer ?? DEFAULT_PAYMENT_SETTINGS.receipt.footer,
        },
      },
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

// =====================================================================
// 💵 Payments, installments and receipts (admitted students only)
// =====================================================================

/** Who passes a "who" rule (admins always) */
function whoAllows(rule: WhoRule, profile: MyProfile | null, isAdmin: boolean): boolean {
  if (!profile) return false;
  if (isAdmin) return true;
  if (rule.mode === 'roles') return rule.roles.includes(profile.role_key);
  if (rule.mode === 'users') return rule.user_ids.includes(profile.id);
  return true;
}

/** May take payments (same rule as the database's can_take_payments) */
export function canTakePayments(s: FeeSettings, profile: MyProfile | null, isAdmin: boolean): boolean {
  return s.enabled && s.payments.enabled && whoAllows(s.payments.who, profile, isAdmin);
}

/** May void a payment (same rule as can_void_payments) */
export function canVoidPayments(s: FeeSettings, profile: MyProfile | null, isAdmin: boolean): boolean {
  return whoAllows(s.payments.void_who, profile, isAdmin);
}

export type Payment = {
  id: string;
  lead_id: string;
  receipt_no: string;
  amount: number;
  method: string;
  txn_id: string | null;
  paid_at: string;
  note: string | null;
  received_by: string | null;
  voided_at: string | null;
  voided_by: string | null;
  void_reason: string | null;
  /** 'refund' = money given back (its own number RFD-…) */
  kind: 'payment' | 'refund';
};

export type Installment = { id: string; seq: number; due_date: string; amount: number };

/** Each installment, with how much of it the payments so far cover (earliest first) */
export type InstallmentState = Installment & { covered: number; state: 'paid' | 'part' | 'due' | 'late' };

export function installmentStates(items: Installment[], paid: number): InstallmentState[] {
  let left = paid;
  const today = new Date().toISOString().slice(0, 10);
  return [...items]
    .sort((a, b) => a.seq - b.seq)
    .map((i) => {
      const covered = Math.min(Number(i.amount), Math.max(left, 0));
      left -= Number(i.amount);
      const state =
        covered >= Number(i.amount) ? 'paid' : covered > 0 ? 'part' : i.due_date < today ? 'late' : 'due';
      return { ...i, covered, state: covered > 0 && covered < Number(i.amount) && i.due_date < today ? 'late' : state };
    });
}

export async function listPayments(leadId: string): Promise<{ payments: Payment[]; installments: Installment[] }> {
  const [p, i] = await Promise.all([
    supabase.from('fee_payments').select('*').eq('lead_id', leadId).order('paid_at', { ascending: false }),
    supabase.from('fee_installments').select('id, seq, due_date, amount').eq('lead_id', leadId).order('seq'),
  ]);
  if (p.error) throw toError(p.error);
  if (i.error) throw toError(i.error);
  return { payments: (p.data ?? []) as unknown as Payment[], installments: (i.data ?? []) as unknown as Installment[] };
}

/** Payments − refunds (void ones left out) */
export const paidTotal = (payments: Payment[]) =>
  payments.filter((p) => !p.voided_at).reduce((t, p) => t + (p.kind === 'refund' ? -1 : 1) * Number(p.amount), 0);

/** Give money back (after a cancelled admission); people who may void payments */
export async function recordRefund(input: {
  leadId: string;
  amount: number;
  method: string;
  reason: string;
  txnId: string;
}): Promise<{ id: string; receipt_no: string }> {
  const { data, error } = await supabase.rpc('record_refund', {
    p_lead_id: input.leadId,
    p_amount: input.amount,
    p_method: input.method,
    p_reason: input.reason.trim(),
    p_txn_id: input.txnId.trim() || undefined,
  });
  if (error) throw toError(error);
  return data as unknown as { id: string; receipt_no: string };
}

export async function recordPayment(input: {
  leadId: string;
  amount: number;
  method: string;
  txnId: string;
  paidAt: Date | null;
  note: string;
}): Promise<{ id: string; receipt_no: string; due: number }> {
  const { data, error } = await supabase.rpc('record_payment', {
    p_lead_id: input.leadId,
    p_amount: input.amount,
    p_method: input.method,
    p_txn_id: input.txnId.trim() || undefined,
    p_paid_at: input.paidAt ? input.paidAt.toISOString() : undefined,
    p_note: input.note.trim() || undefined,
  });
  if (error) throw toError(error);
  return data as unknown as { id: string; receipt_no: string; due: number };
}

export async function voidPayment(id: string, reason: string): Promise<void> {
  const { error } = await supabase.rpc('void_payment', { p_payment_id: id, p_reason: reason.trim() });
  if (error) throw toError(error);
}

export async function setInstallments(leadId: string, items: { due_date: string; amount: number }[]): Promise<void> {
  const { error } = await supabase.rpc('set_installments', { p_lead_id: leadId, p_items: items as unknown as Json });
  if (error) throw toError(error);
}

/** The fee for admitting to a course: the negotiated one, or the course's full fee */
export async function getAdmissionFee(
  leadId: string,
  courseId: string,
): Promise<{ full: number; discount: number; final: number; negotiated: boolean }> {
  const [neg, fees] = await Promise.all([listNegotiations(leadId), supabase.from('course_fees').select('amount').eq('course_id', courseId)]);
  const n = neg.find((x) => x.course_id === courseId);
  if (n) {
    const t = totals(n);
    return { full: t.list, discount: t.discount, final: t.final, negotiated: true };
  }
  const full = ((fees.data ?? []) as { amount: number }[]).reduce((t, f) => t + Number(f.amount), 0);
  return { full, discount: 0, final: full, negotiated: false };
}

// ---------------------------------------------------------------------
// Text receipt (shared on WhatsApp etc.). Kept apart from the screen so a
// PDF receipt can later use the same data.
// ---------------------------------------------------------------------
export type ReceiptData = {
  institute: { name: string; address: string; phone: string };
  student: { name: string; studentId: string | null; course: string | null; batch: string | null };
  payment: Payment;
  receivedByName: string | null;
  finalFee: number;
  paidSoFar: number;
};

export async function loadReceiptData(
  payment: Payment,
  finalFee: number,
  paidSoFar: number,
  receivedByName: string | null,
): Promise<ReceiptData> {
  const [lead, inst, name] = await Promise.all([
    supabase
      .from('leads')
      .select(
        'name, student_ref, course:courses!leads_admitted_course_id_fkey(name), batch:batches!leads_admitted_batch_id_fkey(name)',
      )
      .eq('id', payment.lead_id)
      .maybeSingle(),
    getSetting<{ institute?: { name?: string; address?: string; phone?: string } }>('message_templates').catch(() => null),
    getSetting<string>('institution_name').catch(() => null),
  ]);
  const l = lead.data as unknown as {
    name: string;
    student_ref: string | null;
    course: { name: string } | null;
    batch: { name: string } | null;
  } | null;
  return {
    institute: {
      name: inst?.institute?.name || name || '',
      address: inst?.institute?.address ?? '',
      phone: inst?.institute?.phone ?? '',
    },
    student: {
      name: l?.name ?? '',
      studentId: l?.student_ref ?? null,
      course: l?.course?.name ?? null,
      batch: l?.batch?.name ?? null,
    },
    payment,
    receivedByName,
    finalFee,
    paidSoFar,
  };
}

export function receiptText(d: ReceiptData, s: PaymentSettings): string {
  const f = s.receipt.fields;
  const p = d.payment;
  const when = new Date(p.paid_at).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });
  const lines: (string | null | false)[] = [
    f.institute && d.institute.name ? `*${d.institute.name}*` : null,
    f.address && d.institute.address,
    f.phone && d.institute.phone ? `📞 ${d.institute.phone}` : null,
    '',
    p.voided_at ? '✕ *VOID* — this receipt is cancelled' : null,
    p.kind === 'refund' ? `↩ *Refund* ${p.receipt_no}` : `🧾 *Money receipt* ${p.receipt_no}`,
    `Date: ${when}`,
    '',
    `Student: ${d.student.name}`,
    f.student_id && d.student.studentId ? `Student ID: ${d.student.studentId}` : null,
    f.course && d.student.course ? `Course: ${d.student.course}` : null,
    f.batch && d.student.batch ? `Batch: ${d.student.batch}` : null,
    '',
    `*Amount: ${money(Number(p.amount))}*`,
    f.method ? `${p.kind === 'refund' ? 'Returned by' : 'Paid by'}: ${p.method}` : null,
    f.txn && p.txn_id ? `Transaction ID: ${p.txn_id}` : null,
    p.kind === 'refund' && p.note ? `Reason: ${p.note}` : f.note && p.note ? `Note: ${p.note}` : null,
    f.paid_due ? '' : null,
    f.paid_due ? `Total fee: ${money(d.finalFee)}` : null,
    f.paid_due ? `Paid so far: ${money(d.paidSoFar)}` : null,
    f.paid_due ? `Due: ${money(Math.max(d.finalFee - d.paidSoFar, 0))}` : null,
    f.received_by && d.receivedByName ? `\nReceived by: ${d.receivedByName}` : null,
    s.receipt.footer ? `\n${s.receipt.footer}` : null,
  ];
  return lines
    .filter((x) => x !== null && x !== false)
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}
