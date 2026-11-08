import { forget, memo } from '@/shared/lib/memo';
import { supabase } from '@/shared/lib/supabase';

// =====================================================================
// 🤝 Admission Contribution: who did how much in every admission
//   (the AI's shares, or an admin's by hand). Everything is counted in
//   the database; a page at a time comes here.
// =====================================================================

export type Period = 'this_month' | 'last_month' | 'last_90' | 'this_year' | 'all' | 'custom';

export type ContribFilters = {
  from: string; // YYYY-MM-DD
  to: string;
  courseId: string | null;
  batchId: string | null;
};

export type ContribPerson = {
  user_id: string;
  name: string | null;
  /** admissions' worth: 1 = one whole admission */
  credit: number;
  admissions: number;
  avg_share: number;
  /** the biggest share in this many admissions */
  top_count: number;
};

export type ContribSummary = {
  totals: { admissions: number; done: number; waiting: number; not_started: number; failed: number; manual: number };
  people: ContribPerson[];
  groups: {
    group: 'source' | 'course';
    key: string;
    admissions: number;
    people: { user_id: string; name: string | null; credit: number }[];
  }[];
};

export type ContribShare = { user_id: string; name: string | null; share: number; reason: string | null };

export type ContribStudent = {
  lead_id: string;
  name: string;
  student_ref: string | null;
  admitted_at: string;
  course: string | null;
  batch: string | null;
  source: string | null;
  status: 'none' | 'pending' | 'working' | 'done' | 'failed';
  manual: boolean;
  decisive: string | null;
  shares: ContribShare[];
};

export type StudentStatus = 'all' | 'done' | 'waiting' | 'not_started' | 'failed' | 'manual';

export type ContribPersonPage = {
  user_id: string;
  name: string | null;
  credit: number;
  admissions: number;
  top_count: number;
  avg_share: number | null;
  by_month: { month: string; credit: number; admissions: number }[];
  items: {
    lead_id: string;
    name: string;
    student_ref: string | null;
    admitted_at: string;
    course: string | null;
    batch: string | null;
    share: number;
    reason: string | null;
    people: number;
    place: number;
  }[];
};

export type TimelineItem = {
  at: string;
  user_id?: string;
  name?: string;
  kind: string;
  text?: string;
  minutes?: number;
};

function toError(error: { message: string }): Error {
  const m = error.message.toLowerCase();
  if (m.includes('network request failed') || m.includes('failed to fetch')) {
    return new Error('No internet connection. Please try again.');
  }
  return new Error(error.message);
}

async function rpc<T>(name: string, args: Record<string, unknown>): Promise<T> {
  const { data, error } = await supabase.rpc(name as never, args as never);
  if (error) throw toError(error);
  return data as T;
}

// ---------------------------------------------------------------------
// 📅 Periods
// ---------------------------------------------------------------------
const iso = (d: Date) =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

export function periodRange(p: Exclude<Period, 'custom'>): { from: string; to: string } {
  const now = new Date();
  const today = iso(now);
  switch (p) {
    case 'this_month':
      return { from: iso(new Date(now.getFullYear(), now.getMonth(), 1)), to: today };
    case 'last_month':
      return {
        from: iso(new Date(now.getFullYear(), now.getMonth() - 1, 1)),
        to: iso(new Date(now.getFullYear(), now.getMonth(), 0)),
      };
    case 'last_90':
      return { from: iso(new Date(now.getFullYear(), now.getMonth(), now.getDate() - 89)), to: today };
    case 'this_year':
      return { from: iso(new Date(now.getFullYear(), 0, 1)), to: today };
    default:
      return { from: '2000-01-01', to: today };
  }
}

export const PERIODS: { key: Exclude<Period, 'custom'>; label: string }[] = [
  { key: 'this_month', label: 'This month' },
  { key: 'last_month', label: 'Last month' },
  { key: 'last_90', label: '90 days' },
  { key: 'this_year', label: 'This year' },
  { key: 'all', label: 'All' },
];

// ---------------------------------------------------------------------
// 👀 May I see it? (Settings → AI → who sees the shares)
// ---------------------------------------------------------------------
export function canSeeContribution(): Promise<boolean> {
  return memo('contrib:cansee', 5 * 60_000, async () => {
    const { data, error } = await supabase.rpc('ai_credit_can_view' as never);
    return !error && !!data;
  });
}

