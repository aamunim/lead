import { supabase } from '@/shared/lib/supabase';
import type { Json } from '@/shared/types/database';

// =====================================================================
// 🏆 Credits and the leaderboard (worked out on the server from the work
//   that is already saved; Settings → Credits sets the numbers)
// =====================================================================

export type CreditKind =
  | 'call_any'
  | 'call_connected'
  | 'talk_minute'
  | 'incoming'
  | 'wa_message'
  | 'wa_call'
  | 'template'
  | 'note'
  | 'voice'
  | 'follow_up_set'
  | 'follow_up_on_time'
  | 'lead_added'
  | 'lead_imported'
  | 'stage_forward'
  | 'visit_planned'
  | 'visit_done'
  | 'paper'
  | 'admitted'
  | 'payment'
  | 'app_time'
  | 'overdue';

export type CreditRule = {
  points: number;
  /** Most credits a day (0 = no limit) */
  cap: number;
  on: boolean;
  min_sec?: number;
  per_call?: number;
  min_chars?: number;
  per_taka?: number;
  per_min?: number;
};
export type CreditRules = Record<CreditKind, CreditRule>;

/** What each kind is, in words; extra = the one setting it has besides points and cap */
export const CREDIT_KINDS: {
  kind: CreditKind;
  icon: string;
  label: string;
  per: string;
  color: string;
  extra?: { key: keyof CreditRule; label: string; unit: string };
}[] = [
  { kind: 'call_any', icon: '📞', label: 'Call made', per: 'a call (same lead within 5 min once)', color: '#3557D4' },
  {
    kind: 'call_connected',
    icon: '✅',
    label: 'Talked (connected)',
    per: 'a call',
    color: '#1F6B42',
    extra: { key: 'min_sec', label: 'At least', unit: 'sec' },
  },
  {
    kind: 'talk_minute',
    icon: '⏱',
    label: 'Talk time',
    per: 'a minute',
    color: '#0E7490',
    extra: { key: 'per_call', label: 'Most per call', unit: 'min' },
  },
  { kind: 'incoming', icon: '📲', label: 'Incoming answered', per: 'a call', color: '#0369A1' },
  { kind: 'wa_message', icon: '💬', label: 'WhatsApp message', per: 'a message', color: '#128C4A' },
  { kind: 'wa_call', icon: '🟢', label: 'WhatsApp call (talked)', per: 'a call', color: '#15803D' },
  { kind: 'template', icon: '✉️', label: 'Ready-made message sent', per: 'a message', color: '#7C3AED' },
  {
    kind: 'note',
    icon: '📝',
    label: 'Note written',
    per: 'a note',
    color: '#6A1B7A',
    extra: { key: 'min_chars', label: 'At least', unit: 'letters' },
  },
  { kind: 'voice', icon: '🎙', label: 'Voice note', per: 'a voice note', color: '#9333EA' },
  { kind: 'follow_up_set', icon: '⏰', label: 'Next call set', per: 'one', color: '#B45309' },
  { kind: 'follow_up_on_time', icon: '✔️', label: 'Next call done on time', per: 'one', color: '#A16207' },
  { kind: 'lead_added', icon: '➕', label: 'Lead added (typed)', per: 'a lead', color: '#2563EB' },
  { kind: 'lead_imported', icon: '📥', label: 'Lead imported', per: 'a lead', color: '#64748B' },
  { kind: 'stage_forward', icon: '🚩', label: 'Stage moved forward', per: 'a move', color: '#D97706' },
  { kind: 'visit_planned', icon: '🏫', label: 'Campus visit planned', per: 'a visit', color: '#7C3AED' },
  { kind: 'visit_done', icon: '🏛', label: 'Campus visit done', per: 'a visit', color: '#6D28D9' },
  { kind: 'paper', icon: '📄', label: 'Paper received', per: 'a paper', color: '#0F766E' },
  { kind: 'admitted', icon: '🎓', label: 'Admitted', per: 'a student', color: '#16A34A' },
  {
    kind: 'payment',
    icon: '💵',
    label: 'Money taken',
    per: 'every ৳ (below)',
    color: '#15803D',
    extra: { key: 'per_taka', label: 'For every', unit: '৳' },
  },
  {
    kind: 'app_time',
    icon: '📱',
    label: 'Time working in the app',
    per: 'every few minutes (below)',
    color: '#475569',
    extra: { key: 'per_min', label: 'For every', unit: 'min' },
  },
  { kind: 'overdue', icon: '⚠️', label: 'Next call missed (minus)', per: 'one left undone', color: '#BA1A1A' },
];

export const kindInfo = (k: string) =>
  CREDIT_KINDS.find((x) => x.kind === k) ??
  (k === 'manual'
    ? { kind: 'manual', icon: '⭐', label: 'Given by the Super Admin', per: '', color: '#CA8A04' }
    : { kind: k, icon: '•', label: k.replace(/_/g, ' '), per: '', color: '#64748B' });

