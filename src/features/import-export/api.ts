import { supabase } from '@/shared/lib/supabase';
import type { Json, Tables } from '@/shared/types/database';

import { writeAndShareSpreadsheet, type ImportRow } from './excel';

// =====================================================================
// Types
// =====================================================================
export type DuplicateMode = 'skip' | 'update' | 'create';
export type AssignMode = 'none' | 'user' | 'round_robin';

export type ImportOptions = {
  fileName: string;
  defaultSourceId: string | null;
  duplicateMode: DuplicateMode;
  assignMode: AssignMode;
  assignUserId: string | null;
  roundRobinUserIds: string[];
};

export type ImportError = { row: number; reason: string };

export type ImportSummary = {
  batchId: string | null;
  created: number;
  updated: number;
  skipped: number;
  errors: ImportError[];
};

export type ImportBatch = Tables<'import_batches'>;

export type ExportFilters = {
  stageId?: string | null;
  sourceId?: string | null;
  assignedTo?: string | null;
  createdFrom?: string | null; // YYYY-MM-DD
  createdTo?: string | null;   // YYYY-MM-DD
};

const CHUNK_SIZE = 200;

function toError(error: { message: string }): Error {
  const m = error.message.toLowerCase();
  if (m.includes('network request failed') || m.includes('fetch')) {
    return new Error('No internet connection. Please try again.');
  }
  return new Error(error.message);
}

// =====================================================================
// Import
// =====================================================================
export async function runImport(
  rows: ImportRow[],
  options: ImportOptions,
  onProgress?: (done: number, total: number) => void,
): Promise<ImportSummary> {
  const summary: ImportSummary = { batchId: null, created: 0, updated: 0, skipped: 0, errors: [] };

  for (let start = 0; start < rows.length; start += CHUNK_SIZE) {
    const chunk = rows.slice(start, start + CHUNK_SIZE);

    const { data, error } = await supabase.rpc('import_leads', {
      p_rows: chunk as unknown as Json,
      p_options: {
        batch_id: summary.batchId,
        file_name: options.fileName,
        default_source_id: options.defaultSourceId,
        duplicate_mode: options.duplicateMode,
        assign_mode: options.assignMode,
        assign_user_id: options.assignUserId,
        round_robin_user_ids: options.roundRobinUserIds,
      } as unknown as Json,
    });

    if (error) {
      // Rows already imported stay; report how far we got
      throw toError({
        message: `${error.message} (stopped after ${summary.created + summary.updated} rows; you can undo this import from the history)`,
      });
    }

    const result = data as unknown as {
      batch_id: string;
      created: number;
      updated: number;
      skipped: number;
      errors: ImportError[];
    };

    summary.batchId = result.batch_id;
    summary.created += result.created;
    summary.updated += result.updated;
    summary.skipped += result.skipped;
    summary.errors.push(...result.errors);

    onProgress?.(Math.min(start + CHUNK_SIZE, rows.length), rows.length);
  }

  return summary;
}

export async function undoImport(batchId: string): Promise<number> {
  const { data, error } = await supabase.rpc('undo_import', { p_batch_id: batchId });
  if (error) throw toError(error);
  return data ?? 0;
}

export async function listImportBatches(): Promise<ImportBatch[]> {
  const { data, error } = await supabase
    .from('import_batches')
    .select('*')
    .order('created_at', { ascending: false })
    .limit(20);

  if (error) throw toError(error);
  return data ?? [];
}

/** True while an import can still be undone (24 hours, not undone yet). */
export function canUndo(batch: ImportBatch): boolean {
  if (batch.undone_at) return false;
  return Date.now() - new Date(batch.created_at).getTime() < 24 * 60 * 60 * 1000;
}

