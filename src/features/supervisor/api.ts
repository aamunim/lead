import { supabase } from '@/shared/lib/supabase';

// =====================================================================
// 🧑‍💼 Supervisor: what needs attention (the server's rules write it
//   every 15 minutes), today's list of who to call first, the team today.
//   Callers see their own · Team Leads their team · admins everyone.
// =====================================================================

function toError(e: { message: string }): Error {
  const m = e.message ?? '';
  if (/could not find the function|relation .* does not exist|schema cache/i.test(m)) {
    return new Error('সুপারভাইজার এখনো server-এ চালু হয়নি। Admin-কে database update চালাতে বলুন।');
  }
  if (/network|fetch/i.test(m)) return new Error('ইন্টারনেট সংযোগ নেই। আবার চেষ্টা করুন।');
  return new Error(m);
}

const rpc = async <T>(name: string, args: Record<string, unknown> = {}): Promise<T> => {
  const { data, error } = await supabase.rpc(name as never, args as never);
  if (error) throw toError(error);
  return data as T;
};

export type Severity = 'urgent' | 'today' | 'improve';
export type FindingStatus = 'open' | 'snoozed' | 'done' | 'wrong' | 'fixed' | 'expired';

export type Finding = {
  id: string;
  rule: string;
  severity: Severity;
  title: string;
  detail: string | null;
  data: { lead_ids?: string[]; route?: string; count?: number } & Record<string, unknown>;
  status: FindingStatus;
  lead_id: string | null;
  lead_name: string | null;
  user_id: string | null;
  user_name: string | null;
  for_managers: boolean;
  created_at: string;
  updated_at: string;
  snooze_until: string | null;
};

export type Task = {
  lead_id: string;
  name: string;
  phone: string | null;
  kind: 'followup' | 'new' | 'visit' | 'golden';
  reason: string;
  priority: number;
  due_at: string | null;
  score: number | null;
  /** 🕐 the hour (0–23) this lead usually answers */
  best_hour: number | null;
};

export type Counts = { urgent: number; today: number; improve: number };

export type SupervisorHome =
  | { enabled: false }
  | {
      enabled: true;
      manager: boolean;
      admin: boolean;
      ai: AiFlags;
      /** an AI is set up and on in Settings → AI */
      ai_ready: boolean;
      me: Counts;
      top: Pick<Finding, 'id' | 'rule' | 'severity' | 'title' | 'detail' | 'lead_id'>[];
      tasks: Task[];
      team: (Counts & { people: number }) | null;
    };

export type AiFlags = {
  enabled: boolean;
  notes_daily: number;
  reports: boolean;
  weekly_day: number;
  coach: boolean;
  ask: boolean;
  /** 💬 the chat with the AI supervisor (super admins only) */
  chat: boolean;
  chat_daily: number;
};

export type TeamRow = {
  user_id: string;
  name: string | null;
  role: string;
  open_leads: number;
  calls: number;
  talked: number;
  talk_min: number;
  followups_late: number;
  new_waiting: number;
  golden_quiet: number;
  urgent: number;
  today: number;
  improve: number;
  last_call: string | null;
};

/** Something was marked: the Home card loads again when it is next seen */
let version = 0;
export const supervisorChanged = () => {
  version += 1;
};
export const supervisorVersion = () => version;

export async function supervisorHome(): Promise<SupervisorHome | null> {
  return rpc<SupervisorHome | null>('supervisor_home');
}

export async function listFindings(q: {
  scope: 'me' | 'team';
  severity?: Severity | null;
  user?: string | null;
  status?: 'open' | 'done' | 'wrong' | 'fixed' | 'all';
  page?: number;
}): Promise<Finding[]> {
  const page = q.page ?? 0;
  return rpc<Finding[]>('supervisor_list', {
    p_scope: q.scope,
    p_severity: q.severity ?? null,
    p_user: q.user ?? null,
    p_status: q.status ?? 'open',
    p_limit: 50,
    p_offset: page * 50,
  });
}

export async function todayTasks(user?: string | null, limit = 30): Promise<Task[]> {
  return rpc<Task[]>('supervisor_tasks', { p_user: user ?? null, p_limit: limit });
}

export async function teamToday(): Promise<TeamRow[]> {
  return rpc<TeamRow[]>('supervisor_team');
}

/** ✅ done · ❌ not right · ⏳ later (days) · ↩ open again */
export async function markFindings(ids: string[], status: 'done' | 'wrong' | 'snoozed' | 'open', days = 1) {
  return rpc<number>('supervisor_mark', { p_ids: ids, p_status: status, p_days: days });
}

