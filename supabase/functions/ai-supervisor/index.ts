// =====================================================================
// 🧑‍💼🤖 Supervisor AI (the AIs, plan and budget of Settings → AI)
//   From the 15-minute job (x-cron-secret):
//     { job: 'notes' }   read new notes, 20 at a time: a promise and its
//                        date, objections, interest up / down, a useful
//                        note or not (+ a short tip)
//     { job: 'reports', weekly }  the day's (and the week's) report for
//                        admins and for each Team Lead's team
//   From the app (signed in):
//     { mode: 'tip' }              today's tip for me (once a day)
//     { mode: 'coach', user_id }   a one-to-one page about a person
//                                  (Team Leads / admins, once a day)
//     { mode: 'ask', question }    a question about the work, answered
//                                  from the numbers the asker may see
//     { mode: 'chat', chat_id?, text }  the chat with the AI supervisor
//                                  (super admins only; see chat.ts)
//   The AI gets numbers, first names and note texts — never phone numbers.
//   It changes nothing by itself; a chat's suggested action happens only
//   when the super admin approves it in the app.
// =====================================================================
import { admin, json, loadConfig, type AiConfig } from '../_shared/ai.ts';
import { asUser, cors, currentUser } from '../_shared/drive.ts';
import { answerByPlan, type Provider, recordUsage } from '../_shared/llm.ts';
import { handleChat } from './chat.ts';

declare const EdgeRuntime: { waitUntil(p: Promise<unknown>): void } | undefined;

/** The job password, compared without giving away how much matched */
function sameText(a: string, b: string): boolean {
  const x = new TextEncoder().encode(a);
  const y = new TextEncoder().encode(b);
  let diff = x.length ^ y.length;
  for (let i = 0; i < Math.max(x.length, y.length); i++) diff |= (x[i] ?? 0) ^ (y[i] ?? 0);
  return diff === 0;
}

const OBJECTIONS = ['fee', 'family', 'distance', 'time', 'other_college', 'job', 'doubt', 'documents', 'other'];

const dhaka = (iso: string) => {
  const d = new Date(iso);
  const f = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Asia/Dhaka',
    weekday: 'short',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).formatToParts(d);
  const g = (t: string) => f.find((p) => p.type === t)?.value ?? '';
  return `${g('year')}-${g('month')}-${g('day')} ${g('weekday')} ${g('hour')}:${g('minute')}`;
};
const todayText = () => dhaka(new Date().toISOString()).slice(0, 14);
const dhakaDay = () => dhaka(new Date().toISOString()).slice(0, 10);
/** the AI is out for now (no key, no credit, busy, over the limit): wait for the next run */
const PAUSE = new Set(['key', 'credit', 'busy', 'quota']);

/** One answer is enough here: in "compare" the free one is asked first, then the other */
function single(cfg: AiConfig): AiConfig {
  if (cfg.plan.mode !== 'compare') return cfg;
  return {
    ...cfg,
    plan: {
      ...cfg.plan,
      mode: 'gemini_then_claude',
      providers: [...cfg.plan.providers].sort((a) => (a === 'gemini' ? -1 : 1)),
    },
  };
}

async function ask<T>(cfg: AiConfig, system: string, user: unknown, schema: unknown, maxTokens: number) {
  const r = await answerByPlan<T>(
    cfg,
    { system, user: JSON.stringify(user), schema: schema as Record<string, unknown>, maxTokens },
    { allowClaude: cfg.plan.budget_ok, down: new Set<Provider>() },
  );
  for (const a of r.answers) await recordUsage('supervisor', a);
  return r;
}

// ---------------------------------------------------------------------
// 3. Notes
// ---------------------------------------------------------------------
const NOTES_SYSTEM = `You read short notes that staff of a teachers' training college in Bangladesh wrote after calling people who may join a course (B.Ed, M.Ed, diplomas). Notes are in Bangla, English or "Banglish".

For each note, find:
- promise: did the person promise or agree to do something on a day ("will come Friday", "will pay after salary on the 5th", "call me Sunday", "will decide after talking to husband next week")? Give promise_kind (call, visit, admit, pay, papers, decide, other or none), promise_text (a few words in Bangla, e.g. "শুক্রবার ক্যাম্পাসে আসবেন") and promise_at as YYYY-MM-DD worked out from the note's own date (written_at) — Bangladesh weekdays; "next week" = the same weekday next week; "after salary" ≈ the 5th of next month; if no day can be worked out, promise_kind none and promise_at "".
- objections: only from this list: fee, family, distance, time, other_college, job, doubt, documents, other. Empty if none.
- interest: 1 if the person sounds warmer than a usual first call (keen, asking about admission), -1 if the person said they are less interested (not interested, "later", "next session", joined elsewhere), 0 if unclear. Not picking up / switched off / busy line is 0, not -1.
- quality: "good" if the note says what happened and what is next; "thin" if it says almost nothing ("ok", "called", "no answer" with nothing else, one word); "skip" if it is not about the person.
- tip: only for a thin note — one short Bangla tip (max 12 words) on what to write next time. Else "".
Never invent facts that are not in the note. Answer for every note, using its source and id exactly.`;

