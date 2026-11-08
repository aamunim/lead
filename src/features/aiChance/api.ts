import { useEffect, useState } from 'react';

import { getSetting, updateSetting } from '@/features/settings/api';
import { forget, memo } from '@/shared/lib/memo';
import { supabase } from '@/shared/lib/supabase';
import type { Json } from '@/shared/types/database';

// =====================================================================
// 🔮 AI chance of admission + what to do / say (open leads)
//   Worked out on the server in the background (ai-lead-chance); the app
//   only reads the saved answer, so lists stay as quick as before.
// =====================================================================

export type ChanceLevel = 'hot' | 'warm' | 'cold';

export type AiChanceSettings = {
  enabled: boolean;
  /** by itself after a new call / note (once a day per lead) */
  auto: boolean;
  model: string;
  effort: 'low' | 'medium' | 'high';
  window_days: number;
  daily_auto_limit: number;
  /** ⏰ once a day at `hour` (Dhaka): which leads to look at again */
  daily_run: { on: boolean; hour: number; changed: boolean; never: boolean; older: boolean; older_days: number };
  /** 💵 all AI stops by itself once this month's cost reaches it ($; 0 = no limit) */
  monthly_budget: number;
  view: { all: boolean; roles: string[]; people: string[] };
  guidance: string;
};

export const DEFAULT_AI_CHANCE: AiChanceSettings = {
  enabled: true,
  auto: true,
  model: 'claude-sonnet-5-5',
  effort: 'medium',
  window_days: 180,
  daily_auto_limit: 100,
  daily_run: { on: true, hour: 7, changed: true, never: false, older: false, older_days: 15 },
  monthly_budget: 80,
  view: { all: true, roles: [], people: [] },
  guidance: '',
};

export type LeadChance = {
  status: 'none' | 'pending' | 'working' | 'done' | 'failed';
  due_at: string | null;
  manual: boolean;
  chance: number | null;
  level: ChanceLevel | null;
  prev_chance: number | null;
  summary: string | null;
  good: string[];
  risks: string[];
  objections: { kind: string; detail: string }[];
  actions: { text: string; why: string }[];
  script: { situation: string; lines: string[] }[];
  best_time: string | null;
  next_call_days: number | null;
  next_call_why: string | null;
  done_at: string | null;
  error: string | null;
  /** looked at today and nothing new since (warn before asking again) */
  fresh_today: boolean;
};

export type ChanceToday = {
  lead_id: string;
  name: string;
  chance: number;
  level: ChanceLevel;
  prev_chance: number | null;
  action: string | null;
  best_time: string | null;
  days_since: number | null;
};

export type AiChanceOverview = {
  pending: number;
  done: number;
  failed: number;
  today: number;
  open_without: number;
  last_error: string | null;
  tokens_in: number;
  tokens_out: number;
  accuracy: Partial<Record<ChanceLevel, { admitted: number; lost: number }>>;
};

/** On list rows (the leads query embeds it; null = not looked at / not allowed) */
export type ChanceOnRow = { chance: number | null; level: ChanceLevel | null } | null;

export const OBJECTION_LABEL: Record<string, string> = {
  fee: '💰 ফি',
  family: '👪 পরিবার',
  distance: '🛣 দূরত্ব',
  time: '⏰ সময় / চাকরির সময়',
  other_college: '🏫 অন্য কলেজ',
  job: '💼 চাকরি',
  doubt: '🤔 কোর্স নিয়ে দ্বিধা',
  documents: '📄 কাগজপত্র',
  other: '❓ অন্য',
};

export function chanceTone(level: ChanceLevel | null | undefined): { icon: string; label: string } {
  if (level === 'hot') return { icon: '🔥', label: 'Hot' };
  if (level === 'warm') return { icon: '🌤', label: 'Warm' };
  return { icon: '❄️', label: 'Cold' };
}

function toError(error: { message: string }): Error {
  const m = error.message.toLowerCase();
  if (m.includes('network request failed') || m.includes('failed to fetch')) {
    return new Error('No internet connection. Please try again.');
  }
  return new Error(error.message);
}

async function rpc<T>(name: string, args?: Record<string, unknown>): Promise<T> {
  const { data, error } = await supabase.rpc(name as never, (args ?? {}) as never);
  if (error) throw toError(error);
  return data as T;
}

const missing = (e: unknown) => e instanceof Error && /could not find the function/i.test(e.message);

// ---------------------------------------------------------------------
// ⚙️ Settings
// ---------------------------------------------------------------------
export async function getAiChanceSettings(): Promise<AiChanceSettings> {
  const saved = await getSetting<Partial<AiChanceSettings>>('ai_chance').catch(() => null);
  return {
    ...DEFAULT_AI_CHANCE,
    ...(saved ?? {}),
    view: { ...DEFAULT_AI_CHANCE.view, ...(saved?.view ?? {}) },
    daily_run: { ...DEFAULT_AI_CHANCE.daily_run, ...(saved?.daily_run ?? {}) },
  };
}

export async function saveAiChanceSettings(s: AiChanceSettings): Promise<void> {
  await updateSetting('ai_chance', s as unknown as Json);
  forget('aichance:*');
}

export const getAiChanceOverview = () => rpc<AiChanceOverview>('ai_chance_overview');