/** Admins: run the rules now */
export async function checkNow(): Promise<{ new: number; fixed: number; open: number }> {
  return rpc('supervisor_check_now');
}

// ---------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------
export type RuleKey =
  | 'new_lead'
  | 'followup_late'
  | 'hot_idle'
  | 'stuck'
  | 'no_note'
  | 'short_calls'
  | 'not_now_high'
  | 'no_calls'
  | 'workload'
  | 'unassigned'
  | 'discount_wait'
  | 'fee_due'
  | 'bank_return'
  | 'bank_pull'
  | 'promise'
  | 'interest_down'
  | 'thin_notes';

export type SupervisorSettings = {
  enabled: boolean;
  start_hour: number;
  end_hour: number;
  off_days: number[];
  brief: boolean;
  day_end: boolean;
  day_end_team_lead: boolean;
  day_end_admins: boolean;
  golden_score: number;
  rules: Record<RuleKey, { on: boolean } & Record<string, number | boolean>>;
  ai: AiFlags;
};

export const DEFAULT_AI: AiFlags = {
  enabled: true,
  notes_daily: 200,
  reports: true,
  weekly_day: 6,
  coach: true,
  ask: true,
  chat: true,
  chat_daily: 50,
};

export async function getSupervisorSettings(): Promise<SupervisorSettings> {
  const r = await rpc<SupervisorSettings>('supervisor_setting');
  // (a server not updated yet sends no AI part: the defaults)
  return {
    ...r,
    off_days: r.off_days ?? [],
    rules: r.rules ?? ({} as SupervisorSettings['rules']),
    ai: { ...DEFAULT_AI, ...(r.ai ?? {}) },
  };
}

export async function saveSupervisorSettings(value: SupervisorSettings): Promise<void> {
  const { error } = await supabase
    .from('app_settings')
    .update({ value } as never)
    .eq('key', 'supervisor');
  if (error) throw toError(error);
}

