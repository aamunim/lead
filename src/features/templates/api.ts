import type { MyProfile } from '@/features/auth/api';
import type { WhoRule } from '@/features/pipeline/api';
import { getSetting, updateSetting } from '@/features/settings/api';
import { supabase } from '@/shared/lib/supabase';
import type { Json } from '@/shared/types/database';

// =====================================================================
// 💬 WhatsApp / SMS message templates
//   Settings → Message templates: the feature on/off, who may use it,
//   what the WhatsApp / SMS button does, the institute's details.
//   Templates: shared (admins) and personal (anyone, their own).
// =====================================================================

export type TemplateChannel = 'whatsapp' | 'sms';

export type TemplateSettings = {
  enabled: boolean;
  who: WhoRule;
  /** 'sheet' = tapping WhatsApp / SMS opens the templates; 'long_press' = only a long press does */
  tap: 'sheet' | 'long_press';
  institute: { name: string; address: string; map_link: string; phone: string };
};

export const DEFAULT_TEMPLATE_SETTINGS: TemplateSettings = {
  enabled: true,
  who: { mode: 'all', roles: [], user_ids: [] },
  tap: 'sheet',
  institute: { name: '', address: '', map_link: '', phone: '' },
};

export type MessageTemplate = {
  id: string;
  name: string;
  body: string;
  channels: 'whatsapp' | 'sms' | 'both';
  category: string | null;
  course_ids: string[] | null;
  is_shared: boolean;
  owner_id: string | null;
  sort_order: number;
  is_active: boolean;
  use_count: number;
  last_used_at: string | null;
};

export const CATEGORIES = ['Welcome', 'Fee', 'Visit', 'Admission', 'Papers', 'Follow-up', 'Other'];

function toError(error: { message: string }): Error {
  const m = error.message.toLowerCase();
  if (m.includes('network request failed') || m.includes('fetch')) {
    return new Error('No internet connection. Please try again.');
  }
  if (m.includes('row-level security')) return new Error('You can change only your own templates.');
  return new Error(error.message);
}

// ---------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------
export async function getTemplateSettings(): Promise<TemplateSettings> {
  try {
    const saved = await getSetting<Partial<TemplateSettings>>('message_templates');
    return {
      ...DEFAULT_TEMPLATE_SETTINGS,
      ...(saved ?? {}),
      who: { ...DEFAULT_TEMPLATE_SETTINGS.who, ...(saved?.who ?? {}) },
      institute: { ...DEFAULT_TEMPLATE_SETTINGS.institute, ...(saved?.institute ?? {}) },
    };
  } catch {
    return DEFAULT_TEMPLATE_SETTINGS;
  }
}

export async function saveTemplateSettings(s: TemplateSettings): Promise<void> {
  await updateSetting('message_templates', s as unknown as Json);
}

/** May this person use templates? (same rule as the database's can_use_templates) */
export function canUseTemplates(s: TemplateSettings, profile: MyProfile | null): boolean {
  if (!profile || !s.enabled) return false;
  if (s.who.mode === 'roles') return s.who.roles.includes(profile.role_key);
  if (s.who.mode === 'users') return s.who.user_ids.includes(profile.id);
  return true;
}

// ---------------------------------------------------------------------
// Templates
// ---------------------------------------------------------------------
export async function listTemplates(): Promise<MessageTemplate[]> {
  const { data, error } = await supabase
    .from('message_templates')
    .select('*')
    .order('sort_order')
    .order('name');
  if (error) throw toError(error);
  return (data ?? []) as unknown as MessageTemplate[];
}

export type TemplateInput = Pick<MessageTemplate, 'name' | 'body' | 'channels' | 'category' | 'course_ids' | 'is_shared' | 'is_active'>;

export async function saveTemplate(id: string | null, input: TemplateInput): Promise<void> {
  const row = {
    ...input,
    name: input.name.trim(),
    body: input.body.trim(),
    course_ids: input.course_ids && input.course_ids.length > 0 ? input.course_ids : null,
  };
  const { error } = id
    ? await supabase.from('message_templates').update(row).eq('id', id)
    : await supabase.from('message_templates').insert(row);
  if (error) throw toError(error);
}

export async function deleteTemplate(id: string): Promise<void> {
  const { error } = await supabase.from('message_templates').delete().eq('id', id);
  if (error) throw toError(error);
}

/** "💬 WhatsApp message sent · Template: Fee list" on the lead */
export async function logTemplateSent(
  leadId: string,
  templateId: string,
  channel: TemplateChannel,
  edited: boolean,
): Promise<void> {
  const { error } = await supabase.rpc('log_template_sent', {
    p_lead_id: leadId,
    p_template_id: templateId,
    p_channel: channel,
    p_edited: edited,
  });
  if (error) throw toError(error);
}