/** Settings → AI: the groups, what is waiting, what was spent */
export type AiChanceCounts = {
  open: number;
  never: number;
  changed: number;
  older: number;
  today: number;
  today_changed: number;
  waiting_now: number;
  waiting_later: number;
  working: number;
  done_today: number;
  auto_today: number;
  /** $ per look (from what was used; 0.03 until there are a few) */
  avg_cost: number;
  spent_month: number;
  budget_ok: boolean;
  last_daily_run: string | null;
};
export type ChanceGroup = 'never' | 'changed' | 'older' | 'today';

export const getAiChanceCounts = (olderDays: number) =>
  rpc<AiChanceCounts>('ai_chance_counts', { p_older_days: olderDays });

/** Run a group: `now` = all at once (no daily limit; the budget still applies) */
export async function queueChanceGroup(
  kind: ChanceGroup,
  opts: { olderDays: number; onlyChanged: boolean; now: boolean },
): Promise<number> {
  const n = await rpc<number>('ai_chance_queue', {
    p_kind: kind,
    p_older_days: opts.olderDays,
    p_only_changed: opts.onlyChanged,
    p_now: opts.now,
  });
  forget('aichance:*');
  wakeAiChance();
  return n;
}

/** ⏹ Empty the queue (old answers stay) */
export async function stopChanceQueue(): Promise<number> {
  const n = await rpc<number>('ai_chance_stop');
  forget('aichance:*');
  return n;
}

/** 📋 Many leads from a list (at most 50). `force`: also the ones looked at today with nothing new */
export async function requestManyChances(
  leadIds: string[],
  force: boolean,
): Promise<{ queued: number; fresh_today: number; skipped: number }> {
  const r = await rpc<{ queued: number; fresh_today: number; skipped: number }>('ai_chance_request_many', {
    p_leads: leadIds.slice(0, 50),
    p_force: force,
  });
  leadIds.forEach((id) => forget(`aichance:lead:${id}`));
  wakeAiChance();
  return r;
}

/** Dollars, short: "$0.42", "$12" */
export const usd = (n: number) => '$' + (n < 10 ? n.toFixed(2) : Math.round(n).toLocaleString());

/** Every open lead not looked at yet → the queue (today's limit applies) */
export async function queueOpenLeads(): Promise<number> {
  const n = await rpc<number>('ai_chance_queue_open');
  wakeAiChance();
  return n;
}

/** Wake the server now (it also wakes itself every 2 minutes). Never waits, never fails. */
export function wakeAiChance(): void {
  supabase.functions.invoke('ai-lead-chance', { body: {} }).catch(() => undefined);
}

// ---------------------------------------------------------------------
// 🔮 One lead
// ---------------------------------------------------------------------
/** null: not allowed / an older database */
export function getLeadChance(leadId: string, force = false): Promise<LeadChance | null> {
  if (force) forget(`aichance:lead:${leadId}`);
  return memo(`aichance:lead:${leadId}`, 60_000, async () => {
    try {
      const d = await rpc<Partial<LeadChance> | null>('lead_ai_chance', { p_lead: leadId });
      if (!d) return null;
      return {
        status: d.status ?? 'none',
        due_at: d.due_at ?? null,
        manual: !!d.manual,
        chance: d.chance ?? null,
        level: d.level ?? null,
        prev_chance: d.prev_chance ?? null,
        summary: d.summary ?? null,
        good: d.good ?? [],
        risks: d.risks ?? [],
        objections: d.objections ?? [],
        actions: d.actions ?? [],
        script: d.script ?? [],
        best_time: d.best_time ?? null,
        next_call_days: d.next_call_days ?? null,
        next_call_why: d.next_call_why ?? null,
        done_at: d.done_at ?? null,
        error: d.error ?? null,
        fresh_today: !!d.fresh_today,
      } as LeadChance;
    } catch (e) {
      if (missing(e)) return null;
      throw e;
    }
  });
}

/** "Check now" on the lead page */
export async function requestLeadChance(leadId: string): Promise<void> {
  await rpc('ai_chance_request', { p_lead: leadId });
  forget(`aichance:lead:${leadId}`);
  wakeAiChance();
}

// ---------------------------------------------------------------------
// 🏠 Home: my leads to call first today
// ---------------------------------------------------------------------
export function getChanceToday(force = false): Promise<ChanceToday[]> {
  if (force) forget('aichance:today');
  return memo('aichance:today', 3 * 60_000, async () => {
    try {
      const rows = await rpc<ChanceToday[] | null>('ai_chance_today', { p_limit: 5 });
      return rows ?? [];
    } catch (e) {
      if (missing(e)) return [];
      throw e;
    }
  });
}

/** May this person see AI chance? (asked once, kept for 5 minutes) */
export function canSeeAiChance(): Promise<boolean> {
  return memo('aichance:cansee', 5 * 60_000, async () => {
    try {
      return !!(await rpc<boolean>('ai_chance_can_view'));
    } catch {
      return false;
    }
  });
}

/** React: true once we know this person may see AI chance */
export function useCanSeeAiChance(): boolean {
  const [on, setOn] = useState(false);
  useEffect(() => {
    let live = true;
    canSeeAiChance().then((v) => live && setOn(v));
    return () => {
      live = false;
    };
  }, []);
  return on;
}
