import { NUDGE_COOLDOWN_MIN } from '@/features/nudges/api';
import { supabase } from '@/shared/lib/supabase';
import { colors } from '@/shared/theme';

// =====================================================================
// Sync health: how each user's phone is doing with call log sync
// =====================================================================

/** Not synced for longer than this → "late" */
export const LATE_AFTER_HOURS = 24;
/** This many calls waiting on the phone → "late" */
export const BACKLOG_LIMIT = 20;

export type HealthStatus = 'problem' | 'late' | 'not_set_up' | 'ok' | 'not_allowed';

export type HealthRow = {
  userId: string;
  userName: string;
  roleKey: string | null;
  teamLeadId: string | null;
  allowed: boolean;

  // Phone (all null when the user has never set it up)
  deviceId: string | null;
  deviceLabel: string | null;
  appVersion: string | null;
  permissionOk: boolean | null;
  syncOn: boolean | null;
  simLabel: string | null;
  pendingCount: number;
  lastSyncAt: Date | null;
  lastError: string | null;
  updatedAt: Date | null;

  phoneCallsToday: number;
  lastPhoneCallAt: Date | null;

  // 💬 WhatsApp on this phone (null = app version without it)
  waOn: boolean | null;
  waAccess: boolean | null;
  waToday: number;

  // Last reminder from the Super Admin
  nudgeAt: Date | null;
  nudgeSeenAt: Date | null;
  nudgeOpen: boolean;

  // Worked out here
  status: HealthStatus;
  /** Short reasons shown on the card, worst first */
  problems: string[];
};

type RawRow = {
  user_id: string;
  user_name: string | null;
  role_key: string | null;
  team_lead_id: string | null;
  allowed: boolean | null;
  device_id: string | null;
  device_label: string | null;
  app_version: string | null;
  permission_ok: boolean | null;
  sync_on: boolean | null;
  sim_label: string | null;
  pending_count: number | null;
  last_sync_at: string | null;
  last_error: string | null;
  updated_at: string | null;
  phone_calls_today: number | null;
  last_phone_call_at: string | null;
  nudge_at: string | null;
  nudge_seen_at: string | null;
  nudge_open: boolean | null;
  wa_on: boolean | null;
  wa_access: boolean | null;
  wa_today: number | null;
};

// =====================================================================
// Status
// =====================================================================
const toDate = (v: string | null) => (v ? new Date(v) : null);

function hoursSince(d: Date | null): number | null {
  return d ? (Date.now() - d.getTime()) / 3_600_000 : null;
}

function workOut(row: Omit<HealthRow, 'status' | 'problems'>): Pick<HealthRow, 'status' | 'problems'> {
  if (!row.deviceId) {
    return row.allowed
      ? { status: 'not_set_up', problems: ['Has not turned on call sync on a phone yet'] }
      : { status: 'not_allowed', problems: [] };
  }

  const red: string[] = [];
  const amber: string[] = [];

  if (!row.allowed) red.push('Sync is not allowed for this user (admin setting)');
  if (row.syncOn === false) red.push('Sync is turned off on the phone');
  if (row.permissionOk === false) red.push('Call log permission is off');
  if (row.lastError) red.push(`Last sync failed: ${row.lastError}`);

  const hours = hoursSince(row.lastSyncAt);
  if (hours == null) amber.push('Never synced successfully');
  else if (hours > LATE_AFTER_HOURS) amber.push(`Not synced for ${formatAgo(row.lastSyncAt)}`);

  if (row.pendingCount >= BACKLOG_LIMIT) amber.push(`${row.pendingCount} calls waiting on the phone`);

  if (red.length > 0) return { status: 'problem', problems: [...red, ...amber] };
  if (amber.length > 0) return { status: 'late', problems: amber };
  return { status: 'ok', problems: [] };
}

/** Worst first: what needs attention comes to the top */
const ORDER: Record<HealthStatus, number> = { problem: 0, late: 1, not_set_up: 2, ok: 3, not_allowed: 4 };

export const STATUS_INFO: Record<HealthStatus, { label: string; icon: string; color: string }> = {
  problem: { label: 'Problem', icon: '🔴', color: colors.danger },
  late: { label: 'Late', icon: '🟡', color: colors.warning },
  not_set_up: { label: 'Not set up', icon: '⚪', color: colors.textMuted },
  ok: { label: 'Working', icon: '🟢', color: colors.success },
  not_allowed: { label: 'Not allowed', icon: '🚫', color: colors.textMuted },
};

