import { supabase } from '@/shared/lib/supabase';
import type { Json } from '@/shared/types/database';

import { getSetting, updateSetting } from '@/features/settings/api';

// =====================================================================
// What a filter can hold
//   Every part is optional. Empty = no filter on that field.
// =====================================================================
export type FollowUpFilter = 'overdue' | 'today' | 'tomorrow' | 'week' | 'none';
export type CreatedFilter = 'today' | '7d' | '30d' | 'this_month';
export type LastContactedFilter = 'never' | 'today' | '7d' | 'over_7d' | 'over_30d';
export type AdmittedFilter = 'this_month' | 'last_month' | '30d' | 'this_year';
/**
 * Admission papers (only leads that need papers):
 *   complete  = every required paper received
 *   missing   = some required papers not received yet
 *   none_yet  = no required paper received yet
 *   originals = we hold original papers (not returned)
 *   no_place  = papers received but "kept at" not written
 */
export type PapersFilter = 'complete' | 'missing' | 'none_yet' | 'originals' | 'no_place';
/**
 * 🏫 Campus visit (leads.visit_status / visit_at):
 *   planned = a visit is planned · today = planned for today · overdue = planned time passed
 *   visited = came at least once · missed = didn't come (no new plan) · none = never planned
 */
export type VisitFilter = 'planned' | 'today' | 'overdue' | 'visited' | 'missed' | 'none';

export type LeadFilters = {
  ratings?: string[];        // 'hot' | 'warm' | 'cold' | 'none'
  stageIds?: string[];
  tagIds?: string[];
  assigned?: string[];       // user ids, or 'none' for unassigned
  followUp?: FollowUpFilter;
  sourceIds?: string[];
  campaignIds?: string[];
  courseIds?: string[];
  leadTypeIds?: string[];
  created?: CreatedFilter;
  lastContacted?: LastContactedFilter;
  admitted?: AdmittedFilter; // admitted in this period (cancelled admissions left out)
  lostReasonIds?: string[];
  papers?: PapersFilter;     // open and admitted leads (lost / cancelled left out)
  visit?: VisitFilter;
};

export type FilterKey =
  | 'follow_up'
  | 'rating'
  | 'stage'
  | 'tags'
  | 'assigned'
  | 'source'
  | 'course'
  | 'campaign'
  | 'lead_type'
  | 'created'
  | 'last_contacted'
  | 'admitted'
  | 'lost_reason'
  | 'papers'
  | 'visit';

export const NONE = 'none';

// =====================================================================
// Labels shown in the app
// =====================================================================
export const FILTER_FIELDS: Record<FilterKey, { label: string; icon: string }> = {
  follow_up: { label: 'Next call', icon: 'alarm' },
  rating: { label: 'Rating', icon: 'star' },
  stage: { label: 'Stage', icon: 'flag' },
  tags: { label: 'Tags', icon: 'pricetags' },
  assigned: { label: 'Assigned to', icon: 'person' },
  source: { label: 'Source', icon: 'megaphone' },
  course: { label: 'Course', icon: 'school' },
  campaign: { label: 'Campaign', icon: 'rocket' },
  lead_type: { label: 'Lead type', icon: 'albums' },
  created: { label: 'Added', icon: 'calendar' },
  last_contacted: { label: 'Last contacted', icon: 'call' },
  admitted: { label: 'Admitted', icon: 'ribbon' },
  lost_reason: { label: 'Lost reason', icon: 'close-circle' },
  papers: { label: 'Papers', icon: 'document-text' },
  visit: { label: 'Campus visit', icon: 'business' },
};

export const FOLLOW_UP_OPTIONS: { value: FollowUpFilter; label: string }[] = [
  { value: 'overdue', label: 'Overdue' },
  { value: 'today', label: 'Today' },
  { value: 'tomorrow', label: 'Tomorrow' },
  { value: 'week', label: 'Next 7 days' },
  { value: 'none', label: 'Not set' },
];

export const CREATED_OPTIONS: { value: CreatedFilter; label: string }[] = [
  { value: 'today', label: 'Today' },
  { value: '7d', label: 'Last 7 days' },
  { value: '30d', label: 'Last 30 days' },
  { value: 'this_month', label: 'This month' },
];

