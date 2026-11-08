// =====================================================================
// 🔮 Chance of admission by AI: works through the queue (lead_chances)
//   For each open lead it sends Claude the lead's story (calls, minutes,
//   the hours they answer, every note, visits, fee talks, next calls;
//   people as codes, no names or phone numbers) and how often leads like
//   it were admitted. Claude answers with the chance, why, the doubts,
//   the next steps and lines to say — in Bangla.
//   Woken by the 2-minute job (x-cron-secret) or the app ("Check").
// =====================================================================
import {
  admin,
  aiClient,
  askClaude,
  billedUsage,
  cachedSystem,
  type AiConfig,
  type Anthropic,
  classify,
  drainQueue,
  effortOf,
  idsOf,
  keyResult,
  modelOf,
  readJson,
  serveAiWorker,
} from '../_shared/ai.ts';

type Answer = {
  chance: number;
  summary: string;
  good: string[];
  risks: string[];
  objections: { kind: string; detail: string }[];
  actions: { text: string; why: string }[];
  script: { situation: string; lines: string[] }[];
  best_time: string;
  next_call_days: number;
  next_call_why: string;
};

const OBJECTIONS = [
  'fee',
  'family',
  'distance',
  'time',
  'other_college',
  'job',
  'doubt',
  'documents',
  'other',
] as const;

const SCHEMA = {
  type: 'object',
  properties: {
    chance: {
      type: 'integer',
      description: 'Chance of admission in percent, 0-100',
    },
    summary: {
      type: 'string',
      description: 'One or two short sentences in Bangla',
    },
    good: {
      type: 'array',
      items: { type: 'string' },
      description: 'Signs for admission, short, Bangla',
    },
    risks: {
      type: 'array',
      items: { type: 'string' },
      description: 'Signs against, short, Bangla',
    },
    objections: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          kind: { type: 'string', enum: OBJECTIONS },
          detail: { type: 'string', description: 'What exactly, in Bangla' },
        },
        required: ['kind', 'detail'],
        additionalProperties: false,
      },
    },
    actions: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          text: {
            type: 'string',
            description: 'What to do next, one short Bangla sentence',
          },
          why: { type: 'string', description: 'Why, short Bangla' },
        },
        required: ['text', 'why'],
        additionalProperties: false,
      },
    },
    script: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          situation: {
            type: 'string',
            description: 'When to say it, e.g. "ফি বেশি বললে", in Bangla',
          },
          lines: {
            type: 'array',
            items: { type: 'string' },
            description: '1-3 lines to say, spoken Bangla',
          },
        },
        required: ['situation', 'lines'],
        additionalProperties: false,
      },
    },
    best_time: {
      type: 'string',
      description: 'Best time to call, Bangla, e.g. "বিকেল ৫টা–৭টা"',
    },
    next_call_days: {
      type: 'integer',
      description: 'Call again in this many days from today (0 = today)',
    },
    next_call_why: { type: 'string', description: 'Short Bangla' },
  },
  required: [
    'chance',
    'summary',
    'good',
    'risks',
    'objections',
    'actions',
    'script',
    'best_time',
    'next_call_days',
    'next_call_why',
  ],
  additionalProperties: false,
} as const;

const SYSTEM = `You help the admission team of a teachers' training college in Bangladesh (B.Ed, M.Ed and similar courses; most students are working teachers or graduates). For one open lead you judge how likely the person is to get admitted, and you coach the caller on what to do and say next.

You get:
- "lead": stage, how old the lead is, days since the last contact, source, courses, area, the staff's own rating, campus visit, fee talk, papers, your previous chance.
- "events": every call (direction, answered or not, minutes, the caller's note), WhatsApp, notes by everyone, visits, fee offers and discounts, papers, hand-overs, next calls set. People are codes (P1, P2…).
- "stats": each person's totals. "answer_hours": by Dhaka hour, how many calls were answered / not. "next_calls": the next call due and how many were missed. "like_this_before": of leads closed in the last year with the same course / the same source, how many were admitted vs lost. "today": today's date and weekday.

Judge the chance honestly and calibrate it:
- Start from "like_this_before" when it has enough cases; otherwise from what an admission office usually sees (most leads are not admitted).
- Move it up for: real conversations (answered calls, long talks), interest stated in notes, questions about classes / fees / papers, a campus visit, a fee agreement, papers given, a referral.
- Move it down for: many unanswered calls in a row, long silence, "not interested", family against, chose another college, fee firmly too high, missed next calls, a lead never reached.
- Notes are the strongest evidence; read them carefully (they may be in Bangla, English or both).

Coach the caller:
- objections: the doubts you can actually see in the notes (fee, family, distance, time / job schedule, other college, job, doubt about the course's value, documents). Do not invent any.
- actions: 2-5 concrete next steps for this lead, most useful first (e.g. call at the hour they answer, invite to a campus visit, talk to the guardian, send the class schedule on WhatsApp, ask the admission officer about installments).
- script: for each likely situation, 1-3 short lines in polite spoken Bangla (আপনি), warm and honest, that the caller can say as they are.
- best_time: from "answer_hours" (Dhaka time); if there is too little data, say so briefly.
- next_call_days: when to call next, counted from today.

Rules: never promise a discount, a scholarship, a fee, a date or anything else that is not in the data — suggest asking the admission officer instead. Keep every text short and simple. Write everything in Bangla except the "kind" values.`;

