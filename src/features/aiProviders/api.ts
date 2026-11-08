import { getSetting, updateSetting } from '@/features/settings/api';
import { forget } from '@/shared/lib/memo';
import { supabase } from '@/shared/lib/supabase';
import type { Json } from '@/shared/types/database';

// =====================================================================
// 🤖 Two AIs: Claude and Gemini (free tier)
//   · each has an on/off switch (off = never used, its key never sent)
//   · each feature picks a mode: claude | gemini | gemini_then_claude | compare
//   · the keys live on the server only; the app sees "AIza…abcd"
//   · every AI's answer is kept: one AI's answers stay when the other answers
// =====================================================================

export type AiProvider = 'claude' | 'gemini';
export type AiMode = 'claude' | 'gemini' | 'gemini_then_claude' | 'compare';

export type AiProvidersSetting = {
  claude: { on: boolean };
  gemini: { on: boolean; model: string | null };
};

export const DEFAULT_AI_PROVIDERS: AiProvidersSetting = {
  claude: { on: true },
  gemini: { on: false, model: null },
};

export const PROVIDER_LABEL: Record<AiProvider, string> = {
  claude: 'Claude',
  gemini: 'Gemini',
};

export const MODES: { key: AiMode; label: string; text: string; needs: AiProvider[] }[] = [
  { key: 'claude', label: 'Claude', text: 'Only Claude (paid, from your Claude credit).', needs: ['claude'] },
  { key: 'gemini', label: 'Gemini', text: 'Only Gemini (free tier, $0).', needs: ['gemini'] },
  {
    key: 'gemini_then_claude',
    label: 'Gemini, then Claude',
    text: 'Gemini first; Claude only when Gemini can’t (its free limit is used up, it is busy or it fails).',
    needs: ['gemini', 'claude'],
  },
  {
    key: 'compare',
    label: 'Both (compare)',
    text: 'Both look at each lead; the lead page shows both answers. Lists and Credits use Claude’s. Costs as much as Claude alone.',
    needs: ['gemini', 'claude'],
  },
];

// ---------------------------------------------------------------------
// 🧠 Which Claude model a feature uses (per feature, Settings → AI)
// ---------------------------------------------------------------------
export type ClaudeModel = 'claude-sonnet-5-5' | 'claude-haiku-5-5';

export const CLAUDE_MODELS: { key: ClaudeModel; label: string; text: string }[] = [
  {
    key: 'claude-haiku-5-5',
    label: 'Haiku 5.5 · cheap',
    text: 'About a twentieth of Sonnet’s price ($0.10 / $0.50 per million tokens). Good for many leads every day; the advice can be a little simpler.',
  },
  {
    key: 'claude-sonnet-5-5',
    label: 'Sonnet 5.5 · best',
    text: 'The most careful answers ($2 / $10 per million tokens). About 20 times Haiku’s price.',
  },
];

export const claudeModelOf = (v: unknown): ClaudeModel =>
  v === 'claude-haiku-5-5' ? 'claude-haiku-5-5' : 'claude-sonnet-5-5';

export const modeOf = (v: unknown): AiMode =>
  v === 'gemini' || v === 'gemini_then_claude' || v === 'compare' ? v : 'claude';

export type GeminiKeyStatus = {
  set: boolean;
  hint: string | null;
  updated_at: string | null;
  last_ok_at: string | null;
  last_error: string | null;
  /** its free limit was used up: resting until then */
  paused_until: string | null;
  /** the last time Gemini could not answer (any reason) */
  last_problem?: string | null;
  last_problem_at?: string | null;
};

export type FeaturePlan = { mode: AiMode; providers: AiProvider[]; budget_ok: boolean };

export type AiProviderStats = {
  ready: Record<AiProvider, boolean>;
  plan: { chance: FeaturePlan; credit: FeaturePlan };
  providers: Record<
    AiProvider,
    {
      chance_answers: number;
      credit_answers: number;
      runs_today: number;
      runs_month: number;
      accuracy: Partial<Record<'hot' | 'warm' | 'cold', { admitted: number; lost: number }>>;
    }
  >;
};

export type GeminiModel = { name: string; label: string };

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

/** An older database without Gemini */
const missing = (e: unknown) => e instanceof Error && /could not find the function/i.test(e.message);

// ---------------------------------------------------------------------
// ⚙️ The switches and the Gemini model
// ---------------------------------------------------------------------
export async function getAiProviders(): Promise<AiProvidersSetting> {
  const saved = await getSetting<Partial<AiProvidersSetting>>('ai_providers').catch(() => null);
  return {
    claude: { ...DEFAULT_AI_PROVIDERS.claude, ...(saved?.claude ?? {}) },
    gemini: { ...DEFAULT_AI_PROVIDERS.gemini, ...(saved?.gemini ?? {}) },
  };
}

export async function saveAiProviders(p: AiProvidersSetting): Promise<void> {
  await updateSetting('ai_providers', p as unknown as Json);
  forget('aichance:*');
  forget('aicredit:*');
}

// ---------------------------------------------------------------------
// 🔑 The Gemini key (admins)
// ---------------------------------------------------------------------
/** null: an older database without Gemini */
export async function getGeminiKeyStatus(): Promise<GeminiKeyStatus | null> {
  try {
    return await rpc<GeminiKeyStatus>('gemini_key_status');
  } catch (e) {
    if (missing(e)) return null;
    throw e;
  }
}

export async function saveGeminiKey(key: string): Promise<void> {
  const base = process.env.EXPO_PUBLIC_SUPABASE_URL ?? '';
  await rpc('set_gemini_key', {
    p_key: key.trim(),
    p_functions_url: base ? `${base.replace(/\/$/, '')}/functions/v1` : null,
  });
}

export const removeGeminiKey = () => rpc<void>('remove_gemini_key');

/** Ask Google whether the key works, and which Flash models it may use (a free check) */
export async function testGeminiKey(): Promise<{ ok: boolean; error?: string; models?: GeminiModel[] }> {
  const { data, error } = await supabase.functions.invoke('ai-admission-credit', {
    body: { action: 'test', provider: 'gemini' },
  });
  if (error) {
    const ctx = (error as { context?: Response }).context;
    if (ctx && typeof ctx.json === 'function') {
      const body = (await ctx.json().catch(() => null)) as { error?: string } | null;
      if (body?.error) return { ok: false, error: body.error };
    }
    return {
      ok: false,
      error: /not found|404/i.test(error.message)
        ? 'The ai-admission-credit Edge Function is not deployed yet.'
        : error.message,
    };
  }
  const d = (data ?? {}) as { ok?: boolean; error?: string; models?: GeminiModel[] };
  // an Edge Function from before Gemini answers the Claude test instead
  if (d.ok && !Array.isArray(d.models)) {
    return { ok: false, error: 'Deploy the new ai-admission-credit Edge Function first.' };
  }
  return { ok: !!d.ok, error: d.error, models: d.models ?? [] };
}

// ---------------------------------------------------------------------
// 📊 Each AI's numbers (admins); null: an older database
// ---------------------------------------------------------------------
export async function getAiProviderStats(): Promise<AiProviderStats | null> {
  try {
    return await rpc<AiProviderStats>('ai_provider_stats');
  } catch (e) {
    if (missing(e)) return null;
    throw e;
  }
}
