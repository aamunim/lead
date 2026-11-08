// =====================================================================
// 🤖 Admission credit by AI: works through the queue (admission_credits)
//   For each admitted lead it sends Claude the lead's story (people as
//   codes P1, P2…; no names or phone numbers) and saves the shares.
//   Who may wake it:
//     · the 2-minute job in the database (header x-cron-secret)
//     · any signed-in person (the app, right after "Admitted")
//   It answers at once and does the work in the background.
//   {"action":"test"} (admins): checks the saved Claude API key.
//   The key is set in the app (Settings → AI); only the server reads it.
// =====================================================================
import {
  admin,
  aiClient,
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

type Person = { code: string; user_id: string };
type Input = {
  people: Person[];
  stats: unknown[];
  lead: unknown;
  events: unknown[];
};
type Answer = {
  shares: { person: string; percent: number; reason: string }[];
  decisive_moment: string;
  confidence: 'high' | 'medium' | 'low';
};

const SCHEMA = {
  type: 'object',
  properties: {
    shares: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          person: { type: 'string', description: 'The person code, e.g. P1' },
          percent: { type: 'integer', description: 'Whole percent, 0-100' },
          reason: {
            type: 'string',
            description: 'One short sentence in Bangla',
          },
        },
        required: ['person', 'percent', 'reason'],
        additionalProperties: false,
      },
    },
    decisive_moment: {
      type: 'string',
      description: 'One short sentence in Bangla',
    },
    confidence: { type: 'string', enum: ['high', 'medium', 'low'] },
  },
  required: ['shares', 'decisive_moment', 'confidence'],
  additionalProperties: false,
} as const;

const SYSTEM = `You share out the credit for one student's admission at a college admission office in Bangladesh, among the staff who worked on the lead.

You get the lead's story: when it was added and from where, every call (direction, answered or not, minutes, the caller's note), WhatsApp calls and messages, notes, campus visits, papers received, fee talks and payments, hand-overs (assigned … to …), stage moves, and who pressed "Admitted". People are codes (P1, P2…). "stats" has each person's totals.

Weigh real influence on the decision, not clicks:
- Conversations that moved the student: answered calls, talk minutes, notes that show real understanding (needs, doubts, family, fees) and follow-through.
- The work near the decision counts most: the campus visit, fee agreement, papers, the closing talk.
- Bringing the lead (adding it from a real contact or referral) earns a fair part; a bulk import with no talk earns little.
- Steady follow-up over weeks counts; many unanswered calls alone count little.
- Pressing "Admitted" or taking the payment is office work: a small part unless that person also did the talking.
- A hand-over is not work in itself; judge what each person did.
- Only people in "people" can get a share. Give 0 to (or leave out) those who did nothing that mattered.

Answer:
- shares: whole percents that add up to exactly 100, with one short reason each in simple Bangla (what that person did that mattered).
- decisive_moment: one short sentence in simple Bangla: what turned the student.
- confidence: high when the story is clear, low when there is little to go on (few notes, no talk).`;

serveAiWorker({
  name: 'ai-admission-credit',
  setting: 'ai_credit',
  allowTest: true,
  drain: (cfg) => {
    const ai = aiClient(cfg);
    return drainQueue(
      async (n) => {
        const { data, error } = await admin.rpc('ai_credit_claim', {
          p_limit: n,
        });
        if (error) throw new Error(error.message);
        return idsOf(data, 'ai_credit_claim');
      },
      (id) => one(ai, cfg, id),
    );
  },
});

async function one(ai: Anthropic, cfg: AiConfig, leadId: string): Promise<'ok' | 'stop'> {
  try {
    const { data: input, error } = await admin.rpc('admission_credit_input', {
      p_lead: leadId,
    });
    if (error) throw new Error(error.message);
    if (!input) {
      await admin.rpc('ai_credit_fail', {
        p_lead: leadId,
        p_error: 'Not admitted any more.',
        p_retry: false,
      });
      return 'ok';
    }
    const story = input as Input;
    if (story.people.length === 0) {
      await admin.rpc('ai_credit_fail', {
        p_lead: leadId,
        p_error: 'Nobody worked on this lead.',
        p_retry: false,
      });
      return 'ok';
    }

    const extra = (cfg.settings.guidance ?? '').trim();
    const res = await ai.beta.messages.create({
      model: modelOf(cfg),
      max_tokens: 8000,
      betas: ['server-side-fallback-2026-07-01'],
      fallbacks: 'default',
      output_config: {
        effort: effortOf(cfg),
        format: { type: 'json_schema', schema: SCHEMA },
      },
      system: extra ? `${SYSTEM}\n\nThe college's own rules (follow them):\n${extra}` : SYSTEM,
      messages: [{ role: 'user', content: JSON.stringify(story) }],
    });

    const { value: answer, why } = readJson<Answer>(res);
    if (!answer) {
      if (res.stop_reason === 'refusal') {
        await admin.rpc('ai_credit_fail', {
          p_lead: leadId,
          p_error: why,
          p_retry: false,
        });
        return 'ok';
      }
      throw new Error(why);
    }

    const byCode = new Map(story.people.map((p) => [p.code, p.user_id]));
    const shares = answer.shares
      .filter((s) => byCode.has(s.person) && s.percent > 0)
      .map((s) => ({
        user_id: byCode.get(s.person),
        share: s.percent,
        reason: s.reason,
      }));
    // the numbers on the card: user ids in place of the codes
    const stats = (story.stats as Record<string, unknown>[]).map(({ person, ...rest }) => ({
      user_id: byCode.get(String(person)),
      ...rest,
    }));

    const { error: saveError } = await admin.rpc('ai_credit_save', {
      p_lead: leadId,
      p_shares: shares,
      p_decisive: answer.decisive_moment,
      p_confidence: answer.confidence,
      p_stats: stats,
      p_model: res.model,
      p_usage: {
        input_tokens: res.usage.input_tokens,
        output_tokens: res.usage.output_tokens,
      },
    });
    if (saveError) throw new Error(saveError.message);
    await keyResult(true);
    // 💵 the monthly budget counts what was used
    await admin.rpc('ai_usage_add', {
      p_feature: 'credit',
      p_in: res.usage.input_tokens,
      p_out: res.usage.output_tokens,
    });
    return 'ok';
  } catch (e) {
    const { msg, kind } = classify(e);
    if (kind === 'key' || kind === 'credit') {
      // stop until an admin saves a new key / presses Test again
      await keyResult(false, msg);
      await admin.rpc('ai_credit_release', { p_lead: leadId });
      return 'stop';
    }
    if (kind === 'busy') {
      await admin.rpc('ai_credit_release', { p_lead: leadId });
      return 'stop';
    }
    await admin.rpc('ai_credit_fail', {
      p_lead: leadId,
      p_error: msg,
      p_retry: true,
    });
    return 'ok';
  }
}
