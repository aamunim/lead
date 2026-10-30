import { supabase } from '@/shared/lib/supabase';
import type { Json, Tables } from '@/shared/types/database';

import {
  applyLeadFilters,
  filterSelect,
  needsClosedLeads,
  type LeadFilters,
} from '@/features/leads/filters';

// =====================================================================
// Phone helpers (same rules as the database)
// =====================================================================
export function normalizePhone(input: string): string {
  let d = input.replace(/\D/g, '');
  if (d.length === 13 && d.startsWith('880')) d = '0' + d.slice(3);
  else if (d.length === 10 && d.startsWith('1')) d = '0' + d;
  return d;
}

/** Bangladeshi mobile number, e.g. 01711234567 */
export function isValidBdMobile(input: string): boolean {
  return /^01[3-9]\d{8}$/.test(normalizePhone(input));
}

// =====================================================================
// Types
// =====================================================================
type Stage = Pick<Tables<'pipeline_stages'>, 'id' | 'key' | 'name' | 'color' | 'kind'>;
type Person = Pick<Tables<'profiles'>, 'id' | 'full_name'>;
type Named = { id: string; name: string };

export type Rating = 'hot' | 'warm' | 'cold';

export type LeadListItem = Pick<
  Tables<'leads'>,
  | 'id'
  | 'name'
  | 'phone'
  | 'whatsapp_number'
  | 'whatsapp_username'
  | 'rating'
  | 'next_follow_up_at'
  | 'last_contacted_at'
  | 'created_at'
  | 'assigned_to'
  | 'stage_id'
  | 'closed_at'
  | 'student_ref'
  // Papers (counts kept up to date by the database)
  | 'papers_required'
  | 'papers_received'
  | 'papers_missing'
  | 'papers_originals_held'
  | 'papers_kept_at'
  // Campus visit (kept up to date by the database)
  | 'visit_status'
  | 'visit_at'
  // Fee & discount (kept up to date by the database)
  | 'fee_status'
  | 'fee_full'
  | 'fee_discount'
  | 'fee_final'
> & {
  stage: Stage | null;
  source: Named | null;
  assignee: Person | null;
  lead_courses: { course: Named | null }[];
  lead_tags: { tag_id: string }[];
};

export type LeadDetail = Tables<'leads'> & {
  stage: Stage | null;
  source: Named | null;
  campaign: Named | null;
  lead_type: Named | null;
  lost_reason: Named | null;
  assignee: Person | null;
  lead_courses: { course: Named | null }[];
  lead_tags: { tag: (Named & { color: string }) | null }[];
};

export type LeadInput = {
  name: string;
  /** At least one of phone, whatsapp_number, whatsapp_username */
  phone?: string | null;
  whatsapp_number?: string | null;
  whatsapp_username?: string | null;
  alt_phone?: string | null;
  email?: string | null;
  area?: string | null;
  guardian_name?: string | null;
  guardian_phone?: string | null;
  guardian_relation?: string | null;
  lead_type_id?: string | null;
  source_id?: string | null;
  campaign_id?: string | null;
  referred_by?: string | null;
  stage_id?: string | null;
  rating?: Rating | null;
  assigned_to?: string | null;
  notes?: string | null;
  custom_fields?: Json;
  course_ids?: string[];
  tag_ids?: string[];
};

/** Fields that can be changed from the list, for one or many leads */
export type QuickPatch = {
  rating?: Rating | null;
  stage_id?: string;
  assigned_to?: string | null;
};

export type QuickFilter = 'all' | 'mine' | 'new' | 'hot' | 'unassigned' | 'closed';

/**
 * Closed leads (Admitted / Lost / Cancelled) in the list:
 *   hide = only open leads (unless a filter is about closed leads:
 *          a stage, the admitted date or a lost reason)
 *   show = everything
 * The "Closed" quick filter always shows only closed leads.
 */
export type ClosedMode = 'hide' | 'show';

/** How the list is ordered (chosen on the list, remembered on the phone) */
export type LeadSort =
  | 'next_call'
  | 'newest'
  | 'oldest'
  | 'name'
  | 'not_contacted_longest'
  | 'recently_contacted'
  | 'visit_date'
  | 'papers_missing'
  | 'discount_most'
  | 'fee_latest';

export const DEFAULT_SORT: LeadSort = 'next_call';

