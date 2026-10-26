import { syncCallsNow, type DeviceCall } from '@/features/call-sync/api';
import { supabase } from '@/shared/lib/supabase';
import { colors } from '@/shared/theme';
import type { Tables } from '@/shared/types/database';

// =====================================================================
// Call outcomes
//   The first six are chosen by hand in the popup.
//   "missed" and "rejected" only come from the phone's call log.
// =====================================================================
export type CallOutcome =
  | 'connected'
  | 'no_answer'
  | 'busy'
  | 'switched_off'
  | 'wrong_number'
  | 'call_back';

export type AnyOutcome = CallOutcome | 'missed' | 'rejected';

export type CallDirection = 'outgoing' | 'incoming' | 'missed' | 'rejected';

type OutcomeInfo = { value: string; label: string; icon: string; color: string };

/** Choices shown in the popup */
export const CALL_OUTCOMES: (OutcomeInfo & { value: CallOutcome })[] = [
  { value: 'connected', label: 'Connected', icon: '✅', color: colors.success },
  { value: 'no_answer', label: 'No answer', icon: '📵', color: colors.warning },
  { value: 'busy', label: 'Busy', icon: '⏳', color: colors.warning },
  { value: 'switched_off', label: 'Switched off', icon: '📴', color: colors.textMuted },
  { value: 'wrong_number', label: 'Wrong number', icon: '❌', color: colors.danger },
  { value: 'call_back', label: 'Call back later', icon: '🔁', color: colors.info },
];

/** Results that only come from the phone */
const PHONE_ONLY: OutcomeInfo[] = [
  { value: 'missed', label: 'Missed call', icon: '📵', color: colors.danger },
  { value: 'rejected', label: 'Rejected', icon: '🚫', color: colors.danger },
];

export function outcomeInfo(value: string): OutcomeInfo {
  return (
    CALL_OUTCOMES.find((o) => o.value === value) ??
    PHONE_ONLY.find((o) => o.value === value) ?? {
      value,
      label: value.replace(/_/g, ' '),
      icon: '📞',
      color: colors.textMuted,
    }
  );
}

/** Arrow + colour for the direction of a call */
export function directionInfo(direction: string): { arrow: string; label: string; color: string } {
  switch (direction) {
    case 'incoming':
      return { arrow: '↙', label: 'Incoming', color: colors.info };
    case 'missed':
      return { arrow: '↙', label: 'Missed', color: colors.danger };
    case 'rejected':
      return { arrow: '↙', label: 'Rejected', color: colors.danger };
    case 'outgoing':
    default:
      return { arrow: '↗', label: 'Outgoing', color: colors.success };
  }
}

/**
 * The result of a call found on the phone, worked out the same way the server does:
 *  outgoing: long enough → Connected, else No answer
 *  incoming: any talk time → Connected, else Missed
 */
export function outcomeFromPhone(call: DeviceCall, connectedMinSec: number): AnyOutcome {
  switch (call.direction) {
    case 'outgoing':
      return call.durationSec >= connectedMinSec ? 'connected' : 'no_answer';
    case 'incoming':
      return call.durationSec > 0 ? 'connected' : 'missed';
    default:
      return call.direction; // missed / rejected
  }
}

// =====================================================================
// Types
// =====================================================================
export type CallLog = Tables<'call_logs'> & {
  caller: { id: string; full_name: string | null; is_active: boolean } | null;
};

export type NewCall = {
  leadId: string;
  outcome: AnyOutcome;
  durationSec?: number | null;
  notes?: string | null;
  calledAt?: string; // ISO time; default = now

  // When the call was found in the phone's call log
  direction?: CallDirection;
  deviceId?: string | null;
  deviceCallId?: string | null;
  simLabel?: string | null;
};

// =====================================================================
// Errors
// =====================================================================
function toError(error: { message: string }): Error {
  const m = error.message.toLowerCase();
  if (m.includes('network request failed') || m.includes('fetch')) {
    return new Error('No internet connection. Please try again.');
  }
  if (m.includes('note can only be added once')) {
    return new Error('This call already has a note, or it is more than 24 hours old.');
  }
  return new Error(error.message);
}

const CALL_SELECT = `
  *,
  caller:user_id(id, full_name, is_active)
`;

// =====================================================================
// Save a call
//   The database then updates the lead's "last contacted" time
//   and adds a line to the lead's timeline.
//   If the call was found in the phone's call log, its id is saved too,
//   so the automatic sync will not add it a second time.
// =====================================================================
export async function logCall(input: NewCall): Promise<string> {
  const notes = input.notes?.trim() || null;
  const fromPhone = !!input.deviceCallId && !!input.deviceId;

  const { data, error } = await supabase
    .from('call_logs')
    .insert({
      lead_id: input.leadId,
      outcome: input.outcome,
      duration_sec: input.durationSec ?? null,
      notes,
      ...(input.calledAt ? { called_at: input.calledAt } : {}),
      ...(input.direction ? { direction: input.direction } : {}),
      ...(fromPhone
        ? {
            device_id: input.deviceId,
            device_call_id: input.deviceCallId,
            sim_label: input.simLabel ?? null,
            phone_verified: true,
          }
        : {}),
    })
    .select('id')
    .single();

  if (error) throw toError(error);
  return data.id;
}

// =====================================================================
// Add a note to a call that came from the phone (opened from a notification)
//   1. Sync first, so the call is on the server if it can be
//   2. Found → add the note to it (once, within 24 hours)
//   3. Not found (sync off / offline) → save it now with the phone's id;
//      the automatic sync will then skip it
// =====================================================================
export async function addNoteToPhoneCall(input: {
  leadId: string;
  deviceId: string;
  call: DeviceCall;
  notes: string;
  connectedMinSec: number;
}): Promise<void> {
  const notes = input.notes.trim() || null;

  try {
    await syncCallsNow();
  } catch {
    // offline: handled below
  }

  const { data: existing, error: findError } = await supabase
    .from('call_logs')
    .select('id, notes')
    .eq('lead_id', input.leadId)
    .eq('device_id', input.deviceId)
    .eq('device_call_id', input.call.id)
    .maybeSingle();

  if (findError) throw toError(findError);

  if (existing) {
    if (!notes) return; // nothing to add (only the rating may have changed)
    if (existing.notes) throw new Error('This call already has a note.');

    const { error } = await supabase.from('call_logs').update({ notes }).eq('id', existing.id);
    if (error) throw toError(error);
    return;
  }

  await logCall({
    leadId: input.leadId,
    outcome: outcomeFromPhone(input.call, input.connectedMinSec),
    notes,
    durationSec: input.call.durationSec,
    calledAt: input.call.calledAt,
    direction: input.call.direction,
    deviceId: input.deviceId,
    deviceCallId: input.call.id,
    simLabel: input.call.simLabel,
  });
}

// =====================================================================
// Calls of one lead (newest first)
// =====================================================================
export async function listLeadCalls(leadId: string): Promise<CallLog[]> {
  const { data, error } = await supabase
    .from('call_logs')
    .select(CALL_SELECT)
    .eq('lead_id', leadId)
    .order('called_at', { ascending: false })
    .limit(50);

  if (error) throw toError(error);
  return (data ?? []) as unknown as CallLog[];
}

// =====================================================================
// Small helpers for showing a call
// =====================================================================
/** 75 → "1m 15s" */
export function formatDuration(sec: number | null | undefined): string | null {
  if (sec == null) return null;
  if (sec < 60) return `${sec}s`;
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  return s === 0 ? `${m}m` : `${m}m ${s}s`;
}