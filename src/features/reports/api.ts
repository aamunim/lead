import type { MyProfile } from '@/features/auth/api';
import type { WhoRule } from '@/features/pipeline/api';
import { getSetting, updateSetting } from '@/features/settings/api';
import { supabase } from '@/shared/lib/supabase';
import type { Json } from '@/shared/types/database';

// =====================================================================
// 📊 Reports: settings, the period, and the data
//   The database only counts leads / calls the person can see.
// =====================================================================

export type ReportSection = 'summary' | 'funnel' | 'visits' | 'sources' | 'team' | 'lost' | 'heatmap';

export const SECTION_LABELS: Record<ReportSection, { title: string; text: string }> = {
  summary: { title: 'Summary', text: 'New leads, contacted, admitted, conversion, lost' },
  funnel: { title: 'Funnel', text: 'How far the leads added in the period got' },
  visits: { title: 'Campus visits', text: 'Visited / didn’t come, and admissions with or without a visit' },
  sources: { title: 'Sources & campaigns', text: 'Where leads and admissions come from' },
  team: { title: 'Team', text: 'Leads, calls, talk time and admissions per person' },
  lost: { title: 'Why leads are lost', text: 'Lost reasons, and the stage they left from' },
  heatmap: { title: 'Best time to call', text: 'Which days and hours calls get answered' },
};

export const SECTION_ORDER: ReportSection[] = ['summary', 'funnel', 'visits', 'sources', 'team', 'lost', 'heatmap'];

export type ReportSettings = {
  /** Who can open Reports (admins always can) */
  who: WhoRule;
  /** The small "this month" card on Home */
  home_card: boolean;
  /** Which parts are shown */
  sections: Record<ReportSection, boolean>;
};

export const DEFAULT_REPORTS: ReportSettings = {
  who: { mode: 'all', roles: [], user_ids: [] },
  home_card: true,
  sections: { summary: true, funnel: true, visits: true, sources: true, team: true, lost: true, heatmap: true },
};

export async function getReportSettings(): Promise<ReportSettings> {
  try {
    const saved = await getSetting<Partial<ReportSettings>>('reports');
    return {
      ...DEFAULT_REPORTS,
      ...(saved ?? {}),
      who: { ...DEFAULT_REPORTS.who, ...(saved?.who ?? {}) },
      sections: { ...DEFAULT_REPORTS.sections, ...(saved?.sections ?? {}) },
    };
  } catch {
    return DEFAULT_REPORTS;
  }
}

export async function saveReportSettings(settings: ReportSettings): Promise<void> {
  await updateSetting('reports', settings as unknown as Json);
}

/** May this person open Reports? Admins (settings.manage) always may. */
export function canSeeReports(settings: ReportSettings, profile: MyProfile | null, isAdmin: boolean): boolean {
  if (!profile) return false;
  if (isAdmin) return true;
  const { who } = settings;
  if (who.mode === 'roles') return who.roles.includes(profile.role_key);
  if (who.mode === 'users') return who.user_ids.includes(profile.id);
  return true;
}

// =====================================================================
// Period
// =====================================================================
export type Period = 'week' | 'month' | 'last_month' | '30d' | 'year';

export const PERIODS: { value: Period; label: string }[] = [
  { value: 'week', label: 'This week' },
  { value: 'month', label: 'This month' },
  { value: 'last_month', label: 'Last month' },
  { value: '30d', label: '30 days' },
  { value: 'year', label: 'This year' },
];

/** 2026-10-28 in the phone's own time */
function day(d: Date): string {
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  return `${d.getFullYear()}-${m}-${dd}`;
}

/** First and last day of the period (both included) */
export function periodRange(period: Period, now = new Date()): { from: string; to: string } {
  const y = now.getFullYear();
  const m = now.getMonth();
  switch (period) {
    case 'week': {
      // Week starts on Saturday (Bangladesh office week)
      const start = new Date(now);
      start.setDate(now.getDate() - ((now.getDay() + 1) % 7));
      return { from: day(start), to: day(now) };
    }
    case 'last_month':
      return { from: day(new Date(y, m - 1, 1)), to: day(new Date(y, m, 0)) };
    case '30d': {
      const start = new Date(now);
      start.setDate(now.getDate() - 29);
      return { from: day(start), to: day(now) };
    }
    case 'year':
      return { from: day(new Date(y, 0, 1)), to: day(now) };
    default:
      return { from: day(new Date(y, m, 1)), to: day(now) };
  }
}

