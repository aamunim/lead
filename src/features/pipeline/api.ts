import { getSetting, updateSetting } from '@/features/settings/api';
import { supabase } from '@/shared/lib/supabase';
import { colors } from '@/shared/theme';
import type { Json } from '@/shared/types/database';

// =====================================================================
// Pipeline: stages, Admitted / Lost / Cancelled, Reopen
//   All closing and reopening goes through database functions,
//   which check the rules (who may, seats, reasons…).
// =====================================================================

export type StageKind = 'open' | 'won' | 'lost' | 'cancelled';

export type PipelineStage = {
  id: string;
  key: string;
  name: string;
  color: string;
  kind: StageKind;
  sortOrder: number;
  isActive: boolean;
  /** Next call N days after moving here (null = none) */
  followUpDays: number | null;
  /** A note is needed to move here */
  noteRequired: boolean;
  /** Ask for a date & time when moving here (e.g. Campus visit) */
  askDate: boolean;
  /** What the date is called, e.g. "Visit date & time" */
  dateLabel: string | null;
};

export const KIND_INFO: Record<StageKind, { label: string; icon: string; color: string }> = {
  open: { label: 'Open', icon: '●', color: colors.primary },
  won: { label: 'Admitted', icon: '🎓', color: colors.success },
  lost: { label: 'Lost', icon: '✕', color: colors.danger },
  cancelled: { label: 'Admission cancelled', icon: '↩', color: colors.textMuted },
};

export const isClosedKind = (kind: string | null | undefined) => !!kind && kind !== 'open';

/** Colours offered for stages */
export const STAGE_COLORS = [
  '#3557D4',
  '#0EA5E9',
  '#14B8A6',
  '#10B981',
  '#84CC16',
  '#F59E0B',
  '#F97316',
  '#EF4444',
  '#EC4899',
  '#8B5CF6',
  '#64748B',
];

// =====================================================================
// Admission settings (Settings → Admission)
// =====================================================================
export type WhoRule = {
  mode: 'all' | 'roles' | 'users';
  roles: string[];
  user_ids: string[];
};

export type StudentIdMode = 'auto' | 'manual' | 'off';

/**
 * Required papers still missing when admitting:
 *   block = can't admit until they are ticked
 *   warn  = show what is missing, admit after a confirm
 *   allow = no check
 */
export type PapersOnAdmitRule = 'block' | 'warn' | 'allow';

export type AdmissionSettings = {
  mark: WhoRule;
  cancel: WhoRule;
  batch_required: boolean;
  allow_overbooking: boolean;
  student_id: { mode: StudentIdMode; pattern: string };
  closed_in_list: 'hide' | 'show';
  papers_on_admit: PapersOnAdmitRule;
};

export const DEFAULT_ADMISSION: AdmissionSettings = {
  mark: { mode: 'all', roles: ['super_admin', 'admin', 'team_lead', 'caller'], user_ids: [] },
  cancel: { mode: 'roles', roles: ['super_admin', 'admin'], user_ids: [] },
  batch_required: false,
  allow_overbooking: false,
  student_id: { mode: 'auto', pattern: '{YY}{000}' },
  closed_in_list: 'hide',
  papers_on_admit: 'warn',
};

const PAPER_RULES: PapersOnAdmitRule[] = ['block', 'warn', 'allow'];

export async function getAdmissionSettings(): Promise<AdmissionSettings> {
  try {
    const saved = await getSetting<Partial<AdmissionSettings>>('admission');
    const papers = saved?.papers_on_admit;
    return {
      ...DEFAULT_ADMISSION,
      ...(saved ?? {}),
      mark: { ...DEFAULT_ADMISSION.mark, ...(saved?.mark ?? {}) },
      cancel: { ...DEFAULT_ADMISSION.cancel, ...(saved?.cancel ?? {}) },
      student_id: { ...DEFAULT_ADMISSION.student_id, ...(saved?.student_id ?? {}) },
      // Older saved settings don't have it, or may hold a wrong value
      papers_on_admit: papers && PAPER_RULES.includes(papers) ? papers : DEFAULT_ADMISSION.papers_on_admit,
    };
  } catch {
    return DEFAULT_ADMISSION;
  }
}

export async function saveAdmissionSettings(settings: AdmissionSettings): Promise<void> {
  await updateSetting('admission', settings as unknown as Json);
}

/**
 * What a student ID pattern looks like, for the settings screen.
 *   {YY}{000}, number 42 → 26042 · ADM-{YYYY}-{0000} → ADM-2026-0042
 */
