import AsyncStorage from '@react-native-async-storage/async-storage';
import Constants from 'expo-constants';
import { PermissionsAndroid, Platform } from 'react-native';

import { getSetting, updateSetting } from '@/features/settings/api';
import { supabase } from '@/shared/lib/supabase';
import type { Json } from '@/shared/types/database';
import {
  callById,
  captureNow,
  clearLeadDirectory as clearNativeDirectory,
  getCallLogPermissions,
  getDeviceId,
  getLeadDirectorySize,
  getNotifySettings,
  getPendingCalls,
  getPendingCount,
  getSimFilter,
  getSims,
  hasCallNotifications,
  isCallLogAvailable,
  isCallSyncEnabled,
  latestCallFor,
  markAppCall,
  removePendingCalls,
  setCallSyncEnabled,
  setLeadDirectory,
  setNotifySettings,
  type DeviceCall,
  type DirectoryEntry,
  type NotifySettings,
} from '../../../modules/call-log';

export { hasCallNotifications, isCallLogAvailable, type DeviceCall, type NotifySettings };

// =====================================================================
// Admin setting (Settings → Call log sync)
// =====================================================================
export type CallSyncMode = 'all' | 'roles' | 'users';

export type CallSyncSettings = {
  enabled: boolean;
  mode: CallSyncMode;
  roles: string[];
  user_ids: string[];
  incoming: boolean;
  missed_follow_up: boolean;
  connected_min_sec: number;
  unreachable_after: number;
  unreachable_retry_days: number;
};

export const DEFAULT_CALL_SYNC: CallSyncSettings = {
  enabled: true,
  mode: 'all',
  roles: ['admin', 'team_lead', 'caller'],
  user_ids: [],
  incoming: true,
  missed_follow_up: true,
  connected_min_sec: 5,
  unreachable_after: 5,
  unreachable_retry_days: 7,
};

export async function getCallSyncSettings(): Promise<CallSyncSettings> {
  try {
    const saved = await getSetting<Partial<CallSyncSettings>>('call_sync');
    return { ...DEFAULT_CALL_SYNC, ...(saved ?? {}) };
  } catch {
    return DEFAULT_CALL_SYNC;
  }
}

export async function saveCallSyncSettings(settings: CallSyncSettings): Promise<void> {
  await updateSetting('call_sync', settings as unknown as Json);
}

/** Is this user allowed to sync (admin setting)? */
export async function canSyncCalls(): Promise<boolean> {
  const { data, error } = await supabase.rpc('can_sync_calls');
  if (error) return false;
  return !!data;
}

// =====================================================================
// Phone permissions
// =====================================================================
export type CallPermissionState = 'granted' | 'denied' | 'blocked' | 'unavailable';

export function callPermissionState(): CallPermissionState {
  if (!isCallLogAvailable) return 'unavailable';
  const p = getCallLogPermissions();
  return p.callLog && p.phoneState ? 'granted' : 'denied';
}

/** Ask for call log + phone state. "blocked" = the user chose "Don't ask again". */
export async function askCallPermissions(): Promise<CallPermissionState> {
  if (!isCallLogAvailable || Platform.OS !== 'android') return 'unavailable';

  const result = await PermissionsAndroid.requestMultiple([
    PermissionsAndroid.PERMISSIONS.READ_CALL_LOG,
    PermissionsAndroid.PERMISSIONS.READ_PHONE_STATE,
  ]);
  const values = Object.values(result);
  if (values.every((v) => v === PermissionsAndroid.RESULTS.GRANTED)) return 'granted';
  if (values.some((v) => v === PermissionsAndroid.RESULTS.NEVER_ASK_AGAIN)) return 'blocked';
  return 'denied';
}

// =====================================================================
// Notifications ("add a note" after a call, "lead is calling")
// =====================================================================
/** Can the app show notifications right now? */
export function notificationPermissionState(): CallPermissionState {
  if (!hasCallNotifications) return 'unavailable';
  return getCallLogPermissions().notifications ? 'granted' : 'denied';
}