// =====================================================================
// Data
// =====================================================================
export type FunnelStep = {
  stage_id: string;
  key: string;
  name: string;
  color: string;
  kind: 'open' | 'won';
  /** Leads added in the period that got at least this far */
  reached: number;
  /** Of those, how many are in this stage now */
  now: number;
};

export type NamedCount = { name: string; leads: number; admitted?: number };

export type TeamRow = {
  user_id: string;
  name: string | null;
  leads: number;
  admitted: number;
  overdue: number;
  // From call_report()
  calls: number;
  connected: number;
  talk_sec: number;
};

export type LeadReport = {
  summary: {
    new_leads: number;
    contacted: number;
    cohort_admitted: number;
    admitted: number;
    lost: number;
    avg_days_to_admit: number | null;
  };
  funnel: FunnelStep[];
  visits: {
    planned_now: number;
    visited: number;
    missed: number;
    visited_admitted: number;
    not_visited: number;
    not_visited_admitted: number;
  };
  sources: NamedCount[];
  campaigns: NamedCount[];
  team: TeamRow[];
  lost_reasons: NamedCount[];
  lost_from: NamedCount[];
};

export type HeatCell = { dow: number; hour: number; attempts: number; connected: number };

export type ReportQuery = { from: string; to: string; userId?: string | null; courseId?: string | null };

function toError(error: { message: string }): Error {
  const m = error.message.toLowerCase();
  if (m.includes('network request failed') || m.includes('fetch')) {
    return new Error('No internet connection. Please try again.');
  }
  return new Error(error.message);
}

export async function getLeadReport(q: ReportQuery, withCalls: boolean): Promise<LeadReport> {
  const [report, calls] = await Promise.all([
    supabase.rpc('lead_report', {
      p_from: q.from,
      p_to: q.to,
      p_user_id: q.userId ?? undefined,
      p_course_id: q.courseId ?? undefined,
    }),
    withCalls
      ? supabase.rpc('call_report', { p_from: q.from, p_to: q.to, p_user_id: q.userId ?? undefined })
      : Promise.resolve({ data: [], error: null }),
  ]);
  if (report.error) throw toError(report.error);
  if (calls.error) throw toError(calls.error);

  const r = report.data as unknown as Omit<LeadReport, 'team'> & { team: Omit<TeamRow, 'calls' | 'connected' | 'talk_sec'>[] };

  // Calls per person (call_report gives one row per person per day)
  const byUser = new Map<string, { name: string; calls: number; connected: number; talk_sec: number }>();
  for (const c of calls.data ?? []) {
    const now = byUser.get(c.user_id) ?? { name: c.user_name, calls: 0, connected: 0, talk_sec: 0 };
    now.calls += c.calls;
    now.connected += c.connected;
    now.talk_sec += c.talk_sec;
    byUser.set(c.user_id, now);
  }
  const team: TeamRow[] = r.team.map((t) => ({ ...t, ...pickCalls(byUser.get(t.user_id)) }));
  // People who called but have no leads assigned
  byUser.forEach((c, userId) => {
    if (!team.some((t) => t.user_id === userId)) {
      team.push({ user_id: userId, name: c.name, leads: 0, admitted: 0, overdue: 0, ...pickCalls(c) });
    }
  });

  return { ...r, team };
}

const pickCalls = (c?: { calls: number; connected: number; talk_sec: number }) => ({
  calls: c?.calls ?? 0,
  connected: c?.connected ?? 0,
  talk_sec: c?.talk_sec ?? 0,
});

export async function getCallHeatmap(q: ReportQuery): Promise<HeatCell[]> {
  const { data, error } = await supabase.rpc('call_heatmap', {
    p_from: q.from,
    p_to: q.to,
    p_user_id: q.userId ?? undefined,
  });
  if (error) throw toError(error);
  return (data ?? []) as HeatCell[];
}

// =====================================================================
// Text helpers
// =====================================================================
export const pct = (part: number, whole: number): string =>
  whole > 0 ? `${Math.round((part / whole) * 100)}%` : '—';

export function formatTalk(sec: number): string {
  if (sec < 60) return `${sec}s`;
  const h = Math.floor(sec / 3600);
  const m = Math.round((sec % 3600) / 60);
  return h > 0 ? `${h}h ${m}m` : `${m}m`;
}
