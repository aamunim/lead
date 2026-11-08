// =====================================================================
// 🤖 Admission credit by AI: works through the queue (admission_credits)
//   For each admitted lead it sends the AI (Claude and / or Gemini,
//   Settings → AI) the lead's story (people as codes P1, P2…; no names or
//   phone numbers) and saves the shares. Each AI's answer is kept; the
//   card uses the latest.
//   Who may wake it:
//     · the 2-minute job in the database (header x-cron-secret)
//     · any signed-in person (the app, right after "Admitted")
//   It answers at once and does the work in the background.
//   {"action":"test","provider":"claude"|"gemini"} (admins): checks a
//   saved key (Gemini: also lists the Flash models it may use).
//   The keys are set in the app (Settings → AI); only the server reads them.
// =====================================================================
import { admin, type AiConfig, drainQueue, idsOf, serveAiWorker, testKey } from '../_shared/ai.ts';
import { answerByPlan, onlyPauses, type Provider, recordUsage, testGemini } from '../_shared/llm.ts';

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
  test: (cfg, provider) => (provider === 'gemini' ? testGemini(cfg.gemini_key!) : testKey(cfg)),
  drain: (cfg) => {
    // an AI that fails for its key / quota / busyness is left out for the rest of this run
    const down = new Set<Provider>();
    return drainQueue(
      async (n) => {
        const { data, error } = await admin.rpc('ai_credit_claim', {
          p_limit: n,
        });
        if (error) throw new Error(error.message);
        return idsOf(data, 'ai_credit_claim');
      },
      (id) => one(cfg, id, down),
    );
  },
});

async function one(cfg: AiConfig, leadId: string, down: Set<Provider>): Promise<'ok' | 'stop'> {
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
    const r = await answerByPlan<Answer>(
      cfg,
      {
        system: extra ? `${SYSTEM}\n\nThe college's own rules (follow them):\n${extra}` : SYSTEM,
        user: JSON.stringify(story),
        schema: SCHEMA as unknown as Record<string, unknown>,
        maxTokens: 8000,
      },
      // past the monthly budget the database only hands out work when a free AI (Gemini) is in the plan
      { allowClaude: cfg.plan.budget_ok, down },
    );

    if (!r.shown) {
      if (r.errors.length === 0 || onlyPauses(r.errors)) {
        // no AI could take it right now (off, out, resting, busy): it waits, no try used up
        await admin.rpc('ai_credit_release', { p_lead: leadId });
      } else {
        const refusedOnly = r.errors.every((e) => e.kind === 'refusal');
        await admin.rpc('ai_credit_fail', {
          p_lead: leadId,
          p_error: r.errors.map((e) => e.message).join(' · '),
          p_retry: !refusedOnly,
        });
      }
      return r.exhausted ? 'stop' : 'ok';
    }

    const byCode = new Map(story.people.map((p) => [p.code, p.user_id]));
    // the numbers on the card: user ids in place of the codes
    const stats = (story.stats as Record<string, unknown>[]).map(({ person, ...rest }) => ({
      user_id: byCode.get(String(person)),
      ...rest,
    }));

    const save = async (a: (typeof r.answers)[number], final: boolean) => {
      const answer = a.value;
      const shares = (Array.isArray(answer.shares) ? answer.shares : [])
        .filter((s) => s && byCode.has(s.person) && Number(s.percent) > 0)
        .map((s) => ({
          user_id: byCode.get(s.person),
          share: Number(s.percent),
          reason: String(s.reason ?? ''),
        }));
      const { error: saveError } = await admin.rpc('ai_credit_save', {
        p_lead: leadId,
        p_shares: shares,
        p_decisive: String(answer.decisive_moment ?? ''),
        p_confidence: answer.confidence,
        p_stats: stats,
        p_model: a.model,
        p_usage: a.usage,
        p_provider: a.provider,
        p_final: final,
      });
      return saveError?.message ?? null;
    };

    // the AI was used (and paid for) whether or not its answer can be kept
    for (const a of r.answers) await recordUsage('credit', a);

    // 🗂 every answer is kept per AI; the shown one (compare mode: Claude's) goes on the card.
    // If the shown one can't be kept (e.g. no real shares), the other AI's answer takes its place.
    const others = r.answers.filter((a) => a !== r.shown);
    for (const a of others) {
      const err = await save(a, false);
      if (err) console.warn('ai-admission-credit', a.provider, err);
    }
    let lastError: string | null = null;
    for (const a of [r.shown, ...others]) {
      lastError = await save(a, true);
      if (!lastError) break;
    }
    if (lastError) throw new Error(lastError);
    return 'ok';
  } catch (e) {
    await admin.rpc('ai_credit_fail', {
      p_lead: leadId,
      p_error: e instanceof Error ? e.message : String(e),
      p_retry: true,
    });
    return 'ok';
  }
}
