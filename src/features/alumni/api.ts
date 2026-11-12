import { getSetting, updateSetting } from '@/features/settings/api';
import { supabase } from '@/shared/lib/supabase';
import type { Json } from '@/shared/types/database';

// =====================================================================
// 🎓 Alumni: students who passed. No pipeline; they refer new people.
//   Referral → inbox → Import as lead (course + person chosen there),
//   Give credit (the number was already a lead) or Reject.
//   Who sees / manages: Settings → Alumni (roles + people; admins always).
// =====================================================================

function toError(e: { message: string; hint?: string | null }): Error {
  const err = new Error(friendly(e.message)) as Error & { hint?: string };
  if (e.hint) err.hint = e.hint;
  return err;
}

function friendly(message: string): string {
  if (/could not find the function|relation .* does not exist|schema cache/i.test(message)) {
    return 'Alumni is not ready on the server yet. Please ask the admin to run the database update.';
  }
  if (/network|fetch/i.test(message)) return 'No internet connection. Please try again.';
  return message;
}

/** 'alumni_duplicate:<id>' → the id */
export function hintId(e: unknown, kind: string): string | null {
  const hint = (e as { hint?: string } | null)?.hint ?? '';
  return hint.startsWith(kind + ':') ? hint.slice(kind.length + 1) : null;
}

const rpc = <T>(name: string, args: Record<string, unknown>) =>
  supabase.rpc(name as never, args as never) as unknown as Promise<{
    data: T | null;
    error: { message: string; hint?: string } | null;
  }>;

// ---------------------------------------------------------------------
// ⚙️ Setting
// ---------------------------------------------------------------------
export type AlumniRule = { all: boolean; roles: string[]; user_ids: string[] };
export type AlumniSettings = {
  view: AlumniRule;
  manage: AlumniRule;
  rewards: {
    enabled: boolean;
    default_amount: number;
    by_course: Record<string, number>;
    /** 🏅 a bonus at N admitted (once each) */
    tiers?: { count: number; amount: number }[];
  };
  /** 🙏 the thanks message (WhatsApp) when a referral is admitted */
  thanks_text?: string;
  /** 🎓 a batch closed → its admitted students become alumni */
  auto_from_batch?: boolean;
  /** ⏰ reminders: a next contact that is due, birthdays (to the one who looks after them) */
  reminders: { next_contact: boolean; birthdays: boolean };
  /** 🔍 which filters the list shows, in this order */
  filters: { key: AlumniFilterKey; enabled: boolean }[];
};

export type AlumniFilterKey =
  | 'next'
  | 'contact'
  | 'course'
  | 'year'
  | 'session'
  | 'district'
  | 'upazila'
  | 'workplace'
  | 'designation'
  | 'tags'
  | 'owner'
  | 'referrals'
  | 'reward'
  | 'birthday'
  | 'dnc'
  | 'sms'
  | 'custom';

export const ALUMNI_FILTER_LABEL: Record<AlumniFilterKey, string> = {
  next: 'Next contact',
  contact: 'Last contact',
  course: 'Course & batch',
  year: 'Passing year',
  session: 'Session',
  district: 'District',
  upazila: 'Upazila',
  workplace: 'Workplace',
  designation: 'Designation',
  tags: 'Tags',
  owner: 'Looked after by',
  referrals: 'Referrals',
  reward: 'Reward',
  birthday: 'Birthday',
  dnc: 'Do not contact',
  sms: 'SMS',
  custom: 'Your own fields',
};

export const ALL_ALUMNI_FILTERS = Object.keys(ALUMNI_FILTER_LABEL) as AlumniFilterKey[];

export const DEFAULT_THANKS =
  'আসসালামু আলাইকুম {first_name}, আপনার পরামর্শে {student} আমাদের {course} কোর্সে ভর্তি হয়েছেন। আন্তরিক ধন্যবাদ! 🙏';

export const DEFAULT_ALUMNI_SETTINGS: AlumniSettings = {
  view: { all: false, roles: ['admin', 'team_lead'], user_ids: [] },
  manage: { all: false, roles: ['admin'], user_ids: [] },
  rewards: { enabled: false, default_amount: 0, by_course: {}, tiers: [] },
  thanks_text: DEFAULT_THANKS,
  auto_from_batch: false,
  reminders: { next_contact: true, birthdays: true },
  filters: ALL_ALUMNI_FILTERS.map((key) => ({ key, enabled: true })),
};

/** Saved filter order + any filter added later (switched on, at the end) */
function mergeFilters(saved: { key: string; enabled: boolean }[] | undefined): AlumniSettings['filters'] {
  const known = (saved ?? []).filter((f) => ALL_ALUMNI_FILTERS.includes(f.key as AlumniFilterKey)) as {
    key: AlumniFilterKey;
    enabled: boolean;
  }[];
  const missing = ALL_ALUMNI_FILTERS.filter((k) => !known.some((f) => f.key === k)).map((key) => ({
    key,
    enabled: true,
  }));
  return [...known, ...missing];
}

export async function getAlumniSettings(): Promise<AlumniSettings> {
  const saved = await getSetting<Partial<AlumniSettings>>('alumni').catch(() => null);
  const d = DEFAULT_ALUMNI_SETTINGS;
  return {
    view: { ...d.view, ...(saved?.view ?? {}) },
    manage: { ...d.manage, ...(saved?.manage ?? {}) },
    rewards: {
      ...d.rewards,
      ...(saved?.rewards ?? {}),
      by_course: { ...(saved?.rewards?.by_course ?? {}) },
      tiers: Array.isArray(saved?.rewards?.tiers) ? saved.rewards.tiers : [],
    },
    thanks_text: saved?.thanks_text?.trim() ? saved.thanks_text : DEFAULT_THANKS,
    auto_from_batch: saved?.auto_from_batch === true,
    reminders: { ...d.reminders, ...(saved?.reminders ?? {}) },
    filters: mergeFilters(saved?.filters),
  };
}

export async function saveAlumniSettings(s: AlumniSettings): Promise<void> {
  await updateSetting('alumni', s as unknown as Json);
}

/** The same rule as the database (alumni_can), for showing the tab / buttons */
export function alumniAllows(
  s: AlumniSettings,
  profile: { id: string; role_key: string } | null,
  isAdmin: boolean,
  level: 'view' | 'manage',
): boolean {
  if (!profile) return false;
  if (isAdmin) return true;
  const rules = level === 'manage' ? [s.manage] : [s.view, s.manage];
  return rules.some((r) => r.all || r.roles.includes(profile.role_key) || r.user_ids.includes(profile.id));
}

// ---------------------------------------------------------------------
// 🧩 Custom fields
// ---------------------------------------------------------------------
export type AlumniFieldType =
  | 'text'
  | 'long_text'
  | 'number'
  | 'date'
  | 'select'
  | 'phone'
  | 'email'
  | 'url'
  | 'yes_no';

export const FIELD_TYPES: { key: AlumniFieldType; label: string }[] = [
  { key: 'text', label: 'Text' },
  { key: 'long_text', label: 'Long text' },
  { key: 'number', label: 'Number' },
  { key: 'date', label: 'Date' },
  { key: 'select', label: 'Choose one' },
  { key: 'phone', label: 'Phone' },
  { key: 'email', label: 'E-mail' },
  { key: 'url', label: 'Link' },
  { key: 'yes_no', label: 'Yes / No' },
];

export type AlumniField = {
  id: string;
  key: string;
  label: string;
  type: AlumniFieldType;
  options: string[];
  required: boolean;
  show_in_list: boolean;
  is_active: boolean;
  sort_order: number;
};

export async function listAlumniFields(includeInactive = false): Promise<AlumniField[]> {
  let q = supabase
    .from('alumni_fields' as never)
    .select('*')
    .order('sort_order')
    .order('label');
  if (!includeInactive) q = q.eq('is_active' as never, true as never);
  const { data, error } = await q;
  if (error) throw toError(error);
  return (data ?? []) as unknown as AlumniField[];
}

