import { getSetting, updateSetting } from '@/features/settings/api';
import { supabase } from '@/shared/lib/supabase';
import type { Json } from '@/shared/types/database';

// =====================================================================
// 👁 Team activity: settings, data and the words for each change
//   Admins see everyone; Team Leads their team (setting); callers no one.
//   The database checks this again (can_see_activity).
// =====================================================================

export type ActivitySettings = {
  /** Count app time (the change log always works) */
  enabled: boolean;
  /** Team Leads see their team's activity */
  team_leads: boolean;
  /** Counting app time stops after this many minutes without a touch */
  idle_minutes: number;
  /** ⚠ after this many minutes without work, in office hours */
  alert_minutes: number;
  /** App sessions are kept this many days */
  keep_days: number;
};

export const DEFAULT_ACTIVITY: ActivitySettings = {
  enabled: true,
  team_leads: true,
  idle_minutes: 10,
  alert_minutes: 60,
  keep_days: 90,
};

export async function getActivitySettings(): Promise<ActivitySettings> {
  try {
    const saved = await getSetting<Partial<ActivitySettings>>('activity');
    return { ...DEFAULT_ACTIVITY, ...(saved ?? {}) };
  } catch {
    return DEFAULT_ACTIVITY;
  }
}

export async function saveActivitySettings(settings: ActivitySettings): Promise<void> {
  await updateSetting('activity', settings as unknown as Json);
}

/** Show the activity screens to this person? */
export function canOpenActivity(
  settings: ActivitySettings,
  hasPermission: (p: string) => boolean,
): boolean {
  if (hasPermission('settings.manage') || hasPermission('leads.view_all')) return true;
  return settings.team_leads && hasPermission('leads.view_team');
}

function toError(error: { message: string }): Error {
  const m = error.message.toLowerCase();
  if (m.includes('network request failed') || m.includes('fetch')) {
    return new Error('No internet connection. Please try again.');
  }
  return new Error(error.message);
}

// =====================================================================
// Periods
// =====================================================================
export type ActivityPeriod = 'today' | 'yesterday' | 'week' | 'month';

export const ACTIVITY_PERIODS: { value: ActivityPeriod; label: string }[] = [
  { value: 'today', label: 'Today' },
  { value: 'yesterday', label: 'Yesterday' },
  { value: 'week', label: 'This week' },
  { value: 'month', label: 'This month' },
];

