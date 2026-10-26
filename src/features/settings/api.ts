import { supabase } from '@/shared/lib/supabase';
import type { Json, Tables, TablesInsert } from '@/shared/types/database';

// =====================================================================
// Errors
// =====================================================================
type DbError = { message: string; code?: string };

function toError(error: DbError): Error {
  if (error.code === '23505') {
    return new Error('An item with this name already exists.');
  }
  if (error.code === '23503') {
    return new Error('This item is in use and cannot be removed. Switch it off instead.');
  }
  const m = error.message.toLowerCase();
  if (m.includes('network request failed') || m.includes('fetch')) {
    return new Error('No internet connection. Please try again.');
  }
  return new Error(error.message);
}

// =====================================================================
// Simple lists (same shape: id, name, is_active, sort_order + extras)
// =====================================================================
export type ListTable =
  | 'lead_sources'
  | 'campaigns'
  | 'pipeline_stages'
  | 'lost_reasons'
  | 'call_results'
  | 'document_types'
  | 'tags'
  | 'lead_types';

export type ListItem = {
  id: string;
  name: string;
  is_active: boolean;
  sort_order: number;
  [extra: string]: unknown;
};

// One loosely typed handle for the generic functions below.
// Each screen knows which extra columns its table has.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const table = (name: ListTable) => supabase.from(name) as any;

export async function listItems(
  name: ListTable,
  options: { includeInactive?: boolean } = {},
): Promise<ListItem[]> {
  let query = table(name).select('*').order('sort_order').order('name');
  if (!options.includeInactive) query = query.eq('is_active', true);

  const { data, error } = await query;
  if (error) throw toError(error);
  return (data ?? []) as ListItem[];
}

export async function createItem(
  name: ListTable,
  values: Record<string, unknown>,
): Promise<ListItem> {
  // Put the new item at the end of the list
  const { data: last } = await table(name)
    .select('sort_order')
    .order('sort_order', { ascending: false })
    .limit(1)
    .maybeSingle();

  const { data, error } = await table(name)
    .insert({ ...values, sort_order: (last?.sort_order ?? 0) + 1 })
    .select('*')
    .single();

  if (error) throw toError(error);
  return data as ListItem;
}

export async function updateItem(
  name: ListTable,
  id: string,
  values: Record<string, unknown>,
): Promise<void> {
  const { error } = await table(name).update(values).eq('id', id);
  if (error) throw toError(error);
}

export async function setItemActive(name: ListTable, id: string, active: boolean): Promise<void> {
  await updateItem(name, id, { is_active: active });
}

/** Save a new order: ids in the order they should appear. */
export async function reorderItems(name: ListTable, ids: string[]): Promise<void> {
  const results = await Promise.all(
    ids.map((id, index) => table(name).update({ sort_order: index + 1 }).eq('id', id)),
  );
  const failed = results.find((r: { error: DbError | null }) => r.error);
  if (failed?.error) throw toError(failed.error);
}

// =====================================================================
// Courses, fees and batches
// =====================================================================
export type Course = Tables<'courses'>;
export type CourseFee = Tables<'course_fees'>;
export type Batch = Tables<'batches'>;

export type CourseWithDetails = Course & {
  course_fees: CourseFee[];
  batches: Batch[];
};

export type FeeInput = { id?: string; name: string; amount: number };

export async function listCourses(includeInactive = false): Promise<CourseWithDetails[]> {
  let query = supabase
    .from('courses')
    .select('*, course_fees(*), batches(*)')
    .order('sort_order')
    .order('name');
  if (!includeInactive) query = query.eq('is_active', true);

  const { data, error } = await query;
  if (error) throw toError(error);
  return (data ?? []) as CourseWithDetails[];
}

export async function getCourse(id: string): Promise<CourseWithDetails | null> {
  const { data, error } = await supabase
    .from('courses')
    .select('*, course_fees(*), batches(*)')
    .eq('id', id)
    .maybeSingle();

  if (error) throw toError(error);
  if (!data) return null;

  const course = data as CourseWithDetails;
  course.course_fees.sort((a, b) => a.sort_order - b.sort_order);
  course.batches.sort((a, b) => a.sort_order - b.sort_order || a.name.localeCompare(b.name));
  return course;
}

