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
};

export type NotifySettings = { afterCall: boolean; incoming: boolean };

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
  markAppCall(number: string): void;
  setLeadDirectory(json: string): Promise<number>;
  clearLeadDirectory(): void;
  getLeadDirectorySize(): number;
  getNotifySettings(): NotifySettings;
  setNotifySettings(afterCall: boolean | null, incoming: boolean | null): void;
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