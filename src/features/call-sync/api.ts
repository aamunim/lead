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
  clearWhatsApp,
  getCallLogPermissions,
  getDeviceId,
  getLeadDirectorySize,
  getNotifySettings,
  getPendingCalls,
  getPendingCount,
  getSimFilter,
  getSims,
  getWhatsAppPending,
  getWhatsAppPendingCount,
  getWhatsAppStatus,
  hasCallNotifications,
  hasWhatsAppSync,
  isCallLogAvailable,
  isCallSyncEnabled,
  latestCallFor,
  markAppCall,
  openAppDetails,
  openNotificationAccess,
  removePendingCalls,
  removeWhatsAppPending,
  setCallSyncEnabled,
  setLeadDirectory,
  setNotifySettings,
  setWhatsAppEnabled,
  whatsAppEventById,
  type DeviceCall,
  type DirectoryEntry,
  type NotifySettings,
  type WhatsAppDeviceEvent,
  type WhatsAppStatus,
} from '../../../modules/call-log';

export {
  hasCallNotifications,
  hasWhatsAppSync,
  isCallLogAvailable,
  openAppDetails,
  openNotificationAccess,
  type DeviceCall,
  type NotifySettings,
  type WhatsAppDeviceEvent,
  type WhatsAppStatus,
};

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
  /** 💬 After WhatsApp is opened from the app, ask what happened */
  whatsapp_ask_after: boolean;
  /** 📞 Calls with numbers that are not leads yet wait on the server; saved as a lead → they join it */
  hold_calls: boolean;
  /** …for this many days */
  hold_days: number;
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
  whatsapp_ask_after: true,
  hold_calls: true,
  hold_days: 15,
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
    setWhatsAppEnabled(false); // WhatsApp needs the lead directory too
  }
}

// =====================================================================
// 💬 WhatsApp sync on this phone (reads WhatsApp's notifications)
//   Needs: call log sync on (for the lead directory) and Android's
//   "Notification access" for this app.
// =====================================================================
export function whatsAppStatus(): WhatsAppStatus {
  return getWhatsAppStatus();
}

/** Turn WhatsApp sync on/off on this phone; returns the new status */
export function setWhatsAppSync(enabled: boolean): WhatsAppStatus {
  setWhatsAppEnabled(enabled && isCallSyncEnabled());
  return getWhatsAppStatus();
}

export function whatsAppPendingCount(): number {
  return getWhatsAppPendingCount();
}

/** A WhatsApp call still on the phone (for "add a note" from its notification) */
export function getWhatsAppEvent(id: string): WhatsAppDeviceEvent | null {
  return whatsAppEventById(id);
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
  clearWhatsApp();
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
    pending_count: getPendingCount() + getWhatsAppPendingCount(),
    error: error ?? null,
    ...(hasWhatsAppSync ? { wa_on: getWhatsAppStatus().enabled, wa_access: getWhatsAppStatus().access } : {}),
  };

  await supabase
    .rpc('report_sync_status', { p_device_id: deviceId, p_info: info as unknown as Json })
    .then(() => undefined, () => undefined);
}

// =====================================================================
// Sync: phone queue → server
// =====================================================================
const LAST_SYNC_KEY = 'call_sync_last_at';
// Calls per request; a part the server is too slow with is sent again in smaller pieces
const CHUNK = 50;
const SMALL_CHUNK = 10;

const isTimeout = (message: string) => /statement timeout|canceling statement|timed out|timeout/i.test(message);

/** A short, plain message instead of the database's own words */
export function syncErrorText(message: string): string {
  if (isTimeout(message)) return 'The server was busy. The calls are kept on this phone and will be sent on the next sync.';
  if (/network request failed|fetch/i.test(message)) return 'No internet. The calls are kept on this phone and will be sent later.';
  return message;
}

type CallPart = ReturnType<typeof getPendingCalls>;

/** Send one part; if the server runs out of time, try again 10 at a time */
async function sendCalls(deviceId: string, part: CallPart): Promise<{ added: number; matched: number; ignored: number }> {
  const { data, error } = await supabase.rpc('sync_phone_calls', {
    p_device_id: deviceId,
    p_calls: part as unknown as Json,
  });
  if (!error) return data as unknown as { added: number; matched: number; ignored: number };
  if (!isTimeout(error.message) || part.length <= SMALL_CHUNK) throw new Error(error.message);

  const r = { added: 0, matched: 0, ignored: 0 };
  for (let i = 0; i < part.length; i += SMALL_CHUNK) {
    const small = part.slice(i, i + SMALL_CHUNK);
    const one = await sendCalls(deviceId, small);
    r.added += one.added;
    r.matched += one.matched;
    r.ignored += one.ignored;
    // Keep what got through, even if a later piece fails
    removePendingCalls(small.map((c) => c.id));
  }
  return r;
}

export type SyncResult = { sent: number; added: number; matched: number; ignored: number };

let running: Promise<SyncResult> | null = null;

async function uploadQueue(): Promise<SyncResult> {
  const total: SyncResult = { sent: 0, added: 0, matched: 0, ignored: 0 };

  await captureNow();

  const deviceId = getDeviceId();
  const pending = getPendingCalls();
  if (!deviceId || (pending.length === 0 && getWhatsAppPendingCount() === 0)) return total;

  for (let i = 0; i < pending.length; i += CHUNK) {
    const part = pending.slice(i, i + CHUNK);
    const r = await sendCalls(deviceId, part);
    total.sent += part.length;
    total.added += r.added;
    total.matched += r.matched;
    total.ignored += r.ignored;

    // The server has handled these (stored, matched, or ignored as non-leads)
    removePendingCalls(part.map((c) => c.id));
  }

  // 💬 WhatsApp calls and messages (already matched to leads on the phone)
  const waEvents = getWhatsAppPending();
  for (let i = 0; i < waEvents.length; i += CHUNK) {
    const part = waEvents.slice(i, i + CHUNK);
    const { data, error } = await supabase.rpc('sync_whatsapp_events', {
      p_device_id: deviceId,
      p_events: part as unknown as Json,
    });
    if (error) throw new Error(error.message);
    const r = data as unknown as { added: number; ignored: number };
    total.sent += part.length;
    total.added += r.added;
    total.ignored += r.ignored;
    removeWhatsAppPending(part.map((e) => e.id));
  }
  return total;
}

/**
 * 1. Copy new calls from the call log into the phone's queue
 * 2. Send the queue to the server, 50 at a time (10 if the server is slow), and remove what it accepted
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
      throw new Error(syncErrorText(msg));
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
