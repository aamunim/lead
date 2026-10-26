import { supabase } from '@/shared/lib/supabase';

// =====================================================================
// Reminders ("nudges") sent by the Super Admin
//   For now there is one kind: "please set up call log sync".
// =====================================================================

export type NudgeReason = 'not_set_up' | 'sync_off' | 'permission_off' | 'late' | 'error';

export type Nudge = {
  id: string;
  kind: 'call_sync_setup';
  reason: NudgeReason | null;
  message: string | null;
  sentByName: string | null;
  createdAt: Date;
  seenAt: Date | null;
};

export type SendNudgeResult = {
  sent: number;
  /** Reminded less than 15 minutes ago, skipped */
  cooldown: number;
  /** Not allowed to sync (admin setting), skipped */
  notAllowed: number;
};

/** Minutes before the same person can be reminded again (matches the database) */
export const NUDGE_COOLDOWN_MIN = 15;

/** Longest message the Super Admin can add (matches the database) */
export const NUDGE_MESSAGE_MAX = 200;

function toError(error: { message: string }): Error {
  const m = error.message.toLowerCase();
  if (m.includes('network request failed') || m.includes('fetch')) {
    return new Error('No internet connection. Please try again.');
  }
  return new Error(error.message);
}

// =====================================================================
// Texts shown to the user
// =====================================================================
export function nudgeTitle(reason: NudgeReason | null): string {
  switch (reason) {
    case 'sync_off':
      return 'Turn call log sync back on';
    case 'permission_off':
      return 'Call log permission is off';
    case 'error':
      return 'Call log sync needs a check';
    case 'late':
      return 'Your calls haven’t synced lately';
    case 'not_set_up':
    default:
      return 'Turn on call log sync';
  }
}

export function nudgeText(reason: NudgeReason | null): string {
  switch (reason) {
    case 'late':
      return 'Open the app now and then so your lead calls are saved. One tap below checks everything.';
    case 'permission_off':
      return 'The app can’t read your call history. Tap below and choose Allow.';
    case 'sync_off':
      return 'Sync was turned off on this phone. Tap below to switch it on again.';
    case 'error':
      return 'The last sync didn’t work. Tap below to try again.';
    case 'not_set_up':
    default:
      return 'Your lead calls will be saved automatically: real call time, incoming and missed calls. Tap below and choose Allow.';
  }
}

// =====================================================================
// For the user
// =====================================================================
type RawNudge = {
  id: string;
  kind: string;
  reason: string | null;
  message: string | null;
  sent_by_name: string | null;
  created_at: string;
  seen_at: string | null;
};

/** My newest open reminder, or null */
export async function getMyOpenNudge(): Promise<Nudge | null> {
  const { data, error } = await supabase.rpc('my_open_nudge');
  if (error) throw toError(error);

  const row = ((data ?? []) as unknown as RawNudge[])[0];
  if (!row) return null;

  return {
    id: row.id,
    kind: 'call_sync_setup',
    reason: (row.reason as NudgeReason | null) ?? null,
    message: row.message,
    sentByName: row.sent_by_name,
    createdAt: new Date(row.created_at),
    seenAt: row.seen_at ? new Date(row.seen_at) : null,
  };
}

/** The user saw the sheet (or tapped "Later"): it won't pop up again, the Home banner stays */
export async function markNudgeSeen(id: string): Promise<void> {
  const { error } = await supabase.rpc('mark_nudge_seen', { p_id: id });
  if (error) throw toError(error);
}

/** Setup finished: close my call sync reminders */
export async function closeMySyncNudges(): Promise<void> {
  const { error } = await supabase.rpc('close_my_sync_nudges');
  if (error) throw toError(error);
}

// =====================================================================
// For the Super Admin
// =====================================================================
export async function sendSyncNudge(userIds: string[], message?: string | null): Promise<SendNudgeResult> {
  const { data, error } = await supabase.rpc('send_sync_nudge', {
    p_user_ids: userIds,
    p_message: message?.trim() || null,
  });
  if (error) throw toError(error);

  const r = (data ?? {}) as { sent?: number; cooldown?: number; not_allowed?: number };
  return { sent: r.sent ?? 0, cooldown: r.cooldown ?? 0, notAllowed: r.not_allowed ?? 0 };
}

/** "Sent to 3 · 1 reminded less than 15 min ago" */
export function describeSendResult(r: SendNudgeResult): string {
  const parts = [`Reminder sent to ${r.sent} ${r.sent === 1 ? 'person' : 'people'}`];
  if (r.cooldown > 0) parts.push(`${r.cooldown} reminded less than ${NUDGE_COOLDOWN_MIN} min ago`);
  if (r.notAllowed > 0) parts.push(`${r.notAllowed} not allowed to sync`);
  return parts.join(' · ');
}