/**
 * Android 13+ asks the user; older phones allow it by default
 * (unless the user turned notifications off in the phone's settings).
 */
export async function askNotificationPermission(): Promise<CallPermissionState> {
  if (!hasCallNotifications || Platform.OS !== 'android') return 'unavailable';

  if (Number(Platform.Version) >= 33) {
    const r = await PermissionsAndroid.request(PermissionsAndroid.PERMISSIONS.POST_NOTIFICATIONS);
    if (r === PermissionsAndroid.RESULTS.NEVER_ASK_AGAIN) return 'blocked';
    if (r !== PermissionsAndroid.RESULTS.GRANTED) return 'denied';
  }
  // Granted, or an older phone: check whether notifications are switched on
  return getCallLogPermissions().notifications ? 'granted' : 'blocked';
}

export function getCallNotifySettings(): NotifySettings {
  return getNotifySettings();
}

export function setCallNotifySettings(s: Partial<NotifySettings>): void {
  setNotifySettings(s);
}

// =====================================================================
// Turning sync on/off on this phone
// =====================================================================
export { isCallSyncEnabled };

/** Turns the on-phone capture on (needs permission) or off */
export function setPhoneCallSync(enabled: boolean): void {
  const on = enabled && callPermissionState() === 'granted';
  setCallSyncEnabled(on);
  if (on) {
    refreshLeadDirectory(true).catch(() => undefined);
  } else {
    clearNativeDirectory();
  }
}

// =====================================================================
// Lead directory on the phone (names for notifications)
// =====================================================================
const DIR_REFRESH_KEY = 'call_sync_directory_at';
const DIR_EVERY_MS = 15 * 60 * 1000;

/**
 * Saves the user's leads (number hash, name, rating…) on the phone,
 * so it can show who is calling with no internet. At most every 15 minutes
 * unless forced (e.g. right after sync is turned on).
 */
export async function refreshLeadDirectory(force = false): Promise<number> {
  if (!hasCallNotifications || !isCallSyncEnabled()) return 0;

  if (!force) {
    const last = Number((await AsyncStorage.getItem(DIR_REFRESH_KEY).catch(() => null)) ?? 0);
    if (Date.now() - last < DIR_EVERY_MS && getLeadDirectorySize() > 0) return getLeadDirectorySize();
  }

  const { data, error } = await supabase.rpc('my_lead_directory');
  if (error) throw new Error(error.message);

  const saved = await setLeadDirectory((data ?? []) as unknown as DirectoryEntry[]);
  await AsyncStorage.setItem(DIR_REFRESH_KEY, String(Date.now())).catch(() => undefined);
  return saved;
}

/** On logout: remove all lead names from the phone and stop capturing */
export async function clearPhoneCallData(): Promise<void> {
  if (!isCallLogAvailable) return;
  clearNativeDirectory();
  setCallSyncEnabled(false);
  await AsyncStorage.multiRemove([DIR_REFRESH_KEY, LAST_SYNC_KEY]).catch(() => undefined);
}

// =====================================================================
// Sync health: tell the server how this phone is doing
// =====================================================================
function simLabel(): string {
  const filter = getSimFilter();
  if (!filter) return 'All SIMs';
  return getSims().find((s) => s.id === filter)?.label ?? 'One SIM';
}

export async function reportSyncStatus(error?: string | null): Promise<void> {
  const deviceId = getDeviceId();
  if (!deviceId) return;

  const info = {
    device_label: `${Constants.deviceName ?? 'Android'} · Android ${Platform.Version}`,
    app_version: Constants.expoConfig?.version ?? null,
    permission_ok: callPermissionState() === 'granted',
    sync_on: isCallSyncEnabled(),
    sim_label: simLabel(),
    pending_count: getPendingCount(),
    error: error ?? null,
  };

  await supabase
    .rpc('report_sync_status', { p_device_id: deviceId, p_info: info as unknown as Json })
    .then(() => undefined, () => undefined);
}

