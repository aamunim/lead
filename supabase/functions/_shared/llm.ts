// =====================================================================
// 🤖 Two AIs behind one door: Claude and Gemini (free tier)
//   · askJson: one AI, one structured answer (JSON matching a schema)
//   · answerByPlan: the feature's mode from Settings → AI
//       claude | gemini | gemini_then_claude | compare
//     An AI that is switched off is never in the plan (the database
//     leaves it out), so its key is never used.
//   · what went wrong, per AI: a refused key stops that AI (shown in
//     Settings → AI); Gemini's free quota → it rests 15 minutes; busy →
//     this run goes on without it
// =====================================================================
import {
  admin,
  aiClient,
  askClaude,
  billedUsage,
  cachedSystem,
  classify,
  effortOf,
  keyResult,
  modelOf,
  readJson,
} from './ai.ts';
import type { AiConfig } from './ai.ts';

export type Provider = 'claude' | 'gemini';
export type Plan = {
  mode: 'claude' | 'gemini' | 'gemini_then_claude' | 'compare';
  providers: Provider[];
  budget_ok: boolean;
};

export type Usage = { input_tokens: number; output_tokens: number; [k: string]: unknown };
export type Answer<T> = { provider: Provider; value: T; model: string; usage: Usage };

export type ErrKind = 'key' | 'credit' | 'busy' | 'quota' | 'refusal' | 'other';
export class AiError extends Error {
  constructor(
    public provider: Provider,
    public kind: ErrKind,
    message: string,
  ) {
    super(message);
  }
}

export type JsonRequest = {
  system: string;
  user: string;
  schema: Record<string, unknown>;
  maxTokens: number;
};

const GEMINI_URL = 'https://generativelanguage.googleapis.com/v1beta';
const GEMINI_TIMEOUT_MS = 75_000;

// ---------------------------------------------------------------------
// Gemini (REST)
// ---------------------------------------------------------------------
const modelPath = (m: string) => (m.startsWith('models/') ? m : `models/${m}`);

type GeminiPart = { text?: string; thought?: boolean };
type GeminiReply = {
  candidates?: { content?: { parts?: GeminiPart[] }; finishReason?: string }[];
  promptFeedback?: { blockReason?: string };
  usageMetadata?: { promptTokenCount?: number; candidatesTokenCount?: number; thoughtsTokenCount?: number };
  modelVersion?: string;
  error?: { code?: number; message?: string; status?: string };
};

async function geminiFetch(key: string, path: string, body?: unknown): Promise<{ status: number; data: GeminiReply }> {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), GEMINI_TIMEOUT_MS);
  try {
    const res = await fetch(`${GEMINI_URL}/${path}`, {
      method: body ? 'POST' : 'GET',
      headers: { 'Content-Type': 'application/json', 'x-goog-api-key': key },
      body: body ? JSON.stringify(body) : undefined,
      signal: ctl.signal,
    });
    const data = (await res.json().catch(() => ({}))) as GeminiReply;
    return { status: res.status, data };
  } catch (e) {
    const aborted = e instanceof DOMException && e.name === 'AbortError';
    throw new AiError(
      'gemini',
      'busy',
      aborted ? 'Gemini took too long.' : `Gemini could not be reached: ${String(e)}`,
    );
  } finally {
    clearTimeout(timer);
  }
}

function geminiError(status: number, data: GeminiReply): AiError {
  const msg = data.error?.message ?? `HTTP ${status}`;
  const st = data.error?.status ?? '';
  if (status === 429 || st === 'RESOURCE_EXHAUSTED') {
    return new AiError('gemini', 'quota', 'Gemini’s free limit is used up for now; it will rest and try again.');
  }
  if (status === 401 || status === 403 || /API_KEY_INVALID|API key not valid|PERMISSION_DENIED/i.test(`${st} ${msg}`)) {
    return new AiError('gemini', 'key', 'The Gemini API key was refused. Save a new key in Settings → AI.');
  }
  if (status === 404) {
    return new AiError('gemini', 'other', 'This Gemini model was not found. Choose another in Settings → AI.');
  }
  if (status >= 500) return new AiError('gemini', 'busy', `Gemini is busy (${status}).`);
  return new AiError('gemini', 'other', `Gemini: ${msg}`);
}

