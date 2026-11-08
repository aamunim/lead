import { claudeModelOf, modeOf, type AiMode, type AiProvider } from '@/features/aiProviders/api';
import { getSetting, updateSetting } from '@/features/settings/api';
import { memo, forget } from '@/shared/lib/memo';
import { supabase } from '@/shared/lib/supabase';
import type { Json } from '@/shared/types/database';

// =====================================================================
// 🤖 AI admission credit: who did how much for each admission
//   The Claude API key lives on the server only (Settings → AI); the app
//   sees "sk-ant-…abcd". The work runs in the background
//   (the ai-admission-credit Edge Function), so nothing here waits for AI.
// =====================================================================

export type AiCreditSettings = {
  enabled: boolean;
  /** which AI: claude | gemini | gemini_then_claude | compare (Settings → AI) */
  provider: AiMode;
  model: string;
  effort: 'low' | 'medium' | 'high';
  window_days: number;
  view: { all: boolean; roles: string[]; people: string[] };
  guidance: string;
};

export const DEFAULT_AI_CREDIT: AiCreditSettings = {
  enabled: true,
  provider: 'claude',
  model: 'claude-sonnet-5-5',
  effort: 'medium',
  window_days: 180,
  view: { all: false, roles: [], people: [] },
  guidance: '',
};

export type AiKeyStatus = {
  set: boolean;
  hint: string | null;
  updated_at: string | null;
  last_ok_at: string | null;
  last_error: string | null;
  /** the last time Claude could not answer (any reason), for Settings → AI */
  last_problem?: string | null;
  last_problem_at?: string | null;
  server_ready: boolean;
};

export type AiCreditOverview = {
  /** what Claude's answers cost, each at its own model's price (an older database: not sent) */
  cost_usd?: number;
  pending: number;
  done: number;
  failed: number;
  manual: number;
  not_queued: number;
  last_error: string | null;
  tokens_in: number;
  tokens_out: number;
};

export type CreditShare = {
  user_id: string;
  name: string | null;
  share: number;
  reason: string | null;
};
export type CreditStat = {
  user_id?: string;
  calls?: number;
  answered_calls?: number;
  talk_minutes?: number;
  whatsapp?: number;
  notes?: number;
  visits?: number;
  fee_actions?: number;
  payments?: number;
  papers?: number;
};
export type LeadCredit = {
  status: 'none' | 'pending' | 'working' | 'done' | 'failed';
  shares: CreditShare[];
  stats: CreditStat[];
  decisive: string | null;
  confidence: 'high' | 'medium' | 'low' | null;
  manual: boolean;
  edit_reason: string | null;
  edited_by: string | null;
  error: string | null;
  done_at: string | null;
  model: string | null;
  /** which AI gave the shares above */
  provider: AiProvider | null;
  /** admins: the other AI could not answer this time */
  side_note: string | null;
  /** 🗂 every AI's latest answer (newest first) */
  answers: CreditAnswer[];
};

/** One AI's latest answer for an admission */
export type CreditAnswer = {
  provider: AiProvider;
  shares: CreditShare[];
  decisive: string | null;
  confidence: 'high' | 'medium' | 'low' | null;
  done_at: string | null;
};

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

/** An older database without this feature */
const missing = (e: unknown) => e instanceof Error && /could not find the function/i.test(e.message);

// ---------------------------------------------------------------------
// ⚙️ Settings
// ---------------------------------------------------------------------
export async function getAiCreditSettings(): Promise<AiCreditSettings> {
  const saved = await getSetting<Partial<AiCreditSettings>>('ai_credit').catch(() => null);
  return {
    ...DEFAULT_AI_CREDIT,
    ...(saved ?? {}),
    provider: modeOf(saved?.provider),
    model: claudeModelOf(saved?.model),
    view: { ...DEFAULT_AI_CREDIT.view, ...(saved?.view ?? {}) },
  };
}

export async function saveAiCreditSettings(s: AiCreditSettings): Promise<void> {
  await updateSetting('ai_credit', s as unknown as Json);
  forget('aicredit:*');
}

