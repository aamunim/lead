// =====================================================================
// 📨🤖 SMS Center: three SMS drafts written by AI (Settings → AI: the
//   same AIs and plan as "Chance of admission")
//   POST { group, goal, hint?, tone?, language?, length?, current?,
//          audience?: { count, filter } } → { options: string[] }
//   The caller must be allowed to send SMS. The AI gets only what the
//   send is about (group, filters as words, how many) — no names, no
//   numbers. Drafts keep {first_name} {course} … for the app to fill in.
// =====================================================================
import { admin, json, loadConfig } from '../_shared/ai.ts';
import { asUser, cors, currentUser } from '../_shared/drive.ts';
import { answerByPlan, type Provider, recordUsage } from '../_shared/llm.ts';

const GROUPS = {
  active: 'people interested in admission who have not been admitted yet (open leads)',
  not_now: 'people who said "not now" earlier (lost leads) — win them back gently',
  admitted: 'admitted students of the college',
  alumni: 'former students (alumni), most are working teachers',
} as const;
type Group = keyof typeof GROUPS;

const SCHEMA = {
  type: 'object',
  properties: {
    options: {
      type: 'array',
      minItems: 3,
      maxItems: 3,
      items: { type: 'string', description: 'One SMS, ready to send' },
    },
  },
  required: ['options'],
  additionalProperties: false,
} as const;

const SYSTEM = `You write SMS messages for a teachers' training college in Bangladesh (B.Ed, M.Ed and similar courses).

Rules:
- Write three different drafts (different openings and wording), each ready to send as it is.
- SMS is plain text: no markdown, no emoji unless asked, no links unless given.
- Keep within the length asked. Bangla: one SMS is 70 letters, two SMS 134. English: one SMS is 160 letters, two 306.
- Polite, warm, clear; Bangla uses আপনি. Like a real person from the college office, not an advertisement.
- Use only facts given (dates, amounts, offers, phone numbers). Never make up a deadline, a discount, a fee or a promise.
- You may use these placeholders exactly as written; the app fills them in for each person: {first_name} {name} {course} {stage} {student_id} {fee_due} {owner} {owner_phone}. Use {fee_due} only for admitted students and only when the goal is about fees.
- End with the college's short name if it is given.`;

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });
  if (req.method !== 'POST') return json({ error: 'POST only.' }, 405);
  try {
    const user = await currentUser(req);
    if (!user) return json({ error: 'Please sign in again.' }, 401);
    const { data: can } = await asUser(req).rpc('sms_can_send');
    if (!can) return json({ error: 'You can’t send SMS. (Settings → SMS)' }, 403);

    const b = (await req.json().catch(() => ({}))) as {
      group?: string;
      goal?: string;
      hint?: string;
      tone?: string;
      language?: string;
      length?: number;
      current?: string;
      audience?: { count?: number; filter?: string };
    };
    const group = (b.group && b.group in GROUPS ? b.group : 'active') as Group;
    const clip = (v: unknown, n: number) =>
      String(v ?? '')
        .slice(0, n)
        .trim();
    const goal = clip(b.goal, 300);
    if (!goal && !clip(b.current, 1000)) return json({ error: 'Write what the SMS is for.' }, 400);
    const language = b.language === 'en' ? 'English' : 'Bangla';
    const parts = Math.min(3, Math.max(1, Number(b.length) || 1));

    const { data: tpl } = await admin.from('app_settings').select('value').eq('key', 'message_templates').maybeSingle();
    const college = (tpl?.value as { institute?: { name?: string } } | null)?.institute?.name || null;

    const cfg = await loadConfig('ai_chance');
    if (cfg.plan.providers.length === 0) {
      return json({ error: 'No AI is on. An admin can switch one on in Settings → AI.' }, 409);
    }
    // one answer is enough: in "compare" the free one is asked first
    if (cfg.plan.mode === 'compare') {
      cfg.plan = {
        ...cfg.plan,
        mode: 'gemini_then_claude',
        providers: [...cfg.plan.providers].sort((a) => (a === 'gemini' ? -1 : 1)),
      };
    }

    const r = await answerByPlan<{ options: string[] }>(
      cfg,
      {
        system: SYSTEM,
        user: JSON.stringify({
          send_to: GROUPS[group],
          goal: goal || null,
          staff_note: clip(b.hint, 400) || null,
          tone: clip(b.tone, 40) || 'friendly',
          language,
          length: `at most ${parts} SMS (${language === 'Bangla' ? [70, 134, 201][parts - 1] : [160, 306, 459][parts - 1]} letters)`,
          improve_this_draft: clip(b.current, 1000) || null,
          how_many_people: Number(b.audience?.count) || null,
          chosen_by: clip(b.audience?.filter, 300) || null,
          college,
          today: new Date().toISOString().slice(0, 10),
        }),
        schema: SCHEMA as unknown as Record<string, unknown>,
        maxTokens: 2000,
      },
      { allowClaude: cfg.plan.budget_ok, down: new Set<Provider>() },
    );
    for (const a of r.answers) await recordUsage('sms', a);
    if (!r.shown) {
      const why = r.errors.map((e) => e.message).join(' · ');
      return json({ error: why || 'No AI could answer right now. Try again in a while.' }, 503);
    }
    const options = (Array.isArray(r.shown.value.options) ? r.shown.value.options : [])
      .map((o) =>
        String(o ?? '')
          .trim()
          .slice(0, 1000),
      )
      .filter(Boolean)
      .slice(0, 3);
    if (options.length === 0) return json({ error: 'The AI gave no draft. Try again.' }, 502);
    return json({ options, provider: r.shown.provider });
  } catch (e) {
    return json({ error: e instanceof Error ? e.message : String(e) }, 500);
  }
});