// ---------------------------------------------------------------------
// 📊 The pages
// ---------------------------------------------------------------------
export function getContribSummary(f: ContribFilters, force = false): Promise<ContribSummary> {
  const key = `contrib:sum:${f.from}:${f.to}:${f.courseId ?? ''}:${f.batchId ?? ''}`;
  if (force) forget(key);
  return memo(key, 2 * 60_000, async () => {
    const d = await rpc<Partial<ContribSummary>>('contrib_summary', {
      p_from: f.from,
      p_to: f.to,
      p_course: f.courseId,
      p_batch: f.batchId,
    });
    return {
      totals: d.totals ?? { admissions: 0, done: 0, waiting: 0, not_started: 0, failed: 0, manual: 0 },
      people: (d.people ?? []).map((p) => ({ ...p, credit: Number(p.credit), avg_share: Number(p.avg_share) })),
      groups: d.groups ?? [],
    };
  });
}

export async function listContribStudents(
  f: ContribFilters & { userId?: string | null; status?: StudentStatus; search?: string },
  page = 0,
  pageSize = 40,
): Promise<{ total: number; items: ContribStudent[] }> {
  const d = await rpc<{ total: number; items: ContribStudent[] }>('contrib_students', {
    p_from: f.from,
    p_to: f.to,
    p_course: f.courseId,
    p_batch: f.batchId,
    p_user: f.userId ?? null,
    p_status: f.status ?? 'all',
    p_search: f.search?.trim() || null,
    p_limit: pageSize,
    p_offset: page * pageSize,
  });
  return {
    total: Number(d?.total ?? 0),
    items: (d?.items ?? []).map((s) => ({
      ...s,
      shares: (s.shares ?? []).map((x) => ({ ...x, share: Number(x.share) })),
    })),
  };
}

export async function getContribPerson(userId: string, from: string, to: string): Promise<ContribPersonPage> {
  const d = await rpc<ContribPersonPage>('contrib_person', { p_user: userId, p_from: from, p_to: to });
  return {
    ...d,
    credit: Number(d.credit ?? 0),
    by_month: (d.by_month ?? []).map((m) => ({ ...m, credit: Number(m.credit) })),
    items: (d.items ?? []).map((i) => ({ ...i, share: Number(i.share) })),
  };
}

export const getContribTimeline = (leadId: string) => rpc<TimelineItem[]>('contrib_timeline', { p_lead: leadId });

// ---------------------------------------------------------------------
// 🎨 One colour per person (the same everywhere)
// ---------------------------------------------------------------------
const PALETTE = ['#3557D4', '#16A34A', '#E8A100', '#DB2777', '#0891B2', '#7C3AED', '#EA580C', '#0F766E', '#B91C1C'];

export function personColor(userId: string): string {
  let h = 2166136261;
  for (let i = 0; i < userId.length; i++) {
    h ^= userId.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return PALETTE[Math.abs(h) % PALETTE.length];
}

/** "2.4" admissions' worth */
export const credits = (n: number) => (Math.round(n * 10) / 10).toLocaleString();

// ---------------------------------------------------------------------
// ⬇️ Export (CSV: opens in Excel)
// ---------------------------------------------------------------------
export async function contribCsv(
  f: ContribFilters & { userId?: string | null; status?: StudentStatus },
): Promise<string> {
  const { items } = await listContribStudents(f, 0, 5000);
  const esc = (v: unknown) => {
    const s = v == null ? '' : String(v);
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const rows = [
    ['Student', 'College ID', 'Admitted', 'Course', 'Batch', 'Source', 'Person', 'Share %', 'Reason', 'Status'],
  ];
  for (const s of items) {
    const base = [s.name, s.student_ref, s.admitted_at.slice(0, 10), s.course, s.batch, s.source];
    if (s.shares.length === 0) rows.push([...base, '', '', '', s.status].map(String));
    for (const x of s.shares) {
      rows.push(
        [...base, x.name ?? '', String(x.share), x.reason ?? '', s.manual ? 'set by hand' : s.status].map((v) =>
          v == null ? '' : String(v),
        ),
      );
    }
  }
  return '﻿' + rows.map((r) => r.map(esc).join(',')).join('\n');
}
