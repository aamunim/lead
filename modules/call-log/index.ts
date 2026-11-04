import { requireOptionalNativeModule } from 'expo-modules-core';
import { Platform } from 'react-native';

// =====================================================================
// Types
// =====================================================================
export type CallDirection = 'outgoing' | 'incoming' | 'missed' | 'rejected';

/** A call waiting in the phone's queue (number already hashed) */
export type PendingCall = {
  id: string;
  hash: string;
  direction: CallDirection;
  duration_sec: number;
  called_at: string; // ISO, UTC
  sim: string | null;
};

/** One call read from the phone (for the note popup) */
export type DeviceCall = {
  id: string;
  direction: CallDirection;
  durationSec: number;
  calledAt: string;
  simId: string | null;
  simLabel: string | null;
};

export type Sim = { id: string; label: string };

export type CallLogPermissions = {
  callLog: boolean;
  phoneState: boolean;
  notifications: boolean;
};

/** One lead in the on-phone directory (from my_lead_directory()) */
export type DirectoryEntry = {
  hash: string;
  lead_id: string;
  name: string;
  rating: string | null;
  stage: string | null;
  course: string | null;
  last_note: string | null;
  // 📲 Caller card (newer databases)
  student_ref?: string | null;
  fee_due?: number | null;
  next_call?: string | null;
  owner?: string | null;
};

/** 📲 The caller card over the call screen */
export type CallerCardSettings = { allowed: boolean; enabled: boolean; unknown: boolean };

export type NotifySettings = { afterCall: boolean; incoming: boolean };

/** 💬 WhatsApp sync on this phone */
export type WhatsAppStatus = {
  /** turned on in the app */
  enabled: boolean;
  /** Android "Notification access" given to this app */
  access: boolean;
};

/** A WhatsApp call / message waiting on the phone (no names or numbers) */
export type WhatsAppEvent = {
  id: string;
  lead_id: string;
  media: 'voice' | 'video' | 'message';
  direction: 'outgoing' | 'incoming' | 'missed';
  duration_sec: number;
  connected: boolean;
  called_at: string;
};

/** One event, read for the "add a note" popup */
export type WhatsAppDeviceEvent = {
  id: string;
  leadId: string;
  media: 'voice' | 'video' | 'message';
  direction: 'outgoing' | 'incoming' | 'missed';
  durationSec: number;
  connected: boolean;
  calledAt: string;
};

type NativeCallLog = {
  getDeviceId(): string;
  getPermissions(): CallLogPermissions;
  isEnabled(): boolean;
  setEnabled(enabled: boolean): void;
  getSims(): Sim[];
  getSimFilter(): string | null;
  setSimFilter(simId: string | null): void;
  captureNow(): Promise<number>;
  getPending(): string;
  getPendingCount(): number;
  removePending(ids: string[]): void;
  latestCallFor(number: string, sinceMs: number): Promise<DeviceCall | null>;
  callById(id: string): Promise<DeviceCall | null>;
  recentCalls(limit: number): Promise<RecentCall[]>;
  markAppCall(number: string): void;
  setLeadDirectory(json: string): Promise<number>;
  clearLeadDirectory(): void;
  getLeadDirectorySize(): number;
  getNotifySettings(): NotifySettings;
  getCallerCard(): CallerCardSettings;
  setCallerCard(enabled: boolean | null, unknown: boolean | null): void;
  openOverlaySettings(): void;
  previewCallerCard(): void;
  setNotifySettings(afterCall: boolean | null, incoming: boolean | null): void;
  getWhatsAppStatus(): WhatsAppStatus;
  setWhatsAppEnabled(enabled: boolean): void;
  openNotificationAccess(): void;
  openAppDetails(): void;
  getWhatsAppPending(): string;
  getWhatsAppPendingCount(): number;
  removeWhatsAppPending(ids: string[]): void;
  whatsAppEventById(id: string): WhatsAppDeviceEvent | null;
  clearWhatsApp(): void;
  // 2.8.0
  takeNativeCrashes(): string;
  getContactGroups(): Promise<string>;
  getGroupContactIds(groupIds: string[]): Promise<string[]>;
  setCallLock(url: string | null, anonKey: string | null, deviceKey: string | null, enabled: boolean): void;
  getCallLock(): { enabled: boolean; hasKey: boolean };
};