async function geminiJson<T>(key: string, model: string, r: JsonRequest): Promise<Answer<T>> {
  const make = (withSchema: boolean) => ({
    systemInstruction: {
      parts: [
        {
          text: withSchema
            ? r.system
            : `${r.system}\n\nAnswer with JSON only, matching this JSON schema:\n${JSON.stringify(r.schema)}`,
        },
      ],
    },
    contents: [{ role: 'user', parts: [{ text: r.user }] }],
    generationConfig: {
      responseMimeType: 'application/json',
      maxOutputTokens: Math.max(r.maxTokens, 16000),
      ...(withSchema ? { responseJsonSchema: r.schema } : {}),
    },
  });
  const path = `${modelPath(model)}:generateContent`;
  let { status, data } = await geminiFetch(key, path, make(true));
  // an older model / API version that doesn't take a JSON schema: the schema goes into the instructions
  if (
    status === 400 &&
    /response_?json_?schema|responseJsonSchema|Unknown name|schema/i.test(data.error?.message ?? '')
  ) {
    ({ status, data } = await geminiFetch(key, path, make(false)));
  }
  if (status < 200 || status >= 300) throw geminiError(status, data);

  const cand = data.candidates?.[0];
  if (!cand) {
    throw new AiError(
      'gemini',
      'refusal',
      `Gemini declined this one${data.promptFeedback?.blockReason ? ` (${data.promptFeedback.blockReason})` : ''}.`,
    );
  }
  if (cand.finishReason && /SAFETY|PROHIBITED|BLOCKLIST|SPII|RECITATION/.test(cand.finishReason)) {
    throw new AiError('gemini', 'refusal', `Gemini declined this one (${cand.finishReason}).`);
  }
  if (cand.finishReason === 'MAX_TOKENS') throw new AiError('gemini', 'other', 'Gemini’s answer was cut short.');
  const text = (cand.content?.parts ?? [])
    .filter((p) => !p.thought && typeof p.text === 'string')
    .map((p) => p.text)
    .join('')
    .trim()
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/\s*```$/, '');
  let value: T;
  try {
    value = JSON.parse(text) as T;
  } catch {
    throw new AiError('gemini', 'other', 'Gemini’s answer was not proper JSON.');
  }
  const u = data.usageMetadata ?? {};
  return {
    provider: 'gemini',
    value,
    model: data.modelVersion ?? model.replace(/^models\//, ''),
    usage: {
      input_tokens: u.promptTokenCount ?? 0,
      output_tokens: (u.candidatesTokenCount ?? 0) + (u.thoughtsTokenCount ?? 0),
    },
  };
}

/** Settings → AI "Test": is the key good, and which Flash models may it use (the free tier) */
export async function testGemini(key: string) {
  const { status, data } = await geminiFetch(key, 'models?pageSize=200');
  if (status < 200 || status >= 300) {
    const e = geminiError(status, data);
    if (e.kind === 'key') await keyResult(false, e.message, 'gemini');
    return { ok: false, error: e.message };
  }
  const models = (
    ((data as unknown as { models?: unknown[] }).models ?? []) as {
      name: string;
      displayName?: string;
      supportedGenerationMethods?: string[];
    }[]
  )
    .filter(
      (m) =>
        (m.supportedGenerationMethods ?? []).includes('generateContent') &&
        /flash/i.test(m.name) &&
        !/image|tts|audio|live|embedding|vision|exp-/i.test(m.name),
    )
    .map((m) => ({ name: m.name, label: m.displayName ?? m.name.replace(/^models\//, '') }));
  await keyResult(true, null, 'gemini');
  return { ok: true, models };
}

// ---------------------------------------------------------------------
// One AI, one answer
// ---------------------------------------------------------------------
export async function askJson<T>(cfg: AiConfig, provider: Provider, r: JsonRequest): Promise<Answer<T>> {
  if (provider === 'gemini') {
    if (!cfg.gemini_key || !cfg.gemini_model) throw new AiError('gemini', 'key', 'Gemini is not set up (key / model).');
    return geminiJson<T>(cfg.gemini_key, cfg.gemini_model, r);
  }
  if (!cfg.key) throw new AiError('claude', 'key', 'No Claude API key is saved.');
  let res;
  try {
    res = await askClaude(aiClient(cfg), {
      model: modelOf(cfg),
      max_tokens: r.maxTokens,
      output_config: { effort: effortOf(cfg), format: { type: 'json_schema', schema: r.schema } },
      system: cachedSystem(r.system),
      messages: [{ role: 'user', content: r.user }],
    });
  } catch (e) {
    const { msg, kind } = classify(e);
    throw new AiError('claude', kind, msg);
  }
  let parsed;
  try {
    parsed = readJson<T>(res);
  } catch {
    throw new AiError('claude', 'other', 'Claude’s answer was not proper JSON.');
  }
  if (!parsed.value) {
    throw new AiError('claude', res.stop_reason === 'refusal' ? 'refusal' : 'other', parsed.why ?? 'No answer.');
  }
  return { provider: 'claude', value: parsed.value, model: res.model, usage: billedUsage(res.usage) };
}

// ---------------------------------------------------------------------
// The feature's plan
// ---------------------------------------------------------------------
/** A problem with one AI: note it (key refused / quota) and leave that AI out for the rest of this run */
async function noteError(e: AiError, down: Set<Provider>) {
  if (e.kind === 'key' || e.kind === 'credit') {
    await keyResult(false, e.message, e.provider);
    down.add(e.provider);
  } else if (e.kind === 'quota') {
    await admin.rpc('ai_provider_pause', { p_provider: e.provider, p_minutes: 15 });
    down.add(e.provider);
  } else if (e.kind === 'busy') {
    down.add(e.provider);
  }
}

export type PlanResult<T> = {
  /** every answer we got (compare mode: up to two) */
  answers: Answer<T>[];
  /** the one the lists / Credits use: Claude's in compare mode, else the only one */
  shown: Answer<T> | null;
  errors: AiError[];
  /** no AI of the plan can be used any more in this run */
  exhausted: boolean;
};

export async function answerByPlan<T>(
  cfg: AiConfig,
  r: JsonRequest,
  opts: { allowClaude: boolean; down: Set<Provider> },
): Promise<PlanResult<T>> {
  const usable = (p: Provider) => !opts.down.has(p) && (p !== 'claude' || opts.allowClaude);
  const answers: Answer<T>[] = [];
  const errors: AiError[] = [];
  for (const p of cfg.plan.providers) {
    if (!usable(p)) continue;
    try {
      answers.push(await askJson<T>(cfg, p, r));
      if (cfg.plan.mode !== 'compare') break; // one answer is enough
    } catch (e) {
      const err = e instanceof AiError ? e : new AiError(p, 'other', e instanceof Error ? e.message : String(e));
      errors.push(err);
      await noteError(err, opts.down);
      // gemini_then_claude / compare: go on with the next AI
    }
  }
  const shown = answers.find((a) => a.provider === 'claude') ?? answers[0] ?? null;
  const exhausted = cfg.plan.providers.every((p) => !usable(p));
  return { answers, shown, errors, exhausted };
}

/** Whether a failure should leave the lead waiting (no try used up): the AI was off, out, busy or resting */
export const onlyPauses = (errors: AiError[]) =>
  errors.length > 0 &&
  errors.every((e) => e.kind === 'key' || e.kind === 'credit' || e.kind === 'busy' || e.kind === 'quota');

/** The usage ledger: Claude counts toward the budget, Gemini's free use is kept apart */
export async function recordUsage(feature: string, a: Answer<unknown>) {
  await admin.rpc('ai_usage_add', {
    p_feature: a.provider === 'gemini' ? `gemini:${feature}` : feature,
    p_in: a.usage.input_tokens,
    p_out: a.usage.output_tokens,
  });
  await keyResult(true, null, a.provider);
}
