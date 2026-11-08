// =====================================================================
// 🤖 Shared by the AI Edge Functions (ai-admission-credit, ai-lead-chance)
//   · the key, the job password and the function's own setting, from the
//     database (only the server reads the key; Settings → AI sets it)
//   · who may wake a function: the 2-minute job (x-cron-secret) or any
//     signed-in person
//   · it answers at once and works through its queue in the background
//   · what a Claude error means: key refused / no credit / busy / other
// =====================================================================
import Anthropic from 'npm:@anthropic-ai/sdk@1.6.0';

import { admin, asUser, cors, currentUser, json } from './drive.ts';

export { Anthropic, admin, json };

declare const EdgeRuntime: { waitUntil(p: Promise<unknown>): void } | undefined;

export const DEFAULT_MODEL = 'claude-sonnet-5-5';
// A run must end inside the Edge Function's time limit (150 s on the free plan):
// new leads start for 45 s, and one call may take 75 s (no retry; a failed one
// waits in the queue for the next run)
const CALL_TIMEOUT_MS = 75_000;

export type AiSettings = {
  enabled?: boolean;
  model?: string;
  effort?: string;
  guidance?: string;
};
export type AiConfig = {
  /** Claude */
  key: string | null;
  gemini_key: string | null;
  gemini_model: string | null;
  cron_secret: string | null;
  settings: AiSettings;
  /** which AIs this feature may use now, in order (switched-off ones are left out) */
  plan: {
    mode: 'claude' | 'gemini' | 'gemini_then_claude' | 'compare';
    providers: ('claude' | 'gemini')[];
    budget_ok: boolean;
  };
};

/** The key, the job password and the setting called `setting` */
export async function loadConfig(setting: string): Promise<AiConfig> {
  const { data, error } = await admin.rpc('ai_server_config', {
    p_setting: setting,
  });
  if (error) throw new Error(error.message);
  const c = (data ?? {}) as Partial<AiConfig>;
  return {
    key: c.key ?? null,
    gemini_key: c.gemini_key ?? null,
    gemini_model: c.gemini_model ?? null,
    cron_secret: c.cron_secret ?? null,
    settings: c.settings ?? {},
    plan: {
      mode: c.plan?.mode ?? 'claude',
      providers: c.plan?.providers ?? [],
      budget_ok: c.plan?.budget_ok ?? true,
    },
  };
}

export function aiClient(cfg: AiConfig): Anthropic {
  return new Anthropic({
    apiKey: cfg.key!,
    timeout: CALL_TIMEOUT_MS,
    maxRetries: 0,
  });
}

/** The Claude models Settings → AI offers (anything else: the default) */
export const CLAUDE_MODELS = ['claude-sonnet-5-5', 'claude-haiku-5-5'];

export function modelOf(cfg: AiConfig): string {
  const m = cfg.settings.model ?? '';
  return CLAUDE_MODELS.includes(m) ? m : DEFAULT_MODEL;
}

export function effortOf(cfg: AiConfig): 'low' | 'medium' | 'high' {
  return (['low', 'medium', 'high'] as const).find((x) => x === cfg.settings.effort) ?? 'medium';
}

/** What went wrong, in words for the admin, and what to do about it */
export function classify(e: unknown): {
  msg: string;
  kind: 'key' | 'credit' | 'busy' | 'other';
} {
  if (e instanceof Anthropic.AuthenticationError) {
    return {
      msg: 'The Claude API key was refused. Save a new key in Settings → AI.',
      kind: 'key',
    };
  }
  if (e instanceof Anthropic.PermissionDeniedError) return { msg: 'This key may not use the model.', kind: 'key' };
  if (e instanceof Anthropic.NotFoundError) return { msg: 'The model was not found.', kind: 'other' };
  if (e instanceof Anthropic.RateLimitError) {
    return {
      msg: 'Claude is busy or the credit ran out; it will try again.',
      kind: 'busy',
    };
  }
  if (e instanceof Anthropic.BadRequestError) {
    return /credit balance/i.test(e.message)
      ? {
          msg: 'The Claude API credit has run out. Add credit, then press Test in Settings → AI.',
          kind: 'credit',
        }
      : { msg: `Claude: ${e.message}`, kind: 'other' };
  }
  if (e instanceof Anthropic.APIError) {
    return {
      msg: `Claude ${e.status ?? ''}: ${e.message}`.trim(),
      kind: e.status === 529 ? 'busy' : 'other',
    };
  }
  return { msg: e instanceof Error ? e.message : String(e), kind: 'other' };
}

/** A key works again / does not: shown in Settings → AI (a refused key also stops that AI) */
export async function keyResult(ok: boolean, error: string | null = null, provider: 'claude' | 'gemini' = 'claude') {
  await admin.rpc('ai_key_result', { p_ok: ok, p_error: error, p_provider: provider });
}

/** A free check: can this key see the model? */
export async function testKey(cfg: AiConfig) {
  const model = modelOf(cfg);
  try {
    await aiClient(cfg).models.retrieve(model);
    await keyResult(true);
    return { ok: true, model };
  } catch (e) {
    const { msg, kind } = classify(e);
    if (kind === 'key') await keyResult(false, msg);
    return { ok: false, error: msg };
  }
}