export const LAST_CONTACTED_OPTIONS: { value: LastContactedFilter; label: string }[] = [
  { value: 'never', label: 'Never' },
  { value: 'today', label: 'Today' },
  { value: '7d', label: 'Last 7 days' },
  { value: 'over_7d', label: 'No contact 7+ days' },
  { value: 'over_30d', label: 'No contact 30+ days' },
];

export const ADMITTED_OPTIONS: { value: AdmittedFilter; label: string }[] = [
  { value: 'this_month', label: 'This month' },
  { value: 'last_month', label: 'Last month' },
  { value: '30d', label: 'Last 30 days' },
  { value: 'this_year', label: 'This year' },
];

export const PAPERS_OPTIONS: { value: PapersFilter; label: string }[] = [
  { value: 'complete', label: '✓ All received' },
  { value: 'missing', label: 'Some missing' },
  { value: 'none_yet', label: 'None yet' },
  { value: 'originals', label: 'Originals with us' },
  { value: 'no_place', label: 'Place not written' },
];

export const VISIT_OPTIONS: { value: VisitFilter; label: string }[] = [
  { value: 'planned', label: 'Planned' },
  { value: 'today', label: 'Today' },
  { value: 'overdue', label: 'Overdue' },
  { value: 'visited', label: '✓ Visited' },
  { value: 'missed', label: 'Didn’t come' },
  { value: 'none', label: 'Never planned' },
];

// =====================================================================
// Small helpers
// =====================================================================
const list = (v?: string[]) => (v && v.length > 0 ? v : null);

/** How many fields have something chosen */
export function countActiveFilters(f: LeadFilters): number {
  return [
    list(f.ratings),
    list(f.stageIds),
    list(f.tagIds),
    list(f.assigned),
    f.followUp,
    list(f.sourceIds),
    list(f.campaignIds),
    list(f.courseIds),
    list(f.leadTypeIds),
    f.created,
    f.lastContacted,
    f.admitted,
    list(f.lostReasonIds),
    f.papers,
    f.visit,
  ].filter(Boolean).length;
}

/**
 * These filters are about closed leads (a stage, admitted date, lost reason, papers):
 * when one is set, the list must not hide closed leads.
 * (Papers keeps only open and admitted leads itself.)
 */
export function needsClosedLeads(f: LeadFilters): boolean {
  return !!(list(f.stageIds) || f.admitted || list(f.lostReasonIds) || f.papers);
}

/** Drop empty parts so saved filters stay small */
export function cleanFilters(f: LeadFilters): LeadFilters {
  const out: LeadFilters = {};
  (Object.keys(f) as (keyof LeadFilters)[]).forEach((k) => {
    const v = f[k];
    if (Array.isArray(v) ? v.length > 0 : !!v) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (out as any)[k] = v;
    }
  });
  return out;
}

function startOfDay(d = new Date()): Date {
  const x = new Date(d);
  x.setHours(0, 0, 0, 0);
  return x;
}
function addDays(d: Date, days: number): Date {
  const x = new Date(d);
  x.setDate(x.getDate() + days);
  return x;
}
const iso = (d: Date) => d.toISOString();

// =====================================================================
// Turning filters into a database query
// =====================================================================
/**
 * Extra joins needed by the filters (added to the select).
 * Separate names, so the lead's own tag/course lists stay complete.
 */
export function filterSelect(f: LeadFilters): string {
  const extra: string[] = [];
  if (list(f.tagIds)) extra.push('tag_filter:lead_tags!inner(tag_id)');
  if (list(f.courseIds)) extra.push('course_filter:lead_courses!inner(course_id)');
  return extra.length > 0 ? `, ${extra.join(', ')}` : '';
}

/** "a,b,c" for PostgREST in(...) */
const inList = (ids: string[]) => ids.map((id) => `"${id}"`).join(',');