export const SORT_OPTIONS: { value: LeadSort; label: string; text: string; icon: string }[] = [
  { value: 'next_call', label: 'Next call', text: 'Soonest call first', icon: '⏰' },
  { value: 'newest', label: 'Newest first', text: 'Last added first', icon: '🆕' },
  { value: 'oldest', label: 'Oldest first', text: 'First added first', icon: '📜' },
  { value: 'name', label: 'Name A–Z', text: 'By name', icon: '🔤' },
  { value: 'not_contacted_longest', label: 'Not contacted longest', text: 'Never called first, then the longest wait', icon: '📞' },
  { value: 'recently_contacted', label: 'Recently contacted', text: 'Last talked to first', icon: '🕐' },
  { value: 'visit_date', label: 'Campus visit date', text: 'Earliest visit first, no visit last', icon: '🏫' },
  { value: 'papers_missing', label: 'Most papers missing', text: 'Most required papers still to collect first', icon: '📄' },
  { value: 'discount_most', label: 'Biggest discount', text: 'Largest discount first, no discount last', icon: '💰' },
  { value: 'fee_latest', label: 'Fee talk: latest', text: 'Last fee talk or discount change first', icon: '💬' },
];

/** Everything the list can be narrowed by */
export type LeadQuery = {
  search?: string;
  quick?: QuickFilter;
  stageId?: string | null;
  /** Only these leads (opened from a notification about many leads) */
  ids?: string[] | null;
  userId?: string;       // the signed-in user, for "mine"
  filters?: LeadFilters;
  closedMode?: ClosedMode;
  sort?: LeadSort;
};

export type DuplicateLead = {
  id: string;
  name: string;
  /** Phone, else WhatsApp number, else @username */
  phone: string;
  stage_name: string;
  assigned_to_name: string | null;
  can_open: boolean;
  matched?: 'phone' | 'whatsapp_number' | 'whatsapp_username';
};

export type ActivityItem = Tables<'lead_activity'> & { user_name: string | null };

export type AssignableUser = Person & { role_key: string; is_active: boolean; team_lead_id: string | null };

// =====================================================================
// Errors
// =====================================================================
function toError(error: { message: string }): Error {
  const m = error.message.toLowerCase();
  if (m.includes('network request failed') || m.includes('fetch')) {
    return new Error('No internet connection. Please try again.');
  }
  return new Error(error.message);
}

const LIST_SELECT = `
  id, name, phone, whatsapp_number, whatsapp_username, rating, next_follow_up_at, last_contacted_at, created_at, assigned_to, stage_id, closed_at, student_ref,
  papers_required, papers_received, papers_missing, papers_originals_held, papers_kept_at,
  visit_status, visit_at,
  fee_status, fee_full, fee_discount, fee_final,
  stage:pipeline_stages(id, key, name, color, kind),
  source:lead_sources(id, name),
  assignee:assigned_to(id, full_name),
  lead_courses(course:courses(id, name)),
  lead_tags(tag_id)
`;

const DETAIL_SELECT = `
  *,
  stage:pipeline_stages(id, key, name, color, kind),
  source:lead_sources(id, name),
  campaign:campaigns(id, name),
  lead_type:lead_types(id, name),
  lost_reason:lost_reasons(id, name),
  assignee:assigned_to(id, full_name),
  lead_courses(course:courses(id, name)),
  lead_tags(tag:tags(id, name, color))
`;

// =====================================================================
// List
// =====================================================================
export const PAGE_SIZE = 30;
/** Most leads that "Mark all matching" will take at once */
export const MAX_MARK_ALL = 2000;