export function formatStudentRef(pattern: string, n: number, now = new Date()): string {
  const year = String(now.getFullYear());
  let out = (pattern.trim() || DEFAULT_ADMISSION.student_id.pattern)
    .replace(/\{YYYY\}/g, year)
    .replace(/\{YY\}/g, year.slice(2));
  const zeros = out.match(/\{(0+)\}/);
  if (!zeros) return out + String(n);
  out = out.replace(/\{0+\}/, String(n).padStart(zeros[1].length, '0'));
  return out;
}

// =====================================================================
// Errors
// =====================================================================
function toError(error: { message: string }): Error {
  const m = error.message.toLowerCase();
  if (m.includes('network request failed') || m.includes('fetch')) {
    return new Error('No internet connection. Please try again.');
  }
  if (m.includes('leads_student_ref_unique')) {
    return new Error('That student ID is already used.');
  }
  if (m.includes('pipeline_stages') && m.includes('duplicate key')) {
    return new Error('A stage with this name already exists.');
  }
  return new Error(error.message);
}

// =====================================================================
// Who may do what (signed-in user)
// =====================================================================
export async function canMarkAdmitted(): Promise<boolean> {
  const { data, error } = await supabase.rpc('can_mark_admitted');
  return !error && !!data;
}

export async function canCancelAdmission(): Promise<boolean> {
  const { data, error } = await supabase.rpc('can_cancel_admission');
  return !error && !!data;
}

// =====================================================================
// Stages
// =====================================================================
const STAGE_COLUMNS =
  'id, key, name, color, kind, sort_order, is_active, follow_up_days, note_required, ask_date, date_label';

type RawStage = {
  id: string;
  key: string;
  name: string;
  color: string;
  kind: string;
  sort_order: number;
  is_active: boolean;
  follow_up_days: number | null;
  note_required: boolean | null;
  ask_date: boolean | null;
  date_label: string | null;
};

const toStage = (s: RawStage): PipelineStage => ({
  id: s.id,
  key: s.key,
  name: s.name,
  color: s.color,
  kind: (s.kind as StageKind) ?? 'open',
  sortOrder: s.sort_order,
  isActive: s.is_active,
  followUpDays: s.follow_up_days ?? null,
  noteRequired: !!s.note_required,
  askDate: !!s.ask_date,
  dateLabel: s.date_label ?? null,
});

/** Stages in pipeline order (open first, then Admitted / Lost / Cancelled) */
export async function listPipelineStages(includeInactive = false): Promise<PipelineStage[]> {
  let query = supabase.from('pipeline_stages').select(STAGE_COLUMNS).order('sort_order');
  if (!includeInactive) query = query.eq('is_active', true);

  const { data, error } = await query;
  if (error) throw toError(error);
  return ((data ?? []) as unknown as RawStage[]).map(toStage);
}

export const openStages = (stages: PipelineStage[]) => stages.filter((s) => s.kind === 'open');

/** What can be set on a stage (Settings → Pipeline stages) */
export type StageInput = {
  name: string;
  color: string;
  followUpDays: number | null;
  noteRequired: boolean;
  askDate: boolean;
  dateLabel: string | null;
};

const stageColumns = (s: Partial<StageInput>) => {
  const out: Record<string, unknown> = {};
  if (s.name !== undefined) out.name = s.name.trim();
  if (s.color !== undefined) out.color = s.color;
  if (s.followUpDays !== undefined) out.follow_up_days = s.followUpDays;
  if (s.noteRequired !== undefined) out.note_required = s.noteRequired;
  if (s.askDate !== undefined) out.ask_date = s.askDate;
  if (s.dateLabel !== undefined) out.date_label = s.dateLabel?.trim() || null;
  return out;
};

/** New open stage (the key and position are set by the database) */
export async function createStage(input: StageInput): Promise<PipelineStage> {
  const { data, error } = await supabase
    .from('pipeline_stages')
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    .insert({ ...stageColumns(input), kind: 'open', is_active: true } as any)
    .select(STAGE_COLUMNS)
    .single();
  if (error) throw toError(error);
  return toStage(data as unknown as RawStage);
}

/** Change a stage (final stages: only name and colour are allowed by the database) */
export async function updateStage(id: string, patch: Partial<StageInput> & { isActive?: boolean }): Promise<void> {
  const columns = stageColumns(patch);
  if (patch.isActive !== undefined) columns.is_active = patch.isActive;
  const { error } = await supabase.from('pipeline_stages').update(columns).eq('id', id);
  if (error) throw toError(error);
}

/** Remove an open stage (only when no lead is in it) */
export async function deleteStage(id: string): Promise<void> {
  const { error } = await supabase.from('pipeline_stages').delete().eq('id', id);
  if (error) throw toError(error);
}

/** Save the order of the open stages (final stages always stay last) */
export async function reorderOpenStages(openIds: string[]): Promise<void> {
  const { error } = await supabase.rpc('reorder_pipeline_stages', { p_open_ids: openIds });
  if (error) throw toError(error);
}

