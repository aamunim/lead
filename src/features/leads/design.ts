import AsyncStorage from '@react-native-async-storage/async-storage';

import { useAuth } from '@/features/auth/AuthProvider';
import { supabase } from '@/shared/lib/supabase';

// =====================================================================
// 🎨 Leads / Students list: the new design or the classic one
//   Each person's own choice, kept on their account (any phone they log
//   in on). Nothing chosen = the new design. A user manager can set it
//   for someone, an admin for everyone (Settings → Lead cards).
// =====================================================================

export type ListDesign = 'new' | 'classic';

export const DESIGN_LABEL: Record<ListDesign, string> = { new: '✨ New', classic: '📋 Classic' };

export const designOf = (value: string | null | undefined): ListDesign => (value === 'classic' ? 'classic' : 'new');

/** The signed-in person's list design */
export function useListDesign(): ListDesign {
  const { profile } = useAuth();
  return designOf(profile?.list_design);
}

/** Someone's design (yourself, or anyone for a user manager) */
export async function saveListDesign(userId: string, design: ListDesign): Promise<void> {
  const { error } = await supabase.from('profiles').update({ list_design: design }).eq('id', userId);
  if (error) throw new Error(error.message);
}

/** Everyone at once (admins); how many changed */
export async function saveListDesignForAll(design: ListDesign): Promise<number> {
  const { data, error } = await supabase.rpc('set_list_design_all', { p_design: design });
  if (error) throw new Error(error.message);
  return Number(data ?? 0);
}

// ---------------------------------------------------------------------
// ⏱ "Next call" sort: leads in Overdue / Today / Tomorrow … groups
//   (on or off with a quick button, on this phone)
// ---------------------------------------------------------------------
const GROUP_KEY = 'leads_group_by_time';

export async function loadGroupByTime(): Promise<boolean> {
  try {
    return (await AsyncStorage.getItem(GROUP_KEY)) !== 'no';
  } catch {
    return true;
  }
}

export function saveGroupByTime(on: boolean): void {
  AsyncStorage.setItem(GROUP_KEY, on ? 'yes' : 'no').catch(() => undefined);
}

export type TimeGroup = 'late' | 'today' | 'tomorrow' | 'week' | 'later' | 'none';

export const GROUP_LABEL: Record<TimeGroup, string> = {
  late: 'OVERDUE',
  today: 'TODAY',
  tomorrow: 'TOMORROW',
  week: 'THIS WEEK',
  later: 'LATER',
  none: 'NO CALL SET',
};

const dayStart = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
const DAY = 86400000;

/** Which group a next-call time falls in */
export function timeGroup(iso: string | null, now = new Date()): TimeGroup {
  if (!iso) return 'none';
  const t = new Date(iso);
  if (t.getTime() < now.getTime()) return 'late';
  const days = Math.round((dayStart(t) - dayStart(now)) / DAY);
  if (days <= 0) return 'today';
  if (days === 1) return 'tomorrow';
  if (days < 7) return 'week';
  return 'later';
}

/** The small time on the card: "11:30 AM", "Tomorrow", "Thu", "12 Nov"; late: "Yesterday", "3 days" */
export function whenChip(iso: string | null, now = new Date()): { text: string; late: boolean } | null {
  if (!iso) return null;
  const t = new Date(iso);
  const time = t.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
  const days = Math.round((dayStart(t) - dayStart(now)) / DAY);
  const late = t.getTime() < now.getTime();
  if (days === 0) return { text: time, late };
  if (late) return { text: days === -1 ? 'Yesterday' : `${-days} days`, late };
  if (days === 1) return { text: 'Tomorrow', late };
  if (days < 7) return { text: t.toLocaleDateString('en-US', { weekday: 'short' }), late };
  return { text: t.toLocaleDateString('en-GB', { day: 'numeric', month: 'short' }), late };
}