/** Adds the filter conditions to a leads query */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function applyLeadFilters<Q extends { [k: string]: any }>(query: Q, f: LeadFilters): Q {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let q: any = query;
  const now = new Date();
  const today = startOfDay(now);

  // Rating (with "No rating")
  const ratings = list(f.ratings);
  if (ratings) {
    const real = ratings.filter((r) => r !== NONE);
    const parts: string[] = [];
    if (real.length > 0) parts.push(`rating.in.(${real.join(',')})`);
    if (ratings.includes(NONE)) parts.push('rating.is.null');
    q = q.or(parts.join(','));
  }

  // Simple id lists
  if (list(f.stageIds)) q = q.in('stage_id', f.stageIds);
  if (list(f.sourceIds)) q = q.in('source_id', f.sourceIds);
  if (list(f.campaignIds)) q = q.in('campaign_id', f.campaignIds);
  if (list(f.leadTypeIds)) q = q.in('lead_type_id', f.leadTypeIds);
  if (list(f.lostReasonIds)) q = q.in('lost_reason_id', f.lostReasonIds);

  // Tags / courses (through the extra joins)
  if (list(f.tagIds)) q = q.in('tag_filter.tag_id', f.tagIds);
  if (list(f.courseIds)) q = q.in('course_filter.course_id', f.courseIds);

  // Assigned to (with "Unassigned")
  const assigned = list(f.assigned);
  if (assigned) {
    const people = assigned.filter((a) => a !== NONE);
    const parts: string[] = [];
    if (people.length > 0) parts.push(`assigned_to.in.(${inList(people)})`);
    if (assigned.includes(NONE)) parts.push('assigned_to.is.null');
    q = q.or(parts.join(','));
  }

  // Next call
  switch (f.followUp) {
    case 'overdue':
      q = q.lt('next_follow_up_at', iso(now));
      break;
    case 'today':
      q = q.gte('next_follow_up_at', iso(today)).lt('next_follow_up_at', iso(addDays(today, 1)));
      break;
    case 'tomorrow':
      q = q.gte('next_follow_up_at', iso(addDays(today, 1))).lt('next_follow_up_at', iso(addDays(today, 2)));
      break;
    case 'week':
      q = q.gte('next_follow_up_at', iso(today)).lt('next_follow_up_at', iso(addDays(today, 7)));
      break;
    case 'none':
      q = q.is('next_follow_up_at', null);
      break;
  }

  // Added
  switch (f.created) {
    case 'today':
      q = q.gte('created_at', iso(today));
      break;
    case '7d':
      q = q.gte('created_at', iso(addDays(today, -6)));
      break;
    case '30d':
      q = q.gte('created_at', iso(addDays(today, -29)));
      break;
    case 'this_month':
      q = q.gte('created_at', iso(new Date(now.getFullYear(), now.getMonth(), 1)));
      break;
  }

  // Last contacted
  switch (f.lastContacted) {
    case 'never':
      q = q.is('last_contacted_at', null);
      break;
    case 'today':
      q = q.gte('last_contacted_at', iso(today));
      break;
    case '7d':
      q = q.gte('last_contacted_at', iso(addDays(today, -6)));
      break;
    case 'over_7d':
      q = q.or(`last_contacted_at.lt.${iso(addDays(now, -7))},last_contacted_at.is.null`);
      break;
    case 'over_30d':
      q = q.or(`last_contacted_at.lt.${iso(addDays(now, -30))},last_contacted_at.is.null`);
      break;
  }

  // Admitted (still admitted: a cancelled admission doesn't count)
  if (f.admitted) {
    const thisMonth = new Date(now.getFullYear(), now.getMonth(), 1);
    // Still admitted: closed with an admission that wasn't cancelled (a reopened lead is open)
    q = q.not('admitted_at', 'is', null).is('cancelled_at', null).not('closed_at', 'is', null);
    switch (f.admitted) {
      case 'this_month':
        q = q.gte('admitted_at', iso(thisMonth));
        break;
      case 'last_month':
        q = q
          .gte('admitted_at', iso(new Date(now.getFullYear(), now.getMonth() - 1, 1)))
          .lt('admitted_at', iso(thisMonth));
        break;
      case '30d':
        q = q.gte('admitted_at', iso(addDays(today, -29)));
        break;
      case 'this_year':
        q = q.gte('admitted_at', iso(new Date(now.getFullYear(), 0, 1)));
        break;
    }
  }

  // Papers: open leads and admitted students only (not lost / cancelled)
  if (f.papers) {
    q = q.or('closed_at.is.null,and(admitted_at.not.is.null,cancelled_at.is.null)');
    switch (f.papers) {
      case 'complete':
        q = q.gt('papers_required', 0).eq('papers_missing', 0);
        break;
      case 'missing':
        q = q.gt('papers_missing', 0);
        break;
      case 'none_yet':
        q = q.gt('papers_required', 0).eq('papers_received', 0);
        break;
      case 'originals':
        q = q.gt('papers_originals_held', 0);
        break;
      case 'no_place':
        q = q.gt('papers_received', 0).is('papers_kept_at', null);
        break;
    }
  }

  // Campus visit
  switch (f.visit) {
    case 'planned':
      q = q.eq('visit_status', 'planned');
      break;
    case 'today':
      q = q.eq('visit_status', 'planned').gte('visit_at', iso(today)).lt('visit_at', iso(addDays(today, 1)));
      break;
    case 'overdue':
      q = q.eq('visit_status', 'planned').lt('visit_at', iso(now));
      break;
    case 'visited':
      q = q.eq('visit_status', 'visited');
      break;
    case 'missed':
      q = q.eq('visit_status', 'missed');
      break;
    case 'none':
      q = q.is('visit_status', null);
      break;
  }

  return q as Q;
}

