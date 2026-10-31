import AsyncStorage from '@react-native-async-storage/async-storage';

import { channelLabel, formatDuration, outcomeInfo } from '@/features/calls/api';
import { getSetting, updateSetting } from '@/features/settings/api';
import type { Json } from '@/shared/types/database';
import { colors } from '@/shared/theme';

// =====================================================================
// 📞📝 The last call and the last note of a lead, on the list and board
//   cards (kept up to date by the database: lead_last)
// =====================================================================

export type LeadLast = {
  call_id: string | null;
  call_at: string | null;
  call_outcome: string | null;
  call_direction: string | null;
  call_channel: string | null;
  call_media: string | null;
  call_duration_sec: number | null;
  call_by: string | null;
  note_at: string | null;
  /** First 200 letters (null for a voice note) */
  note_text: string | null;
  note_more: boolean;
  note_by: string | null;
  note_kind: 'call' | 'note' | 'voice' | null;
  note_voice_file: string | null;
  note_voice_sec: number | null;
};

/** For the list query */
export const LAST_SELECT = `last:lead_last(call_id, call_at, call_outcome, call_direction, call_channel, call_media,
  call_duration_sec, call_by, note_at, note_text, note_more, note_by, note_kind, note_voice_file, note_voice_sec)`;

/** "now", "5m ago", "2h ago", "yesterday", "3d ago", "12 Oct" */
export function ago(iso: string): string {
  const ms = Date.now() - new Date(iso).getTime();
  const min = Math.floor(ms / 60000);
  if (min < 1) return 'now';
  if (min < 60) return `${min}m ago`;
  const h = Math.floor(min / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24);
  if (d === 1) return 'yesterday';
  if (d < 7) return `${d}d ago`;
  return new Date(iso).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' });
}

/** The call's colour: green answered, orange not answered, red missed */
export function callDot(outcome: string | null): string {
  if (outcome === 'connected' || outcome === 'message') return colors.success;
  if (outcome === 'missed' || outcome === 'rejected' || outcome === 'wrong_number') return colors.danger;
  return colors.warning;
}

/** "📞 Connected 3m 20s · 2h ago · Karim" */
export function callLineText(last: LeadLast, nameOf: (id: string | null) => string | null): string | null {
  if (!last.call_at || !last.call_outcome) return null;
  const wa = channelLabel(last.call_channel, last.call_media);
  const icon = wa ? '💬' : '📞';
  const what =
    last.call_outcome === 'message'
      ? `${wa} ${last.call_direction === 'incoming' ? 'received' : 'sent'}`
      : `${last.call_direction === 'incoming' && last.call_outcome === 'connected' ? 'Incoming · ' : ''}${outcomeInfo(last.call_outcome).label}`;
  const length = last.call_outcome === 'connected' ? formatDuration(last.call_duration_sec) : null;
  const who = nameOf(last.call_by);
  return [`${icon} ${what}${length ? ` ${length}` : ''}`, ago(last.call_at), who].filter(Boolean).join(' · ');
}

/** Days since the last contact (null = never) */
export function daysSince(iso: string | null): number | null {
  if (!iso) return null;
  return Math.floor((Date.now() - new Date(iso).getTime()) / 86400000);
}

// ---------------------------------------------------------------------
// Settings → Lead cards: after how many days without contact a card turns orange
// ---------------------------------------------------------------------
export type CardSettings = { stale_days: number };
export const DEFAULT_CARD_SETTINGS: CardSettings = { stale_days: 7 };

export async function getCardSettings(): Promise<CardSettings> {
  try {
    const saved = await getSetting<Partial<CardSettings>>('lead_cards');
    return { ...DEFAULT_CARD_SETTINGS, ...(saved ?? {}) };
  } catch {
    return DEFAULT_CARD_SETTINGS;
  }
}

// ---------------------------------------------------------------------
// Compact / Detailed cards: each person's own choice, on this phone
// ---------------------------------------------------------------------
const DETAIL_KEY = 'lead_cards_detailed';

export async function loadDetailed(): Promise<boolean> {
  try {
    return (await AsyncStorage.getItem(DETAIL_KEY)) !== 'no';
  } catch {
    return true;
  }
}

export function saveDetailed(on: boolean): void {
  AsyncStorage.setItem(DETAIL_KEY, on ? 'yes' : 'no').catch(() => undefined);
}

export async function saveCardSettings(s: CardSettings): Promise<void> {
  await updateSetting('lead_cards', s as unknown as Json);
}
