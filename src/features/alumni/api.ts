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
  rewards: { enabled: boolean; default_amount: number; by_course: Record<string, number> };
};

export const DEFAULT_ALUMNI_SETTINGS: AlumniSettings = {
  view: { all: false, roles: ['admin', 'team_lead'], user_ids: [] },
  manage: { all: false, roles: ['admin'], user_ids: [] },
  rewards: { enabled: false, default_amount: 0, by_course: {} },
};

export async function getAlumniSettings(): Promise<AlumniSettings> {
  const saved = await getSetting<Partial<AlumniSettings>>('alumni').catch(() => null);
  const d = DEFAULT_ALUMNI_SETTINGS;
  return {
    view: { ...d.view, ...(saved?.view ?? {}) },
    manage: { ...d.manage, ...(saved?.manage ?? {}) },
    rewards: { ...d.rewards, ...(saved?.rewards ?? {}), by_course: { ...(saved?.rewards?.by_course ?? {}) } },
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
  // from alumni_overview
  course_name: string | null;
  batch_name: string | null;
  owner_name: string | null;
  referrals: number;
  referrals_waiting: number;
  referred_leads: number;
  referred_admitted: number;
};

export type AlumniSort = 'name' | 'newest' | 'referrals' | 'admitted' | 'quiet';
export type AlumniQuery = {
  search?: string;
  courseId?: string | null;
  batchId?: string | null;
  district?: string | null;
  only?: 'referred' | 'never_contacted' | 'do_not_contact' | 'no_course' | null;
  sort?: AlumniSort;
  page?: number;
};

export const ALUMNI_PAGE = 50;

// The search and filters (the list, and "select all that match")
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function alumniFilters<Q extends { or: any; eq: any; ilike: any; gt: any; is: any }>(query: Q, q: AlumniQuery): Q {
  const s = (q.search ?? '').trim();
  if (s) {
    const digits = s.replace(/\D/g, '');
    const safe = s.replace(/[%,()]/g, ' ');
    const parts = [
      `name.ilike.%${safe}%`,
      `workplace.ilike.%${safe}%`,
      `student_ref.ilike.%${safe}%`,
      `ref_code.ilike.%${safe}%`,
    ];
    if (digits.length >= 4) parts.push(`phone.ilike.%${digits.slice(-10)}%`);
    query = query.or(parts.join(','));
  }
  if (q.courseId) query = query.eq('course_id' as never, q.courseId as never);
  if (q.batchId) query = query.eq('batch_id' as never, q.batchId as never);
  if (q.district) query = query.ilike('district' as never, q.district as never);
  if (q.only === 'referred') query = query.gt('referrals' as never, 0 as never);
  if (q.only === 'never_contacted') query = query.is('last_contacted_at' as never, null as never);
  if (q.only === 'do_not_contact') query = query.eq('do_not_contact' as never, true as never);
  if (q.only === 'no_course') query = query.is('course_id' as never, null as never);
  return query;
}

export async function listAlumni(q: AlumniQuery = {}): Promise<{ rows: Alumnus[]; total: number }> {
  let query = alumniFilters(supabase.from('alumni_overview' as never).select('*', { count: 'exact' }), q);
  switch (q.sort ?? 'name') {
    case 'newest':
      query = query.order('created_at' as never, { ascending: false });
      break;
    case 'referrals':
      query = query.order('referrals' as never, { ascending: false }).order('name' as never);
      break;
    case 'admitted':
      query = query
        .order('referred_admitted' as never, { ascending: false })
        .order('referrals' as never, { ascending: false });
      break;
    case 'quiet':
      query = query.order('last_contacted_at' as never, { ascending: true, nullsFirst: true });
      break;
    default:
      query = query.order('name' as never);
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
};

export async function saveAlumnus(id: string | null, row: AlumnusInput): Promise<string> {
  const { data, error } = await rpc<string>('save_alumni', { p_id: id, p_row: row });
  if (error) throw toError(error);
  return data as string;
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
  | 'restored';

export type AlumniEvent = {
  id: string;
  kind: AlumniEventKind;
  body: string | null;
  data: Record<string, Json>;
  created_at: string;
  by: { full_name: string | null } | null;
};

export async function listAlumniEvents(alumniId: string): Promise<AlumniEvent[]> {
  const { data, error } = await supabase
    .from('alumni_events' as never)
    .select('id, kind, body, data, created_at, by:profiles!alumni_events_by_user_fkey(full_name)')
    .eq('alumni_id' as never, alumniId as never)
    .order('created_at' as never, { ascending: false })
    .limit(200);
  if (error) throw toError(error);
  return (data ?? []) as unknown as AlumniEvent[];
}

export async function addAlumniEvent(alumniId: string, kind: 'note' | 'call' | 'whatsapp' | 'message', body?: string) {
  const { error } = await rpc('add_alumni_event', { p_alumni: alumniId, p_kind: kind, p_body: body ?? null });
  if (error) throw toError(error);
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
  | { action: 'delete' };

export async function alumniBulk(ids: string[], a: AlumniBulkAction): Promise<number> {
  const { data, error } = await rpc<number>('alumni_bulk', {
    p_ids: ids,
    p_action: a.action,
    p_course_id: a.action === 'course' ? a.courseId : null,
    p_batch_id: a.action === 'course' ? (a.batchId ?? null) : null,
  });
  if (error) throw toError(error);
  return Number(data ?? 0);
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