/** Builds the leads query with search, quick filter and the full filters */
function buildLeadQuery(options: LeadQuery, withCount: boolean) {
  const {
    search = '',
    quick = 'all',
    stageId = null,
    userId,
    filters = {},
    closedMode = 'hide',
    sort = DEFAULT_SORT,
    ids = null,
  } = options;

  let query = supabase
    .from('leads')
    .select(LIST_SELECT + filterSelect(filters), withCount ? { count: 'exact' } : undefined)
    .is('deleted_at', null);

  // Search by name, phone, WhatsApp number or WhatsApp username
  const text = search.replace(/[%,()*"]/g, ' ').trim();
  if (text) {
    const digits = normalizePhone(text);
    const username = text.replace(/^@+/, '').toLowerCase();
    const parts = [`name.ilike.%${text}%`, `whatsapp_username.ilike.%${username}%`];
    if (digits.length >= 3) {
      parts.push(
        `phone.ilike.%${digits}%`,
        `alt_phone.ilike.%${digits}%`,
        `whatsapp_number.ilike.%${text.replace(/\D/g, '')}%`,
      );
    }
    query = query.or(parts.join(','));
  }

  // Quick filters
  if (quick === 'mine' && userId) query = query.eq('assigned_to', userId);
  if (quick === 'hot') query = query.eq('rating', 'hot');
  if (quick === 'unassigned') query = query.is('assigned_to', null);
  if (quick === 'new') query = query.is('last_contacted_at', null);

  // Closed leads (Admitted / Lost / Cancelled)
  if (ids && ids.length > 0) query = query.in('id', ids);

  const wantsClosed = !!stageId || needsClosedLeads(filters) || !!(ids && ids.length > 0);
  if (quick === 'closed') query = query.not('closed_at', 'is', null);
  else if (closedMode === 'hide' && !wantsClosed) query = query.is('closed_at', null);

  if (stageId) query = query.eq('stage_id', stageId);

  // Full filters
  query = applyLeadFilters(query, filters);

  return orderLeads(query, sort);
}

/**
 * The order for each sort. Every sort ends with the id, so leads with the same
 * value (e.g. the same name) never show twice or go missing between pages.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function orderLeads<Q extends { order: (...args: any[]) => Q }>(query: Q, sort: LeadSort): Q {
  let q = query;
  switch (sort) {
    case 'newest':
      q = q.order('created_at', { ascending: false });
      break;
    case 'oldest':
      q = q.order('created_at', { ascending: true });
      break;
    case 'name':
      q = q.order('name', { ascending: true }).order('created_at', { ascending: false });
      break;
    case 'not_contacted_longest':
      q = q.order('last_contacted_at', { ascending: true, nullsFirst: true }).order('created_at', { ascending: true });
      break;
    case 'recently_contacted':
      q = q.order('last_contacted_at', { ascending: false, nullsFirst: false }).order('created_at', { ascending: false });
      break;
    case 'visit_date':
      q = q.order('visit_at', { ascending: true, nullsFirst: false }).order('created_at', { ascending: false });
      break;
    case 'papers_missing':
      q = q.order('papers_missing', { ascending: false, nullsFirst: false }).order('created_at', { ascending: false });
      break;
    case 'discount_most':
      q = q.order('fee_discount', { ascending: false, nullsFirst: false }).order('created_at', { ascending: false });
      break;
    case 'fee_latest':
      q = q.order('fee_updated_at', { ascending: false, nullsFirst: false }).order('created_at', { ascending: false });
      break;
    default:
      q = q.order('next_follow_up_at', { ascending: true, nullsFirst: false }).order('created_at', { ascending: false });
  }
  return q.order('id', { ascending: true });
}

/** Strip the helper joins used only for filtering */
function cleanRows(data: unknown[] | null): LeadListItem[] {
  return (data ?? []).map((row) => {
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    const { tag_filter, course_filter, ...rest } = row as Record<string, unknown>;
    return rest as unknown as LeadListItem;
  });
}

/** One page of leads, plus how many match in total */
export async function listLeads(
  options: LeadQuery & { page?: number },
): Promise<{ items: LeadListItem[]; hasMore: boolean; total: number | null }> {
  const page = options.page ?? 0;

  const { data, error, count } = await buildLeadQuery(options, page === 0).range(
    page * PAGE_SIZE,
    page * PAGE_SIZE + PAGE_SIZE - 1,
  );
  if (error) throw toError(error);

  const items = cleanRows(data);
  return { items, hasMore: items.length === PAGE_SIZE, total: count ?? null };
}

/** Every lead that matches (up to MAX_MARK_ALL), for "Mark all matching" */
export async function listAllMatchingLeads(options: LeadQuery): Promise<LeadListItem[]> {
  const { data, error } = await buildLeadQuery(options, false).range(0, MAX_MARK_ALL - 1);
  if (error) throw toError(error);
  return cleanRows(data);
}

// =====================================================================
// One lead
// =====================================================================
export async function getLead(id: string): Promise<LeadDetail | null> {
  const { data, error } = await supabase
    .from('leads')
    .select(DETAIL_SELECT)
    .eq('id', id)
    .maybeSingle();

  if (error) throw toError(error);
  return data as unknown as LeadDetail | null;
}

// =====================================================================
// Create / update
// =====================================================================
function leadColumns(input: LeadInput) {
  const { course_ids, tag_ids, ...columns } = input;
  // Empty strings become null so the database stays clean
  const clean: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(columns)) {
    if (value === undefined) continue;
    clean[key] = typeof value === 'string' ? value.trim() || null : value;
  }
  return clean;
}

async function replaceLinks(leadId: string, courseIds?: string[], tagIds?: string[]) {
  if (courseIds) {
    const { error: delError } = await supabase.from('lead_courses').delete().eq('lead_id', leadId);
    if (delError) throw toError(delError);
    if (courseIds.length > 0) {
      const { error } = await supabase
        .from('lead_courses')
        .insert(courseIds.map((course_id) => ({ lead_id: leadId, course_id })));
      if (error) throw toError(error);
    }
  }

  if (tagIds) {
    const { error: delError } = await supabase.from('lead_tags').delete().eq('lead_id', leadId);
    if (delError) throw toError(delError);
    if (tagIds.length > 0) {
      const { error } = await supabase
        .from('lead_tags')
        .insert(tagIds.map((tag_id) => ({ lead_id: leadId, tag_id })));
      if (error) throw toError(error);
    }
  }
}

export async function createLead(input: LeadInput): Promise<string> {
  const { data, error } = await supabase
    .from('leads')
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    .insert(leadColumns(input) as any)
    .select('id')
    .single();

  if (error) throw toError(error);
  await replaceLinks(data.id, input.course_ids, input.tag_ids);
  return data.id;
}

export async function updateLead(id: string, input: LeadInput): Promise<void> {
  const { error } = await supabase
    .from('leads')
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    .update(leadColumns(input) as any)
    .eq('id', id);

  if (error) throw toError(error);
  await replaceLinks(id, input.course_ids, input.tag_ids);
}

export async function softDeleteLead(id: string): Promise<void> {
  const { error } = await supabase
    .from('leads')
    .update({ deleted_at: new Date().toISOString() })
    .eq('id', id);
  if (error) throw toError(error);
}

// =====================================================================
// Quick changes from the list (one lead or many)
//   Security rules still apply: leads the user cannot edit are skipped.
//   updateLeads returns how many leads were really changed.
// =====================================================================
const CHUNK = 200; // keep URLs short when many leads are marked

function chunks<T>(items: T[], size = CHUNK): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

/**
 * Change rating, stage and/or assigned person.
 * A stage change skips closed leads (Admitted / Lost / Cancelled):
 * those only move with Reopen / Cancel admission.
 */
export async function updateLeads(ids: string[], patch: QuickPatch): Promise<number> {
  if (ids.length === 0 || Object.keys(patch).length === 0) return 0;

  let changed = 0;
  for (const part of chunks(ids)) {
    let query = supabase.from('leads').update(patch).in('id', part);
    if (patch.stage_id) query = query.is('closed_at', null);
    const { data, error } = await query.select('id');
    if (error) throw toError(error);
    changed += data?.length ?? 0;
  }
  return changed;
}

/**
 * Add a note below each lead's existing notes (with today's date and the user's name).
 * Returns how many leads got it.
 */
export async function addNoteToLeads(ids: string[], note: string): Promise<number> {
  if (ids.length === 0) return 0;

  let changed = 0;
  for (const part of chunks(ids)) {
    const { data, error } = await supabase.rpc('add_lead_note', { p_lead_ids: part, p_note: note.trim() });
    if (error) throw toError(error);
    changed += data ?? 0;
  }
  return changed;
}

/** Add tags (leads that already have a tag keep it once) */
export async function addTagsToLeads(ids: string[], tagIds: string[]): Promise<void> {
  if (ids.length === 0 || tagIds.length === 0) return;

  for (const part of chunks(ids)) {
    const { data: existing, error: readError } = await supabase
      .from('lead_tags')
      .select('lead_id, tag_id')
      .in('lead_id', part)
      .in('tag_id', tagIds);
    if (readError) throw toError(readError);

    const have = new Set((existing ?? []).map((r) => `${r.lead_id}:${r.tag_id}`));
    const rows = part.flatMap((lead_id) =>
      tagIds.filter((tag_id) => !have.has(`${lead_id}:${tag_id}`)).map((tag_id) => ({ lead_id, tag_id })),
    );

    if (rows.length > 0) {
      const { error } = await supabase.from('lead_tags').insert(rows);
      if (error) throw toError(error);
    }
  }
}

/** Remove tags */
export async function removeTagsFromLeads(ids: string[], tagIds: string[]): Promise<void> {
  if (ids.length === 0 || tagIds.length === 0) return;

  for (const part of chunks(ids)) {
    const { error } = await supabase
      .from('lead_tags')
      .delete()
      .in('lead_id', part)
      .in('tag_id', tagIds);
    if (error) throw toError(error);
  }
}

// =====================================================================
// Duplicate check
// =====================================================================
export async function findDuplicates(
  contact: { phone?: string | null; whatsapp_number?: string | null; whatsapp_username?: string | null },
  excludeId?: string,
): Promise<DuplicateLead[]> {
  const phone = contact.phone && normalizePhone(contact.phone).length >= 11 ? contact.phone : undefined;
  const waNumber =
    contact.whatsapp_number && contact.whatsapp_number.replace(/\D/g, '').length >= 8
      ? contact.whatsapp_number
      : undefined;
  const username =
    contact.whatsapp_username && contact.whatsapp_username.replace(/^@+/, '').trim().length >= 3
      ? contact.whatsapp_username
      : undefined;
  if (!phone && !waNumber && !username) return [];

  const { data, error } = await supabase.rpc('find_leads_by_contact', {
    ...(phone ? { p_phone: phone } : {}),
    ...(waNumber ? { p_whatsapp_number: waNumber } : {}),
    ...(username ? { p_whatsapp_username: username } : {}),
    ...(excludeId ? { p_exclude_id: excludeId } : {}),
  });

  if (error) throw toError(error);
  return (data ?? []) as DuplicateLead[];
}

// =====================================================================
// Activity timeline
// =====================================================================
export async function listLeadActivity(leadId: string): Promise<ActivityItem[]> {
  const { data, error } = await supabase
    .from('lead_activity')
    .select('*')
    .eq('lead_id', leadId)
    .order('created_at', { ascending: false })
    .limit(100);

  if (error) throw toError(error);
  const rows = data ?? [];

  // Look up the names of the people who did each action
  const userIds = [...new Set(rows.map((r) => r.user_id).filter(Boolean))] as string[];
  const names = new Map<string, string | null>();
  if (userIds.length > 0) {
    const { data: people } = await supabase.from('profiles').select('id, full_name').in('id', userIds);
    for (const p of people ?? []) names.set(p.id, p.full_name);
  }

  return rows.map((r) => ({ ...r, user_name: r.user_id ? names.get(r.user_id) ?? null : null }));
}

// =====================================================================
// People
//   - no options: every active user (for the "Assigned to" list)
//   - teamLeadId: only that Team Lead and the callers in their team
//   - includeInactive: deactivated users too (for names in timelines)
// =====================================================================
export async function listAssignableUsers(
  options: { teamLeadId?: string; includeInactive?: boolean } = {},
): Promise<AssignableUser[]> {
  let query = supabase
    .from('profiles')
    .select('id, full_name, role_key, is_active, team_lead_id')
    .order('full_name');

  if (!options.includeInactive) {
    query = query.eq('is_active', true);
  }

  if (options.teamLeadId) {
    query = query.or(`id.eq.${options.teamLeadId},team_lead_id.eq.${options.teamLeadId}`);
  }

  const { data, error } = await query;
  if (error) throw toError(error);
  return data ?? [];
}
// =====================================================================
// 🗑 Delete one note of the lead (Admins any; your own Note within 24 hours)
//   block = the note exactly as stored (LeadNote.raw). Returns the
//   change-log line, for Undo.
// =====================================================================
export async function deleteLeadNote(leadId: string, block: string, reason?: string): Promise<string> {
  const { data, error } = await supabase.rpc('delete_lead_note', {
    p_lead_id: leadId,
    p_block: block,
    ...(reason?.trim() ? { p_reason: reason.trim() } : {}),
  });
  if (error) throw toError(error);
  return data as string;
}
