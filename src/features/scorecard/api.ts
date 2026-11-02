import { getSetting, updateSetting } from '@/features/settings/api';
import { supabase } from '@/shared/lib/supabase';
import type { Json } from '@/shared/types/database';

// =====================================================================
// 🏁 Weekly scorecard: each person's week (Sat–Fri) next to the week
//   before. Who you see: yourself; admins and leads.view_all everyone;
//   a Team Lead their team. Sunday morning admins get the totals.
// =====================================================================

export type WeekNumbers = {
  leads: number;
  calls: number;
  connected: number;
  admitted: number;
  money: number;
  response_min: number | null;
  follow_ups: number;
  missed: number;
};

export type ScoreRow = { user_id: string; name: string; role: string | null; now: WeekNumbers; before: WeekNumbers };
export type Scorecard = { weekStart: Date; weekEnd: Date; rows: ScoreRow[] };

export type ScorecardSettings = { enabled: boolean; weekday: number; hour: number };
export const DEFAULT_SCORECARD: ScorecardSettings = { enabled: true, weekday: 0, hour: 9 };

const ymd = (d: Date) =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

/** The Saturday that starts the week holding `day` */
export function weekStart(day: Date): Date {
  const d = new Date(day);
  d.setHours(0, 0, 0, 0);
  d.setDate(d.getDate() - ((d.getDay() + 1) % 7));
  return d;
}

export function lastWeekStart(): Date {
  const d = new Date();
  d.setDate(d.getDate() - 7);
  return weekStart(d);
}

export async function getScorecard(week: Date): Promise<Scorecard> {
  const { data, error } = await supabase.rpc('weekly_scorecard', { p_week: ymd(week) });
  if (error) {
    throw new Error(
      /could not find the function/i.test(error.message)
        ? 'The database is not updated yet (npx supabase db push).'
        : error.message,
    );
  }
  const r = data as unknown as { week_start: string; week_end: string; rows: ScoreRow[] };
  return { weekStart: new Date(r.week_start), weekEnd: new Date(r.week_end), rows: r.rows ?? [] };
}

export async function getScorecardSettings(): Promise<ScorecardSettings> {
  const saved = await getSetting<Partial<ScorecardSettings>>('scorecard').catch(() => null);
  return { ...DEFAULT_SCORECARD, ...(saved ?? {}) };
}

export async function saveScorecardSettings(s: ScorecardSettings): Promise<void> {
  await updateSetting('scorecard', s as unknown as Json);
}

// --- Text helpers --------------------------------------------------------
export const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

export function weekLabel(s: Scorecard): string {
  const f = (d: Date) => d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short' });
  return `${f(s.weekStart)} – ${f(s.weekEnd)}`;
}

export function taka(n: number): string {
  if (Math.abs(n) >= 100000) return `৳${(n / 100000).toFixed(n % 100000 === 0 ? 0 : 1)}L`;
  if (Math.abs(n) >= 1000) return `৳${(n / 1000).toFixed(n % 1000 === 0 ? 0 : 1)}k`;
  return `৳${Math.round(n)}`;
}

export function minutes(m: number | null): string {
  if (m == null) return '—';
  if (m < 60) return `${Math.round(m)} min`;
  if (m < 60 * 24) return `${(m / 60).toFixed(1)} h`;
  return `${(m / 60 / 24).toFixed(1)} d`;
}

/** +3 / −2 / '' */
export function delta(now: number, before: number): string {
  const d = now - before;
  if (d === 0) return '';
  return d > 0 ? `+${d}` : `−${Math.abs(d)}`;
}

export function totals(rows: ScoreRow[]): { now: WeekNumbers; before: WeekNumbers } {
  const sum = (k: 'now' | 'before'): WeekNumbers => {
    const t: WeekNumbers = {
      leads: 0,
      calls: 0,
      connected: 0,
      admitted: 0,
      money: 0,
      response_min: null,
      follow_ups: 0,
      missed: 0,
    };
    let rs = 0;
    let rn = 0;
    for (const r of rows) {
      const w = r[k];
      t.leads += w.leads;
      t.calls += w.calls;
      t.connected += w.connected;
      t.admitted += w.admitted;
      t.money += Number(w.money);
      t.follow_ups += w.follow_ups;
      t.missed += w.missed;
      if (w.response_min != null) {
        rs += w.response_min * Math.max(1, w.leads);
        rn += Math.max(1, w.leads);
      }
    }
    t.response_min = rn ? rs / rn : null;
    return t;
  };
  return { now: sum('now'), before: sum('before') };
}

/** Two or three things worth a look */
export function highlights(rows: ScoreRow[]): string[] {
  const out: string[] = [];
  const top = [...rows].sort((a, b) => b.now.admitted - a.now.admitted)[0];
  if (top && top.now.admitted > 0)
    out.push(`🥇 ${top.name}: ${top.now.admitted} admission${top.now.admitted === 1 ? '' : 's'}`);
  const missed = [...rows].filter((r) => r.now.missed >= 3).sort((a, b) => b.now.missed - a.now.missed)[0];
  if (missed)
    out.push(`⚠ ${missed.name}: ${missed.now.missed} follow-ups missed (${missed.before.missed} the week before)`);
  const slow = [...rows]
    .filter((r) => (r.now.response_min ?? 0) > 120 && r.now.leads >= 2)
    .sort((a, b) => (b.now.response_min ?? 0) - (a.now.response_min ?? 0))[0];
  if (slow) out.push(`🐢 ${slow.name}: first call after ${minutes(slow.now.response_min)} on average`);
  const up = [...rows]
    .filter((r) => r.now.admitted - r.before.admitted >= 2)
    .sort((a, b) => b.now.admitted - b.before.admitted - (a.now.admitted - a.before.admitted))[0];
  if (up && up !== top)
    out.push(`📈 ${up.name}: ${delta(up.now.admitted, up.before.admitted)} admissions vs the week before`);
  return out.slice(0, 3);
}
