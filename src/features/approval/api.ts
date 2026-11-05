import type { MyProfile } from '@/features/auth/api';
import type { WhoRule } from '@/features/pipeline/api';
import { getSetting, updateSetting } from '@/features/settings/api';
import { supabase } from '@/shared/lib/supabase';
import type { Json } from '@/shared/types/database';

// =====================================================================
// 🏛 Admission flow (admitted students only, outside the pipeline)
//   ✅ Admitted → 📤 Submitted Online (NU Admission ID, no money)
//              → 🏛 Received by ITTC (the course's admission fee paid)
//   The Admission Officer (Settings → Admission flow) and admins do both.
//   Cancelling the admission hides all of it (the timeline keeps it).
// =====================================================================

export type ApprovalStatus = 'waiting' | 'approved' | 'returned';

export type ApprovalSettings = {
  enabled: boolean;
  who: WhoRule;
  /** ৳ the default admission fee (a course can have its own: Settings → Courses) */
  admission_min_paid: number;
  /** (old: the registration step is gone) */
  registration_min_paid: number;
};

export const DEFAULT_APPROVAL_SETTINGS: ApprovalSettings = {
  enabled: true,
  who: { mode: 'roles', roles: [], user_ids: [] },
  admission_min_paid: 1000,
  registration_min_paid: 6000,
};

export async function getApprovalSettings(): Promise<ApprovalSettings> {
  try {
    const saved = await getSetting<Partial<ApprovalSettings>>('admission_approval');
    return {
      ...DEFAULT_APPROVAL_SETTINGS,
      ...(saved ?? {}),
      who: { ...DEFAULT_APPROVAL_SETTINGS.who, ...(saved?.who ?? {}) },
    };
  } catch {
    return DEFAULT_APPROVAL_SETTINGS;
  }
}

export async function saveApprovalSettings(s: ApprovalSettings): Promise<void> {
  await updateSetting('admission_approval', s as unknown as Json);
}

/** May this person approve? (admins always; the database checks again) */
export function canApprove(s: ApprovalSettings, profile: MyProfile | null, isAdmin: boolean): boolean {
  if (!profile) return false;
  if (isAdmin) return true;
  if (!s.enabled) return false;
  if (s.who.mode === 'roles') return s.who.roles.includes(profile.role_key);
  if (s.who.mode === 'users') return s.who.user_ids.includes(profile.id);
  return true;
}

/**
 * Where a student is: ✅ admitted → 📤 Submitted Online → 🏛 Received by ITTC
 * (one badge for the cards and the table)
 */
export function stageBadge(
  submittedAt: string | null | undefined,
  receivedAt: string | null | undefined,
  feeOk?: boolean | null,
): { text: string; color: 'wait' | 'good' | 'bad' } | null {
  if (receivedAt) return { text: '🏛 Received by ITTC', color: 'good' };
  if (submittedAt && feeOk) return { text: '🏛 Ready for ITTC', color: 'wait' };
  if (submittedAt) return { text: '📤 Submitted online', color: 'wait' };
  return { text: '⏳ Not submitted', color: 'wait' };
}

function toError(error: { message: string }): Error {
  const m = error.message;
  if (/network request failed|fetch/i.test(m)) return new Error('No internet connection. Please try again.');
  return new Error(m);
}

/** Course · batch · section of an admitted student */
export type Placement = { courseId: string | null; batchId: string | null; sectionId: string | null };



/** Change the course / batch / section (at approval or later) */
export async function setPlacement(leadId: string, p: Placement): Promise<void> {
  if (!p.courseId) throw new Error('Please choose a course.');
  if (!p.batchId) throw new Error('Please choose a batch.');
  if (!p.sectionId) throw new Error('Please choose a section.');
  const { error } = await supabase.rpc('set_admission_placement', {
    p_lead: leadId,
    p_course: p.courseId,
    p_batch: p.batchId,
    p_section: p.sectionId,
  });
  if (error) throw toError(error);
}




/** Paid so far (refunds taken off), as the database counts it for the approvals */
export async function getPaid(leadId: string): Promise<number> {
  const { data, error } = await supabase.rpc('lead_paid', { p_lead: leadId });
  if (error) throw toError(error);
  return Number(data ?? 0);
}

// ---------------------------------------------------------------------
// Courses → batches → sections (for the pickers)
// ---------------------------------------------------------------------
export type PlacementOptions = {
  courses: { id: string; name: string }[];
  batches: { id: string; name: string; course_id: string }[];
  sections: { id: string; name: string; batch_id: string }[];
};

export async function getPlacementOptions(): Promise<PlacementOptions> {
  const [c, b, s] = await Promise.all([
    supabase.from('courses').select('id, name').eq('is_active', true).order('sort_order').order('name'),
    supabase.from('batches').select('id, name, course_id').eq('is_active', true).order('sort_order').order('name'),
    supabase
      .from('batch_sections')
      .select('id, name, batch_id')
      .eq('is_active', true)
      .order('sort_order')
      .order('name'),
  ]);
  if (c.error) throw toError(c.error);
  if (b.error) throw toError(b.error);
  if (s.error) throw toError(s.error);
  return { courses: c.data ?? [], batches: b.data ?? [], sections: s.data ?? [] };
}

// Settings → Courses → a batch: its sections
export type BatchSection = { id: string; batch_id: string; name: string; sort_order: number; is_active: boolean };

export async function listSections(batchId: string): Promise<BatchSection[]> {
  const { data, error } = await supabase
    .from('batch_sections')
    .select('id, batch_id, name, sort_order, is_active')
    .eq('batch_id', batchId)
    .order('sort_order')
    .order('name');
  if (error) throw toError(error);
  return data ?? [];
}

