// =====================================================================
// 💬 The chat with the AI supervisor (super admins only)
//   Each message, in two steps:
//     1. the AI reads the question (and the chat so far) and picks up to
//        3 reads from a fixed list (TOOLS) — nothing else can be read
//     2. the reads run as the super admin (their own sign-in), phone
//        numbers are taken out, and the AI answers from them in Bangla,
//        with links to the leads / people it names and, when useful,
//        suggested actions (a follow-up, a hand over, a message) that
//        happen only when the super admin taps "হ্যাঁ" in the app
// =====================================================================
import type { SupabaseClient } from 'jsr:@supabase/supabase-js@2';

import { admin, json, type AiConfig } from '../_shared/ai.ts';

type Ask = <T>(
  cfg: AiConfig,
  system: string,
  user: unknown,
  schema: unknown,
  maxTokens: number,
) => Promise<{
  shown: { value: T; provider: string } | null;
  errors: { kind: string; message: string }[];
}>;

type Start = {
  chat_id: string;
  message_id: string;
  used: number;
  daily: number;
  memory: string;
  history: { role: string; text: string; at: string }[];
  people: { id: string; name: string; role: string; team_lead: string | null }[];
  courses: { id: string; name: string }[];
  stages: { id: string; name: string; kind: string }[];
};

// ---------------------------------------------------------------------
// The reads the AI may ask for
// ---------------------------------------------------------------------
const TOOLS = {
  team: 'the whole team: each person\'s calls, talk minutes, follow-ups on time / late, admissions, "Not Now", open issues, what the AI noticed in notes, objections, the month\'s forecast — for the last `days` (1-90) against the same days before',
  person:
    'one person (person_id): the same numbers for the last `days` against the days before, their open issues, tips from their notes',
  lead: 'one lead found by `query` (a name, a student ID): stage, courses, who has it, score, AI chance, fee, visit, pending follow-up, the last calls and notes (up to 5 matches are listed)',
  pipeline:
    'leads report between `from` and `to` (YYYY-MM-DD), optionally for one course_id: new leads, by stage, by source, admissions, conversion',
  forecast:
    'the admission targets of `month` (YYYY-MM) per course against admissions so far, the pace and the expected end of month',
  objections:
    "the objections people raised in the last `days` (fee, family, distance…) with counts, and the college's own answers (playbook)",
  not_now: '"Not Now" (lost) leads between `from` and `to`: per person and per reason, with notes',
  fees: 'fee collection between `from` and `to`: money collected, by person / course, dues',
  bank: 'the Lead Bank: numbers waiting, returned, pulled',
  findings: "the supervisor's open issues for everyone (late follow-ups, idle hot leads, stuck leads, short calls…)",
  reports: 'the latest AI daily / weekly reports',
  activity: 'team activity between `from` and `to`: per person time in the app, calls, notes, leads added',
} as const;
type ToolName = keyof typeof TOOLS;
const TOOL_NAMES = Object.keys(TOOLS) as ToolName[];

type ToolCall = {
  name: ToolName;
  days: number;
  person_id: string;
  query: string;
  from: string;
  to: string;
  month: string;
  course_id: string;
};

const PLAN_SCHEMA = {
  type: 'object',
  properties: {
    tools: {
      type: 'array',
      description: 'at most 3; empty when no data is needed (e.g. "write a message to the team")',
      items: {
        type: 'object',
        properties: {
          name: { type: 'string', enum: TOOL_NAMES },
          days: { type: 'integer', description: '1-90, or 0 when not used' },
          person_id: { type: 'string', description: 'an id from people, or ""' },
          query: { type: 'string', description: 'for lead: the name / student ID, or ""' },
          from: { type: 'string', description: 'YYYY-MM-DD or ""' },
          to: { type: 'string', description: 'YYYY-MM-DD or ""' },
          month: { type: 'string', description: 'YYYY-MM or ""' },
          course_id: { type: 'string', description: 'an id from courses, or ""' },
        },
        required: ['name', 'days', 'person_id', 'query', 'from', 'to', 'month', 'course_id'],
        additionalProperties: false,
      },
    },
  },
  required: ['tools'],
  additionalProperties: false,
};

const PLAN_SYSTEM = `You help the AI supervisor of the admission team of a teachers' training college in Bangladesh answer the super admin. Before answering, pick the data needed to answer the latest message, from this list only:
${TOOL_NAMES.map((n) => `- ${n}: ${TOOLS[n]}`).join('\n')}

Rules: at most 3 reads; the fewest that answer the question; use ids exactly from "people" / "courses"; dates are in Bangladesh time, "today" is given; "this week" = the last 7 days, "this month" = from the 1st. Use the chat so far to understand short follow-ups ("and Karim?", "what about last month?"). If the message needs no data (a greeting, writing a message from what was already said), pick none.`;