// =====================================================================
// Sync: phone queue → server
// =====================================================================
const LAST_SYNC_KEY = 'call_sync_last_at';
const CHUNK = 200;

export type SyncResult = { sent: number; added: number; matched: number; ignored: number };

let running: Promise<SyncResult> | null = null;

async function uploadQueue(): Promise<SyncResult> {
  const total: SyncResult = { sent: 0, added: 0, matched: 0, ignored: 0 };

  await captureNow();

  const deviceId = getDeviceId();
  const pending = getPendingCalls();
  if (!deviceId || pending.length === 0) return total;

  for (let i = 0; i < pending.length; i += CHUNK) {
    const part = pending.slice(i, i + CHUNK);
    const { data, error } = await supabase.rpc('sync_phone_calls', {
      p_device_id: deviceId,
      p_calls: part as unknown as Json,
    });
    if (error) throw new Error(error.message);

    const r = data as unknown as { added: number; matched: number; ignored: number };
    total.sent += part.length;
    total.added += r.added;
    total.matched += r.matched;
    total.ignored += r.ignored;

    // The server has handled these (stored, matched, or ignored as non-leads)
    removePendingCalls(part.map((c) => c.id));
  }
  return total;
}

/**
 * 1. Copy new calls from the call log into the phone's queue
 * 2. Send the queue to the server, 200 at a time, and remove what it accepted
 * 3. Refresh the on-phone lead directory (every 15 min)
 * 4. Report this phone's health to the server
 * Only one sync runs at a time; a second call just waits for the first.
 */
export function syncCallsNow(): Promise<SyncResult> {
  if (running) return running;

  running = (async () => {
    if (!isCallLogAvailable || !isCallSyncEnabled()) {
      return { sent: 0, added: 0, matched: 0, ignored: 0 };
    }

    try {
      const total = await uploadQueue();
      await AsyncStorage.setItem(LAST_SYNC_KEY, new Date().toISOString()).catch(() => undefined);
      await refreshLeadDirectory().catch(() => undefined);
      await reportSyncStatus(null);
      return total;
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      await reportSyncStatus(msg);
      throw e;
    }
  })().finally(() => {
    running = null;
  });

  return running;
}

/** When the last successful sync finished (on this phone) */
export async function lastSyncAt(): Promise<Date | null> {
  try {
    const v = await AsyncStorage.getItem(LAST_SYNC_KEY);
    return v ? new Date(v) : null;
  } catch {
    return null;
  }
}

/** How many calls are waiting on this phone */
export function pendingCount(): number {
  return getPendingCount();
}

/** How many leads are saved on this phone for caller names */
export function directorySize(): number {
  return getLeadDirectorySize();
}

// =====================================================================
// For the after-call popup
// =====================================================================
/**
 * The app's Call button was pressed: remember it, so the phone doesn't
 * also show an "add a note" notification (the app shows its own popup).
 */
export function markCallFromApp(phone: string): void {
  if (isCallLogAvailable) markAppCall(phone);
}

/**
 * The real call with this number, made after the user tapped Call.
 * Tries a few times, because the phone writes its call log a moment after the call.
 */
export async function findDeviceCall(phone: string, sinceMs: number): Promise<DeviceCall | null> {
  if (!isCallLogAvailable || callPermissionState() !== 'granted') return null;

  for (const wait of [0, 800, 1500]) {
    if (wait) await new Promise((r) => setTimeout(r, wait));
    const call = await latestCallFor(phone, sinceMs - 5000);
    if (call) return call;
  }
  return null;
}

/** A call by its call-log id (from the "add a note" notification) */
export async function getCallById(id: string): Promise<DeviceCall | null> {
  if (!isCallLogAvailable || callPermissionState() !== 'granted') return null;
  return callById(id);
}

/** This phone's id, sent with calls saved from the popup */
export { getDeviceId };