/** "Current school" → current_school (unique) */
export function fieldKeyFor(label: string, taken: string[]): string {
  let base = label
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 30);
  if (!/^[a-z]/.test(base)) base = 'f_' + base;
  if (!base || base === 'f_') base = 'field';
  let key = base;
  let n = 2;
  while (taken.includes(key)) key = `${base}_${n++}`;
  return key;
}

export async function saveAlumniField(f: Partial<AlumniField> & { label: string }): Promise<void> {
  const row = {
    label: f.label.trim(),
    type: f.type ?? 'text',
    options: (f.options ?? []).map((o) => o.trim()).filter(Boolean),
    required: !!f.required,
    show_in_list: !!f.show_in_list,
    is_active: f.is_active ?? true,
    sort_order: f.sort_order ?? 0,
  };
  const { error } = f.id
    ? await supabase
        .from('alumni_fields' as never)
        .update(row as never)
        .eq('id' as never, f.id as never)
    : await supabase.from('alumni_fields' as never).insert({ ...row, key: f.key } as never);
  if (error) throw toError(error);
}

export async function deleteAlumniField(id: string): Promise<void> {
  // the values stay on each alumnus (hidden); turning the field on again shows them
  const { error } = await supabase
    .from('alumni_fields' as never)
    .update({ is_active: false } as never)
    .eq('id' as never, id as never);
  if (error) throw toError(error);
}

// ---------------------------------------------------------------------
// 🎓 Alumni
// ---------------------------------------------------------------------
export type Alumnus = {
  id: string;
  name: string;
  phone: string | null;
  whatsapp_number: string | null;
  email: string | null;
  photo_url: string | null;
  course_id: string | null;
  batch_id: string | null;
  session: string | null;
  passing_year: number | null;
  student_ref: string | null;
  workplace: string | null;
  designation: string | null;
  district: string | null;
  upazila: string | null;
  address: string | null;
  custom: Record<string, Json>;
  tags: string[];
  notes: string | null;
  owner_id: string | null;
  do_not_contact: boolean;
  lead_id: string | null;
  ref_code: string;
  last_contacted_at: string | null;
  created_at: string;
  // ⏰ next contact, 🎂, the latest note (kept on the row)
  next_contact_at?: string | null;
  next_contact_note?: string | null;
  birth_date?: string | null;
  last_note?: string | null;
  last_note_at?: string | null;
  last_referral_at?: string | null;
  // 🔗 link opens, 🎯 refer score (0–100), ✍️ their own update link
  cnt_opens?: number;
  refer_score?: number | null;
  update_token?: string | null;
  workplace_key?: string | null;
  // from alumni_overview
  course_name: string | null;
  batch_name: string | null;
  owner_name: string | null;
  referrals: number;
  referrals_waiting: number;
  referred_leads: number;
  referred_admitted: number;
  /** what is still to be paid (only managers see rewards: 0 for others) */
  reward_due?: number;
};

export type AlumniSort =
  | 'name'
  | 'newest'
  | 'referrals'
  | 'admitted'
  | 'recent_referral'
  | 'quiet'
  | 'recent_contact'
  | 'next_contact'
  | 'year_new'
  | 'year_old'
  | 'batch'
  | 'reward_due'
  | 'district'
  | 'workplace'
  | 'score';

export const ALUMNI_SORTS: { key: AlumniSort; label: string; manage?: boolean }[] = [
  { key: 'name', label: 'A–Z' },
  { key: 'next_contact', label: 'Next contact' },
  { key: 'score', label: 'Most likely to refer' },
  { key: 'referrals', label: 'Most referrals' },
  { key: 'admitted', label: 'Most admitted' },
  { key: 'recent_referral', label: 'Latest referral' },
  { key: 'quiet', label: 'Longest quiet' },
  { key: 'recent_contact', label: 'Contacted lately' },
  { key: 'year_new', label: 'Passing year (new)' },
  { key: 'year_old', label: 'Passing year (old)' },
  { key: 'batch', label: 'Batch' },
  { key: 'district', label: 'District' },
  { key: 'workplace', label: 'Workplace' },
  { key: 'reward_due', label: 'Reward due', manage: true },
  { key: 'newest', label: 'Newest' },
];

/** Everything the filter sheet can set (all optional; empty = no filter) */
export type AlumniFilters = {
  /** a course id, or 'none' (no course) */
  courseId?: string | null;
  /** a batch id, or 'none' (no batch) */
  batchId?: string | null;
  /** 📵 no phone number */
  noPhone?: boolean | null;
  yearFrom?: number | null;
  yearTo?: number | null;
  session?: string | null;
  district?: string | null;
  upazila?: string | null;
  workplace?: string | null;
  designation?: string | null;
  /** has a workplace / has none */
  hasWorkplace?: boolean | null;
  /** 🏫 one school (from Schools): the same school written a little differently */
  workplaceKey?: string | null;
  tags?: string[];
  /** a person's id, or 'none' (nobody) */
  ownerId?: string | null;
  /** last contact: never, or older than N days, or within the last 7 days */
  contact?: 'never' | '30' | '90' | '180' | 'week' | null;
  /** next contact */
  next?: 'late' | 'today' | 'week' | 'set' | 'none' | null;
  referrals?: 'none' | 'any' | '3' | 'admitted' | 'waiting' | null;
  /** rewards still to be paid (managers) */
  rewardDue?: boolean | null;
  /** birthday this month */
  birthday?: 'month' | 'week' | null;
  /** do not contact: hide them / only them */
  dnc?: 'hide' | 'only' | null;
  /** 📨 got any SMS / never got one */
  sms?: 'any' | 'never' | null;
  /** 📨 one send: who got it (true) / who didn't (false) */
  smsBatchId?: string | null;
  smsBatchGot?: boolean | null;
  /** your own fields: key → value */
  custom?: Record<string, string>;
};

export type AlumniQuery = {
  search?: string;
  courseId?: string | null;
  batchId?: string | null;
  district?: string | null;
  only?: 'referred' | 'never_contacted' | 'do_not_contact' | 'no_course' | 'due' | 'birthday' | 'call_week' | null;
  sort?: AlumniSort;
  page?: number;
  filters?: AlumniFilters;
};

export const ALUMNI_PAGE = 50;

/** How many filters are set (the badge on the Filter button) */
export function countAlumniFilters(f: AlumniFilters | undefined): number {
  if (!f) return 0;
  let n = 0;
  if (f.courseId || f.batchId) n++;
  if (f.noPhone) n++;
  if (f.yearFrom || f.yearTo) n++;
  for (const k of [
    'session',
    'district',
    'upazila',
    'workplace',
    'designation',
    'ownerId',
    'contact',
    'next',
    'referrals',
    'birthday',
    'dnc',
    'sms',
    'smsBatchId',
  ] as const)
    if (f[k]) n++;
  if (f.hasWorkplace != null) n++;
  if (f.workplaceKey) n++;
  if (f.rewardDue) n++;
  if (f.tags?.length) n++;
  n += Object.values(f.custom ?? {}).filter(Boolean).length;
  return n;
}

const day = 86400000;
const iso = (ms: number) => new Date(ms).toISOString();
/** Midnight tonight (the phone's day) */
function endOfToday(): number {
  const d = new Date();
  d.setHours(24, 0, 0, 0);
  return d.getTime();
}

// The search and filters (the list, and "select all that match")
function alumniFilters<
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  Q extends {
    or: any;
    eq: any;
    ilike: any;
    gt: any;
    gte: any;
    lt: any;
    lte: any;
    is: any;
    not: any;
    contains: any;
    in: any;
  },
