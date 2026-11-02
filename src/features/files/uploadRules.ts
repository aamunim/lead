import { supabase } from '@/shared/lib/supabase';

// =====================================================================
// 📎 Upload rules (Settings → Upload rules): picture size and weight,
//   PDF weight, what a paper takes; and the iLovePDF accounts that make
//   big PDFs smaller on the server. Admins and the Admission Officer.
// =====================================================================

export type UploadDefaults = { img_max_side: number; img_max_kb: number; pdf_max_kb: number };
export const DEFAULT_UPLOAD: UploadDefaults = { img_max_side: 1600, img_max_kb: 500, pdf_max_kb: 2048 };

export type PaperRule = {
  id: string;
  name: string;
  is_active: boolean;
  accept: 'any' | 'image' | 'pdf';
  img_width: number | null;
  img_height: number | null;
  img_max_kb: number | null;
  pdf_max_kb: number | null;
};

/** What applies to one upload (a paper's own rule, else the defaults) */
export type AppliedRule = {
  accept: 'any' | 'image' | 'pdf';
  /** exact size (stretched to fit, nothing cut off) */
  exact: { width: number; height: number } | null;
  /** else: the longest side at most */
  maxSide: number;
  imgMaxKb: number;
  pdfMaxKb: number;
};

function toError(e: { message: string }): Error {
  return new Error(/network|fetch/i.test(e.message) ? 'No internet connection. Please try again.' : e.message);
}

export async function getUploadDefaults(): Promise<UploadDefaults> {
  const { data } = await supabase.rpc('upload_rules_setting');
  return { ...DEFAULT_UPLOAD, ...((data ?? {}) as Partial<UploadDefaults>) };
}

export async function saveUploadDefaults(d: UploadDefaults): Promise<void> {
  const { error } = await supabase.rpc('set_upload_defaults', {
    p_img_max_side: d.img_max_side,
    p_img_max_kb: d.img_max_kb,
    p_pdf_max_kb: d.pdf_max_kb,
  });
  if (error) throw toError(error);
}

export async function listPaperRules(): Promise<PaperRule[]> {
  const { data, error } = await supabase
    .from('admission_papers')
    .select('id, name, is_active, accept, img_width, img_height, img_max_kb, pdf_max_kb')
    .order('sort_order')
    .order('name');
  if (error) throw toError(error);
  return (data ?? []) as PaperRule[];
}

export async function savePaperRule(r: PaperRule): Promise<void> {
  const { error } = await supabase.rpc('set_paper_upload_rule', {
    p_paper: r.id,
    p_accept: r.accept,
    p_img_width: r.img_width ?? undefined,
    p_img_height: r.img_height ?? undefined,
    p_img_max_kb: r.img_max_kb ?? undefined,
    p_pdf_max_kb: r.pdf_max_kb ?? undefined,
  });
  if (error) throw toError(error);
}

export async function canEditUploadRules(): Promise<boolean> {
  const { data } = await supabase.rpc('can_edit_upload_rules');
  return !!data;
}

/** The rule for one upload */
export async function ruleFor(paperId: string | null): Promise<AppliedRule> {
  const d = await getUploadDefaults();
  type Own = Pick<PaperRule, 'accept' | 'img_width' | 'img_height' | 'img_max_kb' | 'pdf_max_kb'>;
  let p: Own | null = null;
  if (paperId) {
    const { data } = await supabase
      .from('admission_papers')
      .select('accept, img_width, img_height, img_max_kb, pdf_max_kb')
      .eq('id', paperId)
      .maybeSingle();
    p = (data as unknown as Own | null) ?? null;
  }
  return {
    accept: p?.accept ?? 'any',
    exact: p?.img_width && p?.img_height ? { width: p.img_width, height: p.img_height } : null,
    maxSide: d.img_max_side,
    imgMaxKb: p?.img_max_kb ?? d.img_max_kb,
    pdfMaxKb: p?.pdf_max_kb ?? d.pdf_max_kb,
  };
}

// ---------------------------------------------------------------------
// iLovePDF accounts (the keys stay on the server; only a hint comes back)
// ---------------------------------------------------------------------
export type PdfAccount = {
  id: string;
  label: string;
  key_hint: string;
  is_active: boolean;
  sort_order: number;
  files_month: number;
  last_used_at: string | null;
  last_error: string | null;
  last_error_at: string | null;
};

export async function listPdfAccounts(): Promise<PdfAccount[]> {
  const { data, error } = await supabase.rpc('list_ilovepdf_accounts');
  if (error) throw toError(error);
  return (data ?? []) as PdfAccount[];
}

export async function addPdfAccount(label: string, publicKey: string): Promise<void> {
  const { error } = await supabase.rpc('add_ilovepdf_account', { p_label: label, p_public_key: publicKey });
  if (error) throw toError(error);
}

export async function updatePdfAccount(
  id: string,
  patch: { label?: string; is_active?: boolean; sort_order?: number },
) {
  const { error } = await supabase.rpc('update_ilovepdf_account', {
    p_id: id,
    p_label: patch.label ?? '',
    p_is_active: patch.is_active ?? undefined,
    p_sort_order: patch.sort_order ?? undefined,
  });
  if (error) throw toError(error);
}

export async function deletePdfAccount(id: string): Promise<void> {
  const { error } = await supabase.rpc('delete_ilovepdf_account', { p_id: id });
  if (error) throw toError(error);
}
