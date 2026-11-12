// =====================================================================
// 📨🤖 SMS Center: three SMS drafts written by AI (Settings → AI: the
//   same AIs and plan as "Chance of admission")
//   POST { group, goal, hint?, tone?, language?, length?, current?,
//          audience?: { count, filter } } → { options: string[] }
//   POST { mode: 'plan', question?, language?, skip_days? }
//     → { suggestions: [{ key, group, title, count, lead_ids, why, message, priority }] }
//     "Which leads should get which SMS today?": the server's ready groups
//     of my leads (sms_ai_segments: only names of groups and counts go to
//     the AI); the AI picks the groups worth an SMS and writes each SMS.
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
      description: 'Exactly three different drafts',
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

const PLAN_SCHEMA = {
  type: 'object',
  properties: {
    suggestions: {
      type: 'array',
      description: 'At most 6, most important first',
      items: {
        type: 'object',
        properties: {
          segment: { type: 'string', description: 'The key of one group from the list' },
          why: { type: 'string', description: 'One short line: why this group should get an SMS today' },
          message: { type: 'string', description: 'The SMS for this group, ready to send' },
          priority: { type: 'integer', description: '1 = most important' },
        },
        required: ['segment', 'why', 'message', 'priority'],
        additionalProperties: false,
      },
    },
  },
  required: ['suggestions'],
  additionalProperties: false,
} as const;

const PLAN_SYSTEM = `You are the admission office's SMS planner at a teachers' training college in Bangladesh.

You get the staff's question and ready groups of their leads (key, group, what the group is, how many people, their courses). Pick the groups that are worth an SMS today — the ones where an SMS helps admission most (a visit soon, a missed call, new and not reached, fees and papers of admitted students, long quiet ones, "not now" ones to win back). Skip groups where an SMS does not help or that overlap too much. Most important first. At most 6.

For each picked group write one SMS for everyone in it:
- Plain text, polite and warm; Bangla uses আপনি. Like a real person from the college office, not an advertisement.
- One SMS long (Bangla at most 70 letters, English at most 160) unless more is really needed (then at most 134 / 306).
- Use only facts given. Never make up a deadline, a discount, a fee or a promise.
- You may use these placeholders exactly as written: {first_name} {course} {student_id} {fee_due} {owner} {owner_phone}. Use {fee_due} only for admitted students' fee groups.
- End with the college's short name if it is given.
"why" says in one short line, in the staff's language, why this group today.`;

type Segment = {
  key: string;
  group: 'active' | 'not_now' | 'admitted';
  title: string;
  count: number;
  skipped_recent_sms: number;
  courses: { course: string; n: number }[];
  lead_ids: string[];
};

async function plan(
  req: Request,
  b: { question?: string; language?: string; skip_days?: number },
  college: string | null,
) {
  const { data: segs, error } = await asUser(req).rpc('sms_ai_segments', {
    p_skip_days: Math.min(30, Math.max(0, Number(b.skip_days ?? 3) || 0)),
  });
  if (error) return json({ error: error.message }, 400);
  const segments = (segs ?? []) as Segment[];
  if (segments.length === 0) {
    return json({ suggestions: [], note: 'No group of your leads needs an SMS today (or all got one recently).' });
  }

  const cfg = await loadConfig('ai_chance');
  if (cfg.plan.providers.length === 0) {
    return json({ error: 'No AI is on. An admin can switch one on in Settings → AI.' }, 409);
  }
  if (cfg.plan.mode === 'compare') {
    cfg.plan = {
      ...cfg.plan,
      mode: 'gemini_then_claude',
      providers: [...cfg.plan.providers].sort((a) => (a === 'gemini' ? -1 : 1)),
    };
  }
  const language = b.language === 'en' ? 'English' : 'Bangla';
  const r = await answerByPlan<{ suggestions: { segment: string; why: string; message: string; priority: number }[] }>(
    cfg,
    {
      system: PLAN_SYSTEM,
      user: JSON.stringify({
        question:
          String(b.question ?? '')
            .slice(0, 400)
            .trim() || 'আজকে কোন কোন লিডকে কী SMS দেওয়া যায়?',
        sms_language: language,
        college,
        today: new Date().toISOString().slice(0, 10),
        groups: segments.map((s) => ({
          key: s.key,
          group: s.group,
          what: s.title,
          people: s.count,
          left_out_got_sms_recently: s.skipped_recent_sms,
          courses: s.courses.slice(0, 4),
        })),
      }),
      schema: PLAN_SCHEMA as unknown as Record<string, unknown>,
      maxTokens: 3000,
    },
    { allowClaude: cfg.plan.budget_ok, down: new Set<Provider>() },
  );
  for (const a of r.answers) await recordUsage('sms', a);
  if (!r.shown) {
    const why = r.errors.map((e) => e.message).join(' · ');
    return json({ error: why || 'No AI could answer right now. Try again in a while.' }, 503);
  }
  const byKey = new Map(segments.map((s) => [s.key, s]));
  const seen = new Set<string>();
  const suggestions = (Array.isArray(r.shown.value.suggestions) ? r.shown.value.suggestions : [])
    .filter((x) => byKey.has(x.segment) && !seen.has(x.segment) && seen.add(x.segment))
    .sort((a, b2) => (a.priority ?? 9) - (b2.priority ?? 9))
    .map((x) => {
      const s = byKey.get(x.segment)!;
      return {
        key: s.key,
        group: s.group,
        title: s.title,
        count: s.count,
        skipped_recent_sms: s.skipped_recent_sms,
        // no ids here (could be ~1 MB): the app asks sms_ai_segment_ids on "Use"
        lead_ids: [] as string[],
        why: String(x.why ?? '').slice(0, 300),
        message: String(x.message ?? '')
          .trim()
          .slice(0, 1000),
        priority: x.priority,
      };
    })
    .filter((x) => x.message)
    .slice(0, 6);
  return json({
    suggestions,
    // the groups the AI did not pick (to choose by hand)
    others: segments
      .filter((s) => !seen.has(s.key))
      .map((s) => ({ key: s.key, group: s.group, title: s.title, count: s.count, lead_ids: [] as string[] })),
    provider: r.shown.provider,
  });
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });
  if (req.method !== 'POST') return json({ error: 'POST only.' }, 405);
  try {
    const user = await currentUser(req);
    if (!user) return json({ error: 'Please sign in again.' }, 401);
    const { data: can } = await asUser(req).rpc('sms_can_send');
    if (!can) return json({ error: 'You can’t send SMS. (Settings → SMS)' }, 403);

    const b = (await req.json().catch(() => ({}))) as {
      mode?: string;
      question?: string;
      skip_days?: number;
      group?: string;
      goal?: string;
      hint?: string;
      tone?: string;
      language?: string;
      length?: number;
      current?: string;
      audience?: { count?: number; filter?: string };
    };
    if (b.mode === 'plan') {
      const { data: t } = await admin.from('app_settings').select('value').eq('key', 'message_templates').maybeSingle();
      return await plan(req, b, (t?.value as { institute?: { name?: string } } | null)?.institute?.name || null);
    }
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