>(query: Q, q: AlumniQuery): Q {
  // "either / or" groups; two groups must both hold (sent as one and(or(…),or(…)))
  const orGroups: string[] = [];
  const s = (q.search ?? '').trim();
  if (s) {
    // search_text: name, numbers, workplace, designation, place, tags, your own fields… (lower case)
    const safe = s.replace(/[%,()*]/g, ' ').toLowerCase();
    const digits = s.replace(/\D/g, '');
    const parts = [`search_text.ilike.%${safe}%`];
    if (digits.length >= 3 && digits.length !== s.length) parts.push(`search_text.ilike.%${digits}%`);
    orGroups.push(parts.join(','));
  }
  const f = q.filters ?? {};
  const courseId = f.courseId ?? q.courseId;
  const batchId = f.batchId ?? q.batchId;
  const district = f.district ?? q.district;
  if (courseId === 'none') query = query.is('course_id' as never, null as never);
  else if (courseId) query = query.eq('course_id' as never, courseId as never);
  if (batchId === 'none') query = query.is('batch_id' as never, null as never);
  else if (batchId) query = query.eq('batch_id' as never, batchId as never);
  if (f.noPhone) query = query.is('phone' as never, null as never);
  if (district) query = query.ilike('district' as never, district as never);
  if (f.upazila) query = query.ilike('upazila' as never, f.upazila as never);
  if (f.session) query = query.eq('session' as never, f.session as never);
  if (f.workplace) query = query.ilike('workplace' as never, `%${f.workplace.replace(/[%,()*]/g, ' ')}%` as never);
  if (f.designation)
    query = query.ilike('designation' as never, `%${f.designation.replace(/[%,()*]/g, ' ')}%` as never);
  if (f.workplaceKey) query = query.eq('workplace_key' as never, f.workplaceKey as never);
  if (f.hasWorkplace === true) query = query.not('workplace' as never, 'is', null);
  if (f.hasWorkplace === false) query = query.is('workplace' as never, null as never);
  if (f.yearFrom) query = query.gte('passing_year' as never, f.yearFrom as never);
  if (f.yearTo) query = query.lte('passing_year' as never, f.yearTo as never);
  if (f.tags?.length) query = query.contains('tags' as never, f.tags as never);
  if (f.ownerId === 'none') query = query.is('owner_id' as never, null as never);
  else if (f.ownerId) query = query.eq('owner_id' as never, f.ownerId as never);
  switch (f.contact) {
    case 'never':
      query = query.is('last_contacted_at' as never, null as never);
      break;
    case 'week':
      query = query.gte('last_contacted_at' as never, iso(Date.now() - 7 * day) as never);
      break;
    case '30':
    case '90':
    case '180':
      orGroups.push(`last_contacted_at.is.null,last_contacted_at.lt.${iso(Date.now() - Number(f.contact) * day)}`);
      break;
  }
  switch (f.next) {
    case 'late':
      query = query.lt('next_contact_at' as never, iso(Date.now()) as never);
      break;
    case 'today':
      query = query.lt('next_contact_at' as never, iso(endOfToday()) as never);
      break;
    case 'week':
      query = query.lt('next_contact_at' as never, iso(endOfToday() + 6 * day) as never);
      break;
    case 'set':
      query = query.not('next_contact_at' as never, 'is', null);
      break;
    case 'none':
      query = query.is('next_contact_at' as never, null as never);
      break;
  }
  switch (f.referrals) {
    case 'none':
      query = query.eq('cnt_referrals' as never, 0 as never);
      break;
    case 'any':
      query = query.gt('cnt_referrals' as never, 0 as never);
      break;
    case '3':
      query = query.gte('cnt_referrals' as never, 3 as never);
      break;
    case 'admitted':
      query = query.gt('cnt_admitted' as never, 0 as never);
      break;
    case 'waiting':
      query = query.gt('cnt_waiting' as never, 0 as never);
      break;
  }
  if (f.rewardDue) query = query.gt('reward_due' as never, 0 as never);
  if (f.dnc === 'hide') query = query.eq('do_not_contact' as never, false as never);
  if (f.dnc === 'only') query = query.eq('do_not_contact' as never, true as never);
  if (f.sms === 'any') query = query.gt('sms_count' as never, 0 as never);
  if (f.sms === 'never') query = query.eq('sms_count' as never, 0 as never);
  if (f.smsBatchId && /^[0-9a-f-]{36}$/i.test(f.smsBatchId)) {
    if (f.smsBatchGot === false) query = query.not('sms_batch_ids' as never, 'cs', `{${f.smsBatchId}}`);
    else query = query.contains('sms_batch_ids' as never, [f.smsBatchId] as never);
  }
  if (f.birthday === 'month') {
    const m = new Date().getMonth() + 1;
    query = query.gte('birth_md' as never, (m * 100) as never).lte('birth_md' as never, (m * 100 + 31) as never);
  } else if (f.birthday === 'week') {
    const days = Array.from({ length: 7 }, (_, i) => {
      const d = new Date(Date.now() + i * day);
      return (d.getMonth() + 1) * 100 + d.getDate();
    });
    query = query.in('birth_md' as never, days as never);
  }
  for (const [key, value] of Object.entries(f.custom ?? {})) {
    if (!value || !/^[a-z0-9_]+$/.test(key)) continue;
    query = query.eq(`custom->>${key}` as never, value as never);
  }
  if (q.only === 'referred') query = query.gt('referrals' as never, 0 as never);
  if (q.only === 'never_contacted') query = query.is('last_contacted_at' as never, null as never);
  if (q.only === 'do_not_contact') query = query.eq('do_not_contact' as never, true as never);
  if (q.only === 'no_course') query = query.is('course_id' as never, null as never);
  if (q.only === 'due') query = query.lt('next_contact_at' as never, iso(endOfToday()) as never);
  if (q.only === 'call_week') {
    // 🎯 likely to refer, not talked to in a month, may be contacted
    query = query.gte('refer_score' as never, 50 as never).eq('do_not_contact' as never, false as never);
    orGroups.push(`last_contacted_at.is.null,last_contacted_at.lt.${iso(Date.now() - 30 * day)}`);
  }
  if (orGroups.length === 1) query = query.or(orGroups[0]);
  else if (orGroups.length > 1) query = query.or(`and(${orGroups.map((g) => `or(${g})`).join(',')})`);
  return query;
}

export async function listAlumni(q: AlumniQuery = {}): Promise<{ rows: Alumnus[]; total: number }> {
  let query = alumniFilters(supabase.from('alumni_overview' as never).select('*', { count: 'exact' }), q);
  const asc = (col: string, nullsFirst = false) => (query = query.order(col as never, { ascending: true, nullsFirst }));
  const desc = (col: string) => (query = query.order(col as never, { ascending: false, nullsFirst: false }));
  switch (q.sort ?? 'name') {
    case 'newest':
      desc('created_at');
      break;
    case 'referrals':
      desc('cnt_referrals');
      asc('name');
      break;
    case 'admitted':
      desc('cnt_admitted');
      desc('cnt_referrals');
      break;
    case 'recent_referral':
      desc('last_referral_at');
      asc('name');
      break;
    case 'quiet':
      asc('last_contacted_at', true);
      break;
    case 'recent_contact':
      desc('last_contacted_at');
      break;
    case 'next_contact':
      asc('next_contact_at');
      asc('name');
      break;
    case 'year_new':
      desc('passing_year');
      asc('name');
      break;
    case 'year_old':
      asc('passing_year');
      asc('name');
      break;
    case 'batch':
      asc('batch_name');
      asc('name');
      break;
    case 'district':
      asc('district');
      asc('name');
      break;
    case 'workplace':
      asc('workplace');
      asc('name');
      break;
    case 'reward_due':
      desc('reward_due');
      asc('name');
      break;
    case 'score':
      desc('refer_score');
      asc('name');
      break;
    default:
      asc('name');
  }
  const page = q.page ?? 0;
  query = query.range(page * ALUMNI_PAGE, page * ALUMNI_PAGE + ALUMNI_PAGE - 1);
  const { data, error, count } = await query;
  if (error) throw toError(error);
  return { rows: (data ?? []) as unknown as Alumnus[], total: count ?? 0 };
}