export async function addSection(batchId: string, name: string, sortOrder: number): Promise<void> {
  const { error } = await supabase
    .from('batch_sections')
    .insert({ batch_id: batchId, name: name.trim(), sort_order: sortOrder });
  if (error) {
    if (error.message.includes('batch_sections_name_key')) throw new Error('This batch already has that section.');
    throw toError(error);
  }
}

export async function updateSection(id: string, patch: { name?: string; is_active?: boolean }): Promise<void> {
  const { error } = await supabase.from('batch_sections').update(patch).eq('id', id);
  if (error) {
    if (error.message.includes('batch_sections_name_key')) throw new Error('This batch already has that section.');
    throw toError(error);
  }
}



export async function setNuAdmissionId(leadId: string, value: string): Promise<void> {
  const { error } = await supabase.rpc('set_nu_admission_id', { p_lead: leadId, p_value: value.trim() });
  if (error) throw toError(error);
}

/** ✏️ College ID (Student ID) typed by hand (Admission Officer / admin) */
export async function setStudentRef(leadId: string, value: string): Promise<void> {
  const { error } = await supabase.rpc('set_student_ref', { p_lead: leadId, p_value: value.trim() });
  if (error) {
    // Two people saving the same ID at once: the database's own check
    if (error.message.includes('leads_student_ref_unique'))
      throw new Error('This College ID is already given to another student.');
    throw toError(error);
  }
}

// ---------------------------------------------------------------------
// 📤 Submitted Online → 🏛 Received by ITTC (Admission Officer / admin)
// ---------------------------------------------------------------------
export async function submitOnline(leadId: string, nuAdmissionId: string, note = ''): Promise<void> {
  if (!nuAdmissionId.trim()) throw new Error('Please type the NU Admission ID.');
  const { error } = await supabase.rpc('submit_online', {
    p_lead: leadId,
    p_nu_admission_id: nuAdmissionId.trim(),
    p_note: note.trim() || undefined,
  });
  if (error) throw toError(error);
}

export async function markReceived(leadId: string, note = ''): Promise<void> {
  const { error } = await supabase.rpc('mark_received', { p_lead: leadId, p_note: note.trim() || undefined });
  if (error) throw toError(error);
}

/** ↩ Undo one step, with a reason (Received first, then Submitted) */
export async function undoIttcStep(leadId: string, step: 'submitted' | 'received', reason: string): Promise<void> {
  if (!reason.trim()) throw new Error('Please write why.');
  const { error } = await supabase.rpc('undo_ittc_step', { p_lead: leadId, p_step: step, p_reason: reason.trim() });
  if (error) throw toError(error);
}

export type BulkReceived = {
  ready: number;
  done: number;
  already: number;
  not_submitted: number;
  short: number;
  skipped: number;
};

/** 🏛 Many at once: the ready ones are marked, the others are left out (dry = only count) */
export async function bulkMarkReceived(leadIds: string[], dry: boolean): Promise<BulkReceived> {
  const { data, error } = await supabase.rpc('bulk_mark_received', { p_leads: leadIds, p_dry: dry });
  if (error) throw toError(error);
  return data as unknown as BulkReceived;
}

/** A course's admission fee (null = the default in Settings → Admission flow) */
export async function setCourseAdmissionFee(courseId: string, amount: number | null): Promise<void> {
  const { error } = await supabase.rpc('set_course_admission_fee', { p_course: courseId, p_amount: amount });
  if (error) throw toError(error);
}

/** The officer's work: not submitted yet, and submitted with the fee paid (ready for ITTC) */
export async function countIttcWork(): Promise<{ notSubmitted: number; ready: number }> {
  const base = () =>
    supabase
      .from('leads')
      .select('id', { count: 'exact', head: true })
      .not('admitted_at', 'is', null)
      .is('deleted_at', null)
      .is('cancelled_at', null);
  const [a, b] = await Promise.all([
    base().is('submitted_at', null),
    base().not('submitted_at', 'is', null).is('received_at', null).eq('admission_fee_ok', true),
  ]);
  return { notSubmitted: a.count ?? 0, ready: b.count ?? 0 };
}

/** The officer's badge (web menu): students ready for ITTC */
export async function countWaitingApproval(): Promise<number> {
  try {
    return (await countIttcWork()).ready;
  } catch {
    return 0;
  }
}

// ---------------------------------------------------------------------
// 🔀 Many students to one course · batch · section (all of them, or none)
// ---------------------------------------------------------------------
export type BulkPlacementPreview = {
  moving: number;
  already_there: number;
  skipped: number;
  seats: { capacity: number | null; taken: number; need: number; ok: boolean };
  id_rule: { kind: 'pattern' | 'range'; start: number | null; end: number | null; pattern: string | null; free: number | null } | null;
  course_change: number;
  course_fee: number | null;
  overpaid: number;
  problems: string[];
  place: string;
};

export async function bulkPlacementPreview(leadIds: string[], p: Placement): Promise<BulkPlacementPreview> {
  const { data, error } = await supabase.rpc('bulk_placement_preview', {
    p_leads: leadIds,
    p_course: p.courseId as string,
    p_batch: p.batchId as string,
    p_section: p.sectionId as string,
  });
  if (error) throw toError(error);
  return data as unknown as BulkPlacementPreview;
}

export async function bulkSetPlacement(leadIds: string[], p: Placement): Promise<{ moved: number; place: string }> {
  const { data, error } = await supabase.rpc('bulk_set_placement', {
    p_leads: leadIds,
    p_course: p.courseId as string,
    p_batch: p.batchId as string,
    p_section: p.sectionId as string,
  });
  if (error) throw toError(error);
  return data as unknown as { moved: number; place: string };
}