/** Each rule: what it looks at, who sees it, and its numbers (Bangla, for Settings) */
export const RULES: {
  key: RuleKey;
  icon: string;
  title: string;
  text: string;
  who: 'own' | 'managers' | 'admins';
  nums: { key: string; label: string; min: number; max: number }[];
}[] = [
  {
    key: 'new_lead',
    icon: '🆕',
    title: 'নতুন lead-এ কল হয়নি',
    text: 'নতুন lead এত মিনিটেও কল না হলে (আলাদা সতর্কতা আগে থেকেই যায়)',
    who: 'own',
    nums: [{ key: 'minutes', label: 'মিনিট', min: 10, max: 600 }],
  },
  {
    key: 'followup_late',
    icon: '⏰',
    title: 'Follow-up বাকি',
    text: 'নির্ধারিত সময়ের এত ঘণ্টা পরেও follow-up না হলে',
    who: 'own',
    nums: [{ key: 'hours', label: 'ঘণ্টা', min: 1, max: 48 }],
  },
  {
    key: 'hot_idle',
    icon: '🎯',
    title: 'সম্ভাবনাময় lead চুপচাপ',
    text: 'Score বেশি / hot lead-এ এত দিন কথা না হলে (প্রতিজনের সেরা ১০টা)',
    who: 'own',
    nums: [{ key: 'days', label: 'দিন', min: 1, max: 30 }],
  },
  {
    key: 'stuck',
    icon: '🧊',
    title: 'একই stage-এ আটকে',
    text: 'এত দিন stage না বদলালে (কমপক্ষে ৫টা হলে)',
    who: 'own',
    nums: [{ key: 'days', label: 'দিন', min: 3, max: 90 }],
  },
  {
    key: 'no_note',
    icon: '📝',
    title: 'Note ছাড়া কল',
    text: 'আজ কথা হওয়া কলে note নেই, এতটা বা বেশি',
    who: 'own',
    nums: [{ key: 'min', label: 'কল', min: 1, max: 50 }],
  },
  {
    key: 'promise',
    icon: '🤝',
    title: 'কথা দেওয়া আছে, কিছু ঠিক করা নেই (AI)',
    text: 'Note-এ “শুক্রবার আসবেন” ধরনের কথা, অথচ ঐ দিনের follow-up / visit নেই (এত দিনের note)',
    who: 'own',
    nums: [{ key: 'days', label: 'দিন', min: 3, max: 30 }],
  },
  {
    key: 'interest_down',
    icon: '📉',
    title: 'আগ্রহ কমছে (AI)',
    text: 'শেষ দুটো note-এ আগ্রহ কমছে, এমন lead এতজন বা বেশি',
    who: 'own',
    nums: [{ key: 'min', label: 'lead', min: 1, max: 50 }],
  },
  {
    key: 'thin_notes',
    icon: '📝',
    title: 'অকাজের note (AI)',
    text: 'সপ্তাহে এতটা বা বেশি খুব ছোট note (আর মোটের অর্ধেক বা বেশি)',
    who: 'own',
    nums: [{ key: 'min', label: 'note', min: 2, max: 100 }],
  },
  {
    key: 'fee_due',
    icon: '💰',
    title: 'ভর্তি হয়েছে, fee বাকি',
    text: 'এত দিন কোনো payment নেই',
    who: 'own',
    nums: [{ key: 'days', label: 'দিন', min: 7, max: 180 }],
  },
  {
    key: 'no_calls',
    icon: '📵',
    title: 'আজ কোনো কল নেই',
    text: 'এই সময় পর্যন্ত কারো কোনো কল না হলে (Team Lead / admin দেখবে)',
    who: 'managers',
    nums: [{ key: 'hour', label: 'টা (২৪ ঘণ্টা)', min: 9, max: 20 }],
  },
  {
    key: 'short_calls',
    icon: '⏱',
    title: 'খুব ছোট "কথা হয়েছে" কল',
    text: 'এত সেকেন্ডের কম কল, দিনে এতটা বা বেশি (ইঙ্গিত, প্রমাণ না)',
    who: 'managers',
    nums: [
      { key: 'sec', label: 'সেকেন্ড', min: 3, max: 60 },
      { key: 'min', label: 'কল', min: 2, max: 50 },
    ],
  },
  {
    key: 'not_now_high',
    icon: '✕',
    title: 'বেশি Not Now',
    text: '৭ দিনে এতটা বা বেশি, আর টিমের গড়ের দ্বিগুণ',
    who: 'managers',
    nums: [{ key: 'min', label: 'lead', min: 2, max: 100 }],
  },
  {
    key: 'workload',
    icon: '⚖️',
    title: 'কাজের ভার বেশি',
    text: 'কারো open lead টিমের মাঝামাঝির এত গুণ (কমপক্ষে এতটা)',
    who: 'managers',
    nums: [
      { key: 'ratio', label: 'গুণ', min: 1.2, max: 5 },
      { key: 'min', label: 'lead', min: 5, max: 1000 },
    ],
  },
  {
    key: 'unassigned',
    icon: '🙋',
    title: 'কাউকে দেওয়া হয়নি',
    text: 'Lead এত ঘণ্টা কারো নামে না থাকলে',
    who: 'admins',
    nums: [{ key: 'hours', label: 'ঘণ্টা', min: 1, max: 72 }],
  },
  {
    key: 'discount_wait',
    icon: '💸',
    title: 'Discount অনুরোধ অপেক্ষায়',
    text: 'এত দিন উত্তর না পেলে',
    who: 'admins',
    nums: [{ key: 'days', label: 'দিন', min: 1, max: 30 }],
  },
  {
    key: 'bank_return',
    icon: '🏦',
    title: 'Lead Bank-এ ফেরত পাঠানোর মতো',
    text: 'এত দিন কোনো অগ্রগতি নেই (কমপক্ষে ১০টা হলে)',
    who: 'admins',
    nums: [{ key: 'days', label: 'দিন', min: 20, max: 365 }],
  },
  {
    key: 'bank_pull',
    icon: '🏦',
    title: 'হাতে কাজ কম',
    text: 'কারো open lead এর কম, অথচ Lead Bank-এ নতুন নম্বর আছে',
    who: 'admins',
    nums: [{ key: 'min_open', label: 'lead', min: 1, max: 200 }],
  },
];

export const SEVERITY: Record<Severity, { label: string; icon: string }> = {
  urgent: { label: 'এখনই', icon: '🔴' },
  today: { label: 'আজ', icon: '🟠' },
  improve: { label: 'উন্নতি', icon: '🟢' },
};

