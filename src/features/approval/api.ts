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

export type ApprovalSettings = { enabled: boolean; who: WhoRule };

export const DEFAULT_APPROVAL_SETTINGS: ApprovalSettings = {
  enabled: true,
  who: { mode: 'roles', roles: [], user_ids: [] },
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

/** Badge for a student's card and the approval card */
export function approvalBadge(status: string | null | undefined): { text: string; color: 'wait' | 'good' | 'bad' } | null {
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

export async function approveAdmission(leadId: string, nuAdmissionId: string, note: string): Promise<void> {
  const { error } = await supabase.rpc('approve_admission', {
    p_lead: leadId,
    p_nu_admission_id: nuAdmissionId.trim() || undefined,
    p_note: note.trim() || undefined,
  });
  if (error) throw toError(error);
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

/** Students waiting for approval (for the officer's Home card) */
export async function countWaitingApproval(): Promise<number> {
  const { count, error } = await supabase
    .from('leads')
    .select('id', { count: 'exact', head: true })
    .eq('approval_status', 'waiting')
    .is('deleted_at', null)
    .is('cancelled_at', null);
  if (error) return 0;
  return count ?? 0;
}