/** "Select all that match": only the ids (asked when tapped, at most 5000) */
export async function listAlumniIds(q: AlumniQuery = {}): Promise<string[]> {
  const { data, error } = await alumniFilters(supabase.from('alumni_overview' as never).select('id'), q).limit(5000);
  if (error) throw toError(error);
  return ((data ?? []) as { id: string }[]).map((r) => r.id);
}

export async function getAlumnus(id: string): Promise<Alumnus | null> {
  const { data, error } = await supabase
    .from('alumni_overview' as never)
    .select('*')
    .eq('id' as never, id as never)
    .maybeSingle();
  if (error) throw toError(error);
  return (data as unknown as Alumnus) ?? null;
}

/** For the pickers (lead page "Referred by"): name / phone / code */
export async function searchAlumni(
  text: string,
): Promise<Pick<Alumnus, 'id' | 'name' | 'phone' | 'batch_name' | 'workplace'>[]> {
  const { rows } = await listAlumni({ search: text, sort: 'name' });
  return rows.slice(0, 20);
}

export type AlumnusInput = {
  name: string;
  phone?: string | null;
  whatsapp_number?: string | null;
  email?: string | null;
  course_id?: string | null;
  batch_id?: string | null;
  session?: string | null;
  passing_year?: number | string | null;
  student_ref?: string | null;
  workplace?: string | null;
  designation?: string | null;
  district?: string | null;
  upazila?: string | null;
  address?: string | null;
  custom?: Record<string, Json>;
  tags?: string[];
  notes?: string | null;
  owner_id?: string | null;
  do_not_contact?: boolean;
  /** 'YYYY-MM-DD' or null */
  birth_date?: string | null;
};

export async function saveAlumnus(id: string | null, row: AlumnusInput): Promise<string> {
  const r = await rpc<string>('save_alumni_v2', { p_id: id, p_row: row });
  if (r.error && /could not find the function/i.test(r.error.message)) {
    // a database from before birthdays
    const { birth_date: _bd, ...rest } = row;
    const old = await rpc<string>('save_alumni', { p_id: id, p_row: rest });
    if (old.error) throw toError(old.error);
    return old.data as string;
  }
  if (r.error) throw toError(r.error);
  return r.data as string;
}

export async function deleteAlumnus(id: string): Promise<void> {
  const { error } = await rpc('delete_alumni', { p_id: id });
  if (error) throw toError(error);
}

// ---------------------------------------------------------------------
// 📝 Notes, calls, history
// ---------------------------------------------------------------------
export type AlumniEventKind =
  | 'note'
  | 'call'
  | 'whatsapp'
  | 'message'
  | 'created'
  | 'edited'
  | 'referral'
  | 'referral_imported'
  | 'referral_credited'
  | 'referral_rejected'
  | 'admitted'
  | 'reward'
  | 'deleted'
  | 'restored'
  | 'next_contact';

export type AlumniEvent = {
  id: string;
  kind: AlumniEventKind;
  body: string | null;
  data: Record<string, Json>;
  created_at: string;
  by: { full_name: string | null } | null;
  // from 2027 on (older rows: null / defaults)
  by_user?: string | null;
  happened_at?: string | null;
  pinned?: boolean;
  deleted_at?: string | null;
  deleted_by?: string | null;
  outcome?: string | null;
  direction?: string | null;
  duration_sec?: number | null;
  channel?: string | null;
  media?: string | null;
  source?: string | null;
};

/** The contact kinds (shown with a result) */
export const CONTACT_KINDS: AlumniEventKind[] = ['call', 'whatsapp', 'message'];

export async function listAlumniEvents(alumniId: string, limit = 300): Promise<AlumniEvent[]> {
  const cols =
    'id, kind, body, data, created_at, by_user, happened_at, pinned, deleted_at, deleted_by, outcome, direction, ' +
    'duration_sec, channel, media, source, by:profiles!alumni_events_by_user_fkey(full_name)';
  let r = await supabase
    .from('alumni_events' as never)
    .select(cols)
    .eq('alumni_id' as never, alumniId as never)
    .order('created_at' as never, { ascending: false })
    .limit(limit);
  if (r.error && /column .* does not exist/i.test(r.error.message)) {
    // a database from before calls on alumni
    r = await supabase
      .from('alumni_events' as never)
      .select('id, kind, body, data, created_at, by:profiles!alumni_events_by_user_fkey(full_name)')
      .eq('alumni_id' as never, alumniId as never)
      .order('created_at' as never, { ascending: false })
      .limit(limit);
  }
  if (r.error) throw toError(r.error);
  const rows = (r.data ?? []) as unknown as AlumniEvent[];
  // the time it happened (a synced call: the call's time), newest first
  return rows.sort((x, y) => (y.happened_at ?? y.created_at).localeCompare(x.happened_at ?? x.created_at));
}

export async function addAlumniEvent(alumniId: string, kind: 'note' | 'call' | 'whatsapp' | 'message', body?: string) {
  const { error } = await rpc('add_alumni_event', { p_alumni: alumniId, p_kind: kind, p_body: body ?? null });
  if (error) throw toError(error);
}

export type AlumniContactInput = {
  alumniId: string;
  channel: 'phone' | 'whatsapp' | 'sms';
  outcome: string;
  note?: string | null;
  direction?: 'outgoing' | 'incoming' | 'missed' | 'rejected';
  media?: 'voice' | 'video' | 'message' | null;
  durationSec?: number | null;
  deviceId?: string | null;
  deviceCallId?: string | null;
  calledAt?: string | null;
  nextAt?: string | null;
  nextNote?: string | null;
};

/** 📞 A call / WhatsApp / message with its result (and the next contact) */
export async function logAlumniContact(i: AlumniContactInput): Promise<string> {
  const { data, error } = await rpc<string>('log_alumni_contact', {
    p_alumni: i.alumniId,
    p_channel: i.channel,
    p_outcome: i.outcome,
    p_note: i.note ?? null,
    p_direction: i.direction ?? 'outgoing',
    p_media: i.media ?? null,
    p_duration: i.durationSec ?? null,
    p_device_id: i.deviceId ?? null,
    p_device_call_id: i.deviceCallId ?? null,
    p_called_at: i.calledAt ?? null,
    p_next_at: i.nextAt ?? null,
    p_next_note: i.nextNote ?? null,
  });
  if (error) throw toError(error);
  return data as string;
}

/** ⏰ Next contact for one or many (null clears it) */
export async function setAlumniNextContact(ids: string[], at: Date | null, note?: string | null): Promise<number> {
  const { data, error } = await rpc<number>('set_alumni_next_contact', {
    p_ids: ids,
    p_at: at ? at.toISOString() : null,
    p_note: note ?? null,
  });
  if (error) throw toError(error);
  return Number(data ?? 0);
}

export async function deleteAlumniEvent(id: string, reason?: string): Promise<void> {
  const { error } = await rpc('delete_alumni_event', { p_event: id, p_reason: reason ?? null });
  if (error) throw toError(error);
}

export async function restoreAlumniEvent(id: string): Promise<void> {
  const { error } = await rpc('restore_alumni_event', { p_event: id });
  if (error) throw toError(error);
}

export async function pinAlumniEvent(id: string, pinned: boolean): Promise<void> {
  const { error } = await rpc('pin_alumni_event', { p_event: id, p_pinned: pinned });
  if (error) throw toError(error);
}

