import type { Json } from '@/shared/types/database';

import { getSetting, updateSetting } from '@/features/settings/api';

// =====================================================================
// The assignment setting (same shape as in the database)
// =====================================================================
export type Visibility = 'assigned' | 'everyone';

export type AssignmentSettings = {
  /** Main switch. Off = no assigning, everyone sees every lead */
  enabled: boolean;
  /** With the switch on: by role, or everyone sees all */
  visibility: Visibility;
  /** Leads added by admins go to admin_auto_user_id */
  admin_auto: boolean;
  admin_auto_user_id: string | null;
  /** Callers get the leads they add */
  caller_self: boolean;
  /** Team Leads can assign within their own team */
  team_lead_assign: boolean;
  /** Team Leads get the leads they add */
  team_lead_self: boolean;
};

export const DEFAULT_ASSIGNMENT: AssignmentSettings = {
  enabled: true,
  visibility: 'assigned',
  admin_auto: false,
  admin_auto_user_id: null,
  caller_self: true,
  team_lead_assign: true,
  team_lead_self: true,
};

// =====================================================================
// Read / save
// =====================================================================
/** Reads the setting; anything missing falls back to the default */
export async function getAssignmentSettings(): Promise<AssignmentSettings> {
  try {
    const saved = await getSetting<Partial<AssignmentSettings>>('assignment');
    return { ...DEFAULT_ASSIGNMENT, ...(saved ?? {}) };
  } catch {
    return DEFAULT_ASSIGNMENT;
  }
}

export async function saveAssignmentSettings(settings: AssignmentSettings): Promise<void> {
  await updateSetting('assignment', settings as unknown as Json);
}

// =====================================================================
// Small helpers used across the app
// =====================================================================
/** true when every active user can see and work on every lead */
export function isSharedMode(s: AssignmentSettings): boolean {
  return !s.enabled || s.visibility === 'everyone';
}

/**
 * Can this user pick an assignee by hand?
 *   - switch on, and
 *   - admin (leads.assign + leads.view_all), or
 *   - Team Lead with leads.assign, when team_lead_assign is on
 */
export function canAssignManually(
  s: AssignmentSettings,
  hasPermission: (key: string) => boolean,
): boolean {
  if (!s.enabled || !hasPermission('leads.assign')) return false;
  if (hasPermission('leads.view_all')) return true;
  return s.team_lead_assign;
}

/**
 * What "Auto" will do for a lead added by this user.
 * Returns the user id it will go to (null = Unassigned) and a short reason.
 */
export function autoAssignee(
  s: AssignmentSettings,
  me: { id: string; role_key: string | null },
  isAdmin: boolean,
): { userId: string | null; reason: string } {
  if (!s.enabled) return { userId: null, reason: 'Assignment is off' };

  if (me.role_key === 'caller' && s.caller_self) {
    return { userId: me.id, reason: 'Callers get the leads they add' };
  }
  if (me.role_key === 'team_lead' && s.team_lead_self) {
    return { userId: me.id, reason: 'Team Leads get the leads they add' };
  }
  if (isAdmin && s.admin_auto && s.admin_auto_user_id) {
    return { userId: s.admin_auto_user_id, reason: 'Auto-assign for leads added by admins' };
  }
  return { userId: null, reason: 'No automatic rule' };
}