const NOTES_SCHEMA = {
  type: 'object',
  properties: {
    items: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          source: { type: 'string', enum: ['call', 'note'] },
          id: { type: 'string' },
          promise_kind: {
            type: 'string',
            enum: ['call', 'visit', 'admit', 'pay', 'papers', 'decide', 'other', 'none'],
          },
          promise_text: { type: 'string' },
          promise_at: { type: 'string', description: 'YYYY-MM-DD or empty' },
          objections: { type: 'array', items: { type: 'string', enum: OBJECTIONS } },
          interest: { type: 'integer', enum: [-1, 0, 1] },
          quality: { type: 'string', enum: ['good', 'thin', 'skip'] },
          tip: { type: 'string' },
        },
        required: [
          'source',
          'id',
          'promise_kind',
          'promise_text',
          'promise_at',
          'objections',
          'interest',
          'quality',
          'tip',
        ],
        additionalProperties: false,
      },
    },
  },
  required: ['items'],
  additionalProperties: false,
};

type NoteIn = { source: 'call' | 'note'; id: string; written_at: string; text: string; call_result: string | null };
type NoteOut = {
  source: string;
  id: string;
  promise_kind: string;
  promise_text: string;
  promise_at: string;
  objections: string[];
  interest: number;
  quality: string;
  tip: string;
};

/** One batch: the AI's reading saved (a note it skipped: read, nothing found) */
async function saveReading(batch: NoteIn[], items: NoteOut[], provider: string | null) {
  const mine = new Set(batch.map((n) => `${n.source}:${n.id}`));
  const got = (items ?? []).filter((x) => mine.has(`${x.source}:${x.id}`));
  const seen = new Set(got.map((x) => `${x.source}:${x.id}`));
  const rows = [
    ...got.map((x) => ({
      ...x,
      promise_kind: x.promise_kind === 'none' ? null : x.promise_kind,
      promise_at: x.promise_kind === 'none' ? null : x.promise_at || null,
      interest: String(x.interest),
    })),
    ...batch.filter((n) => !seen.has(`${n.source}:${n.id}`)).map((n) => ({ source: n.source, id: n.id })),
  ];
  const { error } = await admin.rpc('sup_notes_save', { p_rows: rows, p_provider: provider });
  if (error) throw new Error(error.message);
}

const askNotes = (cfg: AiConfig, batch: NoteIn[]) =>
  ask<{ items: NoteOut[] }>(
    cfg,
    NOTES_SYSTEM,
    {
      today: todayText(),
      notes: batch.map((n) => ({
        source: n.source,
        id: n.id,
        written_at: dhaka(n.written_at),
        call_result: n.call_result,
        text: n.text,
      })),
    },
    NOTES_SCHEMA,
    6000,
  );

async function readNotes(cfg: AiConfig) {
  const started = Date.now();
  // (a new batch only while there is time for it to finish inside the server's limit)
  while (Date.now() - started < 30_000) {
    const { data, error } = await admin.rpc('sup_notes_todo', { p_limit: 20 });
    if (error) throw new Error(error.message);
    const batch = (data ?? []) as NoteIn[];
    if (batch.length === 0) return;
    const r = await askNotes(cfg, batch);
    if (r.shown) {
      try {
        await saveReading(batch, r.shown.value.items, r.shown.provider);
      } catch (e) {
        // paid for, but not kept (a bad answer the database refuses): counted, so it is not paid for again and again
        console.error('ai-supervisor save', e);
        await admin.rpc('sup_notes_failed', { p_rows: batch.map((n) => ({ source: n.source, id: n.id })) });
        return;
      }
      continue;
    }
    // the AI is out (off, key, credit, busy, quota): stop, try on the next run
    if (r.errors.length === 0 || r.errors.some((e) => PAUSE.has(e.kind))) return;
    if (!r.errors.every((e) => e.kind === 'refusal')) {
      // a broken answer / a server error: counted, so a bad batch is not paid for again and again
      await admin.rpc('sup_notes_failed', { p_rows: batch.map((n) => ({ source: n.source, id: n.id })) });
      return;
    }
    // the AI declined this batch: one by one, so only the note it declines is put aside
    for (const n of batch) {
      if (Date.now() - started > 40_000) return;
      const one = await askNotes(cfg, [n]);
      if (one.shown) {
        try {
          await saveReading([n], one.shown.value.items, one.shown.provider);
        } catch (e) {
          console.error('ai-supervisor save', e);
          await admin.rpc('sup_notes_failed', { p_rows: [{ source: n.source, id: n.id }] });
          return;
        }
      } else if (one.errors.length > 0 && one.errors.every((e) => e.kind === 'refusal')) {
        await saveReading([n], [], null); // read: nothing to keep
      } else {
        if (one.errors.length > 0 && !one.errors.some((e) => PAUSE.has(e.kind))) {
          await admin.rpc('sup_notes_failed', { p_rows: [{ source: n.source, id: n.id }] });
        }
        return;
      }
    }
  }
}