// ---------------------------------------------------------------------
// Filling in {name}, {course} …
// ---------------------------------------------------------------------
export const VARIABLES: { key: string; label: string }[] = [
  { key: 'name', label: 'Lead name' },
  { key: 'first_name', label: 'First name' },
  { key: 'course', label: 'Course' },
  { key: 'batch', label: 'Batch' },
  { key: 'batch_start', label: 'Batch start' },
  { key: 'fee', label: 'Fee list' },
  { key: 'visit_time', label: 'Visit time' },
  { key: 'next_call', label: 'Next call' },
  { key: 'papers_missing', label: 'Papers missing' },
  { key: 'student_id', label: 'Student ID' },
  { key: 'my_name', label: 'My name' },
  { key: 'my_phone', label: 'My phone' },
  { key: 'institute', label: 'Institute' },
  { key: 'address', label: 'Address' },
  { key: 'map_link', label: 'Map link' },
  { key: 'office_phone', label: 'Office phone' },
  { key: 'today', label: 'Today' },
];

export type TemplateContext = Record<string, string>;

/** {name} → the value; returns the text and the variables that had no value */
export function fillTemplate(body: string, ctx: TemplateContext): { text: string; missing: string[] } {
  const missing = new Set<string>();
  const text = body.replace(/\{([a-z_]+)\}/g, (all, key: string) => {
    if (!(key in ctx) && !VARIABLES.some((v) => v.key === key)) return all; // not ours: keep as typed
    const v = ctx[key]?.trim();
    if (!v) {
      missing.add(key);
      return '';
    }
    return v;
  });
  return { text: text.replace(/\n{3,}/g, '\n\n').trim(), missing: [...missing] };
}

const dateText = (iso: string | null | undefined, withTime = false) => {
  if (!iso) return '';
  const d = new Date(iso);
  const day = d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });
  return withTime ? `${day}, ${d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}` : day;
};

const money = (n: number) => `৳${Math.round(n).toLocaleString('en-IN')}`;

/** Everything a template may need about this lead, the sender and the institute */
export async function loadTemplateContext(
  leadId: string,
  me: { full_name: string | null; phone?: string | null } | null,
  settings: TemplateSettings,
): Promise<{ ctx: TemplateContext; courseIds: string[] }> {
  const { data: lead } = await supabase
    .from('leads')
    .select(
      'name, student_ref, next_follow_up_at, visit_at, visit_status, admitted_course_id, admitted_batch_id, lead_courses(course_id)',
    )
    .eq('id', leadId)
    .maybeSingle();

  const l = lead as unknown as {
    name: string;
    student_ref: string | null;
    next_follow_up_at: string | null;
    visit_at: string | null;
    visit_status: string | null;
    admitted_course_id: string | null;
    admitted_batch_id: string | null;
    lead_courses: { course_id: string }[];
  } | null;

  const courseIds = [
    ...(l?.admitted_course_id ? [l.admitted_course_id] : []),
    ...(l?.lead_courses ?? []).map((c) => c.course_id),
  ].filter((v, i, a) => a.indexOf(v) === i);
  const courseId = courseIds[0] ?? null;

  const [course, batch, papers] = await Promise.all([
    courseId
      ? supabase.from('courses').select('name, course_fees(name, amount, sort_order)').eq('id', courseId).maybeSingle()
      : Promise.resolve({ data: null }),
    l?.admitted_batch_id
      ? supabase.from('batches').select('name, start_date').eq('id', l.admitted_batch_id).maybeSingle()
      : Promise.resolve({ data: null }),
    supabase.rpc('lead_missing_papers', { p_lead_id: leadId }),
  ]);

  const c = course.data as unknown as { name: string; course_fees: { name: string; amount: number; sort_order: number }[] } | null;
  const fees = (c?.course_fees ?? []).slice().sort((a, b) => a.sort_order - b.sort_order);
  const b = batch.data as unknown as { name: string; start_date: string | null } | null;
  const missing = ((papers.data ?? []) as { name: string }[]).map((p) => `• ${p.name}`);

  const ctx: TemplateContext = {
    name: l?.name ?? '',
    first_name: (l?.name ?? '').trim().split(/\s+/)[0] ?? '',
    course: c?.name ?? '',
    batch: b?.name ?? '',
    batch_start: dateText(b?.start_date),
    fee: fees.length > 0
      ? [...fees.map((f) => `• ${f.name}: ${money(Number(f.amount))}`),
        ...(fees.length > 1 ? [`মোট: ${money(fees.reduce((t, f) => t + Number(f.amount), 0))}`] : [])].join('\n')
      : '',
    visit_time: l?.visit_status === 'planned' ? dateText(l.visit_at, true) : '',
    next_call: dateText(l?.next_follow_up_at, true),
    papers_missing: missing.join('\n'),
    student_id: l?.student_ref ?? '',
    my_name: me?.full_name ?? '',
    my_phone: me?.phone ?? '',
    institute: settings.institute.name,
    address: settings.institute.address,
    map_link: settings.institute.map_link,
    office_phone: settings.institute.phone,
    today: dateText(new Date().toISOString()),
  };
  return { ctx, courseIds };
}