/** The text of a structured answer, as JSON (null when refused or cut short) */
export function readJson<T>(res: Anthropic.Beta.BetaMessage): {
  value: T | null;
  why?: string;
} {
  if (res.stop_reason === 'refusal') return { value: null, why: 'The AI declined this one.' };
  if (res.stop_reason === 'max_tokens') return { value: null, why: 'The answer was cut short.' };
  const text = res.content.map((b) => (b.type === 'text' ? b.text : '')).join('');
  return { value: JSON.parse(text) as T };
}

/**
 * The common front door: CORS, who is asking, the optional "test" action
 * (admins), then the background work.
 */
export function serveAiWorker(opts: {
  name: string;
  setting: string;
  /** Settings → AI "Test" (admins): checks one AI's key */
  test?: (cfg: AiConfig, provider: 'claude' | 'gemini') => Promise<unknown>;
  drain: (cfg: AiConfig) => Promise<void>;
}) {
  Deno.serve(async (req) => {
    if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });
    if (req.method !== 'POST') return json({ error: 'POST only.' }, 405);
    try {
      const body = (await req.json().catch(() => ({}))) as { action?: string; provider?: string };
      const cfg = await loadConfig(opts.setting);

      const secret = req.headers.get('x-cron-secret');
      const fromJob = !!secret && !!cfg.cron_secret && secret === cfg.cron_secret;
      if (!fromJob) {
        const user = await currentUser(req);
        if (!user) return json({ error: 'Please sign in again.' }, 401);
      }

      if (body.action === 'test' && opts.test) {
        if (fromJob) return json({ error: 'Not allowed.' }, 403);
        const { data: isAdmin } = await asUser(req).rpc('has_permission', {
          perm: 'settings.manage',
        });
        if (!isAdmin) return json({ error: 'Only an admin can do this.' }, 403);
        const provider = body.provider === 'gemini' ? 'gemini' : 'claude';
        if (provider === 'claude' && !cfg.key) {
          return json({ error: 'No Claude API key is saved.', code: 'no_key' }, 409);
        }
        if (provider === 'gemini' && !cfg.gemini_key) {
          return json({ error: 'No Gemini API key is saved.', code: 'no_key' }, 409);
        }
        return json(await opts.test(cfg, provider));
      }

      // no AI on for this feature (both switched off, or no working key): nothing to do
      if (cfg.plan.providers.length === 0) return json({ ok: false, code: 'no_ai' });
      if (cfg.settings.enabled === false) return json({ ok: false, code: 'off' });

      const work = opts.drain(cfg).catch((e) => console.error(opts.name, e));
      if (typeof EdgeRuntime !== 'undefined') {
        EdgeRuntime.waitUntil(work);
        return json({ ok: true, started: true }, 202);
      }
      await work;
      return json({ ok: true });
    } catch (e) {
      return json({ error: e instanceof Error ? e.message : String(e) }, 500);
    }
  });
}

/**
 * Take items from a queue until it is empty or time is up.
 * `claim` returns ids; `one` returns 'stop' to end early (key / credit / busy).
 */
export async function drainQueue(
  claim: (n: number) => Promise<string[]>,
  one: (id: string) => Promise<'ok' | 'stop'>,
  parallel = 3,
  startNewUntilMs = 45_000,
) {
  const started = Date.now();
  while (Date.now() - started < startNewUntilMs) {
    const ids = await claim(parallel);
    if (ids.length === 0) break;
    const results = await Promise.all(ids.map((id) => one(id)));
    if (results.includes('stop')) break;
  }
}

/** setof uuid from an RPC → string[] */
export function idsOf(data: unknown, fn: string): string[] {
  return ((data ?? []) as unknown[]).map((x) => (typeof x === 'string' ? x : (x as Record<string, string>)[fn]));
}

/**
 * 🗂 Prompt caching: the instructions are the same for every lead, so they
 * are marked to be kept by Claude for a few minutes; the next leads read
 * them at a tenth of the price (each lead's own story is never the same).
 */
export function cachedSystem(text: string): Anthropic.Beta.BetaTextBlockParam[] {
  return [{ type: 'text', text, cache_control: { type: 'ephemeral' } }];
}

/**
 * What a call cost, as plain input / output tokens for the budget:
 * cache reads count 0.1×, cache writes 1.25× an input token.
 */
export function billedUsage(u: Anthropic.Beta.BetaUsage) {
  const read = u.cache_read_input_tokens ?? 0;
  const write = u.cache_creation_input_tokens ?? 0;
  return {
    input_tokens: Math.round(u.input_tokens + read * 0.1 + write * 1.25),
    output_tokens: u.output_tokens,
    fresh_input: u.input_tokens,
    cache_read: read,
    cache_write: write,
  };
}

/**
 * Ask Claude, with the server-side fallback for a declined request. If the
 * API ever refuses that option itself (an older account or model), ask
 * again without it rather than failing every lead.
 */
export async function askClaude(
  ai: Anthropic,
  params: Omit<Anthropic.Beta.MessageCreateParamsNonStreaming, 'betas' | 'fallbacks'>,
): Promise<Anthropic.Beta.BetaMessage> {
  // Haiku has no server-side fallback: ask it plainly (no wasted refused request first)
  if (/haiku/i.test(String(params.model))) return await ai.beta.messages.create(params);
  try {
    return await ai.beta.messages.create({
      ...params,
      betas: ['server-side-fallback-2026-07-01'],
      fallbacks: 'default',
    });
  } catch (e) {
    if (e instanceof Anthropic.BadRequestError && /fallback/i.test(e.message)) {
      return await ai.beta.messages.create(params);
    }
    throw e;
  }
}