/** "সন্ধ্যা ৭টা" style hint for the hour a lead answers */
export function hourText(h: number | null): string | null {
  if (h == null) return null;
  const part = h < 5 ? 'রাত' : h < 12 ? 'সকাল' : h < 16 ? 'দুপুর' : h < 18 ? 'বিকাল' : h < 20 ? 'সন্ধ্যা' : 'রাত';
  const hr = h % 12 === 0 ? 12 : h % 12;
  return `${part} ${hr}টায় বেশি ধরেন`;
}

// ---------------------------------------------------------------------
// 🤖 The AI parts (steps 3–5)
// ---------------------------------------------------------------------
export type ReportBody = { summary: string; wins: string[]; concerns: string[]; actions: string[] };
export type Report = {
  id: string;
  kind: 'daily' | 'weekly' | 'coach' | 'tip';
  day: string;
  body: ReportBody;
  provider: string | null;
  created_at: string;
};

/** The Edge Function (the AI); its own error text is shown */
async function callAi<T>(body: Record<string, unknown>): Promise<T> {
  const { data, error } = await supabase.functions.invoke('ai-supervisor', { body });
  if (error) {
    let msg = error.message;
    try {
      const b = await (error as { context?: Response }).context?.clone().json();
      if (b?.error) msg = b.error;
      else if (typeof b?.message === 'string') msg = b.message;
    } catch {
      // keep the first message
    }
    const status = (error as { context?: Response }).context?.status;
    // (the request never reached the server; a server's own error text is shown as it is)
    if (/^Failed to send/i.test(msg)) msg = 'ইন্টারনেট সংযোগ নেই, বা AI এখনো server-এ চালু হয়নি।';
    else if (status === 404) msg = 'AI এখনো server-এ চালু হয়নি (Edge Function ai-supervisor)।';
    else if (/non-2xx/i.test(msg)) msg = 'Server উত্তর দিতে পারেনি। একটু পরে চেষ্টা করুন।';
    throw new Error(msg);
  }
  if ((data as { error?: string })?.error) throw new Error((data as { error: string }).error);
  return data as T;
}

/** Today's tip (mine) or a one-to-one page (someone I look after), if made already */
export async function getReport(kind: 'tip' | 'coach', subject?: string | null): Promise<Report | null> {
  return rpc<Report | null>('supervisor_report_get', { p_kind: kind, p_subject: subject ?? null });
}

/** Ask the AI to make it now (once a day; refresh: make it again) */
export async function makeReport(kind: 'tip' | 'coach', subject?: string | null, refresh = false): Promise<Report> {
  const r = await callAi<{ report: Report | null }>({ mode: kind, user_id: subject ?? null, refresh });
  if (!r.report) throw new Error('এখন তৈরি করা যায়নি। একটু পরে চেষ্টা করুন।');
  return r.report;
}

export async function latestReports(): Promise<{ daily: Report | null; weekly: Report | null }> {
  return rpc('supervisor_reports_latest');
}

// ---------------------------------------------------------------------
// 💬 The chat with the AI supervisor (super admins only)
// ---------------------------------------------------------------------
export type ChatSummary = { id: string; title: string; pinned: boolean; updated_at: string; last: string | null };
export type ChatAction = {
  type: 'follow_up' | 'hand_over' | 'message';
  status: 'pending' | 'done' | 'dismissed';
  lead_ids?: string[];
  lead_names?: string[];
  user_id?: string;
  user_name?: string;
  due_at?: string;
  note?: string;
  text?: string;
  result?: string;
};
export type ChatLink = { type: 'lead' | 'person'; id: string; label: string };
export type ChatMessage = {
  id: string;
  role: 'user' | 'assistant';
  body: string;
  data: { sources?: string[]; links?: ChatLink[]; actions?: ChatAction[] };
  provider?: string | null;
  created_at: string;
};

export async function chatList(): Promise<{ daily: number; used: number; chats: ChatSummary[] }> {
  return rpc('supervisor_chat_list');
}
export async function chatGet(chatId: string): Promise<ChatMessage[]> {
  return rpc<ChatMessage[]>('supervisor_chat_get', { p_chat: chatId });
}
/** Send a message; the answer comes back saved (with its links and suggested actions) */
export async function chatSend(
  chatId: string | null,
  text: string,
): Promise<{ chat_id: string; user_message_id: string; message: ChatMessage; used: number; daily: number }> {
  return callAi({ mode: 'chat', chat_id: chatId, text });
}
export async function chatEdit(
  chatId: string,
  change: { title?: string; pinned?: boolean; remove?: boolean },
): Promise<void> {
  await rpc('supervisor_chat_edit', {
    p_chat: chatId,
    p_title: change.title ?? null,
    p_pinned: change.pinned ?? null,
    p_delete: !!change.remove,
  });
}
/** A suggested action: do it (yes) or put it aside (no) */
export async function chatAct(messageId: string, index: number, yes: boolean): Promise<ChatAction> {
  return rpc<ChatAction>('supervisor_chat_act', { p_message: messageId, p_index: index, p_do: yes });
}

