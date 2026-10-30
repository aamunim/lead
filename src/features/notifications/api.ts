import { getSetting, updateSetting } from '@/features/settings/api';
import { supabase } from '@/shared/lib/supabase';
import type { Json } from '@/shared/types/database';

// =====================================================================
// 🔔 Notifications: the in-app list, settings, hand over
//   The database decides who gets what (notify()); this file reads the
//   list and changes the settings.
// =====================================================================

export type NotificationKind =
  | 'assigned'
  | 'follow_up'
  | 'visit'
  | 'auto_assigned'
  | 'speed_to_lead'
  | 'outcome'
  | 'signup'
  | 'sync_nudge'
  | 'missed_call'
  | 'discount'
  | 'payment';

export const KIND_INFO: { kind: NotificationKind; icon: string; title: string; text: string }[] = [
  { kind: 'assigned', icon: '👥', title: 'Lead given to you', text: 'Someone hands you a lead (with their note)' },
  { kind: 'follow_up', icon: '⏰', title: 'Next call', text: 'A few minutes before, and once more if it is late' },
  { kind: 'visit', icon: '🏫', title: 'Campus visits', text: 'Today’s visits in the morning, and 1 hour before' },
  { kind: 'auto_assigned', icon: '🆕', title: 'New lead for you', text: 'A new lead is given to you automatically' },
  { kind: 'speed_to_lead', icon: '⚡', title: 'New lead not called', text: 'The person, then their Team Lead, then admins' },
  { kind: 'outcome', icon: '🎓', title: 'Admitted / lost', text: 'To admins and the lead’s Team Lead' },
  { kind: 'signup', icon: '🙋', title: 'New sign-up', text: 'To admins who approve users' },
  { kind: 'sync_nudge', icon: '📞', title: 'Turn on call sync', text: 'When an admin sends the reminder' },
  { kind: 'missed_call', icon: '📵', title: 'Missed call from a lead', text: 'To the lead’s person, when another phone missed it' },
  { kind: 'discount', icon: '💰', title: 'Discounts', text: 'Requests to approve, answers, and approved ones running out' },
  { kind: 'payment', icon: '📅', title: 'Installments', text: 'Before and on the date; late ones to Team Lead and admins' },
];

export type NotificationSettings = {
  kinds: Record<NotificationKind, boolean>;
  /** "Lead given to you" also comes in quiet hours */
  assigned_in_quiet_hours: boolean;
};

export const DEFAULT_NOTIFICATIONS: NotificationSettings = {
  kinds: {
    assigned: true,
    follow_up: true,
    visit: true,
    auto_assigned: true,
    speed_to_lead: true,
    outcome: true,
    signup: true,
    sync_nudge: true,
    missed_call: true,
    discount: true,
    payment: true,
  },
  assigned_in_quiet_hours: true,
};

/** The timing settings that already existed (one row each) */
export type TimingSettings = {
  early_reminder_minutes: number;
  repeat_reminder_minutes: number;
  speed_to_lead_minutes: number;
  escalate_team_lead_hours: number;
  escalate_admin_hours: number;
  quiet_hours: { start: string; end: string };
};

export const DEFAULT_TIMING: TimingSettings = {
  early_reminder_minutes: 10,
  repeat_reminder_minutes: 15,
  speed_to_lead_minutes: 15,
  escalate_team_lead_hours: 4,
  escalate_admin_hours: 24,
  quiet_hours: { start: '22:00', end: '08:00' },
};

function toError(error: { message: string }): Error {
  const m = error.message.toLowerCase();
  if (m.includes('network request failed') || m.includes('fetch')) {
    return new Error('No internet connection. Please try again.');
  }
  return new Error(error.message);
}

export async function getNotificationSettings(): Promise<NotificationSettings> {
  try {
    const saved = await getSetting<Partial<NotificationSettings>>('notifications');
    return {
      ...DEFAULT_NOTIFICATIONS,
      ...(saved ?? {}),
      kinds: { ...DEFAULT_NOTIFICATIONS.kinds, ...(saved?.kinds ?? {}) },
    };
  } catch {
    return DEFAULT_NOTIFICATIONS;
  }
}

export async function saveNotificationSettings(s: NotificationSettings): Promise<void> {
  await updateSetting('notifications', s as unknown as Json);
}

export async function getTimingSettings(): Promise<TimingSettings> {
  const keys = Object.keys(DEFAULT_TIMING) as (keyof TimingSettings)[];
  const values = await Promise.all(keys.map((k) => getSetting<unknown>(k).catch(() => null)));
  const out = { ...DEFAULT_TIMING } as Record<string, unknown>;
  keys.forEach((k, i) => {
    if (values[i] != null) out[k] = values[i];
  });
  return out as TimingSettings;
}

export async function saveTimingSettings(s: TimingSettings): Promise<void> {
  await Promise.all(
    (Object.keys(s) as (keyof TimingSettings)[]).map((k) => updateSetting(k, s[k] as unknown as Json)),
  );
}

// --- The Super Admin's own muted kinds -------------------------------------
export async function getMyMuted(): Promise<NotificationKind[]> {
  const { data } = await supabase.from('notification_prefs').select('muted').maybeSingle();
  return (data?.muted ?? []) as NotificationKind[];
}

export async function setMyMuted(kinds: NotificationKind[]): Promise<void> {
  const { error } = await supabase.rpc('set_my_muted_notifications', { p_kinds: kinds });
  if (error) throw toError(error);
}

// =====================================================================
// The 🔔 list
// =====================================================================
export type AppNotification = {
  id: string;
  kind: NotificationKind | string;
  title: string;
  body: string | null;
  data: { lead_id?: string; lead_ids?: string[]; route?: string } | null;
  created_at: string;
  read_at: string | null;
};

export async function listNotifications(): Promise<AppNotification[]> {
  const { data, error } = await supabase
    .from('notifications')
    .select('id, kind, title, body, data, created_at, read_at')
    .order('created_at', { ascending: false })
    .limit(100);
  if (error) throw toError(error);
  return (data ?? []) as unknown as AppNotification[];
}

export async function countUnread(): Promise<number> {
  const { count, error } = await supabase
    .from('notifications')
    .select('id', { count: 'exact', head: true })
    .is('read_at', null);
  if (error) return 0;
  return count ?? 0;
}

export async function markRead(ids?: string[]): Promise<void> {
  const { error } = await supabase.rpc('mark_notifications_read', { p_ids: ids });
  if (error) throw toError(error);
}

// =====================================================================
// Hand over
// =====================================================================
/** Give leads to a person, with an optional note. Returns how many moved. */
export async function handOverLeads(
  leadIds: string[],
  to: string,
  note?: string,
): Promise<{ done: number; skipped: number }> {
  const { data, error } = await supabase.rpc('hand_over_leads', {
    p_lead_ids: leadIds,
    p_to: to,
    p_note: note?.trim() || undefined,
  });
  if (error) throw toError(error);
  const r = (data ?? {}) as { done?: number; skipped?: number };
  return { done: r.done ?? 0, skipped: r.skipped ?? 0 };
}
