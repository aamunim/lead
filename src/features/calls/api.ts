import {
  getWhatsAppEvent,
  syncCallsNow,
  type DeviceCall,
  type WhatsAppDeviceEvent,
} from '@/features/call-sync/api';
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

export type AnyOutcome = CallOutcome | 'missed' | 'rejected' | 'message';

/** 📞 phone call, or 💬 WhatsApp (call or message) */
export type CallChannel = 'phone' | 'whatsapp';
/** WhatsApp only: what it was */
export type WhatsAppMedia = 'voice' | 'video' | 'message';

/** Results you can choose for a WhatsApp call (no SIM, so no "switched off") */
export const WHATSAPP_CALL_OUTCOMES: CallOutcome[] = ['connected', 'no_answer', 'busy', 'call_back'];

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
  { value: 'message', label: 'Message', icon: '💬', color: '#1F7A57' },
];

/** "WhatsApp call", "WhatsApp video", "WhatsApp message", or "" for a phone call */
export function channelLabel(channel: string | null | undefined, media: string | null | undefined): string {
  if (channel !== 'whatsapp') return '';
  if (media === 'message') return 'WhatsApp message';
  if (media === 'video') return 'WhatsApp video';
  return 'WhatsApp call';
}

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

  /** Default phone. WhatsApp needs media (voice / video / message). */
  channel?: CallChannel;
  media?: WhatsAppMedia | null;

  /** 'whatsapp' when it was read from WhatsApp's notifications */
  source?: 'app' | 'whatsapp';

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

  // A call from the phone's call log: the automatic sync may have saved it
  // already; the database then puts this result and note on that call
  if (fromPhone && input.channel !== 'whatsapp') {
    const { data, error } = await supabase.rpc('save_phone_call', {
      p_lead_id: input.leadId,
      p_outcome: input.outcome,
      p_notes: notes ?? '',
      p_duration_sec: input.durationSec ?? (null as unknown as number),
      p_called_at: input.calledAt ?? new Date().toISOString(),
      p_direction: input.direction ?? 'outgoing',
      p_device_id: input.deviceId as string,
      p_device_call_id: input.deviceCallId as string,
      p_sim_label: input.simLabel ?? undefined,
    });
    if (error) throw toError(error);
    return data as string;
  }

  const { data, error } = await supabase
    .from('call_logs')
    .insert({
      lead_id: input.leadId,
      outcome: input.outcome,
      duration_sec: input.durationSec ?? null,
      notes,
      ...(input.calledAt ? { called_at: input.calledAt } : {}),
      ...(input.direction ? { direction: input.direction } : {}),
      ...(input.channel === 'whatsapp' ? { channel: 'whatsapp', media: input.media ?? 'message' } : {}),
      ...(input.source === 'whatsapp' ? { source: 'whatsapp' } : {}),
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
}): Promise<string> {
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
    if (!notes) return existing.id; // nothing to add (only the rating may have changed)
    if (existing.notes) throw new Error('This call already has a note.');

    const { error } = await supabase.from('call_logs').update({ notes }).eq('id', existing.id);
    if (error) throw toError(error);
    return existing.id;
  }

  return logCall({
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
// Add a note to a WhatsApp call read from WhatsApp's notifications
//   Same steps as addNoteToPhoneCall: sync first, then add the note to
//   the saved call, or save it now with the phone's id (sync then skips it)
// =====================================================================
/** The result of a WhatsApp call from WhatsApp's notifications */
export function outcomeOfWhatsApp(e: WhatsAppDeviceEvent): AnyOutcome {
  if (e.media === 'message') return 'message';
  if (e.direction === 'missed') return 'missed';
  if (e.connected) return 'connected';
  return e.direction === 'incoming' ? 'missed' : 'no_answer';
}

/**
 * The WhatsApp call behind an "add a note" notification: from the phone's
 * queue, or (already uploaded) from the saved call
 */
export async function findWhatsAppCall(eventId: string, deviceId: string | null): Promise<WhatsAppDeviceEvent | null> {
  const onPhone = getWhatsAppEvent(eventId);
  if (onPhone) return onPhone;
  if (!deviceId) return null;

  const { data } = await supabase
    .from('call_logs')
    .select('lead_id, media, direction, outcome, duration_sec, called_at')
    .eq('device_id', deviceId)
    .eq('device_call_id', `wa:${eventId}`)
    .maybeSingle();
  if (!data) return null;
  return {
    id: eventId,
    leadId: data.lead_id,
    media: (data.media ?? 'voice') as WhatsAppDeviceEvent['media'],
    direction: (data.direction === 'missed' || data.direction === 'rejected'
      ? 'missed'
      : data.direction) as WhatsAppDeviceEvent['direction'],
    durationSec: data.duration_sec ?? 0,
    connected: data.outcome === 'connected',
    calledAt: data.called_at,
  };
}

export async function addNoteToWhatsAppCall(input: {
  leadId: string;
  deviceId: string;
  event: WhatsAppDeviceEvent;
  notes: string;
}): Promise<string> {
  const notes = input.notes.trim() || null;
  const deviceCallId = `wa:${input.event.id}`;

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
    .eq('device_call_id', deviceCallId)
    .maybeSingle();
  if (findError) throw toError(findError);

  if (existing) {
    if (!notes) return existing.id;
    if (existing.notes) throw new Error('This call already has a note.');
    const { error } = await supabase.from('call_logs').update({ notes }).eq('id', existing.id);
    if (error) throw toError(error);
    return existing.id;
  }

  const outcome = outcomeOfWhatsApp(input.event);
  const missed = outcome === 'missed';
  return logCall({
    leadId: input.leadId,
    outcome,
    notes,
    durationSec: outcome === 'connected' ? input.event.durationSec : null,
    calledAt: input.event.calledAt,
    direction: missed ? 'missed' : input.event.direction,
    channel: 'whatsapp',
    media: input.event.media,
    source: 'whatsapp',
    deviceId: input.deviceId,
    deviceCallId,
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
// =====================================================================
// 💬 WhatsApp calls and messages (the WhatsApp calls screen)
//   Only leads I may see (row security on call_logs)
// =====================================================================
export type WhatsAppKind = 'all' | 'calls' | 'messages';

export type WhatsAppLog = CallLog & {
  lead: {
    id: string;
    name: string;
    phone: string | null;
    whatsapp_number: string | null;
    whatsapp_username: string | null;
  } | null;
};

export const WHATSAPP_PAGE = 40;

export async function listWhatsAppLogs(options: {
  since: Date;
  kind: WhatsAppKind;
  /** Load the page older than this time */
  before?: string | null;
}): Promise<WhatsAppLog[]> {
  let query = supabase
    .from('call_logs')
    .select(`${CALL_SELECT}, lead:leads(id, name, phone, whatsapp_number, whatsapp_username)`)
    .eq('channel', 'whatsapp')
    .gte('called_at', options.since.toISOString())
    .order('called_at', { ascending: false })
    .limit(WHATSAPP_PAGE);

  if (options.kind === 'calls') query = query.neq('outcome', 'message');
  if (options.kind === 'messages') query = query.eq('outcome', 'message');
  if (options.before) query = query.lt('called_at', options.before);

  const { data, error } = await query;
  if (error) throw toError(error);
  return (data ?? []) as unknown as WhatsAppLog[];
}

// =====================================================================
// 🗑 Delete what was written by hand (Admins any; the writer within 24 hours)
//   Calls read from the phone's call log or WhatsApp can't be deleted.
//   Each returns the change-log line, for Undo (restoreDeleted).
// =====================================================================
const DELETE_WINDOW_MS = 24 * 60 * 60 * 1000;

/** Written in the app (not read from the phone or WhatsApp) */
export function isHandWritten(c: Pick<CallLog, 'source' | 'device_call_id'>): boolean {
  return c.source === 'app' && !c.device_call_id;
}

/** May this person delete this entry? (the database checks again) */
export function canDeleteEntry(writerId: string | null, writtenAt: string, me: string | null, isAdmin: boolean) {
  if (isAdmin) return true;
  return !!me && writerId === me && Date.now() - new Date(writtenAt).getTime() < DELETE_WINDOW_MS;
}

export async function deleteCall(callId: string, reason?: string): Promise<string> {
  const { data, error } = await supabase.rpc('delete_call_log', {
    p_call_id: callId,
    ...(reason?.trim() ? { p_reason: reason.trim() } : {}),
  });
  if (error) throw toError(error);
  return data as string;
}

export async function deleteCallNote(callId: string, reason?: string): Promise<string> {
  const { data, error } = await supabase.rpc('delete_call_note', {
    p_call_id: callId,
    ...(reason?.trim() ? { p_reason: reason.trim() } : {}),
  });
  if (error) throw toError(error);
  return data as string;
}

/** Undo a delete (the person who deleted: 10 minutes; admins: any time) */
export async function restoreDeleted(activityId: string): Promise<void> {
  const { error } = await supabase.rpc('restore_deleted', { p_activity_id: activityId });
  if (error) throw toError(error);
}
