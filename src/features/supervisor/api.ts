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
export type FindingStatus = 'open' | 'snoozed' | 'done' | 'wrong' | 'fixed';

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
      me: Counts;
      top: Pick<Finding, 'id' | 'rule' | 'severity' | 'title' | 'detail' | 'lead_id'>[];
      tasks: Task[];
      team: (Counts & { people: number }) | null;
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
  | 'bank_pull';

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
};

export async function getSupervisorSettings(): Promise<SupervisorSettings> {
  return rpc<SupervisorSettings>('supervisor_setting');
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