/** stage id → how many leads are in it */
export async function stageLeadCounts(): Promise<Map<string, number>> {
  const { data, error } = await supabase.rpc('stage_lead_counts');
  if (error) throw toError(error);
  return new Map(((data ?? []) as { stage_id: string; leads: number }[]).map((r) => [r.stage_id, r.leads]));
}

/** Kept for older screens: next call after N days, note required */
export async function saveStageRule(
  stageId: string,
  rule: { followUpDays: number | null; noteRequired: boolean },
): Promise<void> {
  await updateStage(stageId, rule);
}

/**
 * Move a lead to another open stage (lead page).
 * The database checks "note required" and "ask for a date", and sets the next call:
 *   dueAt given → a reminder at that time (e.g. the campus visit)
 *   else the stage's "next call after N days", if any
 */
export async function moveLeadStage(
  leadId: string,
  stageId: string,
  note?: string | null,
  dueAt?: Date | null,
): Promise<{ followUpAt: Date | null }> {
  const { data, error } = await supabase.rpc('move_lead_stage', {
    p_lead_id: leadId,
    p_stage_id: stageId,
    p_note: note?.trim() || null,
    p_due_at: dueAt ? dueAt.toISOString() : null,
  });
  if (error) throw toError(error);
  const r = (data ?? {}) as { follow_up_at?: string | null };
  return { followUpAt: r.follow_up_at ? new Date(r.follow_up_at) : null };
}

/**
 * Move one or many leads to an open stage, with all the stage rules.
 * Leads that can't be moved are skipped; when none could be, it throws the reason.
 */
export async function bulkMoveLeadStage(
  leadIds: string[],
  stageId: string,
  note?: string | null,
  dueAt?: Date | null,
): Promise<{ done: number; skipped: number }> {
  const { data, error } = await supabase.rpc('bulk_move_lead_stage', {
    p_lead_ids: leadIds,
    p_stage_id: stageId,
    p_note: note?.trim() || undefined,
    p_due_at: dueAt ? dueAt.toISOString() : undefined,
  });
  if (error) throw toError(error);
  const r = (data ?? {}) as { done?: number; skipped?: number };
  return { done: r.done ?? 0, skipped: r.skipped ?? 0 };
}

// =====================================================================
// Lists used by the sheets
// =====================================================================
export type Named = { id: string; name: string };

export async function listActiveCourses(): Promise<Named[]> {
  const { data, error } = await supabase
    .from('courses')
    .select('id, name')
    .eq('is_active', true)
    .order('sort_order')
    .order('name');
  if (error) throw toError(error);
  return (data ?? []) as Named[];
}

export async function listLostReasons(): Promise<Named[]> {
  const { data, error } = await supabase
    .from('lost_reasons')
    .select('id, name')
    .eq('is_active', true)
    .order('sort_order')
    .order('name');
  if (error) throw toError(error);
  return (data ?? []) as Named[];
}

export type AdmissionBatch = {
  id: string;
  name: string;
  startDate: string | null;
  classTime: string | null;
  status: string;
  seatCapacity: number | null;
  seatsTaken: number;
  seatsLeft: number | null;
  isFull: boolean;
};

/** Batches of a course with seats taken / left */
export async function listAdmissionBatches(courseId: string): Promise<AdmissionBatch[]> {
  const { data, error } = await supabase.rpc('admission_batches', { p_course_id: courseId });
  if (error) throw toError(error);

  type Raw = {
    id: string;
    name: string;
    start_date: string | null;
    class_time: string | null;
    status: string;
    seat_capacity: number | null;
    seats_taken: number | null;
    seats_left: number | null;
    is_full: boolean | null;
  };

  return ((data ?? []) as unknown as Raw[]).map((b) => ({
    id: b.id,
    name: b.name,
    startDate: b.start_date,
    classTime: b.class_time,
    status: b.status,
    seatCapacity: b.seat_capacity,
    seatsTaken: b.seats_taken ?? 0,
    seatsLeft: b.seats_left,
    isFull: !!b.is_full,
  }));
}

/** "Spring-27 · 12 of 40 left" / "Spring-27 · Full" / "Spring-27" */
export function batchLabel(b: AdmissionBatch): string {
  if (b.seatCapacity == null) return b.name;
  if (b.isFull) return `${b.name} · Full (${b.seatsTaken}/${b.seatCapacity})`;
  return `${b.name} · ${b.seatsLeft} of ${b.seatCapacity} left`;
}

/** What the next automatic student ID will be (not used up) */
export async function previewStudentRef(): Promise<string | null> {
  const { data, error } = await supabase.rpc('preview_student_ref');
  if (error) return null;
  return (data as string | null) ?? null;
}