/** Can I delete this entry? (writer within 24 h; managers any time; not synced ones) */
export function canDeleteAlumniEvent(e: AlumniEvent, me: string | null, manage: boolean): boolean {
  if (e.deleted_at || !['note', 'call', 'whatsapp', 'message'].includes(e.kind)) return false;
  if ((e.source ?? 'app') !== 'app') return false;
  if (manage) return true;
  return !!me && e.by_user === me && Date.now() - new Date(e.created_at).getTime() < 24 * 3600 * 1000;
}

export const EVENT_TEXT: Record<AlumniEventKind, { icon: string; text: string }> = {
  note: { icon: '📝', text: 'Note' },
  call: { icon: '📞', text: 'Called' },
  whatsapp: { icon: '💬', text: 'WhatsApp' },
  message: { icon: '✉️', text: 'Message' },
  created: { icon: '🎓', text: 'Added to alumni' },
  edited: { icon: '✏️', text: 'Details changed' },
  referral: { icon: '📨', text: 'Referred' },
  referral_imported: { icon: '🎯', text: 'Referral became a lead' },
  referral_credited: { icon: '🤝', text: 'Got credit for a lead' },
  referral_rejected: { icon: '✕', text: 'Referral rejected' },
  admitted: { icon: '🎉', text: 'Referral admitted' },
  reward: { icon: '🎁', text: 'Reward' },
  deleted: { icon: '🗑', text: 'Deleted' },
  restored: { icon: '↩', text: 'Restored' },
  next_contact: { icon: '⏰', text: 'Next contact' },
};

// ---------------------------------------------------------------------
// 📥 Many at once
// ---------------------------------------------------------------------
export type ImportResult = {
  added: number;
  updated: number;
  skipped: number;
  failed: number;
  errors: { row: number; name: string | null; error: string }[];
};

export async function importAlumni(rows: (AlumnusInput & { from?: string })[], update = false): Promise<ImportResult> {
  const { data, error } = await rpc<ImportResult>('import_alumni', { p_rows: rows, p_update: update });
  if (error) throw toError(error);
  return data as ImportResult;
}

export async function alumniFromStudents(opts: { leadIds?: string[]; batchId?: string }): Promise<ImportResult> {
  const { data, error } = await rpc<ImportResult>('alumni_from_students', {
    p_lead_ids: opts.leadIds ?? null,
    p_batch_id: opts.batchId ?? null,
  });
  if (error) throw toError(error);
  return data as ImportResult;
}

/** Columns an Excel file may have (header words, Bangla too) */
export const ALUMNI_IMPORT_FIELDS: { key: keyof AlumnusInput; label: string; words: string[] }[] = [
  { key: 'name', label: 'Name', words: ['name', 'নাম', 'student name'] },
  { key: 'phone', label: 'Phone', words: ['phone', 'mobile', 'cell', 'number', 'ফোন', 'মোবাইল'] },
  { key: 'whatsapp_number', label: 'WhatsApp', words: ['whatsapp'] },
  { key: 'email', label: 'E-mail', words: ['email', 'e-mail', 'mail'] },
  { key: 'session', label: 'Session', words: ['session', 'সেশন'] },
  { key: 'passing_year', label: 'Passing year', words: ['passing year', 'year', 'pass', 'সাল'] },
  { key: 'student_ref', label: 'Roll / Student ID', words: ['roll', 'student id', 'id', 'reg', 'রোল'] },
  {
    key: 'workplace',
    label: 'Workplace',
    words: ['school', 'workplace', 'institution', 'office', 'কর্মস্থল', 'স্কুল'],
  },
  { key: 'designation', label: 'Designation', words: ['designation', 'post', 'পদ'] },
  { key: 'district', label: 'District', words: ['district', 'জেলা', 'area'] },
  { key: 'upazila', label: 'Upazila', words: ['upazila', 'thana', 'উপজেলা', 'থানা'] },
  { key: 'address', label: 'Address', words: ['address', 'ঠিকানা'] },
  { key: 'notes', label: 'Notes', words: ['note', 'notes', 'comment', 'মন্তব্য'] },
];

// ---------------------------------------------------------------------
// 📨 Referrals
// ---------------------------------------------------------------------
export type ReferralStatus = 'new' | 'imported' | 'credited' | 'rejected';
export type Referral = {
  id: string;
  alumni_id: string;
  name: string;
  phone: string;
  course_id: string | null;
  area: string | null;
  note: string | null;
  channel: 'staff' | 'alumni_link' | 'prospect_link';
  status: ReferralStatus;
  existing_lead_id: string | null;
  lead_id: string | null;
  reject_reason: string | null;
  created_at: string;
  handled_at: string | null;
  alumni: { name: string; phone: string | null } | null;
  course: { name: string } | null;
  existing: { name: string; assigned: { full_name: string | null } | null } | null;
  by: { full_name: string | null } | null;
};

const REFERRAL_SELECT =
  'id, alumni_id, name, phone, course_id, area, note, channel, status, existing_lead_id, lead_id, reject_reason, created_at, handled_at, ' +
  'alumni:alumni!alumni_referrals_alumni_id_fkey(name, phone), course:courses(name), ' +
  'existing:leads!alumni_referrals_existing_lead_id_fkey(name, assigned:profiles!leads_assigned_to_fkey(full_name)), ' +
  'by:profiles!alumni_referrals_created_by_fkey(full_name)';

export async function listReferrals(
  opts: { status?: ReferralStatus | 'done'; alumniId?: string } = {},
): Promise<Referral[]> {
  let q = supabase.from('alumni_referrals' as never).select(REFERRAL_SELECT);
  if (opts.status === 'done') q = q.neq('status' as never, 'new' as never);
  else if (opts.status) q = q.eq('status' as never, opts.status as never);
  if (opts.alumniId) q = q.eq('alumni_id' as never, opts.alumniId as never);
  const { data, error } = await q.order('created_at' as never, { ascending: false }).limit(300);
  if (error) throw toError(error);
  return (data ?? []) as unknown as Referral[];
}

export async function addReferral(input: {
  alumniId: string;
  name: string;
  phone: string;
  courseId?: string | null;
  area?: string;
  note?: string;
}): Promise<{ id: string; existing_lead: string | null }> {
  const { data, error } = await rpc<{ id: string; existing_lead: string | null }>('add_alumni_referral', {
    p_alumni: input.alumniId,
    p_name: input.name,
    p_phone: input.phone,
    p_course_id: input.courseId ?? null,
    p_area: input.area ?? null,
    p_note: input.note ?? null,
    p_channel: 'staff',
  });
  if (error) throw toError(error);
  return data as { id: string; existing_lead: string | null };
}

export async function importReferral(
  referralId: string,
  courseIds: string[],
  assignTo: string | null,
): Promise<string> {
  const { data, error } = await rpc<string>('import_alumni_referral', {
    p_referral: referralId,
    p_course_ids: courseIds,
    p_assign_to: assignTo,
    p_stage_id: null,
  });
  if (error) throw toError(error);
  return data as string;
}

export async function creditReferral(referralId: string, opts: { leadId?: string; replace?: boolean } = {}) {
  const { error } = await rpc('credit_alumni_referral', {
    p_referral: referralId,
    p_lead_id: opts.leadId ?? null,
    p_replace: !!opts.replace,
  });
  if (error) throw toError(error);
}

export async function rejectReferral(referralId: string, reason?: string) {
  const { error } = await rpc('reject_alumni_referral', { p_referral: referralId, p_reason: reason ?? null });
  if (error) throw toError(error);
}

/** Lead page: the alumnus who referred this lead (null = none) */
export async function setLeadReferrer(leadId: string, alumniId: string | null) {
  const { error } = await rpc('set_lead_alumni_referrer', { p_lead: leadId, p_alumni: alumniId });
  if (error) throw toError(error);
}