// =====================================================================
// Export
// =====================================================================
const EXPORT_SELECT = `
  name, phone, whatsapp_number, whatsapp_username, alt_phone, email, area,
  guardian_name, guardian_phone, guardian_relation,
  rating, notes, referred_by, created_at, created_by, import_batch_id, next_follow_up_at,
  student_ref, approval_status, approval_by, approval_at, nu_admission_id, last_contacted_at, visit_status, visit_at,
  fee_status, fee_full, fee_discount, fee_final, fee_paid, fee_due,
  stage:pipeline_stages(name),
  source:lead_sources(name),
  campaign:campaigns(name),
  lead_type:lead_types(name),
  assignee:assigned_to(full_name),
  lead_courses(course:courses(name)),
  lead_tags(tag:tags(name))
`;

type ExportLead = {
  name: string;
  phone: string | null;
  whatsapp_number: string | null;
  whatsapp_username: string | null;
  alt_phone: string | null;
  email: string | null;
  area: string | null;
  guardian_name: string | null;
  guardian_phone: string | null;
  guardian_relation: string | null;
  rating: string | null;
  notes: string | null;
  referred_by: string | null;
  created_at: string;
  created_by: string | null;
  import_batch_id: string | null;
  student_ref: string | null;
  approval_status: string | null;
  approval_by: string | null;
  approval_at: string | null;
  nu_admission_id: string | null;
  next_follow_up_at: string | null;
  last_contacted_at: string | null;
  visit_status: string | null;
  visit_at: string | null;
  fee_status: string | null;
  fee_full: number | null;
  fee_discount: number | null;
  fee_final: number | null;
  fee_paid: number | null;
  fee_due: number | null;
  stage: { name: string } | null;
  source: { name: string } | null;
  campaign: { name: string } | null;
  lead_type: { name: string } | null;
  assignee: { full_name: string | null } | null;
  lead_courses: { course: { name: string } | null }[];
  lead_tags: { tag: { name: string } | null }[];
};

const EXPORT_HEADERS = [
  'Name', 'Phone', 'WhatsApp number', 'WhatsApp username', 'Alternative phone', 'Email', 'Area',
  'Guardian name', 'Guardian phone', 'Guardian relation',
  'Courses', 'Stage', 'Rating', 'Source', 'Campaign', 'Referred by', 'Lead type', 'Tags',
  'Assigned to', 'Created', 'Created by', 'Next follow-up', 'Last contacted', 'Campus visit',
  'Fee status', 'Full fee', 'Discount', 'To pay', 'Paid', 'Due', 'Notes',
  'College ID', 'NU Admission ID', 'Admission approval', 'Approved by', 'Approved on',
];

const APPROVAL: Record<string, string> = { waiting: 'Waiting', approved: 'Approved', returned: 'Sent back' };

const FEE_STATUS: Record<string, string> = {
  negotiating: 'Negotiating',
  discount_waiting: 'Discount waiting',
  discount_given: 'Discount given',
  final: 'Final (admitted)',
};

const num = (v: number | null) => (v == null ? null : Number(v));

/** "Planned · 28 Oct 2026, 11:00", "Visited · …", "Didn't come · …" */
function visitText(status: string | null, at: string | null): string {
  const label = status === 'planned' ? 'Planned' : status === 'visited' ? 'Visited' : status === 'missed' ? "Didn't come" : '';
  if (!label) return '';
  return at ? `${label} · ${dateText(at)}` : label;
}

const dateText = (iso: string | null) =>
  iso ? new Date(iso).toLocaleString('en-GB', { dateStyle: 'medium', timeStyle: 'short' }) : '';

/** Read every matching lead, 1000 at a time. */
async function fetchLeadsForExport(filters: ExportFilters): Promise<ExportLead[]> {
  const all: ExportLead[] = [];
  const pageSize = 1000;

  for (let from = 0; ; from += pageSize) {
    let query = supabase
      .from('leads')
      .select(EXPORT_SELECT)
      .is('deleted_at', null)
      .order('created_at', { ascending: false })
      .range(from, from + pageSize - 1);

    if (filters.stageId) query = query.eq('stage_id', filters.stageId);
    if (filters.sourceId) query = query.eq('source_id', filters.sourceId);
    if (filters.assignedTo) query = query.eq('assigned_to', filters.assignedTo);
    if (filters.createdFrom) query = query.gte('created_at', `${filters.createdFrom}T00:00:00`);
    if (filters.createdTo) query = query.lte('created_at', `${filters.createdTo}T23:59:59`);

    const { data, error } = await query;
    if (error) throw toError(error);

    const page = (data ?? []) as unknown as ExportLead[];
    all.push(...page);
    if (page.length < pageSize) break;
  }

  return all;
}