// Missing in Expo Go and on iPhone; everything below then quietly does nothing.
const native =
  Platform.OS === 'android' ? requireOptionalNativeModule<NativeCallLog>('CallLog') : null;

// Older dev APKs don't have the newer functions yet: check before calling
function has<K extends keyof NativeCallLog>(name: K): boolean {
  return !!native && typeof (native as any)[name] === 'function';
}

// =====================================================================
// Safe wrappers
// =====================================================================
/** true on an Android build that includes this module (dev build / APK) */
export const isCallLogAvailable = !!native;

/** true when this build has the lead directory + notifications (Step 2) */
export const hasCallNotifications = has('setLeadDirectory');

export function getDeviceId(): string | null {
  return native?.getDeviceId() ?? null;
}

export function getCallLogPermissions(): CallLogPermissions {
  const p = native?.getPermissions();
  return {
    callLog: p?.callLog ?? false,
    phoneState: p?.phoneState ?? false,
    notifications: p?.notifications ?? false,
  };
}

export function isCallSyncEnabled(): boolean {
  return native?.isEnabled() ?? false;
}

export function setCallSyncEnabled(enabled: boolean): void {
  native?.setEnabled(enabled);
}

export function getSims(): Sim[] {
  return native?.getSims() ?? [];
}

export function getSimFilter(): string | null {
  return native?.getSimFilter() ?? null;
}

export function setSimFilter(simId: string | null): void {
  native?.setSimFilter(simId);
}

export async function captureNow(): Promise<number> {
  return native ? native.captureNow() : 0;
}

export function getPendingCalls(): PendingCall[] {
  if (!native) return [];
  try {
    return JSON.parse(native.getPending()) as PendingCall[];
  } catch {
    return [];
  }
}

export function getPendingCount(): number {
  if (has('getPendingCount')) return native!.getPendingCount();
  return getPendingCalls().length;
}

export function removePendingCalls(ids: string[]): void {
  if (ids.length > 0) native?.removePending(ids);
}

export async function latestCallFor(number: string, sinceMs: number): Promise<DeviceCall | null> {
  if (!native) return null;
  try {
    return await native.latestCallFor(number, sinceMs);
  } catch {
    return null;
  }
}

/** 🕘 One recent call per number (newest first), for "new lead from a recent call" */
export type RecentCall = {
  number: string;
  /** The name the phone shows for it (saved contacts), if any */
  name: string | null;
  direction: 'incoming' | 'outgoing' | 'missed' | 'rejected' | 'other';
  durationSec: number;
  calledAt: string;
};

/** true when this build can list recent calls (version 2.7 and later) */
export const hasRecentCalls = has('recentCalls');

export async function recentCalls(limit = 60): Promise<RecentCall[]> {
  if (!has('recentCalls')) return [];
  try {
    return await native!.recentCalls(limit);
  } catch {
    return [];
  }
}

export async function callById(id: string): Promise<DeviceCall | null> {
  if (!has('callById')) return null;
  try {
    return await native!.callById(id);
  } catch {
    return null;
  }
}

/** Call this right before opening the dialer from the app's Call button */
export function markAppCall(number: string): void {
  if (has('markAppCall')) native!.markAppCall(number);
}

// ---------------------------------------------------------------------
// Lead directory
// ---------------------------------------------------------------------
/** Save the user's leads on the phone; returns how many were saved */
export async function setLeadDirectory(entries: DirectoryEntry[]): Promise<number> {
  if (!has('setLeadDirectory')) return 0;
  try {
    return await native!.setLeadDirectory(JSON.stringify(entries));
  } catch {
    return 0;
  }
}

/** On logout: remove all lead names from the phone */
export function clearLeadDirectory(): void {
  if (has('clearLeadDirectory')) native!.clearLeadDirectory();
}

export function getLeadDirectorySize(): number {
  return has('getLeadDirectorySize') ? native!.getLeadDirectorySize() : 0;
}

// ---------------------------------------------------------------------
// Notifications
// ---------------------------------------------------------------------
export function getNotifySettings(): NotifySettings {
  if (!has('getNotifySettings')) return { afterCall: false, incoming: false };
  return native!.getNotifySettings();
}

