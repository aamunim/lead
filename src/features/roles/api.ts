import { useEffect, useState } from 'react';

import { supabase } from '@/shared/lib/supabase';

// =====================================================================
// 👥 Roles (Settings → Roles, the Super Admin): the four first roles and
//   any new ones. Each role "works like" a Caller, Team Lead or Admin
//   (teams, self-assignment, discount limits), has its permissions and
//   may be limited to some courses.
// =====================================================================

export type ActsAs = 'caller' | 'team_lead' | 'admin';

export type Role = {
  key: string;
  name: string;
  description: string | null;
  rank: number;
  permissions: string[];
  isSystem: boolean;
  actsAs: ActsAs;
  /** null = every course */
  courseIds: string[] | null;
  people: number;
};

export const ACTS_AS: { key: ActsAs; label: string; hint: string }[] = [
  { key: 'caller', label: 'Caller', hint: 'Works on own leads; belongs to a Team Lead' },
  { key: 'team_lead', label: 'Team Lead', hint: 'Can lead a team of callers' },
  { key: 'admin', label: 'Admin', hint: 'Looks after everything' },
];

/** The permissions, in plain words (the database knows the same list) */
export const PERMISSIONS: { group: string; items: { key: string; label: string }[] }[] = [
  {
    group: '📋 Leads',
    items: [
      { key: 'leads.view_own', label: 'See own leads' },
      { key: 'leads.edit_own', label: 'Change own leads' },
      { key: 'leads.view_team', label: 'See the team’s leads' },
      { key: 'leads.edit_team', label: 'Change the team’s leads' },
      { key: 'leads.view_all', label: 'See all leads' },
      { key: 'leads.edit_all', label: 'Change all leads' },
      { key: 'leads.assign', label: 'Give leads to people' },
      { key: 'leads.delete', label: 'Delete leads' },
      { key: 'leads.export', label: 'Export to Excel' },
      { key: 'import.run', label: 'Import leads' },
    ],
  },
  {
    group: '📊 Reports',
    items: [
      { key: 'reports.view_team', label: 'Team reports' },
      { key: 'reports.view_all', label: 'All reports' },
    ],
  },
  {
    group: '💰 Fees',
    items: [
      { key: 'payments.manage', label: 'Payments (void, refund)' },
      { key: 'discounts.approve_limited', label: 'Approve small discounts' },
      { key: 'discounts.approve', label: 'Approve any discount' },
    ],
  },
  {
    group: '⚙️ Admin',
    items: [
      { key: 'settings.manage', label: 'Settings (sees every course)' },
      { key: 'users.manage', label: 'Users' },
    ],
  },
];

function toError(e: { message: string }): Error {
  if (/could not find the function|acts_as/i.test(e.message)) return new Error('The database is not updated yet.');
  return new Error(/network|fetch/i.test(e.message) ? 'No internet connection. Please try again.' : e.message);
}

export async function listRolesFull(): Promise<Role[]> {
  const [r, c] = await Promise.all([
    supabase
      .from('roles')
      .select('key, name, description, rank, permissions, is_system, acts_as, course_ids')
      .order('rank', { ascending: false }),
    supabase.rpc('role_counts'),
  ]);
  if (r.error) throw toError(r.error);
  const counts = new Map(((c.data ?? []) as { role_key: string; people: number }[]).map((x) => [x.role_key, x.people]));
  return (r.data ?? []).map((x) => ({
    key: x.key,
    name: x.name,
    description: x.description,
    rank: x.rank,
    permissions: x.permissions ?? [],
    isSystem: x.is_system,
    actsAs: ((x.acts_as as ActsAs) ?? (x.key === 'caller' ? 'caller' : x.key === 'team_lead' ? 'team_lead' : 'admin')) as ActsAs,
    courseIds: x.course_ids ?? null,
    people: counts.get(x.key) ?? 0,
  }));
}

export async function saveRole(input: {
  key: string | null;
  name: string;
  description: string;
  actsAs: ActsAs;
  permissions: string[];
  courseIds: string[] | null;
}): Promise<string> {
  const { data, error } = await supabase.rpc('save_role', {
    p_key: input.key,
    p_name: input.name.trim(),
    p_description: input.description.trim() || null,
    p_acts_as: input.actsAs,
    p_permissions: input.permissions,
    p_course_ids: input.courseIds && input.courseIds.length ? input.courseIds : null,
  });
  if (error) throw toError(error);
  return String(data);
}

export async function deleteRole(key: string): Promise<void> {
  const { error } = await supabase.rpc('delete_role', { p_key: key });
  if (error) throw toError(error);
}

export async function setUserCourses(userId: string, courseIds: string[] | null): Promise<void> {
  const { error } = await supabase.rpc('set_user_courses', {
    p_user: userId,
    p_course_ids: courseIds && courseIds.length ? courseIds : null,
  });
  if (error) throw toError(error);
}

// ---------------------------------------------------------------------
// The roles for "who may use this" pickers in Settings (all but the
// Super Admin, who always may): loaded once, the four first ones until then
// ---------------------------------------------------------------------
export type RoleChoice = { key: string; label: string };

const FIRST: RoleChoice[] = [
  { key: 'admin', label: 'Admins' },
  { key: 'team_lead', label: 'Team Leads' },
  { key: 'caller', label: 'Callers' },
];
let cache: RoleChoice[] | null = null;

const plural = (name: string) => (/s$/i.test(name) ? name : `${name}s`);

export async function listRoleChoices(): Promise<RoleChoice[]> {
  if (cache) return cache;
  const { data, error } = await supabase.from('roles').select('key, name, rank').order('rank', { ascending: false });
  if (error || !data) return FIRST;
  cache = data.filter((r) => r.key !== 'super_admin').map((r) => ({ key: r.key, label: plural(r.name) }));
  return cache;
}

/** For the Settings pickers: [{ key, label }] (without the Super Admin) */
export function useRoleChoices(opts: { withoutAdmin?: boolean } = {}): RoleChoice[] {
  const [list, setList] = useState<RoleChoice[]>(cache ?? FIRST);
  useEffect(() => {
    listRoleChoices().then(setList);
  }, []);
  return opts.withoutAdmin ? list.filter((r) => r.key !== 'admin') : list;
}

/** A role's label for sentences ("Admins and Team Leads can …") */
export const roleLabelOf = (list: RoleChoice[], key: string) => list.find((r) => r.key === key)?.label ?? key;

/** Forget the cached list (after a role is added or renamed) */
export function forgetRoleChoices() {
  cache = null;
}