export async function askSupervisor(question: string): Promise<{ answer: string; points: string[]; provider: string }> {
  return callAi({ mode: 'ask', question });
}

export type ForecastCourse = {
  course_id: string;
  name: string;
  target: number | null;
  admitted: number;
  pace: number | null;
  need_per_day: number | null;
  hot_open: number;
  ai_expected: number;
};
export type Forecast = {
  month: string;
  days: number;
  days_past: number;
  courses: ForecastCourse[];
  total: { target: number | null; admitted: number; pace: number | null; hot_open: number; ai_expected: number };
};
export async function getForecast(month?: string | null): Promise<Forecast> {
  return rpc<Forecast>('supervisor_forecast', { p_month: month ?? null });
}

export async function getObjections(days = 30): Promise<{ days: number; kinds: { kind: string; leads: number }[] }> {
  return rpc('supervisor_objections', { p_days: days });
}

export type ImpactNumbers = {
  first_call_min: number | null;
  followups_on_time_pct: number | null;
  admitted_per_week: number | null;
  calls_per_day: number | null;
};
export async function getImpact(): Promise<{
  started_at: string;
  days_after: number;
  before: ImpactNumbers;
  after: ImpactNumbers;
}> {
  return rpc('supervisor_impact');
}

export type RuleStat = {
  rule: string;
  raised: number;
  done: number;
  wrong: number;
  fixed: number;
  expired: number;
  open: number;
  wrong_pct: number | null;
};
export async function getRuleStats(days = 30): Promise<RuleStat[]> {
  return rpc<RuleStat[]>('supervisor_rule_stats', { p_days: days });
}

// 📚 the playbook: the college's own answers to objections
export type PlaybookItem = { kind: string; answer: string };
export async function getPlaybook(): Promise<PlaybookItem[]> {
  const { data, error } = await supabase
    .from('app_settings')
    .select('value')
    .eq('key', 'supervisor_playbook')
    .maybeSingle();
  if (error) throw toError(error);
  const items = ((data as { value?: { items?: unknown } } | null)?.value?.items ?? []) as unknown[];
  return items
    .filter((x): x is PlaybookItem => !!x && typeof (x as PlaybookItem).kind === 'string')
    .map((x) => ({ kind: x.kind, answer: String(x.answer ?? '') }));
}
export async function savePlaybook(items: PlaybookItem[]): Promise<void> {
  const clean = items.map((x) => ({ kind: x.kind, answer: x.answer.trim().slice(0, 1500) })).filter((x) => x.answer);
  const { error } = await supabase
    .from('app_settings')
    .update({ value: { items: clean } } as never)
    .eq('key', 'supervisor_playbook');
  if (error) throw toError(error);
}

// 🎯 monthly admission targets per course
export async function getTargets(month: string): Promise<Record<string, number>> {
  const { data, error } = await supabase
    .from('admission_targets' as never)
    .select('course_id, target')
    .eq('month', month);
  if (error) throw toError(error);
  return Object.fromEntries(
    ((data ?? []) as { course_id: string; target: number }[]).map((r) => [r.course_id, r.target]),
  );
}
export async function saveTargets(month: string, targets: Record<string, number | null>): Promise<void> {
  const keep = Object.entries(targets).filter(([, v]) => v != null && v >= 0);
  const drop = Object.entries(targets)
    .filter(([, v]) => v == null)
    .map(([k]) => k);
  if (keep.length) {
    const { error } = await supabase
      .from('admission_targets' as never)
      .upsert(keep.map(([course_id, target]) => ({ course_id, month, target })) as never, {
        onConflict: 'course_id,month',
      });
    if (error) throw toError(error);
  }
  if (drop.length) {
    const { error } = await supabase
      .from('admission_targets' as never)
      .delete()
      .eq('month', month)
      .in('course_id', drop);
    if (error) throw toError(error);
  }
}

export const WEEK_DAYS = ['রবিবার', 'সোমবার', 'মঙ্গলবার', 'বুধবার', 'বৃহস্পতিবার', 'শুক্রবার', 'শনিবার'];