// =====================================================================
// Errors
// =====================================================================
function toError(error: { message: string; code?: string }): Error {
  if (error.code === '23514') return new Error('Please give the filter a name (up to 40 letters).');
  const m = error.message.toLowerCase();
  if (m.includes('network request failed') || m.includes('fetch')) {
    return new Error('No internet connection. Please try again.');
  }
  return new Error(error.message);
}

// =====================================================================
// Saved filters
// =====================================================================
export type SavedFilter = {
  id: string;
  owner_id: string;
  name: string;
  filters: LeadFilters;
  is_shared: boolean;
  sort_order: number;
};

export async function listSavedFilters(): Promise<SavedFilter[]> {
  const { data, error } = await supabase
    .from('saved_filters')
    .select('id, owner_id, name, filters, is_shared, sort_order')
    .order('is_shared', { ascending: false })
    .order('sort_order')
    .order('created_at');
  if (error) throw toError(error);
  return (data ?? []) as unknown as SavedFilter[];
}

export async function createSavedFilter(name: string, filters: LeadFilters, shared = false): Promise<SavedFilter> {
  const { data, error } = await supabase
    .from('saved_filters')
    .insert({ name: name.trim(), filters: cleanFilters(filters) as Json, is_shared: shared })
    .select('id, owner_id, name, filters, is_shared, sort_order')
    .single();
  if (error) throw toError(error);
  return data as unknown as SavedFilter;
}

export async function updateSavedFilter(
  id: string,
  values: { name?: string; filters?: LeadFilters; is_shared?: boolean },
): Promise<void> {
  const patch: Record<string, unknown> = {};
  if (values.name !== undefined) patch.name = values.name.trim();
  if (values.filters !== undefined) patch.filters = cleanFilters(values.filters);
  if (values.is_shared !== undefined) patch.is_shared = values.is_shared;

  const { error } = await supabase.from('saved_filters').update(patch).eq('id', id);
  if (error) throw toError(error);
}

export async function deleteSavedFilter(id: string): Promise<void> {
  const { error } = await supabase.from('saved_filters').delete().eq('id', id);
  if (error) throw toError(error);
}

// =====================================================================
// Admin setting: which filters are shown, and their order
// =====================================================================
export type FilterConfig = { fields: { key: FilterKey; enabled: boolean }[] };

export const DEFAULT_FILTER_CONFIG: FilterConfig = {
  fields: [
    { key: 'follow_up', enabled: true },
    { key: 'rating', enabled: true },
    { key: 'stage', enabled: true },
    { key: 'tags', enabled: true },
    { key: 'assigned', enabled: true },
    { key: 'source', enabled: true },
    { key: 'course', enabled: true },
    { key: 'campaign', enabled: false },
    { key: 'lead_type', enabled: false },
    { key: 'created', enabled: true },
    { key: 'last_contacted', enabled: true },
    { key: 'admitted', enabled: true },
    { key: 'papers', enabled: true },
    { key: 'visit', enabled: true },
    { key: 'lost_reason', enabled: true },
  ],
};

/** Reads the setting; unknown keys are dropped and missing ones added at the end */
export async function getFilterConfig(): Promise<FilterConfig> {
  let saved: FilterConfig | null = null;
  try {
    saved = await getSetting<FilterConfig>('lead_filters');
  } catch {
    saved = null;
  }

  const known = new Set(Object.keys(FILTER_FIELDS));
  const fields = (saved?.fields ?? []).filter((f) => known.has(f.key));
  for (const d of DEFAULT_FILTER_CONFIG.fields) {
    if (!fields.some((f) => f.key === d.key)) fields.push(d);
  }
  return { fields };
}

export async function saveFilterConfig(config: FilterConfig): Promise<void> {
  await updateSetting('lead_filters', config as unknown as Json);
}