export type BoardRow = {
  user_id: string;
  name: string | null;
  role_key: string;
  total: number;
  rank: number | null;
  hidden: boolean;
  team_lead_id: string | null;
};

export async function getLeaderboard(from: string, to: string): Promise<BoardRow[]> {
  const { data, error } = await supabase.rpc('leaderboard', { p_from: from, p_to: to });
  if (error) throw new Error(error.message);
  return ((data ?? []) as BoardRow[]).map((r) => ({ ...r, total: Number(r.total) }));
}

export type BreakdownRow = { kind: string; qty: number; points: number };

export async function getBreakdown(userId: string, from: string, to: string): Promise<BreakdownRow[]> {
  const { data, error } = await supabase.rpc('credit_breakdown', { p_user: userId, p_from: from, p_to: to });
  if (error) throw new Error(error.message);
  return ((data ?? []) as BreakdownRow[]).map((r) => ({ ...r, qty: Number(r.qty), points: Number(r.points) }));
}

export type CreditSettings = { enabled: boolean; retro: boolean; rules: CreditRules };

export async function getCreditSettings(): Promise<CreditSettings> {
  const [{ data: cfg }, { data: rules }] = await Promise.all([
    supabase.from('app_settings').select('value').eq('key', 'credits').maybeSingle(),
    supabase.rpc('current_credit_rules'),
  ]);
  const v = (cfg?.value ?? {}) as { enabled?: boolean; retro?: boolean };
  return { enabled: v.enabled ?? true, retro: v.retro ?? true, rules: (rules ?? {}) as unknown as CreditRules };
}

export async function saveCreditSettings(s: CreditSettings): Promise<void> {
  const { error } = await supabase.rpc('save_credit_rules', {
    p_rules: s.rules as unknown as Json,
    p_enabled: s.enabled,
    p_retro: s.retro,
  });
  if (error) throw new Error(error.message);
}

export async function setLeaderboardHidden(userId: string, hidden: boolean): Promise<void> {
  const { error } = await supabase.rpc('set_leaderboard_hidden', { p_user: userId, p_hidden: hidden });
  if (error) throw new Error(error.message);
}

export async function giveCredits(userId: string, points: number, reason: string): Promise<void> {
  const { error } = await supabase.rpc('add_credit_adjustment', { p_user: userId, p_points: points, p_reason: reason });
  if (error) throw new Error(error.message);
}

// ---------------------------------------------------------------------
// Periods (week starts on Saturday, like Team activity)
// ---------------------------------------------------------------------
export type BoardPeriod = 'today' | 'week' | 'month' | 'last_month' | 'all';

export const BOARD_PERIODS: { value: BoardPeriod; label: string }[] = [
  { value: 'today', label: 'Today' },
  { value: 'week', label: 'This week' },
  { value: 'month', label: 'This month' },
  { value: 'last_month', label: 'Last month' },
  { value: 'all', label: 'All time' },
];

const ymd = (d: Date) =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

/** The period, and the same length just before it (for ▲▼) */
export function boardRange(
  p: BoardPeriod,
  now = new Date(),
): { from: string; to: string; prev: { from: string; to: string } | null } {
  const day = (offset: number, base = now) => {
    const d = new Date(base);
    d.setDate(d.getDate() + offset);
    return d;
  };
  switch (p) {
    case 'today':
      return { from: ymd(now), to: ymd(now), prev: { from: ymd(day(-1)), to: ymd(day(-1)) } };
    case 'week': {
      const start = day(-((now.getDay() + 1) % 7));
      const len = Math.round((now.getTime() - start.getTime()) / 86400000);
      const pStart = day(-7, start);
      return { from: ymd(start), to: ymd(now), prev: { from: ymd(pStart), to: ymd(day(len, pStart)) } };
    }
    case 'month': {
      const start = new Date(now.getFullYear(), now.getMonth(), 1);
      const pStart = new Date(now.getFullYear(), now.getMonth() - 1, 1);
      const pEnd = new Date(
        now.getFullYear(),
        now.getMonth() - 1,
        Math.min(now.getDate(), new Date(now.getFullYear(), now.getMonth(), 0).getDate()),
      );
      return { from: ymd(start), to: ymd(now), prev: { from: ymd(pStart), to: ymd(pEnd) } };
    }
    case 'last_month': {
      const s = new Date(now.getFullYear(), now.getMonth() - 1, 1);
      const e = new Date(now.getFullYear(), now.getMonth(), 0);
      return {
        from: ymd(s),
        to: ymd(e),
        prev: {
          from: ymd(new Date(now.getFullYear(), now.getMonth() - 2, 1)),
          to: ymd(new Date(now.getFullYear(), now.getMonth() - 1, 0)),
        },
      };
    }
    default:
      return { from: '2020-01-01', to: ymd(now), prev: null };
  }
}
