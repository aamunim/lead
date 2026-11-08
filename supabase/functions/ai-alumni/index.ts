// =====================================================================
// ✨ A WhatsApp message for an alumnus, written by AI (Settings → AI:
//   the same AIs and plan as "Chance of admission")
//   POST { alumni_id?, purpose: refer | reconnect | birthday | thanks |
//   campaign, hint? } → { message }
//   The caller must see alumni. The AI gets the alumnus's first name,
//   course, batch, workplace, counts and their last notes — no phone
//   numbers. A campaign message (no alumnus) keeps {first_name} and
//   {refer_link} for the app to fill in for each person.
// =====================================================================
import { admin, json, loadConfig } from '../_shared/ai.ts';
import { asUser, cors, currentUser } from '../_shared/drive.ts';
import { answerByPlan, type Provider, recordUsage } from '../_shared/llm.ts';

const PURPOSES = {
  refer:
    'Ask them, warmly, whether a colleague, friend or relative wants to study with us; mention that they can share their own link {refer_link}.',
  reconnect: 'A friendly hello to catch up after a long time; ask how they are and how work is going. No request.',
  birthday: 'A warm birthday wish. No request, no link.',
  thanks: 'Thank them warmly for referring a student who got admitted. No request.',
  campaign:
    'A message for many alumni at once: write it with {first_name} where the name goes, and {refer_link} for their own referral link if a link fits.',
} as const;
type Purpose = keyof typeof PURPOSES;

const SCHEMA = {
  type: 'object',
  properties: {
    message: { type: 'string', description: 'The WhatsApp message in Bangla, ready to send' },
  },
  required: ['message'],
  additionalProperties: false,
} as const;

const SYSTEM = `You write short WhatsApp messages from a teachers' training college in Bangladesh to its former students (alumni). Most alumni are working teachers.

Write in warm, polite, natural Bangla (আপনি), like a real person from the college office — not like an advertisement. 2-5 short lines, at most one or two emoji. Use what you know about the person (first name, course, batch, workplace, past notes) only where it reads naturally; never make up facts. Never promise money, a discount, a reward or anything else that is not in the data. Keep {placeholders} exactly as written when you use them. Sign off with the college's name if it is given.`;

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });
  if (req.method !== 'POST') return json({ error: 'POST only.' }, 405);
  try {
    const user = await currentUser(req);
    if (!user) return json({ error: 'Please sign in again.' }, 401);
    const { data: can } = await asUser(req).rpc('alumni_can', { p_level: 'view' });
    if (!can) return json({ error: 'You cannot see alumni.' }, 403);

    const body = (await req.json().catch(() => ({}))) as { alumni_id?: string | null; purpose?: string; hint?: string };
    const purpose = (body.purpose && body.purpose in PURPOSES ? body.purpose : 'refer') as Purpose;
    const hint = String(body.hint ?? '')
      .slice(0, 300)
      .trim();

    let person: unknown = null;
    if (purpose !== 'campaign') {
      if (!body.alumni_id) return json({ error: 'Choose an alumnus.' }, 400);
      const { data, error } = await admin.rpc('alumni_ai_input', { p_alumni: body.alumni_id });
      if (error) throw new Error(error.message);
      if (!data) return json({ error: 'Alumnus not found.' }, 404);
      person = data;
    }
    const { data: tpl } = await admin.from('app_settings').select('value').eq('key', 'message_templates').maybeSingle();
    const college = (tpl?.value as { institute?: { name?: string } } | null)?.institute?.name || null;

    const cfg = await loadConfig('ai_chance');
    if (cfg.plan.providers.length === 0) {
      return json({ error: 'No AI is on. An admin can switch one on in Settings → AI.' }, 409);
    }
    // one message is enough: in "compare" the free one is asked first
    if (cfg.plan.mode === 'compare') {
      cfg.plan = {
        ...cfg.plan,
        mode: 'gemini_then_claude',
        providers: [...cfg.plan.providers].sort((a) => (a === 'gemini' ? -1 : 1)),
      };
    }

    const r = await answerByPlan<{ message: string }>(
      cfg,
      {
        system: SYSTEM,
        user: JSON.stringify({
          purpose: PURPOSES[purpose],
          staff_hint: hint || null,
          college,
          alumnus: person,
          today: new Date().toISOString().slice(0, 10),
        }),
        schema: SCHEMA as unknown as Record<string, unknown>,
        maxTokens: 2000,
      },
      { allowClaude: cfg.plan.budget_ok, down: new Set<Provider>() },
    );
    for (const a of r.answers) await recordUsage('alumni', a);
    if (!r.shown) {
      const why = r.errors.map((e) => e.message).join(' · ');
      return json({ error: why || 'No AI could answer right now. Try again in a while.' }, 503);
    }
    const message = String(r.shown.value.message ?? '')
      .trim()
      .slice(0, 2000);
    if (!message) return json({ error: 'The AI gave no message. Try again.' }, 502);
    return json({ message, provider: r.shown.provider });
  } catch (e) {
    return json({ error: e instanceof Error ? e.message : String(e) }, 500);
  }
});