// ---------------------------------------------------------------------
// 🔑 The key (admins)
// ---------------------------------------------------------------------
export const getAiKeyStatus = () => rpc<AiKeyStatus>('ai_key_status');

export async function saveAiKey(key: string): Promise<void> {
  const base = process.env.EXPO_PUBLIC_SUPABASE_URL ?? '';
  await rpc('set_ai_key', {
    p_key: key.trim(),
    p_functions_url: base ? `${base.replace(/\/$/, '')}/functions/v1` : null,
  });
}

export const removeAiKey = () => rpc<void>('remove_ai_key');

/** Ask Claude whether the key works (a free check) */
export async function testAiKey(): Promise<{
  ok: boolean;
  error?: string;
  model?: string;
}> {
  const { data, error } = await supabase.functions.invoke('ai-admission-credit', {
    body: { action: 'test', provider: 'claude' },
  });
  if (error) {
    // the function answered with an error message of its own
    const ctx = (error as { context?: Response }).context;
    if (ctx && typeof ctx.json === 'function') {
      const body = (await ctx.json().catch(() => null)) as {
        error?: string;
      } | null;
      if (body?.error) return { ok: false, error: body.error };
    }
    return {
      ok: false,
      error: /not found|404/i.test(error.message)
        ? 'The ai-admission-credit Edge Function is not deployed yet.'
        : error.message,
    };
  }
  return data as { ok: boolean; error?: string; model?: string };
}

// ---------------------------------------------------------------------
// ⚙️ The work
// ---------------------------------------------------------------------
export const getAiCreditOverview = () => rpc<AiCreditOverview>('ai_credit_overview');

/** Every admitted lead not worked out yet → the queue */
export async function queueAllAdmissions(): Promise<number> {
  const n = await rpc<number>('ai_credit_queue_all');
  wakeAiCredit();
  return n;
}

/** Wake the server now (it also wakes itself every 2 minutes). Never waits, never fails. */
export function wakeAiCredit(): void {
  supabase.functions.invoke('ai-admission-credit', { body: {} }).catch(() => undefined);
}

export async function redoLeadCredit(leadId: string): Promise<void> {
  await rpc('ai_credit_redo', { p_lead: leadId });
  forget(`aicredit:lead:${leadId}`);
  wakeAiCredit();
}

export async function setLeadCreditByHand(
  leadId: string,
  shares: { user_id: string; share: number; reason?: string | null }[],
  reason: string,
): Promise<void> {
  await rpc('ai_credit_set_manual', {
    p_lead: leadId,
    p_shares: shares,
    p_reason: reason,
  });
  forget(`aicredit:lead:${leadId}`);
}

// ---------------------------------------------------------------------
// 👀 Reading
// ---------------------------------------------------------------------
/** null: this person may not see admission credit (or an older database) */
export function getLeadCredit(leadId: string, force = false): Promise<LeadCredit | null> {
  if (force) forget(`aicredit:lead:${leadId}`);
  return memo(`aicredit:lead:${leadId}`, 60_000, async () => {
    try {
      const d = await rpc<Partial<LeadCredit> | null>('lead_admission_credit', {
        p_lead: leadId,
      });
      if (!d) return null;
      return {
        status: d.status ?? 'none',
        shares: (d.shares ?? []).map((s) => ({ ...s, share: Number(s.share) })),
        stats: d.stats ?? [],
        decisive: d.decisive ?? null,
        confidence: d.confidence ?? null,
        manual: !!d.manual,
        edit_reason: d.edit_reason ?? null,
        edited_by: d.edited_by ?? null,
        error: d.error ?? null,
        done_at: d.done_at ?? null,
        model: d.model ?? null,
        provider: d.provider ?? null,
        side_note: d.side_note ?? null,
        answers: (d.answers ?? []).map((a) => ({
          ...a,
          shares: (a.shares ?? []).map((x) => ({ ...x, share: Number(x.share) })),
        })),
      } as LeadCredit;
    } catch (e) {
      if (missing(e)) return null;
      throw e;
    }
  });
}
