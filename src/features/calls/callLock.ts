import AsyncStorage from '@react-native-async-storage/async-storage';
import { Alert } from 'react-native';

import { getSetting, updateSetting } from '@/features/settings/api';
import { supabase } from '@/shared/lib/supabase';
import type { Json } from '@/shared/types/database';
import { hasNativeCallLock, setNativeCallLock } from '../../../modules/call-log';

// =====================================================================
// 📵 Call lock: one person on a call with a lead at a time.
//   Before a call from the app the lead is marked "on call"; someone else
//   tapping Call then sees "🚫 Rahim is on a call with this lead".
//   The mark goes when the call result opens (back in the app), the
//   moment the call ends (2.8.0 phones), or by itself after N minutes.
// =====================================================================

export type CallLockSettings = {
  enabled: boolean;
  /** block: can't call (some may call anyway) · warn: asks "Call anyway?" */
  mode: 'block' | 'warn';
  /** The mark ends by itself after this many minutes */
  minutes: number;
  /** Who may call anyway when it blocks */
  override: 'none' | 'admin' | 'admin_tl';
  /** WhatsApp calls too */
  whatsapp: boolean;
  /** "📞 Rahim is on a call" on the list cards */
  cards: boolean;
};

export const DEFAULT_CALL_LOCK: CallLockSettings = {
  enabled: true,
  mode: 'block',
  minutes: 15,
  override: 'admin',
  whatsapp: false,
  cards: true,
};

export async function getCallLockSettings(): Promise<CallLockSettings> {
  try {
    const saved = await getSetting<Partial<CallLockSettings>>('call_lock');
    return { ...DEFAULT_CALL_LOCK, ...(saved ?? {}) };
  } catch {
    return DEFAULT_CALL_LOCK;
  }
}

export async function saveCallLockSettings(s: CallLockSettings): Promise<void> {
  await updateSetting('call_lock', s as unknown as Json);
}

type LockAnswer = {
  ok: boolean;
  mode?: 'block' | 'warn';
  by_name?: string | null;
  minutes?: number;
  channel?: string;
  can_override?: boolean;
};

async function start(leadId: string, channel: 'phone' | 'whatsapp', force = false): Promise<LockAnswer> {
  const ask = supabase
    .rpc('start_call_lock', { p_lead: leadId, p_channel: channel, p_force: force })
    .then(({ data, error }) => (error ? { ok: true } : ((data as unknown as LockAnswer) ?? { ok: true })));
  // No answer in 2.5 seconds (slow or no internet): call as before
  const timeout = new Promise<LockAnswer>((resolve) => setTimeout(() => resolve({ ok: true }), 2500));
  try {
    return await Promise.race([ask, timeout]);
  } catch {
    return { ok: true };
  }
}

const firstName = (n: string | null | undefined) => (n ?? '').trim().split(' ')[0] || 'Someone';
const since = (m: number | undefined) => (!m || m <= 0 ? 'just now' : m === 1 ? 'for 1 minute' : `for ${m} minutes`);

/**
 * Before a call: marks the lead "on call", or tells who is on a call with it.
 * Resolves true = call, false = don't.
 */
export async function confirmLock(leadId: string, channel: 'phone' | 'whatsapp' = 'phone'): Promise<boolean> {
  const r = await start(leadId, channel);
  if (r.ok) return true;

  const who = firstName(r.by_name);
  const warn = r.mode === 'warn';
  const title = `${warn ? '⚠️' : '🚫'} ${who} is on a call with this lead`;
  const body = `${r.channel === 'whatsapp' ? 'On WhatsApp' : 'On the phone'} ${since(r.minutes)}.\n\n${
    warn ? 'Two calls at once upset the lead. Call anyway?' : 'Try again when the call is over.'
  }`;

  return new Promise<boolean>((resolve) => {
    const buttons: { text: string; style?: 'cancel' | 'destructive'; onPress: () => void }[] = [
      { text: r.can_override ? 'Cancel' : 'OK', style: 'cancel', onPress: () => resolve(false) },
    ];
    if (r.can_override)
      buttons.push({
        text: 'Call anyway',
        style: 'destructive',
        onPress: () => {
          start(leadId, channel, true).then((again) => resolve(again.ok));
        },
      });
    Alert.alert(title, body, buttons, { cancelable: true, onDismiss: () => resolve(false) });
  });
}

/** Back from the call (the call result opens): the lead is free again */
export function endCallLock(leadId?: string | null): void {
  supabase.rpc('end_call_lock', { p_lead: leadId ?? null }).then(
    () => undefined,
    () => undefined,
  );
}

export type ActiveLock = { name: string; startedAt: Date; channel: string };

/** Who is on a call with these leads now (others, not you) */
export async function getActiveLocks(leadIds: string[]): Promise<Map<string, ActiveLock>> {
  if (leadIds.length === 0) return new Map();
  const { data, error } = await supabase.rpc('active_call_locks', { p_leads: leadIds.slice(0, 300) });
  if (error || !data) return new Map();
  return new Map(
    (data as { lead_id: string; user_name: string | null; started_at: string; channel: string }[]).map((r) => [
      r.lead_id,
      { name: firstName(r.user_name), startedAt: new Date(r.started_at), channel: r.channel },
    ]),
  );
}

// ---------------------------------------------------------------------
// 📲 2.8.0 phones: the phone itself marks an answered lead call and clears
//   the mark when any call ends. It gets a key (only for its own user).
// ---------------------------------------------------------------------
const KEY = 'callLock.deviceKey';

function newKey(): string {
  const chars = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
  const bytes = new Uint8Array(40);
  const c = (globalThis as { crypto?: { getRandomValues?: (a: Uint8Array) => Uint8Array } }).crypto;
  if (c?.getRandomValues) c.getRandomValues(bytes);
  else for (let i = 0; i < bytes.length; i++) bytes[i] = Math.floor(Math.random() * 256);
  return Array.from(bytes, (b) => chars[b % chars.length]).join('');
}

let setUpFor: string | null = null;

/** Once after sign-in: gives this phone its key (or turns its part off) */
export async function setupNativeCallLock(userId: string): Promise<void> {
  if (!hasNativeCallLock || setUpFor === userId) return;
  setUpFor = userId;
  try {
    const s = await getCallLockSettings();
    if (!s.enabled) {
      setNativeCallLock(null, null, null, false);
      return;
    }
    let key = await AsyncStorage.getItem(KEY);
    if (!key) {
      key = newKey();
      await AsyncStorage.setItem(KEY, key);
    }
    const { error } = await supabase.rpc('register_call_lock_device', { p_key: key });
    if (error) {
      setUpFor = null;
      return;
    }
    setNativeCallLock(
      process.env.EXPO_PUBLIC_SUPABASE_URL ?? null,
      process.env.EXPO_PUBLIC_SUPABASE_ANON_KEY ?? null,
      key,
      true,
    );
  } catch {
    setUpFor = null;
  }
}

/** Signed out: the phone stops marking calls */
export function clearNativeCallLock(): void {
  setUpFor = null;
  setNativeCallLock(null, null, null, false);
}
