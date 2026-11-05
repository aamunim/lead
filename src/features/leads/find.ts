import { supabase } from '@/shared/lib/supabase';

// =====================================================================
// 🔎 Finding a lead again
//   🕘 Recent: the leads I worked on (calls, notes, changes, opened)
//   ⭐ Starred: my own short list
// =====================================================================

export type RecentRow = { leadId: string; at: Date; kind: string; detail: Record<string, unknown> };
export type RecentRange = { day: 'today' } | { day: 'custom'; from: string; to: string };

const dayStart = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate());
const parseDay = (s: string) => {
  const [y, m, d] = s.split('-').map(Number);
  return new Date(y, (m ?? 1) - 1, d ?? 1);
};

/** The time span of a choice: today, or the chosen days (whole days) */
export function recentSpan(r: RecentRange): { from: Date; to: Date } {
  if (r.day === 'today') return { from: dayStart(new Date()), to: new Date() };
  const to = parseDay(r.to);
  to.setDate(to.getDate() + 1);
  return { from: parseDay(r.from), to };
}

export async function listRecent(r: RecentRange, limit = 200): Promise<RecentRow[]> {
  const { from, to } = recentSpan(r);
  const { data, error } = await supabase.rpc(
    'my_recent_leads' as never,
    {
      p_from: from.toISOString(),
      p_to: to.toISOString(),
      p_limit: limit,
    } as never,
  );
  if (error) throw new Error(error.message);
  return ((data ?? []) as { lead_id: string; at: string; kind: string; detail: Record<string, unknown> | null }[]).map(
    (x) => ({ leadId: x.lead_id, at: new Date(x.at), kind: x.kind, detail: x.detail ?? {} }),
  );
}

/** "📞 Call · 3m", "📝 Note", "🔀 Stage", "👀 Opened" */
export function recentWhat(row: Pick<RecentRow, 'kind' | 'detail'>): string {
  const d = row.detail as { outcome?: string; sec?: number; channel?: string; to?: string };
  switch (row.kind) {
    case 'call': {
      const min = d.sec ? Math.max(1, Math.round(d.sec / 60)) : 0;
      const how = d.channel === 'whatsapp' ? '💬 WhatsApp call' : '📞 Call';
      return `${how}${d.outcome && d.outcome !== 'connected' ? ` · ${d.outcome.replace(/_/g, ' ')}` : min ? ` · ${min}m` : ''}`;
    }
    case 'call_logged':
      return '📞 Call';
    case 'note_added':
    case 'note_edited':
      return '📝 Note';
    case 'stage_changed':
      return `🔀 Stage${d.to ? ` → ${d.to}` : ''}`;
    case 'opened':
      return '👀 Opened';
    case 'follow_up_set':
    case 'followup_set':
      return '⏰ Next call set';
    case 'whatsapp_sent':
    case 'template_sent':
      return '💬 Message';
    default:
      return '✏️ ' + row.kind.replace(/_/g, ' ');
  }
}

/** "now", "5m", "2h", "Yesterday", "3 Nov" */
export function recentWhen(at: Date): string {
  const min = Math.round((Date.now() - at.getTime()) / 60000);
  if (min < 1) return 'now';
  if (min < 60) return `${min}m ago`;
  if (at.toDateString() === new Date().toDateString())
    return at.toLocaleTimeString('en-GB', { hour: 'numeric', minute: '2-digit', hour12: true });
  const y = new Date();
  y.setDate(y.getDate() - 1);
  if (at.toDateString() === y.toDateString()) return 'Yesterday';
  return at.toLocaleDateString('en-GB', { day: 'numeric', month: 'short' });
}

/** 👀 I opened this lead (for 🕘 Recent; quiet) */
export function touchLead(leadId: string) {
  supabase.rpc('touch_lead' as never, { p_lead: leadId } as never).then(
    () => undefined,
    () => undefined,
  );
}

// ---------------------------------------------------------------------
// ⭐ Stars (kept in memory, so cards can show them without asking)
// ---------------------------------------------------------------------
let stars: Map<string, number> | null = null;
let loadingStars: Promise<Map<string, number>> | null = null;
const listeners = new Set<() => void>();

export function onStarsChange(fn: () => void) {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}

export async function myStars(force = false): Promise<Map<string, number>> {
  if (stars && !force) return stars;
  if (!loadingStars) {
    loadingStars = (async () => {
      const { data } = await supabase
        .from('lead_stars' as never)
        .select('lead_id, created_at')
        .order('created_at', { ascending: false })
        .limit(1000);
      stars = new Map(
        ((data ?? []) as { lead_id: string; created_at: string }[]).map((r) => [
          r.lead_id,
          new Date(r.created_at).getTime(),
        ]),
      );
      return stars;
    })().finally(() => {
      loadingStars = null;
    });
  }
  return loadingStars;
}

export const isStarred = (leadId: string) => !!stars?.has(leadId);

export async function toggleStar(leadId: string): Promise<boolean> {
  const now = await myStars();
  const on = !now.has(leadId);
  if (on) {
    const { error } = await supabase.from('lead_stars' as never).insert({ lead_id: leadId } as never);
    if (error && !/duplicate/i.test(error.message)) throw new Error(error.message);
    now.set(leadId, Date.now());
  } else {
    const { error } = await supabase
      .from('lead_stars' as never)
      .delete()
      .eq('lead_id', leadId);
    if (error) throw new Error(error.message);
    now.delete(leadId);
  }
  listeners.forEach((fn) => fn());
  return on;
}

/** Starred ids, the newest star first */
export async function starredIds(): Promise<string[]> {
  const m = await myStars(true);
  return [...m.entries()].sort((a, b) => b[1] - a[1]).map(([id]) => id);
}

supabase.auth.onAuthStateChange((event) => {
  if (event === 'SIGNED_OUT' || event === 'SIGNED_IN') stars = null;
});
