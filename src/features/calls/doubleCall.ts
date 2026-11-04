import { Alert } from 'react-native';

import { formatDuration, outcomeInfo } from '@/features/calls/api';
import { getSetting, updateSetting } from '@/features/settings/api';
import { supabase } from '@/shared/lib/supabase';
import type { Json } from '@/shared/types/database';

// =====================================================================
// 📞⚠️ Double-call warning: before a call from the app, has someone else
//   talked to (or written a note on) this lead in the last N minutes?
//   Then: "Rahim called 12 minutes ago. Call again?"
//   Settings → Double-call warning decides everything.
// =====================================================================

export type DoubleCallSettings = {
  enabled: boolean;
  /** The window, in minutes */
  minutes: number;
  /** Count calls nobody answered too (not only the ones where they talked) */
  count_attempts: boolean;
  /** Count notes and voice notes */
  count_notes: boolean;
  /** Count WhatsApp calls and messages */
  count_whatsapp: boolean;
  /** Warn about your own calls too */
  own: boolean;
  /** "Call anyway" goes into the change log */
  log_anyway: boolean;
};

export const DEFAULT_DOUBLE_CALL: DoubleCallSettings = {
  enabled: true,
  minutes: 30,
  count_attempts: false,
  count_notes: true,
  count_whatsapp: false,
  own: false,
  log_anyway: true,
};

export async function getDoubleCallSettings(): Promise<DoubleCallSettings> {
  try {
    const saved = await getSetting<Partial<DoubleCallSettings>>('double_call');
    return { ...DEFAULT_DOUBLE_CALL, ...(saved ?? {}) };
  } catch {
    return DEFAULT_DOUBLE_CALL;
  }
}

export async function saveDoubleCallSettings(s: DoubleCallSettings): Promise<void> {
  await updateSetting('double_call', s as unknown as Json);
}

type RecentContact = {
  kind: 'call' | 'note' | 'voice';
  at: string;
  user_id: string | null;
  user_name: string | null;
  minutes_ago: number;
  window: number;
  last_note: string | null;
  log_anyway: boolean;
  call: {
    at: string;
    user_id: string | null;
    user_name: string | null;
    outcome: string;
    duration_sec: number | null;
    channel: string;
    direction: string;
  } | null;
};

/** Someone else's contact with this lead in the window (null: none, off, or no answer in 2 seconds) */
async function recentContact(leadId: string): Promise<RecentContact | null> {
  const ask = supabase
    .rpc('recent_contact', { p_lead: leadId })
    .then(({ data, error }) => (error ? null : ((data as unknown as RecentContact | null) ?? null)));
  const timeout = new Promise<null>((resolve) => setTimeout(() => resolve(null), 2000));
  try {
    return await Promise.race([ask, timeout]);
  } catch {
    return null;
  }
}

const ago = (m: number) => (m <= 0 ? 'just now' : m === 1 ? '1 minute ago' : `${m} minutes ago`);
const firstName = (n: string | null) => (n ?? '').trim().split(' ')[0] || 'Someone';

/**
 * Ask before calling when someone else was in touch a moment ago.
 * Resolves true = go ahead and call, false = don't.
 * onRead: "Read notes" (show the lead's last calls and notes).
 */
export async function confirmCall(leadId: string, onRead?: () => void): Promise<boolean> {
  const r = await recentContact(leadId);
  if (!r) return true;

  const who = firstName(r.user_name);
  const title =
    r.kind === 'call'
      ? `⚠️ ${who} ${r.call?.channel === 'whatsapp' ? 'was on WhatsApp with this lead' : 'called'} ${ago(r.minutes_ago)}`
      : `⚠️ ${who} wrote a ${r.kind === 'voice' ? 'voice note' : 'note'} ${ago(r.minutes_ago)}`;

  const lines: string[] = [];
  if (r.call) {
    const o = outcomeInfo(r.call.outcome).label;
    const len =
      r.call.outcome === 'connected' && r.call.duration_sec ? ` · ${formatDuration(r.call.duration_sec)}` : '';
    const by = r.kind === 'call' ? '' : ` · ${firstName(r.call.user_name)}`;
    lines.push(`${r.call.channel === 'whatsapp' ? '💬' : '📞'} ${o}${len}${by}`);
  }
  if (r.last_note) lines.push(`📝 “${r.last_note.length > 140 ? `${r.last_note.slice(0, 140)}…` : r.last_note}”`);
  lines.push('', 'Read the notes before calling again. Call anyway?');

  return new Promise<boolean>((resolve) => {
    Alert.alert(
      title,
      lines.join('\n'),
      [
        ...(onRead
          ? [
              {
                text: 'Read notes',
                onPress: () => {
                  resolve(false);
                  onRead();
                },
              },
            ]
          : []),
        { text: 'Cancel', style: 'cancel' as const, onPress: () => resolve(false) },
        {
          text: 'Call anyway',
          onPress: () => {
            resolve(true);
            if (r.log_anyway) {
              supabase
                .rpc('log_double_call', {
                  p_lead: leadId,
                  p_other: r.user_id as string,
                  p_minutes: r.minutes_ago,
                  p_kind: r.kind,
                })
                .then(
                  () => undefined,
                  () => undefined,
                );
            }
          },
        },
      ],
      { cancelable: true, onDismiss: () => resolve(false) },
    );
  });
}
