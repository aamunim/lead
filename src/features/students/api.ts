import type { MyProfile } from '@/features/auth/api';
import type { WhoRule } from '@/features/pipeline/api';
import { getSetting, updateSetting } from '@/features/settings/api';
import { supabase } from '@/shared/lib/supabase';
import type { Json } from '@/shared/types/database';

// =====================================================================
// 🎓 Students: the admitted students' own tab (the same leads, only admitted)
//   Settings → Students: the tab on/off and who sees it. The usual "who
//   sees which leads" rule still applies inside.
// =====================================================================

export type StudentsSettings = { enabled: boolean; who: WhoRule };

export const DEFAULT_STUDENTS_SETTINGS: StudentsSettings = {
  enabled: true,
  who: { mode: 'all', roles: [], user_ids: [] },
};

export async function getStudentsSettings(): Promise<StudentsSettings> {
  try {
    const saved = await getSetting<Partial<StudentsSettings>>('students');
    return {
      ...DEFAULT_STUDENTS_SETTINGS,
      ...(saved ?? {}),
      who: { ...DEFAULT_STUDENTS_SETTINGS.who, ...(saved?.who ?? {}) },
    };
  } catch {
    return DEFAULT_STUDENTS_SETTINGS;
  }
}

export async function saveStudentsSettings(s: StudentsSettings): Promise<void> {
  await updateSetting('students', s as unknown as Json);
}

/** May this person see the Students tab? (admins always, when it is on) */
export function canSeeStudents(s: StudentsSettings, profile: MyProfile | null, isAdmin: boolean): boolean {
  if (!profile || !s.enabled) return false;
  if (isAdmin) return true;
  if (s.who.mode === 'roles') return s.who.roles.includes(profile.role_key);
  if (s.who.mode === 'users') return s.who.user_ids.includes(profile.id);
  return true;
}

export type StudentsSummaryData = {
  students: number;
  new_this_month: number;
  with_due: number;
  due: number;
  overdue: number;
  overdue_amount: number;
  collected_month: number;
  papers_missing: number;
};

/** Totals over the students this person can see */
export async function getStudentsSummary(): Promise<StudentsSummaryData | null> {
  const { data, error } = await supabase.rpc('students_summary');
  if (error) return null;
  return data as unknown as StudentsSummaryData;
}

/** ৳3.5L / ৳12.4K style for small tiles */
export function shortMoney(n: number): string {
  const v = Math.round(n);
  if (v >= 10000000) return `৳${(v / 10000000).toFixed(1).replace(/\.0$/, '')}Cr`;
  if (v >= 100000) return `৳${(v / 100000).toFixed(1).replace(/\.0$/, '')}L`;
  if (v >= 1000) return `৳${(v / 1000).toFixed(1).replace(/\.0$/, '')}K`;
  return `৳${v}`;
}