const ANSWER_SCHEMA = {
  type: 'object',
  properties: {
    answer: { type: 'string', description: 'the reply, in Bangla' },
    links: {
      type: 'array',
      description: 'leads / people named in the answer (ids from the data), at most 8',
      items: {
        type: 'object',
        properties: { type: { type: 'string', enum: ['lead', 'person'] }, id: { type: 'string' } },
        required: ['type', 'id'],
        additionalProperties: false,
      },
    },
    actions: {
      type: 'array',
      description: 'suggested actions the super admin can approve with one tap, at most 3; usually none',
      items: {
        type: 'object',
        properties: {
          type: { type: 'string', enum: ['follow_up', 'hand_over', 'message'] },
          lead_ids: { type: 'array', items: { type: 'string' } },
          user_id: { type: 'string' },
          due_at: { type: 'string', description: 'follow_up: ISO time with +06:00, or ""' },
          note: { type: 'string' },
          text: { type: 'string', description: 'message: the message, in Bangla, or ""' },
        },
        required: ['type', 'lead_ids', 'user_id', 'due_at', 'note', 'text'],
        additionalProperties: false,
      },
    },
    memory: {
      type: 'string',
      description:
        'in Bangla, at most 800 letters: the important facts, numbers and decisions of this whole chat so far, for later messages',
    },
  },
  required: ['answer', 'links', 'actions', 'memory'],
  additionalProperties: false,
};

const ANSWER_SYSTEM = `You are the AI supervisor of the admission team of a teachers' training college in Bangladesh, talking with the super admin (the head of the college's admissions). You get the chat so far, what you kept in mind from earlier ("memory"), the people (ids, names, roles, Team Leads), the courses, and the data read for this message.

Answer in plain, short Bangla (আপনি), like a sharp, kind supervisor:
- Use only the numbers in the data, and say which numbers you used. Never invent numbers, names or events. If the data cannot answer, say so and say what would help.
- Compare with "before" where it helps; name people fairly (praise too).
- When asked for advice or a plan, be concrete: who, what, by when.
- Never write phone numbers. "[নম্বর]" in the data is a hidden number.
- links: the leads and people your answer names (their ids from the data).
- actions: only when the super admin asked for something to be done, or one clear step obviously helps. They happen only if the super admin approves. follow_up: exactly one lead, due_at in the next 60 days (Bangladesh time, +06:00), a short note. hand_over: the leads (from the data) and the person (user_id from people) to give them to. message: a short, polite Bangla message to one person (user_id), as from the super admin. Otherwise an empty list.
- memory: update what to keep in mind from this chat (short).`;

// ---------------------------------------------------------------------
// Phone numbers and other contact details never go to the AI
// ---------------------------------------------------------------------
const D = '[0-9০-৯]';
// between digits: spaces (also no-break), dots, dashes of every kind, slashes, brackets, commas, _ and *
const S = '[\\s\\u00A0()/,_*.\\u2010-\\u2015-]';
// a Bangladesh mobile (+88 / 88 / 0 1[3-9] + 8 digits), however it is written
const PHONE = new RegExp(
  `(?<!${D})(\\+?(88|৮৮)${S}{0,5})?[0০]${S}{0,5}[1১]${S}{0,5}[3-9৩-৯](${S}{0,5}${D}){8}(?!${D})`,
  'g',
);
// a land line (02-9123456), a foreign number (+1 415 …), any 10+ digit run
const LAND = new RegExp(`(?<!${D})[0০][2-9২-৯]${D}{0,2}[ -]?${D}{6,8}(?!${D})`, 'g');
const INTL = new RegExp(`\\+[1-9](${S}{0,2}[0-9]){7,14}(?![0-9])`, 'g');
const LONG = new RegExp(`${D}{10,}`, 'g');
const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;
const CONTACT_KEY = /phone|whatsapp|mobile|email|hash|password|token|secret/i;
// ids and times are kept as they are (an id with many digits is not a phone number)
const KEEP =
  /^([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|\d{4}-\d{2}-\d{2}([T ][0-9:.]+(Z|[+-]\d{2}(:?\d{2})?)?)?)$/i;

export const maskText = (s: string) =>
  s
    .replace(EMAIL, '[ইমেইল]')
    .replace(PHONE, '[নম্বর]')
    .replace(INTL, '[নম্বর]')
    .replace(LAND, '[নম্বর]')
    .replace(LONG, '[নম্বর]');

export function clean(v: unknown, depth = 0): unknown {
  if (depth > 12) return null;
  if (typeof v === 'string') return KEEP.test(v) ? v : maskText(v);
  if (Array.isArray(v)) return v.slice(0, 200).map((x) => clean(x, depth + 1));
  if (v && typeof v === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, x] of Object.entries(v as Record<string, unknown>)) {
      if (!CONTACT_KEY.test(k)) out[k] = clean(x, depth + 1);
    }
    return out;
  }
  return v;
}