export async function saveCourse(
  values: TablesInsert<'courses'> & { id?: string },
): Promise<Course> {
  const { id, ...rest } = values;
  const query = id
    ? supabase.from('courses').update(rest).eq('id', id).select('*').single()
    : supabase.from('courses').insert(rest).select('*').single();

  const { data, error } = await query;
  if (error) throw toError(error);
  return data;
}

/** Replace a course's fee lines with the given list (keeps ids that still exist). */
export async function saveCourseFees(courseId: string, fees: FeeInput[]): Promise<void> {
  const { data: existing, error: readError } = await supabase
    .from('course_fees')
    .select('id')
    .eq('course_id', courseId);
  if (readError) throw toError(readError);

  // 1. Remove fee lines that are no longer in the list
  const keepIds = fees.filter((f) => f.id).map((f) => f.id as string);
  const removeIds = (existing ?? []).map((f) => f.id).filter((id) => !keepIds.includes(id));

  if (removeIds.length > 0) {
    const { error } = await supabase.from('course_fees').delete().in('id', removeIds);
    if (error) throw toError(error);
  }

  // 2. Update the lines that already exist (one by one: names, amounts, order)
  const updates = fees
    .map((f, index) => ({ ...f, sort_order: index + 1 }))
    .filter((f) => f.id);

  for (const f of updates) {
    const { error } = await supabase
      .from('course_fees')
      .update({ name: f.name.trim(), amount: f.amount, sort_order: f.sort_order })
      .eq('id', f.id as string);
    if (error) throw toError(error);
  }

  // 3. Insert the new lines (all together)
  const inserts = fees
    .map((f, index) => ({ ...f, sort_order: index + 1 }))
    .filter((f) => !f.id)
    .map((f) => ({
      course_id: courseId,
      name: f.name.trim(),
      amount: f.amount,
      sort_order: f.sort_order,
    }));

  if (inserts.length > 0) {
    const { error } = await supabase.from('course_fees').insert(inserts);
    if (error) throw toError(error);
  }
}

/**
 * Add or change one batch of a course.
 *   With id: update it. Without id: add it at the end of the course's batches.
 */
export async function saveBatch(values: TablesInsert<'batches'> & { id?: string }): Promise<Batch> {
  const { id, ...rest } = values;

  if (id) {
    const { data, error } = await supabase.from('batches').update(rest).eq('id', id).select('*').single();
    if (error) throw toError(error);
    return data;
  }

  // New batch: put it after the course's other batches
  const { data: last } = await supabase
    .from('batches')
    .select('sort_order')
    .eq('course_id', rest.course_id)
    .order('sort_order', { ascending: false })
    .limit(1)
    .maybeSingle();

  const { data, error } = await supabase
    .from('batches')
    .insert({ ...rest, sort_order: rest.sort_order ?? (last?.sort_order ?? 0) + 1 })
    .select('*')
    .single();
  if (error) throw toError(error);
  return data;
}

// =====================================================================
// Holidays
// =====================================================================
export type Holiday = Tables<'holidays'>;

export async function listHolidays(year: number): Promise<Holiday[]> {
  const { data, error } = await supabase
    .from('holidays')
    .select('*')
    .lte('start_date', `${year}-12-31`)
    .gte('end_date', `${year}-01-01`)
    .order('start_date');

  if (error) throw toError(error);
  return data ?? [];
}

export async function saveHoliday(
  values: TablesInsert<'holidays'> & { id?: string },
): Promise<void> {
  const { id, ...rest } = values;
  const { error } = id
    ? await supabase.from('holidays').update(rest).eq('id', id)
    : await supabase.from('holidays').insert(rest);
  if (error) throw toError(error);
}

export async function deleteHoliday(id: string): Promise<void> {
  const { error } = await supabase.from('holidays').delete().eq('id', id);
  if (error) throw toError(error);
}

// =====================================================================
// App settings (key → JSON value)
// =====================================================================
export async function getSetting<T = Json>(key: string): Promise<T | null> {
  const { data, error } = await supabase
    .from('app_settings')
    .select('value')
    .eq('key', key)
    .maybeSingle();

  if (error) throw toError(error);
  return (data?.value as T) ?? null;
}

export async function updateSetting(key: string, value: Json): Promise<void> {
  const { error } = await supabase.from('app_settings').update({ value }).eq('key', key);
  if (error) throw toError(error);
}