function day(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

export function activityRange(period: ActivityPeriod, now = new Date()): { from: string; to: string } {
  switch (period) {
    case 'yesterday': {
      const y = new Date(now);
      y.setDate(now.getDate() - 1);
      return { from: day(y), to: day(y) };
    }
    case 'week': {
      // Week starts on Saturday
      const start = new Date(now);
      start.setDate(now.getDate() - ((now.getDay() + 1) % 7));
      return { from: day(start), to: day(now) };
    }
    case 'month':
      return { from: day(new Date(now.getFullYear(), now.getMonth(), 1)), to: day(now) };
    default:
      return { from: day(now), to: day(now) };
  }
}

// =====================================================================
// Data
// =====================================================================
export type TeamMember = {
  user_id: string;
  name: string | null;
  role_key: string;
  last_seen_at: string | null;
  app_sec: number;
  sessions: number;
  calls: number;
  connected: number;
  talk_sec: number;
  actions: number;
  admitted: number;
  first_at: string | null;
  last_at: string | null;
  /** 💬 WhatsApp, counted apart from phone calls */
  wa_calls: number;
  wa_connected: number;
  wa_messages: number;
  /** ➕ Leads this person added (imported ones too) */
  leads_added: number;
  leads_imported: number;
};

export async function listTeamActivity(from: string, to: string): Promise<TeamMember[]> {
  const { data, error } = await supabase.rpc('team_activity', { p_from: from, p_to: to });
  if (error) throw toError(error);
  return (data ?? []) as TeamMember[];
}

export type FeedItem = {
  id: string;
  created_at: string;
  action: string;
  details: Record<string, unknown> | null;
  lead_id: string;
  lead_name: string;
  lead_phone: string | null;
  user_id: string;
  user_name: string | null;
};

export type FeedQuery = {
  from: string;
  to: string;
  userId?: string | null;
  actions?: string[] | null;
  search?: string;
  before?: string | null;
};

export const FEED_PAGE = 100;

export async function listActivityFeed(q: FeedQuery): Promise<FeedItem[]> {
  const { data, error } = await supabase.rpc('activity_feed', {
    p_from: q.from,
    p_to: q.to,
    p_user_id: q.userId ?? undefined,
    p_actions: q.actions && q.actions.length > 0 ? q.actions : undefined,
    p_search: q.search?.trim() || undefined,
    p_before: q.before ?? undefined,
    p_limit: FEED_PAGE,
  });
  if (error) throw toError(error);
  return (data ?? []) as unknown as FeedItem[];
}

export async function countActivity(q: FeedQuery): Promise<Map<string, number>> {
  const { data, error } = await supabase.rpc('activity_counts', {
    p_from: q.from,
    p_to: q.to,
    p_user_id: q.userId ?? undefined,
    p_search: q.search?.trim() || undefined,
  });
  if (error) throw toError(error);
  return new Map((data ?? []).map((r) => [r.action, r.n]));
}

export type ActivityDay = { day: string; app_sec: number; actions: number; calls: number; wa: number };

export async function listUserDays(userId: string, days = 14): Promise<ActivityDay[]> {
  const { data, error } = await supabase.rpc('user_activity_days', { p_user_id: userId, p_days: days });
  if (error) throw toError(error);
  return (data ?? []) as ActivityDay[];
}

export type AppSession = {
  id: string;
  started_at: string;
  last_seen_at: string;
  active_sec: number;
  ended: boolean;
  device_label: string | null;
  app_version: string | null;
};

/** One person's app sessions that started on the days from..to (phone's time) */
export async function listUserSessions(userId: string, from: string, to: string): Promise<AppSession[]> {
  const start = new Date(`${from}T00:00:00`);
  const end = new Date(`${to}T00:00:00`);
  end.setDate(end.getDate() + 1);
  const { data, error } = await supabase
    .from('app_sessions')
    .select('id, started_at, last_seen_at, active_sec, ended, device_label, app_version')
    .eq('user_id', userId)
    .gte('started_at', start.toISOString())
    .lt('started_at', end.toISOString())
    .order('started_at', { ascending: false })
    .limit(200);
  if (error) throw toError(error);
  return (data ?? []) as AppSession[];
}

// =====================================================================
// Kinds of change (filter chips) and how each line reads
// =====================================================================
export type ChangeKind =
  | 'stage'
  | 'tag'
  | 'call'
  | 'note'
  | 'followup'
  | 'assign'
  | 'rating'
  | 'details'
  | 'visit'
  | 'papers'
  | 'fee'
  | 'deleted'
  | 'lead';

export const CHANGE_KINDS: { kind: ChangeKind; label: string; icon: string; actions: string[] }[] = [
  { kind: 'stage', label: 'Stage', icon: '🚩', actions: ['stage_changed'] },
  { kind: 'tag', label: 'Tag', icon: '🏷', actions: ['tag_added', 'tag_removed'] },
  { kind: 'call', label: 'Call', icon: '📞', actions: ['call_logged'] },
  { kind: 'note', label: 'Note', icon: '📝', actions: ['note_added', 'note_edited'] },
  { kind: 'followup', label: 'Next call', icon: '⏰', actions: ['follow_up_set', 'follow_up_cancelled'] },
  { kind: 'assign', label: 'Assign', icon: '👥', actions: ['assigned'] },
  { kind: 'rating', label: 'Rating', icon: '⭐', actions: ['rating_changed'] },
  {
    kind: 'details',
    label: 'Details',
    icon: '✏️',
    actions: ['details_changed', 'fields_changed', 'course_added', 'course_removed'],
  },
  {
    kind: 'visit',
    label: 'Visit',
    icon: '🏫',
    actions: ['visit_planned', 'visit_moved', 'visit_done', 'visit_missed', 'visit_cancelled'],
  },
  {
    kind: 'papers',
    label: 'Papers',
    icon: '📄',
    actions: ['paper_received', 'paper_not_needed', 'paper_unticked', 'paper_returned', 'papers_moved', 'file_added', 'file_deleted', 'files_downloaded'],
  },
  {
    kind: 'fee',
    label: 'Fee / payment',
    icon: '💰',
    actions: [
      'negotiation_started',
      'negotiation_event',
      'discount_requested',
      'discount_approved',
      'discount_rejected',
      'discount_cancelled',
      'payment_received',
      'payment_voided',
      'payment_refunded',
      'installments_set',
    ],
  },
  {
    kind: 'deleted',
    label: 'Call / note deleted',
    icon: '🗑',
    actions: ['call_deleted', 'call_note_deleted', 'note_deleted', 'entry_restored'],
  },
  { kind: 'lead', label: 'Added / deleted', icon: '➕', actions: ['created', 're_enquiry', 'deleted', 'restored'] },
];

export function kindOf(action: string) {
  return CHANGE_KINDS.find((k) => k.actions.includes(action)) ?? null;
}

export type StageInfo = { name: string; kind: string };

function when(iso?: unknown): string {
  if (typeof iso !== 'string') return '';
  const d = new Date(iso);
  return `${d.toLocaleDateString([], { day: 'numeric', month: 'short' })} ${d.toLocaleTimeString([], {
    hour: 'numeric',
    minute: '2-digit',
  })}`;
}

const q = (v: unknown) => (v == null || v === '' ? '—' : String(v));

/**
 * What changed, in words. "warn" = worth a second look (lost, cancelled, deleted).
 * userNames: id → name, for "Assigned to …".
 */
export function describeChange(
  item: Pick<FeedItem, 'action' | 'details'>,
  stages: Map<string, StageInfo>,
  userNames: Map<string, string>,
): { text: string; warn: boolean } {
  const d = (item.details ?? {}) as Record<string, unknown>;
  switch (item.action) {
    case 'stage_changed': {
      const to = stages.get(String(d.to ?? ''));
      return {
        text: `${stages.get(String(d.from ?? ''))?.name ?? '—'} → ${to?.name ?? '—'}`,
        warn: to?.kind === 'lost' || to?.kind === 'cancelled',
      };
    }
    case 'tag_added':
      return { text: `+ ${q(d.tag)}`, warn: false };
    case 'tag_removed':
      return { text: `− ${q(d.tag)}`, warn: false };
    case 'course_added':
      return { text: `Course + ${q(d.course)}`, warn: false };
    case 'course_removed':
      return { text: `Course − ${q(d.course)}`, warn: false };
    case 'call_logged':
      if (d.channel === 'whatsapp') {
        const what = d.media === 'message' ? 'message' : d.media === 'video' ? 'video call' : 'call';
        return {
          text: `💬 WhatsApp ${what}${String(d.direction ?? '') === 'incoming' ? ' · incoming' : ''}${d.outcome === 'message' ? '' : ` · ${q(d.outcome).replace(/_/g, ' ')}`}`,
          warn: false,
        };
      }
      return { text: `${String(d.direction ?? '') === 'incoming' ? 'Incoming · ' : ''}${q(d.outcome).replace(/_/g, ' ')}`, warn: false };
    case 'note_added':
      return { text: `“${q(d.note)}”`, warn: false };
    case 'note_edited':
      return { text: `Notes edited: “${q(d.to)}”`, warn: false };
    case 'follow_up_set':
      return { text: `Next call ${when(d.due_at)}`, warn: false };
    case 'follow_up_cancelled':
      return { text: 'Next call removed', warn: false };
    case 'assigned':
      return {
        text: d.to ? `→ ${userNames.get(String(d.to)) ?? 'someone'}` : 'Unassigned',
        warn: false,
      };
    case 'rating_changed':
      return { text: `${q(d.from)} → ${q(d.to)}`, warn: false };
    case 'details_changed':
      return {
        text: [
          d.old_name !== d.new_name ? `Name: ${q(d.old_name)} → ${q(d.new_name)}` : null,
          d.old_phone !== d.new_phone ? `Phone: ${q(d.old_phone)} → ${q(d.new_phone)}` : null,
        ]
          .filter(Boolean)
          .join(' · '),
        warn: false,
      };
    case 'fields_changed': {
      const changes = (Array.isArray(d.changes) ? d.changes : []) as { field: string; from: unknown; to: unknown }[];
      return { text: changes.map((c) => `${c.field}: ${q(c.from)} → ${q(c.to)}`).join(' · '), warn: false };
    }
    case 'visit_planned':
      return { text: `Visit planned ${when(d.at)}`, warn: false };
    case 'visit_moved':
      return { text: `Visit moved to ${when(d.at)}`, warn: false };
    case 'visit_done':
      return { text: 'Visited the campus', warn: false };
    case 'visit_missed':
      return { text: 'Didn’t come to the visit', warn: false };
    case 'visit_cancelled':
      return { text: 'Visit cancelled', warn: false };
    case 'paper_received':
      return { text: `${q(d.paper)} received`, warn: false };
    case 'paper_not_needed':
      return { text: `${q(d.paper)}: not needed`, warn: false };
    case 'paper_unticked':
      return { text: `${q(d.paper)} unticked`, warn: false };
    case 'paper_returned':
      return { text: `${q(d.paper)} returned`, warn: false };
    case 'papers_moved':
      return { text: d.kept_at ? `Kept at ${q(d.kept_at)}` : 'Place removed', warn: false };
    case 'negotiation_started':
      return { text: `💰 Fee talk started: ${q(d.course)}`, warn: false };
    case 'negotiation_event':
      return {
        text:
          d.kind === 'note'
            ? `💰 “${q(d.note)}”`
            : `💰 ${d.kind === 'lead_asked' ? 'Lead asked' : d.kind === 'offer' ? 'Offered' : 'Told the fee'} ৳${Math.round(Number(d.amount ?? 0)).toLocaleString('en-IN')}`,
        warn: false,
      };
    case 'discount_requested':
    case 'discount_approved':
    case 'discount_rejected':
    case 'discount_cancelled': {
      const verb = { discount_requested: 'asked', discount_approved: 'approved', discount_rejected: 'not approved', discount_cancelled: 'taken back' }[
        item.action
      ];
      return {
        text: `💰 Discount ${verb}: ৳${Math.round(Number(d.amount ?? 0)).toLocaleString('en-IN')} off ${q(d.fee)}${d.reason ? ` · ${q(d.reason)}` : ''}`,
        warn: item.action === 'discount_rejected',
      };
    }
    case 'payment_received':
      return {
        text: `💵 ৳${Math.round(Number(d.amount ?? 0)).toLocaleString('en-IN')} received (${q(d.method)}) · ${q(d.receipt_no)}`,
        warn: false,
      };
    case 'payment_voided':
      return {
        text: `✕ Payment void: ${q(d.receipt_no)} · ৳${Math.round(Number(d.amount ?? 0)).toLocaleString('en-IN')}${d.reason ? ` · ${q(d.reason)}` : ''}`,
        warn: true,
      };
    case 'file_added':
      return { text: d.kind === 'voice' ? '🎙 Voice note added' : `📎 File added: ${q(d.name)}`, warn: false };
    case 'file_deleted':
      return { text: `📎 File removed: ${q(d.name)}`, warn: true };
    case 'files_downloaded':
      return { text: `📦 Downloaded all files (${d.count ?? 0})`, warn: false };
    case 'admission_approved':
      return { text: `✅ Admission approved${d.nu_admission_id ? ` · NU ${q(d.nu_admission_id)}` : ''}`, warn: false };
    case 'admission_returned':
      return { text: `↩ Admission sent back: ${q(d.reason)}`, warn: true };
    case 'admission_resubmitted':
      return { text: '🎓 Sent for approval again', warn: false };
    case 'nu_id_set':
      return { text: `🆔 NU Admission ID: ${d.to ? q(d.to) : 'removed'}`, warn: false };
    case 'placement_changed':
      return { text: `🏫 Course · batch · section: ${q(d.to)}`, warn: false };
    case 'registration_approved':
      return { text: '📝 Registration approved', warn: false };
    case 'registration_returned':
      return { text: `↩ Registration sent back${d.reason ? `: ${q(d.reason)}` : ''}`, warn: true };
    case 'registration_resubmitted':
      return { text: '📝 Registration sent again', warn: false };
    case 'final_fee_changed':
      return {
        text: `💰 Final fee ৳${Math.round(Number(d.from ?? 0)).toLocaleString('en-IN')} → ৳${Math.round(Number(d.to ?? 0)).toLocaleString('en-IN')}${d.reason ? ` · ${q(d.reason)}` : ''}`,
        warn: true,
      };
    case 'student_ref_changed':
      return { text: `🎓 Student ID changed: ${q(d.from)} → ${q(d.to)}`, warn: false };
    case 'admission_approval_cleared':
      return { text: '🎓 Admission approval cleared (cancelled)', warn: true };
    case 'payment_refunded':
      return {
        text: `↩ Refund ৳${Math.round(Number(d.amount ?? 0)).toLocaleString('en-IN')} (${q(d.method)}) · ${q(d.receipt_no)}${d.reason ? ` · ${q(d.reason)}` : ''}`,
        warn: true,
      };
    case 'installments_set':
      return { text: Number(d.count ?? 0) > 0 ? `📅 ${q(d.count)} installments set` : '📅 Installment plan removed', warn: false };
    case 'created':
      return { text: 'Lead added', warn: false };
    case 're_enquiry':
      return { text: 'Asked again (re-enquiry)', warn: false };
    case 'deleted':
      return { text: 'Lead deleted', warn: true };
    case 'restored':
      return { text: 'Lead restored', warn: false };
    case 'call_deleted': {
      const what =
        d.channel === 'whatsapp' ? (d.media === 'message' ? 'WhatsApp message' : 'WhatsApp call') : 'Call';
      return {
        text: `🗑 ${what} deleted (${q(d.outcome).replace(/_/g, ' ')}, ${when(d.called_at)})${
          d.note ? ` “${q(d.note)}”` : ''
        }${d.reason ? ` · Reason: ${q(d.reason)}` : ''}${d.restored_at ? ' · ✓ restored' : ''}`,
        warn: !d.restored_at,
      };
    }
    case 'call_note_deleted':
    case 'note_deleted':
      return {
        text: `🗑 Note deleted: “${q(d.note)}”${d.reason ? ` · Reason: ${q(d.reason)}` : ''}${
          d.restored_at ? ' · ✓ restored' : ''
        }`,
        warn: !d.restored_at,
      };
    case 'entry_restored':
      return { text: `↩ Restored${d.note ? `: “${q(d.note)}”` : ''}`, warn: false };
    default:
      return { text: item.action.replace(/_/g, ' '), warn: false };
  }
}

/** Same change by the same person to many leads within 2 minutes → one group */
export type FeedGroup = { key: string; items: FeedItem[] };

export function groupFeed(items: FeedItem[]): FeedGroup[] {
  const groups: FeedGroup[] = [];
  const sameChange = (a: FeedItem, b: FeedItem) =>
    a.user_id === b.user_id &&
    a.action === b.action &&
    a.lead_id !== b.lead_id &&
    JSON.stringify(a.details?.to ?? a.details?.tag ?? a.details?.course ?? null) ===
      JSON.stringify(b.details?.to ?? b.details?.tag ?? b.details?.course ?? null) &&
    Math.abs(new Date(a.created_at).getTime() - new Date(b.created_at).getTime()) < 2 * 60 * 1000 &&
    !['call_logged', 'note_added', 'note_edited', 'fields_changed', 'details_changed'].includes(a.action);

  for (const item of items) {
    const last = groups[groups.length - 1];
    if (last && sameChange(last.items[last.items.length - 1], item)) last.items.push(item);
    else groups.push({ key: item.id, items: [item] });
  }
  return groups;
}

export function formatDuration(sec: number): string {
  if (sec < 60) return sec > 0 ? '<1m' : '0m';
  const h = Math.floor(sec / 3600);
  const m = Math.round((sec % 3600) / 60);
  return h > 0 ? `${h}h ${m}m` : `${m}m`;
}

// =====================================================================
// One person, everything for the details page (user_activity_detail)
// =====================================================================
export type UserDetail = {
  calls: {
    total: number;
    outgoing: number;
    incoming: number;
    missed: number;
    connected: number;
    no_answer: number;
    talk_sec: number;
    avg_sec: number;
    longest_sec: number;
    short: number;
    with_note: number;
  };
  wa: { calls: number; connected: number; missed: number; talk_sec: number; video: number; sent: number; received: number };
  follow_ups: { due: number; on_time: number; late: number; missed: number; avg_late_min: number; overdue_now: number };
  speed: {
    given: number;
    called: number;
    within_15: number;
    within_60: number;
    avg_min: number;
    median_min: number;
    not_called: number;
  };
  leads: {
    open_now: number;
    given: number;
    admitted: number;
    lost: number;
    stages: { name: string; color: string; n: number }[];
    lost_reasons: { name: string; n: number }[];
  };
  hours: { hour: number; calls: number; actions: number; app_min: number }[];
  /** One day only: 60+ minutes with no work between 9 AM and 7 PM */
  gaps: { from: string; to: string }[];
};

export async function getUserDetail(userId: string, from: string, to: string): Promise<UserDetail> {
  const { data, error } = await supabase.rpc('user_activity_detail', { p_user_id: userId, p_from: from, p_to: to });
  if (error) throw toError(error);
  return data as unknown as UserDetail;
}

/** The same number of days just before (for ↑ / ↓) */
export function previousRange(range: { from: string; to: string }): { from: string; to: string } {
  const from = new Date(`${range.from}T00:00:00`);
  const to = new Date(`${range.to}T00:00:00`);
  const days = Math.round((to.getTime() - from.getTime()) / 86400000) + 1;
  const pTo = new Date(from);
  pTo.setDate(from.getDate() - 1);
  const pFrom = new Date(pTo);
  pFrom.setDate(pTo.getDate() - (days - 1));
  return { from: day(pFrom), to: day(pTo) };
}