// ---------------------------------------------------------------------
// 4. Reports, a one-to-one page, today's tip
// ---------------------------------------------------------------------
const REPORT_SCHEMA = {
  type: 'object',
  properties: {
    summary: { type: 'string', description: '2-3 sentences in Bangla' },
    wins: { type: 'array', items: { type: 'string' } },
    concerns: { type: 'array', items: { type: 'string' } },
    actions: { type: 'array', items: { type: 'string' } },
  },
  required: ['summary', 'wins', 'concerns', 'actions'],
  additionalProperties: false,
};
type Report = { summary: string; wins: string[]; concerns: string[]; actions: string[] };

const REPORT_SYSTEM = `You are the supervisor of the admission team of a teachers' training college in Bangladesh. You get the numbers of a period ("now") and the same length before it ("before") for each person (first names only), their open issues, what the AI noticed in notes, the common objections, and (for a whole team) the month's admission forecast against the targets.

Write for the manager, in short, plain Bangla (আপনি):
- summary: how the team did, in 2-3 sentences, with the most important numbers.
- wins: 1-4 things that went well (name people when deserved).
- concerns: 1-4 things that need attention, with numbers and names.
- actions: 2-5 concrete steps for tomorrow / next week (who, what).
Be fair and kind: compare people with their own "before" first. Never invent numbers; say "data কম" if there is too little. Calls to leads, talk minutes, follow-ups on time, admissions and "Not Now" matter most.`;

const COACH_SYSTEM = `You help a Team Lead / admin of a teachers' training college in Bangladesh prepare a short one-to-one talk with one staff member. You get the person's numbers for the last 14 days ("now") and the 14 days before ("before"), their open issues, tips from their notes and their leads' common objections.

Answer in plain, kind Bangla (আপনি):
- summary: how the person is doing, 2-3 sentences with numbers.
- wins: 1-3 things to praise.
- concerns: 1-3 things to talk about, with numbers.
- actions: 3 concrete points / questions for the talk, supportive (not blaming).
Never invent numbers.`;

const TIP_SYSTEM = `You coach a caller of a teachers' training college in Bangladesh for today. You get their numbers for the last 7 days ("now") and the week before, their open issues, tips from their notes and their leads' common objections.

Answer in short, warm Bangla (আপনি), to the person:
- summary: one line on how they are doing (praise first if deserved).
- wins: 0-2 short things they did well.
- concerns: 0-2 short things to improve.
- actions: exactly 3 small, concrete things to do today.
Never invent numbers.`;