const DAY = /^\d{4}-\d{2}-\d{2}$/;
const ID = /^[0-9a-f-]{36}$/i;

function dhakaDate(offsetDays = 0) {
  const d = new Date(Date.now() + 6 * 3600_000 - offsetDays * 86400_000);
  return d.toISOString().slice(0, 10);
}

function range(t: ToolCall): [string, string] {
  let to = DAY.test(t.to) ? t.to : dhakaDate();
  let from = DAY.test(t.from) ? t.from : '';
  if (!from) from = dhakaDate(Math.max(1, Math.min(t.days || 7, 366)) - 1);
  if (from > to) [from, to] = [to, from];
  // at most a year
  const min = new Date(new Date(`${to}T00:00:00Z`).getTime() - 365 * 86400_000).toISOString().slice(0, 10);
  if (from < min) from = min;
  return [from, to];
}

const days = (t: ToolCall, d = 7) => Math.max(1, Math.min(t.days || d, 90));

async function runTool(db: SupabaseClient, t: ToolCall): Promise<unknown> {
  const call = async (fn: string, args: Record<string, unknown>) => {
    const { data, error } = await db.rpc(fn, args);
    if (error) return { error: error.message };
    return data;
  };
  switch (t.name) {
    case 'team':
      return call('supervisor_chat_numbers', { p_subject: null, p_days: days(t) });
    case 'person':
      if (!ID.test(t.person_id)) return { error: 'no such person' };
      return call('supervisor_chat_numbers', { p_subject: t.person_id, p_days: days(t, 14) });
    case 'lead':
      return call('supervisor_chat_lead', { p_query: t.query });
    case 'pipeline': {
      const [from, to] = range(t);
      return call('lead_report', {
        p_from: from,
        p_to: to,
        p_user_id: null,
        p_course_id: ID.test(t.course_id) ? t.course_id : null,
      });
    }
    case 'forecast':
      return call('supervisor_forecast', {
        p_month: /^\d{4}-\d{2}$/.test(t.month) ? `${t.month}-01` : null,
      });
    case 'objections': {
      const objections = await call('supervisor_objections', { p_days: days(t, 30) });
      const { data } = await db.from('app_settings').select('value').eq('key', 'supervisor_playbook').maybeSingle();
      return { objections, playbook: (data?.value as { items?: unknown[] } | null)?.items ?? [] };
    }
    case 'not_now': {
      const [from, to] = range(t);
      return call('team_lost', { p_from: from, p_to: to, p_limit: 80 });
    }
    case 'fees': {
      const [from, to] = range(t);
      return call('collection_report', { p_from: from, p_to: to });
    }
    case 'bank':
      return call('bank_summary', {});
    case 'findings': {
      // what each issue is about (its lead lists can be thousands long: only how many)
      const rows = await call('supervisor_list', { p_scope: 'team', p_limit: 80 });
      if (!Array.isArray(rows)) return rows;
      return (rows as Record<string, unknown>[]).map((f) => {
        const d = (f.data ?? {}) as { lead_ids?: unknown[] };
        return {
          rule: f.rule,
          severity: f.severity,
          title: f.title,
          detail: f.detail,
          status: f.status,
          person: f.user_name,
          person_id: f.user_id,
          lead: f.lead_name,
          lead_id: f.lead_id,
          leads: Array.isArray(d.lead_ids) ? d.lead_ids.length : undefined,
          managers_only: f.for_managers,
          since: f.created_at,
        };
      });
    }
    case 'reports':
      return call('supervisor_reports_latest', {});
    case 'activity': {
      const [from, to] = range(t);
      return call('team_activity', { p_from: from, p_to: to });
    }
  }
}

/** A read, made safe and small enough for the AI */
function forAi(v: unknown, max = 14_000): unknown {
  const s = JSON.stringify(clean(v)) ?? 'null';
  return s.length <= max ? JSON.parse(s) : `${s.slice(0, max)} …(cut: too long)`;
}