export async function getLeadReferrer(leadId: string): Promise<{ id: string; name: string } | null> {
  const { data, error } = await supabase
    .from('leads')
    .select('referred_by_alumni_id' as never)
    .eq('id', leadId)
    .maybeSingle();
  if (error || !data) return null;
  const id = (data as unknown as { referred_by_alumni_id: string | null }).referred_by_alumni_id;
  if (!id) return null;
  const a = await supabase
    .from('alumni' as never)
    .select('id, name')
    .eq('id' as never, id as never)
    .maybeSingle();
  return (a.data as unknown as { id: string; name: string }) ?? null;
}

// ---------------------------------------------------------------------
// 🎁 Rewards
// ---------------------------------------------------------------------
export type Reward = {
  id: string;
  alumni_id: string;
  lead_id: string | null;
  amount: number;
  status: 'due' | 'paid' | 'cancelled';
  paid_at: string | null;
  method: string | null;
  note: string | null;
  created_at: string;
  lead: { name: string } | null;
  course: { name: string } | null;
};

export async function listRewards(alumniId?: string): Promise<Reward[]> {
  let q = supabase
    .from('alumni_rewards' as never)
    .select(
      'id, alumni_id, lead_id, amount, status, paid_at, method, note, created_at, lead:leads(name), course:courses(name)',
    );
  if (alumniId) q = q.eq('alumni_id' as never, alumniId as never);
  const { data, error } = await q.order('created_at' as never, { ascending: false });
  if (error) throw toError(error);
  return ((data ?? []) as unknown as Reward[]).map((r) => ({ ...r, amount: Number(r.amount) }));
}

export async function setReward(id: string, status: Reward['status'], method?: string, note?: string) {
  const { error } = await rpc('set_alumni_reward', {
    p_reward: id,
    p_status: status,
    p_method: method ?? null,
    p_note: note ?? null,
  });
  if (error) throw toError(error);
}

// ---------------------------------------------------------------------
// 📊 Numbers
// ---------------------------------------------------------------------
export type AlumniSummary = {
  alumni: number;
  waiting: number;
  referrals_month: number;
  leads_month: number;
  admitted_month: number;
  admitted_total: number;
  rewards_due: number | null;
  can_manage: boolean;
};

export async function alumniSummary(): Promise<AlumniSummary | null> {
  const { data, error } = await rpc<AlumniSummary>('alumni_summary', {});
  if (error) throw toError(error);
  return data ?? null;
}

// ---------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------
export function waNumber(phone: string | null | undefined): string | null {
  if (!phone) return null;
  const d = phone.replace(/\D/g, '');
  if (d.startsWith('880')) return d;
  if (d.startsWith('0') && d.length === 11) return '88' + d;
  return d || null;
}

export function customText(v: Json | undefined, type: AlumniFieldType): string {
  if (v === null || v === undefined || v === '') return '';
  if (type === 'yes_no') return v === true || v === 'true' || v === 'yes' ? 'Yes' : 'No';
  return String(v);
}

// ---------------------------------------------------------------------
// 🎓 Marked alumni, all at once (alumni_bulk)
// ---------------------------------------------------------------------
export type AlumniBulkAction =
  | { action: 'course'; courseId: string; batchId?: string | null }
  | { action: 'unassign' }
  | { action: 'delete' }
  | { action: 'note'; text: string }
  | { action: 'tag_add' | 'tag_remove'; tag: string }
  | { action: 'owner'; ownerId: string | null }
  | { action: 'dnc_on' | 'dnc_off' };

export async function alumniBulk(ids: string[], a: AlumniBulkAction): Promise<number> {
  const args: Record<string, unknown> = {
    p_ids: ids,
    p_action: a.action,
    p_course_id: a.action === 'course' ? a.courseId : null,
    p_batch_id: a.action === 'course' ? (a.batchId ?? null) : null,
  };
  if (a.action === 'note') args.p_text = a.text;
  if (a.action === 'tag_add' || a.action === 'tag_remove') args.p_text = a.tag;
  if (a.action === 'owner') args.p_owner = a.ownerId;
  const { data, error } = await rpc<number>('alumni_bulk', args);
  if (error) throw toError(error);
  return Number(data ?? 0);
}

// ---------------------------------------------------------------------
// 🔍 Filter choices, saved filters
// ---------------------------------------------------------------------
export type AlumniFilterValues = {
  districts: string[];
  upazilas: string[];
  workplaces: string[];
  designations: string[];
  sessions: string[];
  years: number[];
  tags: string[];
};

export async function alumniFilterValues(): Promise<AlumniFilterValues> {
  const { data, error } = await rpc<AlumniFilterValues>('alumni_filter_values', {});
  if (error) throw toError(error);
  return data ?? { districts: [], upazilas: [], workplaces: [], designations: [], sessions: [], years: [], tags: [] };
}

export type AlumniSavedFilter = {
  id: string;
  owner_id: string;
  name: string;
  filters: { filters?: AlumniFilters; sort?: AlumniSort };
  is_shared: boolean;
};

export async function listAlumniSavedFilters(): Promise<AlumniSavedFilter[]> {
  const { data, error } = await supabase
    .from('alumni_saved_filters' as never)
    .select('id, owner_id, name, filters, is_shared')
    .order('name' as never);
  if (error) {
    if (/relation .* does not exist|schema cache/i.test(error.message)) return [];
    throw toError(error);
  }
  return (data ?? []) as unknown as AlumniSavedFilter[];
}

export async function saveAlumniFilter(name: string, filters: AlumniFilters, sort: AlumniSort, shared: boolean) {
  const { error } = await supabase
    .from('alumni_saved_filters' as never)
    .insert({ name: name.trim().slice(0, 40), filters: { filters, sort }, is_shared: shared } as never);
  if (error) throw toError(error);
}

export async function deleteAlumniFilter(id: string) {
  const { error } = await supabase
    .from('alumni_saved_filters' as never)
    .delete()
    .eq('id' as never, id as never);
  if (error) throw toError(error);
}

// ---------------------------------------------------------------------
// 🏠 Home: alumni to contact today, birthdays
// ---------------------------------------------------------------------
export type AlumniToday = {
  due: number;
  list: {
    id: string;
    name: string;
    phone: string | null;
    next_contact_at: string;
    next_contact_note: string | null;
    batch_name: string | null;
    late: boolean;
    /** ⛔ do not contact: no 📞 button */
    do_not_contact?: boolean;
  }[];
  birthdays: { id: string; name: string; phone: string | null }[];
};

/** null: no alumni for this person (or an older database) */
export async function alumniToday(limit = 5): Promise<AlumniToday | null> {
  const { data, error } = await rpc<AlumniToday>('alumni_today', { p_limit: limit });
  if (error) {
    if (/could not find the function/i.test(error.message)) return null;
    throw toError(error);
  }
  return data ?? null;
}

// ---------------------------------------------------------------------
// 🔎 "Matched in …" (what the search found, when it's not the name)
// ---------------------------------------------------------------------
export function alumniMatchLine(a: Alumnus, search: string): string | null {
  const q = search.trim().toLowerCase();
  if (!q || a.name.toLowerCase().includes(q)) return null;
  const digits = q.replace(/\D/g, '');
  const checks: [string, string | null | undefined][] = [
    ['Phone', a.phone],
    ['WhatsApp', a.whatsapp_number],
    ['Workplace', a.workplace],
    ['Designation', a.designation],
    ['District', a.district],
    ['Upazila', a.upazila],
    ['Student ID', a.student_ref],
    ['Code', a.ref_code],
    ['Email', a.email],
    ['Session', a.session],
    ['Address', a.address],
  ];
  for (const [label, v] of checks) {
    if (!v) continue;
    const low = v.toLowerCase();
    if (low.includes(q) || (digits.length >= 3 && low.replace(/\D/g, '').includes(digits))) return `${label}: ${v}`;
  }
  const tag = a.tags.find((t) => t.toLowerCase().includes(q));
  if (tag) return `Tag: ${tag}`;
  for (const [k, v] of Object.entries(a.custom ?? {})) {
    if (v != null && String(v).toLowerCase().includes(q)) return `${k.replace(/_/g, ' ')}: ${String(v)}`;
  }
  return null;
}