export function setNotifySettings(s: Partial<NotifySettings>): void {
  if (has('setNotifySettings')) native!.setNotifySettings(s.afterCall ?? null, s.incoming ?? null);
}

// ---------------------------------------------------------------------
// 📲 Caller card (newer builds only: null when this build has none)
// ---------------------------------------------------------------------
export const hasCallerCard = has('getCallerCard');

export function getCallerCard(): CallerCardSettings | null {
  return hasCallerCard ? native!.getCallerCard() : null;
}

export function setCallerCard(s: Partial<Pick<CallerCardSettings, 'enabled' | 'unknown'>>): void {
  if (hasCallerCard) native!.setCallerCard(s.enabled ?? null, s.unknown ?? null);
}

export function openOverlaySettings(): void {
  if (hasCallerCard) native!.openOverlaySettings();
}

export function previewCallerCard(): void {
  if (hasCallerCard) native!.previewCallerCard();
}
// ---------------------------------------------------------------------
// 💬 WhatsApp (read from WhatsApp's notifications; newer builds only)
// ---------------------------------------------------------------------
/** true when this build can read WhatsApp's notifications */
export const hasWhatsAppSync = has('getWhatsAppStatus');

export function getWhatsAppStatus(): WhatsAppStatus {
  if (!hasWhatsAppSync) return { enabled: false, access: false };
  return native!.getWhatsAppStatus();
}

export function setWhatsAppEnabled(enabled: boolean): void {
  if (hasWhatsAppSync) native!.setWhatsAppEnabled(enabled);
}

export function openNotificationAccess(): void {
  if (has('openNotificationAccess')) native!.openNotificationAccess();
}

export function openAppDetails(): void {
  if (has('openAppDetails')) native!.openAppDetails();
}

export function getWhatsAppPending(): WhatsAppEvent[] {
  if (!has('getWhatsAppPending')) return [];
  try {
    return JSON.parse(native!.getWhatsAppPending()) as WhatsAppEvent[];
  } catch {
    return [];
  }
}

export function getWhatsAppPendingCount(): number {
  return has('getWhatsAppPendingCount') ? native!.getWhatsAppPendingCount() : 0;
}

export function removeWhatsAppPending(ids: string[]): void {
  if (ids.length > 0 && has('removeWhatsAppPending')) native!.removeWhatsAppPending(ids);
}

export function whatsAppEventById(id: string): WhatsAppDeviceEvent | null {
  if (!has('whatsAppEventById')) return null;
  try {
    return native!.whatsAppEventById(id);
  } catch {
    return null;
  }
}

export function clearWhatsApp(): void {
  if (has('clearWhatsApp')) native!.clearWhatsApp();
}

// =====================================================================
// 2.8.0: 💥 Android crashes · 👥 contact groups · 📵 call lock
// =====================================================================
export type NativeCrashItem = { name: string; message: string; stack: string; thread: string; at: number };

/** Crashes in the Android part since the last time (and they are cleared) */
export function takeNativeCrashes(): NativeCrashItem[] {
  if (!has('takeNativeCrashes')) return [];
  try {
    return JSON.parse(native!.takeNativeCrashes()) as NativeCrashItem[];
  } catch {
    return [];
  }
}

export type ContactGroup = { key: string; title: string; count: number; ids: string[] };

export const hasContactGroups = has('getContactGroups');

export async function getContactGroups(): Promise<ContactGroup[]> {
  if (!hasContactGroups) return [];
  try {
    return JSON.parse(await native!.getContactGroups()) as ContactGroup[];
  } catch {
    return [];
  }
}

export async function getGroupContactIds(groupIds: string[]): Promise<string[]> {
  if (!has('getGroupContactIds')) return [];
  try {
    return await native!.getGroupContactIds(groupIds);
  } catch {
    return [];
  }
}

export const hasNativeCallLock = has('setCallLock');

export function setNativeCallLock(url: string | null, anonKey: string | null, deviceKey: string | null, enabled: boolean): void {
  if (hasNativeCallLock) native!.setCallLock(url, anonKey, deviceKey, enabled);
}