serveAiWorker({
  name: 'ai-lead-chance',
  setting: 'ai_chance',
  drain: (cfg) => {
    const ai = aiClient(cfg);
    return drainQueue(
      async (n) => {
        const { data, error } = await admin.rpc('ai_chance_claim', {
          p_limit: n,
        });
        if (error) throw new Error(error.message);
        return idsOf(data, 'ai_chance_claim');
      },
      (id) => one(ai, cfg, id),
      5, // leads at a time (a group of hundreds finishes in an hour or two)
    );
  },
});

const clean = (list: unknown, max: number) =>
  (Array.isArray(list) ? list : [])
    .map((x) => String(x ?? '').trim())
    .filter(Boolean)
    .slice(0, max)
    .map((x) => x.slice(0, 300));

async function one(ai: Anthropic, cfg: AiConfig, leadId: string): Promise<'ok' | 'stop'> {
  try {
    const { data: input, error } = await admin.rpc('ai_chance_input', {
      p_lead: leadId,
    });
    if (error) throw new Error(error.message);
    if (!input) {
      // admitted / lost / deleted meanwhile
      await admin.rpc('ai_chance_fail', {
        p_lead: leadId,
        p_error: 'Not an open lead any more.',
        p_retry: false,
      });
      return 'ok';
    }

    const extra = (cfg.settings.guidance ?? '').trim();
    const res = await askClaude(ai, {
      model: modelOf(cfg),
      max_tokens: 10000,
      output_config: {
        effort: effortOf(cfg),
        format: { type: 'json_schema', schema: SCHEMA },
      },
      system: cachedSystem(extra ? `${SYSTEM}\n\nThe college's own notes (use them):\n${extra}` : SYSTEM),
      messages: [{ role: 'user', content: JSON.stringify(input) }],
    });

    const { value: a, why } = readJson<Answer>(res);
    if (!a) {
      if (res.stop_reason === 'refusal') {
        await admin.rpc('ai_chance_fail', {
          p_lead: leadId,
          p_error: why,
          p_retry: false,
        });
        return 'ok';
      }
      throw new Error(why);
    }

    const result = {
      chance: Math.max(0, Math.min(100, Math.round(Number(a.chance) || 0))),
      summary: String(a.summary ?? '').slice(0, 600),
      good: clean(a.good, 5),
      risks: clean(a.risks, 5),
      objections: (a.objections ?? [])
        .filter((o) => o && OBJECTIONS.includes(o.kind as (typeof OBJECTIONS)[number]))
        .slice(0, 5)
        .map((o) => ({
          kind: o.kind,
          detail: String(o.detail ?? '').slice(0, 300),
        })),
      actions: (a.actions ?? [])
        .slice(0, 5)
        .map((x) => ({
          text: String(x.text ?? '').slice(0, 300),
          why: String(x.why ?? '').slice(0, 300),
        }))
        .filter((x) => x.text),
      script: (a.script ?? [])
        .slice(0, 5)
        .map((x) => ({
          situation: String(x.situation ?? '').slice(0, 200),
          lines: clean(x.lines, 3),
        }))
        .filter((x) => x.lines.length > 0),
      best_time: String(a.best_time ?? '').slice(0, 200),
      next_call_days: Math.max(0, Math.min(60, Math.round(Number(a.next_call_days) || 0))),
      next_call_why: String(a.next_call_why ?? '').slice(0, 300),
    };

    const usage = billedUsage(res.usage);
    const { error: saveError } = await admin.rpc('ai_chance_save', {
      p_lead: leadId,
      p_r: result,
      p_model: res.model,
      p_usage: usage,
    });
    if (saveError) throw new Error(saveError.message);
    await keyResult(true);
    // 💵 the monthly budget counts what was used
    await admin.rpc('ai_usage_add', {
      p_feature: 'chance',
      p_in: usage.input_tokens,
      p_out: usage.output_tokens,
    });
    return 'ok';
  } catch (e) {
    const { msg, kind } = classify(e);
    if (kind === 'key' || kind === 'credit') {
      await keyResult(false, msg);
      await admin.rpc('ai_chance_release', { p_lead: leadId });
      return 'stop';
    }
    if (kind === 'busy') {
      await admin.rpc('ai_chance_release', { p_lead: leadId });
      return 'stop';
    }
    await admin.rpc('ai_chance_fail', {
      p_lead: leadId,
      p_error: msg,
      p_retry: true,
    });
    return 'ok';
  }
}