// ---------------------------------------------------------------------
// 🔗 Public links (website, no sign-in)
// ---------------------------------------------------------------------
export const PUBLIC_SITE = 'https://lead.ittc.edu.bd';
export const referLink = (code: string) => `${PUBLIC_SITE}/refer/${code}`;
export const applyLink = () => `${PUBLIC_SITE}/apply`;

export type PublicForms = { refer: boolean; apply: boolean };

export async function getPublicForms(): Promise<PublicForms> {
  const v = await getSetting<Partial<PublicForms>>('public_forms').catch(() => null);
  return { refer: v?.refer !== false, apply: v?.apply !== false };
}

export async function savePublicForms(v: PublicForms): Promise<void> {
  await updateSetting('public_forms', v as unknown as Json);
}

/** ✍️ An alumnus's own link to update their details (the office approves) */
export const updateLink = (token: string) => `${PUBLIC_SITE}/update/${token}`;

// ---------------------------------------------------------------------
// ✉️ A message with the alumnus's details filled in
//   {name} {first_name} {batch} {course} {refer_link} {ref_code} {update_link}
//   (+ for thanks: {student})
// ---------------------------------------------------------------------
export const MESSAGE_VARS = [
  '{first_name}',
  '{name}',
  '{batch}',
  '{course}',
  '{refer_link}',
  '{ref_code}',
  '{update_link}',
];

export function fillAlumniMessage(
  text: string,
  a: Pick<Alumnus, 'name' | 'ref_code' | 'batch_name' | 'course_name'> & { update_token?: string | null },
  extra: Record<string, string> = {},
): string {
  const vars: Record<string, string> = {
    name: a.name,
    first_name: a.name.trim().split(/\s+/)[0] ?? a.name,
    batch: a.batch_name ?? '',
    course: a.course_name ?? '',
    refer_link: a.ref_code ? referLink(a.ref_code) : '',
    ref_code: a.ref_code ?? '',
    update_link: a.update_token ? updateLink(a.update_token) : '',
    ...extra,
  };
  return text.replace(/\{(\w+)\}/g, (m, k: string) => (k in vars ? vars[k] : m));
}

// ---------------------------------------------------------------------
// 🏆 Top referrers
// ---------------------------------------------------------------------
export type TopPeriod = 'month' | 'year' | 'all';
export type TopReferrer = {
  id: string;
  name: string;
  batch_name: string | null;
  workplace: string | null;
  referrals: number;
  leads: number;
  admitted: number;
  opens: number;
};

export async function alumniTop(period: TopPeriod, limit = 30): Promise<TopReferrer[]> {
  const { data, error } = await rpc<TopReferrer[]>('alumni_top', { p_period: period, p_limit: limit });
  if (error) throw toError(error);
  return data ?? [];
}

// ---------------------------------------------------------------------
// 📣 Campaigns: one message to many, sent one by one on WhatsApp
// ---------------------------------------------------------------------
export type AlumniCampaign = {
  id: string;
  name: string;
  message: string;
  created_at: string;
  closed_at: string | null;
  by_name: string | null;
  total: number;
  sent: number;
  skipped: number;
  referrals: number;
  admitted: number;
};

export type CampaignItem = {
  alumni_id: string;
  sent_at: string | null;
  skipped: boolean;
  alumni: Pick<Alumnus, 'id' | 'name' | 'phone' | 'whatsapp_number' | 'ref_code' | 'update_token'> & {
    course: { name: string } | null;
    batch: { name: string } | null;
  };
};

export async function createAlumniCampaign(name: string, message: string, ids: string[]): Promise<string> {
  const { data, error } = await rpc<string>('create_alumni_campaign', { p_name: name, p_message: message, p_ids: ids });
  if (error) throw toError(error);
  return data as string;
}

export async function markAlumniCampaign(campaignId: string, alumniId: string, sent: boolean): Promise<void> {
  const { error } = await rpc('mark_alumni_campaign', { p_campaign: campaignId, p_alumni: alumniId, p_sent: sent });
  if (error) throw toError(error);
}

export async function listAlumniCampaigns(id?: string): Promise<AlumniCampaign[]> {
  const { data, error } = await rpc<AlumniCampaign[]>('alumni_campaign_list', { p_id: id ?? null });
  if (error) throw toError(error);
  return data ?? [];
}

export async function getCampaignItems(campaignId: string): Promise<CampaignItem[]> {
  const { data, error } = await supabase
    .from('alumni_campaign_items' as never)
    .select(
      'alumni_id, sent_at, skipped, alumni:alumni!inner(id, name, phone, whatsapp_number, ref_code, update_token, ' +
        'course:courses(name), batch:batches(name))',
    )
    .eq('campaign_id' as never, campaignId as never)
    .order('alumni_id' as never)
    .limit(2000);
  if (error) throw toError(error);
  const rows = (data ?? []) as unknown as CampaignItem[];
  return rows.sort((x, y) => x.alumni.name.localeCompare(y.alumni.name));
}

// ---------------------------------------------------------------------
// 🙏 Say thanks (a referral was admitted)
// ---------------------------------------------------------------------
export type ThanksDue = { lead_id: string; name: string; admitted_at: string; course: string | null };

export async function alumniThanksDue(alumniId: string): Promise<ThanksDue[]> {
  const { data, error } = await rpc<ThanksDue[]>('alumni_thanks_due', { p_alumni: alumniId });
  if (error) throw toError(error);
  return data ?? [];
}

export async function markAlumniThanked(alumniId: string, leadId: string): Promise<void> {
  const { error } = await rpc('mark_alumni_thanked', { p_alumni: alumniId, p_lead: leadId });
  if (error) throw toError(error);
}

// ---------------------------------------------------------------------
// 🏫 Schools (workplaces)
// ---------------------------------------------------------------------
export type AlumniSchool = {
  key: string;
  name: string;
  district: string | null;
  alumni: number;
  referrals: number;
  leads: number;
  admitted: number;
};

export async function alumniSchools(search?: string): Promise<AlumniSchool[]> {
  const { data, error } = await rpc<AlumniSchool[]>('alumni_schools', { p_search: search?.trim() || null });
  if (error) throw toError(error);
  return data ?? [];
}

export type SchoolAlumni = {
  /** the school's key (the alumni list filter) */
  key: string;
  count: number;
  list: { id: string; name: string; designation: string | null; referrals: number }[];
};

/** The lead page: alumni who work at the lead's workplace (null: none, or no access) */
export async function schoolAlumni(workplace: string): Promise<SchoolAlumni | null> {
  const { data, error } = await rpc<SchoolAlumni>('school_alumni', { p_workplace: workplace });
  if (error) return null;
  return data && data.count > 0 ? data : null;
}

// ---------------------------------------------------------------------
// 📊 Dashboard
// ---------------------------------------------------------------------
export type AlumniDashboard = {
  alumni: number;
  with_workplace: number;
  contacted_90: number;
  never_contacted: number;
  referrers: number;
  funnel: { opens: number; referrals: number; leads: number; admitted: number };
  months: { month: string; opens: number; referrals: number; admitted: number }[];
  districts: { name: string; alumni: number; referrals: number; admitted: number }[];
  rewards_due: number | null;
  rewards_paid: number | null;
  campaigns: number;
  updates_waiting: number | null;
};

export async function alumniDashboard(): Promise<AlumniDashboard | null> {
  const { data, error } = await rpc<AlumniDashboard>('alumni_dashboard', {});
  if (error) throw toError(error);
  return data;
}

