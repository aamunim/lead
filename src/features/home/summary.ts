import { supabase } from '@/shared/lib/supabase';

// =====================================================================
// ⚡ Home's numbers in one request (home_summary). Every card on Home
//   asks for it; they share the same answer for a few seconds.
// =====================================================================

export type HomeSummary = {
  talk_min: number;
  leads_today: number;
  admitted_today: number;
  taken_today: number;
  unread: number;
  discounts: number;
  pending_users: number;
  ittc_not_submitted: number;
  ittc_ready: number;
};

const SHARE_MS = 5_000;
const shared = new Map<string, { at: number; p: Promise<HomeSummary | null> }>();

/** me = only my own numbers (null = the whole team); null back = the database is not updated yet */
export function getHomeSummary(me: string | null, startIso: string): Promise<HomeSummary | null> {
  const key = `${me ?? 'team'}|${startIso}`;
  const hit = shared.get(key);
  if (hit && Date.now() - hit.at < SHARE_MS) return hit.p;
  const p = (async () => {
    const { data, error } = await supabase.rpc('home_summary' as never, { p_me: me, p_start: startIso } as never);
    if (error || !data) return null;
    return data as unknown as HomeSummary;
  })();
  shared.set(key, { at: Date.now(), p });
  return p;
}

/** The same request made twice at once (two cards): one answer for both */
export function shareRecent<T>(key: string, run: () => Promise<T>, ms = 3_000): Promise<T> {
  const hit = recent.get(key);
  if (hit && Date.now() - hit.at < ms) return hit.p as Promise<T>;
  const p = run();
  recent.set(key, { at: Date.now(), p });
  p.catch(() => recent.delete(key));
  return p;
}
const recent = new Map<string, { at: number; p: Promise<unknown> }>();