const BN_TOOL: Record<ToolName, string> = {
  team: 'টিমের হিসাব',
  person: 'একজনের হিসাব',
  lead: 'Lead-এর তথ্য',
  pipeline: 'Lead রিপোর্ট',
  forecast: 'লক্ষ্য ও forecast',
  objections: 'আপত্তি ও উত্তর',
  not_now: 'Not Now',
  fees: 'ফি আদায়',
  bank: 'Lead Bank',
  findings: 'খোলা সমস্যা',
  reports: 'AI রিপোর্ট',
  activity: 'টিমের কাজ',
};

// ---------------------------------------------------------------------
export async function handleChat(
  cfg: AiConfig,
  db: SupabaseClient,
  userId: string,
  body: { chat_id?: string | null; text?: string },
  ask: Ask,
  today: string,
) {
  const text = String(body.text ?? '')
    .trim()
    .slice(0, 1500);
  if (text.length < 2) return json({ error: 'কিছু লিখুন।' }, 400);
  const chatId = body.chat_id && ID.test(body.chat_id) ? body.chat_id : null;

  // the checks (super admin, chat on, the day's cap) and the message saved
  const { data: started, error: startErr } = await db.rpc('supervisor_chat_start', { p_chat: chatId, p_text: text });
  if (startErr) {
    const capped = /আজকের .* message শেষ/.test(startErr.message);
    return json({ error: startErr.message }, capped ? 429 : 403);
  }
  const s = started as Start;
  const chat = {
    today,
    memory: s.memory || '',
    chat_so_far: s.history,
    message: maskText(text),
  };
  const fail = (why: string) =>
    json({ error: why || 'এখন কোনো AI উত্তর দিতে পারছে না। একটু পরে চেষ্টা করুন।', chat_id: s.chat_id }, 503);

  // 1. what to read
  const people = clean(
    s.people.map((p) => ({ id: p.id, name: p.name, role: p.role, team_lead: p.team_lead })),
  ) as Start['people'];
  const courses = clean(s.courses);
  const plan = await ask<{ tools: ToolCall[] }>(cfg, PLAN_SYSTEM, { ...chat, people, courses }, PLAN_SCHEMA, 800);
  if (!plan.shown) return fail(plan.errors.map((e) => e.message).join(' · '));
  const calls = (Array.isArray(plan.shown.value.tools) ? plan.shown.value.tools : [])
    .filter((t) => TOOL_NAMES.includes(t?.name))
    .slice(0, 3);

  // 2. the reads, as the super admin
  const data: Record<string, unknown> = {};
  const sources: string[] = [];
  for (const [i, t] of calls.entries()) {
    const v = await runTool(db, t).catch((e) => ({ error: e instanceof Error ? e.message : String(e) }));
    data[`${i + 1}_${t.name}`] = { asked: { ...t }, result: forAi(v) };
    const what = [
      BN_TOOL[t.name],
      t.name === 'person' ? s.people.find((p) => p.id === t.person_id)?.name : null,
      t.name === 'lead' ? t.query : null,
      ['pipeline', 'not_now', 'fees', 'activity'].includes(t.name) ? range(t).join(' → ') : null,
      ['team', 'person', 'objections'].includes(t.name) ? `${days(t, t.name === 'team' ? 7 : 14)} দিন` : null,
      t.name === 'forecast' && t.month ? t.month : null,
    ]
      .filter(Boolean)
      .join(' · ');
    sources.push(what);
  }

  // 3. the answer
  const r = await ask<{
    answer: string;
    links: { type: string; id: string }[];
    actions: Record<string, unknown>[];
    memory: string;
  }>(cfg, ANSWER_SYSTEM, { ...chat, people, courses, stages: clean(s.stages), data }, ANSWER_SCHEMA, 3000);
  if (!r.shown) return fail(r.errors.map((e) => e.message).join(' · '));
  const v = r.shown.value;

  // saved with its links and actions checked against the database
  const { data: saved, error: saveErr } = await admin.rpc('sup_chat_save', {
    p_user: userId,
    p_chat: s.chat_id,
    p_body: maskText(String(v.answer ?? '')).slice(0, 4000),
    p_data: { sources, links: v.links ?? [], actions: v.actions ?? [] },
    p_memory: maskText(String(v.memory ?? '')).slice(0, 1200),
    p_provider: r.shown.provider,
  });
  if (saveErr) return fail(saveErr.message);
  return json({ chat_id: s.chat_id, user_message_id: s.message_id, message: saved, used: s.used, daily: s.daily });
}