async function makeReport(
  cfg: AiConfig,
  kind: 'daily' | 'weekly' | 'coach' | 'tip',
  reader: string | null,
  subject: string | null,
) {
  const days = kind === 'weekly' ? 7 : kind === 'daily' ? 1 : kind === 'coach' ? 14 : 7;
  const { data, error } = await admin.rpc('sup_report_input', {
    p_reader: reader,
    p_subject: subject,
    p_days: days,
    // a tip is read by the person it is about: not the Team Lead / admin-only findings
    // a Team Lead's own daily / weekly report: not the admin-only findings about that Team Lead
    p_hide_managers_of: kind === 'tip' ? subject : kind === 'daily' || kind === 'weekly' ? reader : null,
  });
  if (error) throw new Error(error.message);
  if (subject && !((data as { people?: unknown[] } | null)?.people ?? []).length) {
    return { ok: false as const, why: 'এই মানুষের কোনো lead-এর কাজের হিসাব নেই (caller / Team Lead নন)।', empty: true };
  }
  const system = kind === 'coach' ? COACH_SYSTEM : kind === 'tip' ? TIP_SYSTEM : REPORT_SYSTEM;
  const r = await ask<Report>(cfg, system, { today: todayText(), kind, period_days: days, data }, REPORT_SCHEMA, 3000);
  if (!r.shown)
    return {
      ok: false as const,
      why: r.errors.map((e) => e.message).join(' · '),
      pause: r.errors.length === 0 || r.errors.some((e) => PAUSE.has(e.kind)),
    };
  const v = r.shown.value;
  const clean = (a: unknown, n: number) =>
    (Array.isArray(a) ? a : [])
      .map((x) => String(x).trim())
      .filter(Boolean)
      .slice(0, n)
      .map((x) => x.slice(0, 300));
  const body = {
    summary: String(v.summary ?? '').slice(0, 800),
    wins: clean(v.wins, 5),
    concerns: clean(v.concerns, 5),
    actions: clean(v.actions, 6),
  };
  const { error: saveErr } = await admin.rpc('sup_report_save', {
    p_kind: kind,
    p_reader: reader,
    p_subject: subject,
    p_data: data,
    p_body: body,
    p_provider: r.shown.provider,
  });
  if (saveErr) throw new Error(saveErr.message);
  return { ok: true as const, body, provider: r.shown.provider };
}

async function reports(cfg: AiConfig, weekly: boolean, daily: boolean, day?: string) {
  const started = Date.now();
  const today = day && /^\d{4}-\d{2}-\d{2}$/.test(day) ? day : dhakaDay();
  const { data, error } = await admin.rpc('sup_report_readers');
  if (error) throw new Error(error.message);
  // made on an earlier run today: not paid for again
  const { data: made, error: madeErr } = await admin
    .from('supervisor_reports')
    .select('kind, reader')
    .eq('day', today)
    .in('kind', ['daily', 'weekly']);
  if (madeErr) throw new Error(madeErr.message);
  const have = new Set(((made ?? []) as { kind: string; reader: string | null }[]).map((m) => `${m.kind}:${m.reader}`));
  const kinds = [...(daily ? (['daily'] as const) : []), ...(weekly ? (['weekly'] as const) : [])];
  let all = true;
  for (const reader of (data ?? []) as (string | null)[]) {
    for (const kind of kinds) {
      if (have.has(`${kind}:${reader}`)) continue;
      // (a new report only while there is time for it to finish inside the server's limit)
      if (Date.now() - started > 100_000) return;
      const r = await makeReport(cfg, kind, reader, null);
      if (r.ok) continue;
      all = false;
      // the AI is out for now: the tick asks again in an hour
      if ('pause' in r && r.pause) return;
    }
  }
  // all made: no more asking today
  if (all) await admin.rpc('sup_reports_done', { p_day: today });
}

// ---------------------------------------------------------------------
// 5. A question
// ---------------------------------------------------------------------
const ASK_SYSTEM = `You are the AI supervisor of the admission team of a teachers' training college in Bangladesh. Answer the question using only the numbers given (last 30 days, "now" vs the 30 days "before"; people by first name; objections; the month's forecast against targets when present). Answer in short, plain Bangla (আপনি), at most 6 sentences, with the numbers you used. If the numbers cannot answer it, say so and say what to look at in the app instead. Never invent numbers, never give phone numbers, never talk about things other than the team's admission work.`;

const ASK_SCHEMA = {
  type: 'object',
  properties: {
    answer: { type: 'string' },
    points: { type: 'array', items: { type: 'string' }, description: 'up to 4 short supporting points' },
  },
  required: ['answer', 'points'],
  additionalProperties: false,
};

