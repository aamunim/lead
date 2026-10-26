import { supabase } from '@/shared/lib/supabase';

// =====================================================================
// Admission papers
//   Settings: the list of papers (required or not, for which courses)
//   Lead:     which were received, original or photocopy, where they are kept
// =====================================================================

/** Admitting with required papers missing (Settings → Admission rules) */
export type PapersOnAdmit = 'block' | 'warn' | 'allow';

export type AdmissionPaper = {
  id: string;
  name: string;
  description: string | null;
  isRequired: boolean;
  /** Empty = all courses */
  courseIds: string[];
  sortOrder: number;
  isActive: boolean;
};

export type PaperStatus = 'received' | 'not_needed';
export type CopyType = 'original' | 'photocopy';

/** One paper on the lead's Papers card */
export type LeadPaper = {
  paperId: string;
  name: string;
  description: string | null;
  isRequired: boolean;
  /** null = not received yet */
  status: PaperStatus | null;
  copyType: CopyType | null;
  /** Only when this paper is kept somewhere else than the student's file */
  keptAt: string | null;
  note: string | null;
  receivedAt: Date | null;
  receivedByName: string | null;
  returnedAt: Date | null;
  returnedByName: string | null;
};

export type LeadPapers = {
  papers: LeadPaper[];
  /** Where the student's whole file is kept */
  folder: string | null;
  required: number;
  /** Required papers received or marked "not needed" */
  done: number;
  /** Originals with us, not returned yet */
  originalsHeld: number;
};

// =====================================================================
// Errors
// =====================================================================
function toError(error: { message: string; code?: string }): Error {
  const m = error.message.toLowerCase();
  if (m.includes('network request failed') || m.includes('fetch')) {
    return new Error('No internet connection. Please try again.');
  }
  if (error.code === '23503' || m.includes('foreign key')) {
    return new Error('Some leads already have this paper ticked. Switch it off instead of removing it.');
  }
  if (error.code === '23514') {
    return new Error('Please give the paper a name (up to 60 letters).');
  }
  return new Error(error.message);
}

// =====================================================================
// Settings: the papers list
// =====================================================================
type RawPaper = {
  id: string;
  name: string;
  description: string | null;
  is_required: boolean;
  course_ids: string[] | null;
  sort_order: number;
  is_active: boolean;
};

const toPaper = (p: RawPaper): AdmissionPaper => ({
  id: p.id,
  name: p.name,
  description: p.description,
  isRequired: p.is_required,
  courseIds: p.course_ids ?? [],
  sortOrder: p.sort_order,
  isActive: p.is_active,
});

export async function listAdmissionPapers(includeInactive = false): Promise<AdmissionPaper[]> {
  let query = supabase
    .from('admission_papers')
    .select('id, name, description, is_required, course_ids, sort_order, is_active')
    .order('sort_order')
    .order('name');
  if (!includeInactive) query = query.eq('is_active', true);

  const { data, error } = await query;
  if (error) throw toError(error);
  return ((data ?? []) as unknown as RawPaper[]).map(toPaper);
}

export type PaperInput = {
  name: string;
  description?: string | null;
  isRequired: boolean;
  courseIds: string[];
  isActive?: boolean;
};

const paperColumns = (p: Partial<PaperInput>) => {
  const out: Record<string, unknown> = {};
  if (p.name !== undefined) out.name = p.name.trim();
  if (p.description !== undefined) out.description = p.description?.trim() || null;
  if (p.isRequired !== undefined) out.is_required = p.isRequired;
  if (p.courseIds !== undefined) out.course_ids = p.courseIds.length > 0 ? p.courseIds : null;
  if (p.isActive !== undefined) out.is_active = p.isActive;
  return out;
};

export async function createPaper(input: PaperInput, sortOrder: number): Promise<void> {
  const { error } = await supabase
    .from('admission_papers')
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    .insert({ ...paperColumns(input), sort_order: sortOrder } as any);
  if (error) throw toError(error);
}

export async function updatePaper(id: string, patch: Partial<PaperInput>): Promise<void> {
  const { error } = await supabase.from('admission_papers').update(paperColumns(patch)).eq('id', id);
  if (error) throw toError(error);
}

export async function deletePaper(id: string): Promise<void> {
  const { error } = await supabase.from('admission_papers').delete().eq('id', id);
  if (error) throw toError(error);
}

/** Save a new order (ids from top to bottom) */
export async function reorderPapers(ids: string[]): Promise<void> {
  for (let i = 0; i < ids.length; i++) {
    const { error } = await supabase.from('admission_papers').update({ sort_order: i + 1 }).eq('id', ids[i]);
    if (error) throw toError(error);
  }
}

