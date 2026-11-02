import type { MyProfile } from '@/features/auth/api';
import type { WhoRule } from '@/features/pipeline/api';
import { getSetting, updateSetting } from '@/features/settings/api';
import { supabase } from '@/shared/lib/supabase';
import type { Json } from '@/shared/types/database';

// =====================================================================
// 🎓 Admission approval: admitted students only, outside the pipeline
//   After "Mark admitted" the Admission Officer checks everything and
//   approves (NU Admission ID now or later) or sends it back with a reason.
//   The College ID is the Student ID (Settings → Admission). Cancelling the
//   admission hides all of it (the timeline keeps it).
// =====================================================================

export type ApprovalStatus = 'waiting' | 'approved' | 'returned';

export type ApprovalSettings = {
  enabled: boolean;
  who: WhoRule;
  /** ৳ paid in total before the admission can be approved */
  admission_min_paid: number;
  /** ৳ paid in total before the registration can be approved */
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
 * Where a student is: the admission approval first, then the registration.
 * (one badge for the cards and the table)
 */
export function stageBadge(
  approval: string | null | undefined,
  registration: string | null | undefined,
): { text: string; color: 'wait' | 'good' | 'bad' } | null {
  if (approval === 'approved') {
    if (registration === 'approved') return { text: '✅ Registered', color: 'good' };
    if (registration === 'returned') return { text: '↩ Registration sent back', color: 'bad' };
    return { text: '📝 Registration waiting', color: 'wait' };
  }
  if (approval === 'returned') return { text: '↩ Admission sent back', color: 'bad' };
  if (approval === 'waiting') return { text: '⏳ Admission waiting', color: 'wait' };
  return null;
}

/** Badge for a student's card and the approval card */
export function approvalBadge(
  status: string | null | undefined,
): { text: string; color: 'wait' | 'good' | 'bad' } | null {
  switch (status) {
    case 'waiting':
      return { text: '⏳ Approval waiting', color: 'wait' };
    case 'approved':
      return { text: '✅ Approved', color: 'good' };
    case 'returned':
      return { text: '↩ Sent back', color: 'bad' };
    default:
      return null;
  }
}

function toError(error: { message: string }): Error {
  const m = error.message;
  if (/network request failed|fetch/i.test(m)) return new Error('No internet connection. Please try again.');
  return new Error(m);
}

/** Course · batch · section of an admitted student */
export type Placement = { courseId: string | null; batchId: string | null; sectionId: string | null };

export async function approveAdmission(
  leadId: string,
  nuAdmissionId: string,
  note: string,
  placement: Placement,
): Promise<void> {
  const { error } = await supabase.rpc('approve_admission', {
    p_lead: leadId,
    p_nu_admission_id: nuAdmissionId.trim() || undefined,
    p_note: note.trim() || undefined,
    p_course: placement.courseId ?? undefined,
    p_batch: placement.batchId ?? undefined,
    p_section: placement.sectionId ?? undefined,
  });
  if (error) throw toError(error);
}

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

export async function approveRegistration(leadId: string, note: string): Promise<void> {
  const { error } = await supabase.rpc('approve_registration', { p_lead: leadId, p_note: note.trim() || undefined });
  if (error) throw toError(error);
}

export async function returnRegistration(leadId: string, reason: string): Promise<void> {
  const { error } = await supabase.rpc('return_registration', { p_lead: leadId, p_reason: reason });
  if (error) throw toError(error);
}

export async function resubmitRegistration(leadId: string, note: string): Promise<void> {
  const { error } = await supabase.rpc('resubmit_registration', { p_lead: leadId, p_note: note.trim() || undefined });
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

export async function returnAdmission(leadId: string, reason: string): Promise<void> {
  const { error } = await supabase.rpc('return_admission', { p_lead: leadId, p_reason: reason });
  if (error) throw toError(error);
}

export async function resubmitAdmission(leadId: string, note: string): Promise<void> {
  const { error } = await supabase.rpc('resubmit_admission', { p_lead: leadId, p_note: note.trim() || undefined });
  if (error) throw toError(error);
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

/** Students waiting for an approval: admission or registration (the officer's Home card, web menu) */
export async function countWaitingApproval(): Promise<number> {
  const { count, error } = await supabase
    .from('leads')
    .select('id', { count: 'exact', head: true })
    .or('approval_status.eq.waiting,registration_status.eq.waiting')
    .is('deleted_at', null)
    .is('cancelled_at', null);
  if (error) return 0;
  return count ?? 0;
}