// ---------------------------------------------------------------------
// ✍️ Their own updates (the office approves)
// ---------------------------------------------------------------------
export type AlumniUpdateRequest = {
  id: string;
  alumni_id: string;
  data: Record<string, string>;
  status: 'pending' | 'approved' | 'rejected';
  created_at: string;
  alumni: Pick<
    Alumnus,
    | 'id'
    | 'name'
    | 'phone'
    | 'whatsapp_number'
    | 'email'
    | 'workplace'
    | 'designation'
    | 'district'
    | 'upazila'
    | 'address'
  > | null;
};

export const UPDATE_FIELD_LABEL: Record<string, string> = {
  phone: 'Phone',
  whatsapp_number: 'WhatsApp',
  email: 'Email',
  workplace: 'Workplace',
  designation: 'Designation',
  district: 'District',
  upazila: 'Upazila',
  address: 'Address',
};

export async function listAlumniUpdates(): Promise<AlumniUpdateRequest[]> {
  const { data, error } = await supabase
    .from('alumni_update_requests' as never)
    .select(
      'id, alumni_id, data, status, created_at, ' +
        'alumni:alumni(id, name, phone, whatsapp_number, email, workplace, designation, district, upazila, address)',
    )
    .eq('status' as never, 'pending' as never)
    .order('created_at' as never, { ascending: false })
    .limit(200);
  if (error) throw toError(error);
  return (data ?? []) as unknown as AlumniUpdateRequest[];
}

export async function handleAlumniUpdate(id: string, approve: boolean, note?: string): Promise<void> {
  const { error } = await rpc('handle_alumni_update', { p_request: id, p_approve: approve, p_note: note ?? null });
  if (error) throw toError(error);
}

/** A new link (the old one stops working) */
export async function newAlumniUpdateLink(alumniId: string): Promise<string> {
  const { data, error } = await rpc<string>('new_alumni_update_link', { p_alumni: alumniId });
  if (error) throw toError(error);
  return data as string;
}

// ---------------------------------------------------------------------
// 👥 Duplicates, merge
// ---------------------------------------------------------------------
export type DuplicateAlumnus = {
  id: string;
  name: string;
  phone: string | null;
  whatsapp: string | null;
  batch: string | null;
  passing_year: number | null;
  workplace: string | null;
  referrals: number;
  created_at: string;
};

export async function alumniDuplicates(): Promise<DuplicateAlumnus[][]> {
  const { data, error } = await rpc<DuplicateAlumnus[][]>('alumni_duplicates', {});
  if (error) throw toError(error);
  return data ?? [];
}

export async function mergeAlumni(keepId: string, otherIds: string[]): Promise<void> {
  const { error } = await rpc('alumni_merge', { p_keep: keepId, p_others: otherIds });
  if (error) throw toError(error);
}

// ---------------------------------------------------------------------
// 🎙 Voice notes (the file behind a "🎙 Voice note" history line)
// ---------------------------------------------------------------------
export type AlumniFile = { id: string; name: string; duration_sec: number | null; mime_type: string | null };

export async function getAlumniFile(id: string): Promise<AlumniFile | null> {
  const { data, error } = await supabase
    .from('alumni_files' as never)
    .select('id, name, duration_sec, mime_type')
    .eq('id' as never, id as never)
    .maybeSingle();
  if (error) throw toError(error);
  return (data as unknown as AlumniFile) ?? null;
}

// ---------------------------------------------------------------------
// ✨ AI: a WhatsApp message for one alumnus (Edge Function ai-alumni)
// ---------------------------------------------------------------------
export type AiPurpose = 'refer' | 'birthday' | 'thanks' | 'reconnect' | 'campaign';

export const AI_PURPOSE_LABEL: Record<AiPurpose, string> = {
  refer: 'Ask for referrals',
  reconnect: 'Catch up',
  birthday: 'Birthday wish',
  thanks: 'Say thanks',
  campaign: 'Campaign (for everyone)',
};

/** The message in Bangla; for a campaign (no alumnus) it keeps {first_name}, {refer_link} … */
export async function aiAlumniMessage(input: {
  alumniId?: string | null;
  purpose: AiPurpose;
  hint?: string;
}): Promise<string> {
  const { data, error } = await supabase.functions.invoke('ai-alumni', {
    body: { alumni_id: input.alumniId ?? null, purpose: input.purpose, hint: input.hint ?? '' },
  });
  if (error) {
    let msg = error.message;
    try {
      const body = await (error as { context?: Response }).context?.json();
      if (body?.error) msg = body.error;
    } catch {
      // keep the first message
    }
    throw new Error(/not found|404/i.test(msg) ? 'AI for alumni is not set up on the server yet.' : msg);
  }
  const text = (data as { message?: string } | null)?.message?.trim();
  if (!text) throw new Error('The AI gave no message. Try again.');
  return text;
}

// ---------------------------------------------------------------------
// 📤 Excel: the list as it is filtered (or the marked ones), your own fields too
// ---------------------------------------------------------------------
export async function exportAlumni(q: AlumniQuery, ids?: string[] | null): Promise<number> {
  const rows: Alumnus[] = [];
  if (ids?.length) {
    // the marked ones, 200 at a time (a long list of ids would make the address too long)
    const list = ids.slice(0, 5000);
    for (let i = 0; i < list.length; i += 200) {
      const { data, error } = await supabase
        .from('alumni_overview' as never)
        .select('*')
        .in('id' as never, list.slice(i, i + 200) as never);
      if (error) throw toError(error);
      rows.push(...((data ?? []) as unknown as Alumnus[]));
    }
    rows.sort((x, y) => x.name.localeCompare(y.name));
  } else {
    const PAGE = 1000;
    for (let from = 0; from < 5000; from += PAGE) {
      const { data, error } = await alumniFilters(supabase.from('alumni_overview' as never).select('*'), q)
        .order('name' as never)
        .order('id' as never)
        .range(from, from + PAGE - 1);
      if (error) throw toError(error);
      const got = (data ?? []) as unknown as Alumnus[];
      rows.push(...got);
      if (got.length < PAGE) break;
    }
  }
  if (rows.length === 0) throw new Error('Nobody to export.');
  const fields = await listAlumniFields().catch(() => [] as AlumniField[]);
  const headers = [
    'Name',
    'Phone',
    'WhatsApp',
    'Email',
    'Course',
    'Batch',
    'Session',
    'Passing year',
    'Student ID',
    'Workplace',
    'Designation',
    'District',
    'Upazila',
    'Address',
    'Birthday',
    'Tags',
    'Looked after by',
    'Referrals',
    'Referred leads',
    'Admitted',
    'Link opens',
    'Refer score',
    'Last contact',
    'Next contact',
    'Last note',
    'Do not contact',
    'Referral code',
    'Notes',
    ...fields.map((f) => f.label),
  ];
  const d = (v: string | null | undefined) => (v ? new Date(v).toLocaleDateString('en-GB') : '');
  const body = rows.map((a) => [
    a.name,
    a.phone,
    a.whatsapp_number,
    a.email,
    a.course_name,
    a.batch_name,
    a.session,
    a.passing_year,
    a.student_ref,
    a.workplace,
    a.designation,
    a.district,
    a.upazila,
    a.address,
    d(a.birth_date),
    (a.tags ?? []).join(', '),
    a.owner_name,
    a.referrals,
    a.referred_leads,
    a.referred_admitted,
    a.cnt_opens ?? 0,
    a.refer_score ?? null,
    d(a.last_contacted_at),
    d(a.next_contact_at),
    a.last_note ?? '',
    a.do_not_contact ? 'Yes' : '',
    a.ref_code,
    a.notes,
    ...fields.map((f) => customText(a.custom?.[f.key], f.type)),
  ]);
  // the spreadsheet code is loaded only when exporting
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { writeAndShareSpreadsheet } =
    require('@/features/import-export/excel') as typeof import('@/features/import-export/excel');
  const day = new Date().toISOString().slice(0, 10);
  await writeAndShareSpreadsheet(`Alumni ${day}.xlsx`, headers, body, 'Alumni');
  return rows.length;
}