// =====================================================================
// Reminders
// =====================================================================
/** Needs a reminder: something is wrong and the user is allowed to sync */
export function needsReminder(row: HealthRow): boolean {
  return row.allowed && (row.status === 'problem' || row.status === 'late' || row.status === 'not_set_up');
}

/** Minutes left before this person can be reminded again (0 = can remind now) */
export function cooldownLeft(row: HealthRow): number {
  if (!row.nudgeAt) return 0;
  const passed = (Date.now() - row.nudgeAt.getTime()) / 60000;
  return Math.max(0, Math.ceil(NUDGE_COOLDOWN_MIN - passed));
}

/** "Reminded 2 h ago · Not seen yet" / "Reminded 2 h ago · Seen 10 min ago" (only while open) */
export function reminderLine(row: HealthRow): string | null {
  if (!row.nudgeAt || !row.nudgeOpen) return null;
  const seen = row.nudgeSeenAt ? `Seen ${formatAgo(row.nudgeSeenAt)}` : 'Not seen yet';
  return `🔔 Reminded ${formatAgo(row.nudgeAt)} · ${seen}`;
}

// =====================================================================
// Load
// =====================================================================
function toError(error: { message: string }): Error {
  const m = error.message.toLowerCase();
  if (m.includes('network request failed') || m.includes('fetch')) {
    return new Error('No internet connection. Please try again.');
  }
  return new Error(error.message);
}

export async function listSyncHealth(): Promise<HealthRow[]> {
  const { data, error } = await supabase.rpc('call_sync_health');
  if (error) throw toError(error);

  const rows = ((data ?? []) as unknown as RawRow[]).map((r) => {
    const base = {
      userId: r.user_id,
      userName: r.user_name ?? 'No name',
      roleKey: r.role_key,
      teamLeadId: r.team_lead_id,
      allowed: !!r.allowed,
      deviceId: r.device_id,
      deviceLabel: r.device_label,
      appVersion: r.app_version,
      permissionOk: r.permission_ok,
      syncOn: r.sync_on,
      simLabel: r.sim_label,
      pendingCount: r.pending_count ?? 0,
      lastSyncAt: toDate(r.last_sync_at),
      lastError: r.last_error,
      updatedAt: toDate(r.updated_at),
      phoneCallsToday: r.phone_calls_today ?? 0,
      lastPhoneCallAt: toDate(r.last_phone_call_at),
      nudgeAt: toDate(r.nudge_at),
      nudgeSeenAt: toDate(r.nudge_seen_at),
      nudgeOpen: !!r.nudge_open,
      waOn: r.wa_on,
      waAccess: r.wa_access,
      waToday: r.wa_today ?? 0,
    };
    return { ...base, ...workOut(base) };
  });

  return rows.sort(
    (a, b) => ORDER[a.status] - ORDER[b.status] || a.userName.localeCompare(b.userName),
  );
}

/** Remove an old phone from the list (saved calls stay) */
export async function forgetSyncDevice(userId: string, deviceId: string): Promise<void> {
  const { error } = await supabase.rpc('forget_sync_device', {
    p_user_id: userId,
    p_device_id: deviceId,
  });
  if (error) throw toError(error);
}

/** How many users/phones in each status */
export function countByStatus(rows: HealthRow[]): Record<HealthStatus, number> {
  const counts: Record<HealthStatus, number> = { problem: 0, late: 0, not_set_up: 0, ok: 0, not_allowed: 0 };
  for (const r of rows) counts[r.status]++;
  return counts;
}

// =====================================================================
// Small helpers for showing times
// =====================================================================
/** "Just now", "12 min ago", "5 h ago", "3 days ago" */
export function formatAgo(d: Date | null): string {
  if (!d) return 'Never';
  const mins = Math.round((Date.now() - d.getTime()) / 60000);
  if (mins < 1) return 'Just now';
  if (mins < 60) return `${mins} min ago`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `${hours} h ago`;
  const days = Math.round(hours / 24);
  return days === 1 ? '1 day ago' : `${days} days ago`;
}