// =====================================================================
// One lead's papers
// =====================================================================
type RawStatus = {
  paper_id: string;
  name: string;
  description: string | null;
  is_required: boolean;
  record_id: string | null;
  status: string | null;
  copy_type: string | null;
  kept_at: string | null;
  note: string | null;
  received_at: string | null;
  received_by_name: string | null;
  returned_at: string | null;
  returned_by_name: string | null;
};

export async function getLeadPapers(leadId: string): Promise<LeadPapers> {
  const [statusRes, folderRes] = await Promise.all([
    supabase.rpc('lead_papers_status', { p_lead_id: leadId }),
    supabase.from('lead_paper_folders').select('kept_at').eq('lead_id', leadId).maybeSingle(),
  ]);
  if (statusRes.error) throw toError(statusRes.error);
  if (folderRes.error) throw toError(folderRes.error);

  const papers: LeadPaper[] = ((statusRes.data ?? []) as unknown as RawStatus[]).map((r) => ({
    paperId: r.paper_id,
    name: r.name,
    description: r.description,
    isRequired: r.is_required,
    status: r.record_id ? ((r.status as PaperStatus) ?? 'received') : null,
    copyType: (r.copy_type as CopyType | null) ?? null,
    keptAt: r.kept_at,
    note: r.note,
    receivedAt: r.received_at ? new Date(r.received_at) : null,
    receivedByName: r.received_by_name,
    returnedAt: r.returned_at ? new Date(r.returned_at) : null,
    returnedByName: r.returned_by_name,
  }));

  // Required first, then optional, then papers that no longer apply
  const required = papers.filter((p) => p.isRequired);
  return {
    papers,
    folder: (folderRes.data as { kept_at: string } | null)?.kept_at ?? null,
    required: required.length,
    done: required.filter((p) => p.status !== null).length,
    originalsHeld: papers.filter((p) => p.status === 'received' && p.copyType === 'original' && !p.returnedAt).length,
  };
}

/** Tick / change one paper. status null = untick. */
export async function setLeadPaper(
  leadId: string,
  paperId: string,
  value: {
    status: PaperStatus | null;
    copyType?: CopyType | null;
    keptAt?: string | null;
    note?: string | null;
  },
): Promise<void> {
  const { error } = await supabase.rpc('set_lead_paper', {
    p_lead_id: leadId,
    p_paper_id: paperId,
    p_status: value.status,
    p_copy_type: value.copyType ?? null,
    p_kept_at: value.keptAt?.trim() || null,
    p_note: value.note?.trim() || null,
  });
  if (error) throw toError(error);
}

/** An original given back to the student (undo = it's with us again) */
export async function returnLeadPaper(leadId: string, paperId: string, undo = false): Promise<void> {
  const { error } = await supabase.rpc('return_lead_paper', {
    p_lead_id: leadId,
    p_paper_id: paperId,
    p_undo: undo,
  });
  if (error) throw toError(error);
}

/** Where the student's file is kept (empty = remove) */
export async function setPaperFolder(leadId: string, keptAt: string): Promise<void> {
  const { error } = await supabase.rpc('set_paper_folder', { p_lead_id: leadId, p_kept_at: keptAt.trim() });
  if (error) throw toError(error);
}

/** Places typed before, newest first */
export async function paperPlaceSuggestions(): Promise<string[]> {
  const { data, error } = await supabase.rpc('paper_place_suggestions');
  if (error) return [];
  return ((data ?? []) as { kept_at: string }[]).map((r) => r.kept_at);
}

/** Required papers still missing (while admitting: for the chosen course) */
export async function listMissingPapers(leadId: string, courseId?: string | null): Promise<string[]> {
  const { data, error } = await supabase.rpc('lead_missing_papers', {
    p_lead_id: leadId,
    p_course_id: courseId ?? null,
  });
  if (error) throw toError(error);
  return ((data ?? []) as { name: string }[]).map((r) => r.name);
}

// =====================================================================
// Small helpers for showing
// =====================================================================
/** "📄 3/5" for a lead card; null when no paper is required */
export function papersBadge(required: number, done: number): { text: string; complete: boolean } | null {
  if (!required) return null;
  return { text: `📄 ${done}/${required}`, complete: done >= required };
}

export function copyLabel(c: CopyType | null): string | null {
  if (c === 'original') return 'Original';
  if (c === 'photocopy') return 'Photocopy';
  return null;
}

/** "22 Oct" */
export function shortDay(d: Date | null): string {
  return d ? d.toLocaleDateString([], { day: 'numeric', month: 'short' }) : '';
}