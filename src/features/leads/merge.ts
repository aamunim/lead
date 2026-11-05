import { supabase } from '@/shared/lib/supabase';

// =====================================================================
// 🔗 Merge leads: one person who called from two (or more) numbers.
//   Everything moves to the main lead; the others are hidden
//   ("merged into …"). Admins can undo it for 30 days.
// =====================================================================

/** The values the person picks on the merge screen (the rest is joined) */
export type MergeFields = Partial<{
  name: string;
  stage_id: string;
  assigned_to: string | null;
  source_id: string | null;
  rating: string | null;
  email: string | null;
  area: string | null;
  guardian_name: string | null;
  guardian_phone: string | null;
  guardian_relation: string | null;
  referred_by: string | null;
  lead_type_id: string | null;
  campaign_id: string | null;
}>;

/** Days a merge can be undone */
export const UNMERGE_DAYS = 30;

function toError(e: { message: string }): Error {
  if (/could not find the function/i.test(e.message)) {
    return new Error('The database is not updated yet.');
  }
  return new Error(/network|fetch/i.test(e.message) ? 'No internet connection. Please try again.' : e.message);
}

export async function mergeLeads(mainId: string, otherIds: string[], fields: MergeFields): Promise<string> {
  const { data, error } = await supabase.rpc(
    'merge_leads' as never,
    {
      p_main: mainId,
      p_others: otherIds,
      p_fields: fields,
    } as never,
  );
  if (error) throw toError(error);
  return String(data);
}

export async function unmergeLead(mergeId: string): Promise<void> {
  const { error } = await supabase.rpc('unmerge_lead' as never, { p_merge: mergeId } as never);
  if (error) throw toError(error);
}

/** ☎ Put a number on a lead (from the duplicate warning on the Add lead form) */
export async function addLeadPhone(leadId: string, phone: string): Promise<void> {
  const { error } = await supabase.rpc('add_lead_phone' as never, { p_lead: leadId, p_phone: phone } as never);
  if (error) throw toError(error);
}

/** A lead that was merged away: the lead it lives in now */
export async function mergedInto(leadId: string): Promise<string | null> {
  const { data } = await supabase.from('leads').select('merged_into').eq('id', leadId).maybeSingle();
  return (data as { merged_into?: string | null } | null)?.merged_into ?? null;
}

/** Can a merge (from the change log line) still be undone? */
export function canUndoMerge(at: string | Date, undoneAt?: unknown): boolean {
  if (undoneAt) return false;
  return Date.now() - new Date(at).getTime() < UNMERGE_DAYS * 86400000;
}