// ---------------------------------------------------------------------
Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });
  if (req.method !== 'POST') return json({ error: 'POST only.' }, 405);
  try {
    const body = (await req.json().catch(() => ({}))) as {
      job?: string;
      weekly?: boolean;
      daily?: boolean;
      day?: string;
      mode?: string;
      user_id?: string;
      question?: string;
      chat_id?: string | null;
      text?: string;
      refresh?: boolean;
    };
    const cfg = single(await loadConfig('ai_chance'));
    const { data: sup } = await admin.rpc('supervisor_setting');
    const ai = ((sup ?? {}) as { ai?: Record<string, unknown> }).ai ?? {};
    const noAi = cfg.plan.providers.length === 0;

    // ---- the 15-minute job ----
    const secret = req.headers.get('x-cron-secret');
    if (secret) {
      if (!cfg.cron_secret || !sameText(secret, cfg.cron_secret)) return json({ error: 'Not allowed.' }, 403);
      if (noAi || ai.enabled === false) return json({ ok: false, code: 'off' });
      const work =
        body.job === 'reports'
          ? ai.reports === false
            ? Promise.resolve()
            : reports(cfg, !!body.weekly, body.daily !== false, body.day)
          : readNotes(cfg);
      const done = work.catch((e) => console.error('ai-supervisor', e));
      if (typeof EdgeRuntime !== 'undefined') {
        EdgeRuntime.waitUntil(done);
        return json({ ok: true, started: true }, 202);
      }
      await done;
      return json({ ok: true });
    }

    // ---- the app ----
    const user = await currentUser(req);
    if (!user) return json({ error: 'Please sign in again.' }, 401);
    const db = asUser(req);
    if (ai.enabled === false) return json({ error: 'সুপারভাইজারের AI বন্ধ আছে (Settings → Supervisor)।' }, 409);
    if (noAi) return json({ error: 'কোনো AI চালু নেই। Admin Settings → AI থেকে চালু করতে পারেন।' }, 409);

    if (body.mode === 'chat') {
      if (ai.chat === false) return json({ error: 'সুপারভাইজার চ্যাট বন্ধ আছে (Settings → Supervisor)।' }, 409);
      return await handleChat(cfg, db, user.id, body, ask, todayText());
    }

    if (body.mode === 'tip' || body.mode === 'coach') {
      const kind = body.mode;
      const subject = kind === 'coach' ? String(body.user_id ?? '') : user.id;
      if (kind === 'coach' && ai.coach === false) return json({ error: 'এই অংশ বন্ধ আছে।' }, 409);
      // the same checks as reading it (who may see whom)
      const { data: have, error: canErr } = await db.rpc('supervisor_report_get', { p_kind: kind, p_subject: subject });
      if (canErr) return json({ error: canErr.message }, 403);
      if (have && !body.refresh) return json({ report: have });
      // a cap per person per day (the budget is shared with every AI feature)
      const { data: may, error: takeErr } = await db.rpc('supervisor_ai_take', { p_kind: kind });
      if (takeErr) return json({ error: takeErr.message }, 403);
      if (!may) return json({ error: 'আজকের মতো যথেষ্ট তৈরি হয়েছে। কাল আবার চেষ্টা করুন।' }, 429);
      const r = await makeReport(cfg, kind, null, subject);
      if (!r.ok) return json({ error: r.why || 'এখন কোনো AI উত্তর দিতে পারছে না। একটু পরে চেষ্টা করুন।' }, 503);
      const { data: saved } = await db.rpc('supervisor_report_get', { p_kind: kind, p_subject: subject });
      return json({ report: saved });
    }

    if (body.mode === 'ask') {
      if (ai.ask === false) return json({ error: 'এই অংশ বন্ধ আছে।' }, 409);
      const question = String(body.question ?? '')
        .trim()
        .slice(0, 300);
      if (question.length < 3) return json({ error: 'প্রশ্নটা লিখুন।' }, 400);
      const { data: ok, error: takeErr } = await db.rpc('supervisor_ask_take');
      if (takeErr) return json({ error: takeErr.message }, 403);
      if (!ok) return json({ error: 'আজকের ২০টা প্রশ্ন শেষ। কাল আবার জিজ্ঞেস করুন।' }, 429);
      const { data: context, error: ctxErr } = await db.rpc('supervisor_ai_context');
      if (ctxErr) return json({ error: ctxErr.message }, 403);
      const r = await ask<{ answer: string; points: string[] }>(
        cfg,
        ASK_SYSTEM,
        { question, context },
        ASK_SCHEMA,
        2000,
      );
      if (!r.shown) {
        const why = r.errors.map((e) => e.message).join(' · ');
        return json({ error: why || 'এখন কোনো AI উত্তর দিতে পারছে না। একটু পরে চেষ্টা করুন।' }, 503);
      }
      return json({
        answer: String(r.shown.value.answer ?? '').slice(0, 1500),
        points: (Array.isArray(r.shown.value.points) ? r.shown.value.points : [])
          .map((x) => String(x).slice(0, 200))
          .slice(0, 4),
        provider: r.shown.provider,
      });
    }

    return json({ error: 'Unknown request.' }, 400);
  } catch (e) {
    return json({ error: e instanceof Error ? e.message : String(e) }, 500);
  }
});