// =====================================================================
// Actions
// =====================================================================
export type AdmitInput = {
  leadId: string;
  courseId: string;
  batchId?: string | null;
  admittedAt?: Date | null;
  studentRef?: string | null;
  note?: string | null;
};

export type AdmitResult = { studentRef: string | null; seatsLeft: number | null };

export async function markAdmitted(input: AdmitInput): Promise<AdmitResult> {
  const { data, error } = await supabase.rpc('mark_admitted', {
    p_lead_id: input.leadId,
    p_course_id: input.courseId,
    p_batch_id: input.batchId ?? null,
    p_admitted_at: input.admittedAt ? input.admittedAt.toISOString() : null,
    p_student_ref: input.studentRef?.trim() || null,
    p_note: input.note?.trim() || null,
  });
  if (error) throw toError(error);

  const r = (data ?? {}) as { student_ref?: string | null; seats_left?: number | null };
  return { studentRef: r.student_ref ?? null, seatsLeft: r.seats_left ?? null };
}

export type LostInput = {
  leadId: string;
  reasonId: string;
  note?: string | null;
  /** "Try again later": a ♻️ Revive call on that day */
  reviveAt?: Date | null;
};

export async function markLost(input: LostInput): Promise<void> {
  const { error } = await supabase.rpc('mark_lost', {
    p_lead_id: input.leadId,
    p_reason_id: input.reasonId,
    p_note: input.note?.trim() || null,
    p_revive_at: input.reviveAt ? input.reviveAt.toISOString() : null,
  });
  if (error) throw toError(error);
}

export async function bulkMarkLost(
  leadIds: string[],
  reasonId: string,
  note?: string | null,
): Promise<{ done: number; skipped: number }> {
  const { data, error } = await supabase.rpc('bulk_mark_lost', {
    p_lead_ids: leadIds,
    p_reason_id: reasonId,
    p_note: note?.trim() || null,
  });
  if (error) throw toError(error);
  const r = (data ?? {}) as { done?: number; skipped?: number };
  return { done: r.done ?? 0, skipped: r.skipped ?? 0 };
}

export async function reopenLead(leadId: string, stageId?: string | null, note?: string | null): Promise<void> {
  const { error } = await supabase.rpc('reopen_lead', {
    p_lead_id: leadId,
    p_stage_id: stageId ?? null,
    p_note: note?.trim() || null,
  });
  if (error) throw toError(error);
}

export async function cancelAdmission(leadId: string, reason: string, note?: string | null): Promise<void> {
  const { error } = await supabase.rpc('cancel_admission', {
    p_lead_id: leadId,
    p_reason: reason.trim(),
    p_note: note?.trim() || null,
  });
  if (error) throw toError(error);
}

// =====================================================================
// "Try again later" choices for Lost
// =====================================================================
export type ReviveChoice = { key: string; label: string; date: Date };

export function reviveChoices(now = new Date()): ReviveChoice[] {
  const at10 = (d: Date) => {
    const x = new Date(d);
    x.setHours(10, 0, 0, 0);
    return x;
  };
  const plusMonths = (n: number) => {
    const d = new Date(now);
    d.setMonth(d.getMonth() + n);
    return at10(d);
  };
  return [
    { key: '1m', label: 'In 1 month', date: plusMonths(1) },
    { key: '3m', label: 'In 3 months', date: plusMonths(3) },
    { key: '6m', label: 'In 6 months', date: plusMonths(6) },
  ];
}

/** Reasons offered when cancelling an admission (any text is allowed) */
export const CANCEL_REASONS = ['Refund requested', 'Joined another institution', 'Personal / family reason', 'Fee not paid'];

// =====================================================================
// Stage history of one lead (newest first)
// =====================================================================
export type StageHistoryItem = {
  id: string;
  fromStageId: string | null;
  toStageId: string | null;
  changedBy: string | null;
  changedByName: string | null;
  changedAt: Date;
  note: string | null;
};

export async function listStageHistory(leadId: string): Promise<StageHistoryItem[]> {
  const { data, error } = await supabase
    .from('lead_stage_history')
    .select('id, from_stage_id, to_stage_id, changed_by, changed_at, note, person:changed_by(full_name)')
    .eq('lead_id', leadId)
    .order('changed_at', { ascending: false })
    .limit(50);
  if (error) throw toError(error);

  type Raw = {
    id: string;
    from_stage_id: string | null;
    to_stage_id: string | null;
    changed_by: string | null;
    changed_at: string;
    note: string | null;
    person: { full_name: string | null } | null;
  };

  return ((data ?? []) as unknown as Raw[]).map((h) => ({
    id: h.id,
    fromStageId: h.from_stage_id,
    toStageId: h.to_stage_id,
    changedBy: h.changed_by,
    changedByName: h.person?.full_name ?? null,
    changedAt: new Date(h.changed_at),
    note: h.note,
  }));
}