/** Count how many leads an export would include (before exporting). */
export async function countLeadsForExport(filters: ExportFilters): Promise<number> {
  let query = supabase.from('leads').select('id', { count: 'exact', head: true }).is('deleted_at', null);
  if (filters.stageId) query = query.eq('stage_id', filters.stageId);
  if (filters.sourceId) query = query.eq('source_id', filters.sourceId);
  if (filters.assignedTo) query = query.eq('assigned_to', filters.assignedTo);
  if (filters.createdFrom) query = query.gte('created_at', `${filters.createdFrom}T00:00:00`);
  if (filters.createdTo) query = query.lte('created_at', `${filters.createdTo}T23:59:59`);

  const { count, error } = await query;
  if (error) throw toError(error);
  return count ?? 0;
}

/** Build the Excel file, open the share sheet and record the export. */
export async function exportLeads(filters: ExportFilters, userId: string): Promise<number> {
  const leads = await fetchLeadsForExport(filters);
  if (leads.length === 0) throw new Error('No leads match these filters.');

  // Who added each lead (created_by points at the sign-in, so names come from profiles)
  const { data: people } = await supabase.from('profiles').select('id, full_name');
  const nameOf = new Map((people ?? []).map((p) => [p.id, p.full_name ?? '']));
  const createdBy = (l: ExportLead) =>
    l.created_by ? `${nameOf.get(l.created_by) ?? ''}${l.import_batch_id ? ' (imported)' : ''}` : '';

  const rows = leads.map((l) => [
    l.name,
    l.phone,
    l.whatsapp_number,
    l.whatsapp_username ? '@' + l.whatsapp_username : null,
    l.alt_phone,
    l.email,
    l.area,
    l.guardian_name,
    l.guardian_phone,
    l.guardian_relation,
    l.lead_courses.map((c) => c.course?.name).filter(Boolean).join(', '),
    l.stage?.name ?? '',
    l.rating ?? '',
    l.source?.name ?? '',
    l.campaign?.name ?? '',
    l.referred_by,
    l.lead_type?.name ?? '',
    l.lead_tags.map((t) => t.tag?.name).filter(Boolean).join(', '),
    l.assignee?.full_name ?? '',
    dateText(l.created_at),
    createdBy(l),
    dateText(l.next_follow_up_at),
    dateText(l.last_contacted_at),
    visitText(l.visit_status, l.visit_at),
    l.fee_status ? FEE_STATUS[l.fee_status] ?? l.fee_status : '',
    num(l.fee_full),
    num(l.fee_discount),
    num(l.fee_final),
    num(l.fee_paid),
    num(l.fee_due),
    l.notes,
    l.student_ref,
    l.nu_admission_id,
    l.approval_status ? (APPROVAL[l.approval_status] ?? l.approval_status) : '',
    l.approval_status === 'approved' && l.approval_by ? (nameOf.get(l.approval_by) ?? '') : '',
    l.approval_status === 'approved' ? dateText(l.approval_at) : '',
  ]);

  // Record the export first (so it is logged even if sharing is cancelled)
  const { error: logError } = await supabase.from('export_logs').insert({
    user_id: userId,
    row_count: leads.length,
    filters: filters as unknown as Json,
  });
  if (logError) throw toError(logError);

  const stamp = new Date().toISOString().slice(0, 10);
  await writeAndShareSpreadsheet(`leads-${stamp}.xlsx`, EXPORT_HEADERS, rows, 'Leads');

  return leads.length;
}

/** Errors from an import as a downloadable Excel file. */
export async function shareImportErrors(errors: ImportError[]): Promise<void> {
  await writeAndShareSpreadsheet(
    'import-errors.xlsx',
    ['Row in your file', 'Problem'],
    errors.map((e) => [e.row, e.reason]),
    'Errors',
  );
}