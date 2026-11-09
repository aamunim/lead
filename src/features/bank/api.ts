import { supabase } from '@/shared/lib/supabase';

// =====================================================================
// 🏦 Lead Bank: numbers kept aside, out of the lead list (admins only).
//   New = never in the leads · Returned = came back from the leads.
//   Into the leads: a course, people in turn, a stage. A returned number
//   comes back as its own lead with all its history.
// =====================================================================

function toError(e: { message: string; hint?: string | null }): Error {
  const m = e.message ?? '';
  if (/could not find the function|relation .* does not exist|schema cache/i.test(m)) {
    return new Error('Lead Bank is not ready on the server yet. Please ask the admin to run the database update.');
  }
  if (/network|fetch/i.test(m)) return new Error('No internet connection. Please try again.');
  return new Error(m);
}

const rpc = async <T>(name: string, args: Record<string, unknown> = {}): Promise<T> => {
  const { data, error } = await supabase.rpc(name as never, args as never);
  if (error) throw toError(error);
  return data as T;
};

export type BankTab = 'new' | 'returned';

export type BankRow = {
  id: string;
  list_id: string | null;
  name: string | null;
  phone: string;
  whatsapp_number: string | null;
  area: string | null;
  note: string | null;
  tags: string[];
  status: 'new' | 'returned' | 'in_leads';
  do_not_call: boolean;
  lead_id: string | null;
  times_pulled: number;
  last_pulled_at: string | null;
  returned_at: string | null;
  return_reason: string | null;
  cooldown_until: string | null;
  created_at: string;
  list: { name: string } | null;
};

export type BankList = {
  id: string;
  name: string;
  note: string | null;
  new: number;
  returned: number;
  in_leads: number;
  pulled: number;
  admitted: number;
};

export type BankSummary = {
  new: number;
  returned: number;
  in_leads: number;
  resting: number;
  do_not_call: number;
  no_list: number;
  lists: BankList[];
};

export const BANK_PAGE = 50;

export async function bankSummary(): Promise<BankSummary | null> {
  return rpc<BankSummary | null>('bank_summary');
}

export type BankQuery = {
  tab: BankTab;
  /** a list id, 'none' (no list) or null (all) */
  listId?: string | null;
  search?: string;
  /** ⏳ resting ones too (they can't go out yet) */
  resting?: boolean;
  /** ⛔ only the "do not call" ones */
  dnc?: boolean;
  page?: number;
};

const COLS =
  'id, list_id, name, phone, whatsapp_number, area, note, tags, status, do_not_call, lead_id, times_pulled, ' +
  'last_pulled_at, returned_at, return_reason, cooldown_until, created_at, list:lead_bank_lists(name)';

function filtered<Q extends { eq: any; is: any; or: any; gt: any }>(query: Q, q: BankQuery): Q {
  query = query.eq('status', q.tab);
  if (q.listId === 'none') query = query.is('list_id', null);
  else if (q.listId) query = query.eq('list_id', q.listId);
  if (q.dnc) query = query.eq('do_not_call', true);
  else query = query.eq('do_not_call', false);
  if (!q.resting && !q.dnc) query = query.or(`cooldown_until.is.null,cooldown_until.lte.${new Date().toISOString()}`);
  const s = (q.search ?? '').trim();
  if (s) {
    const safe = s.replace(/[%,()*"\\:]/g, ' ');
    const digits = s.replace(/\D/g, '');
    const parts = [`name.ilike.%${safe}%`, `area.ilike.%${safe}%`];
    if (digits.length >= 3) parts.push(`phone.ilike.%${digits}%`, `whatsapp_number.ilike.%${digits}%`);
    query = query.or(parts.join(','));
  }
  return query;
}

export async function listBank(q: BankQuery): Promise<{ rows: BankRow[]; total: number }> {
  const page = q.page ?? 0;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let query: any = filtered(supabase.from('lead_bank' as never).select(COLS, { count: 'exact' }) as any, q);
  query = query
    .order(q.tab === 'returned' ? 'returned_at' : 'created_at', { ascending: false })
    // many share one time (one import, one "To bank"): the id keeps the pages apart
    .order('id', { ascending: false })
    .range(page * BANK_PAGE, page * BANK_PAGE + BANK_PAGE - 1);
  const { data, error, count } = await query;
  if (error) throw toError(error);
  return { rows: (data ?? []) as BankRow[], total: count ?? 0 };
}

/** "Select all that match" (at most 2000: one batch into the leads).
 *  In pages of 1000: the server never sends more than that at once. */
export async function listBankIds(q: BankQuery, limit = 2000): Promise<string[]> {
  const out: string[] = [];
  for (let from = 0; from < limit; from += 1000) {
    const to = Math.min(limit, from + 1000) - 1;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const query: any = filtered(supabase.from('lead_bank' as never).select('id') as any, q);
    const { data, error } = await query.order('created_at').order('id').range(from, to);
    if (error) throw toError(error);
    const ids = ((data ?? []) as { id: string }[]).map((r) => r.id);
    out.push(...ids);
    if (ids.length < to - from + 1) break;
  }
  return out;
}

// ---------------------------------------------------------------------
// Lists
// ---------------------------------------------------------------------
export async function createBankList(name: string, note?: string): Promise<string> {
  const { data, error } = await supabase
    .from('lead_bank_lists' as never)
    .insert({ name: name.trim(), note: note?.trim() || null } as never)
    .select('id')
    .single();
  if (error)
    throw toError(
      /duplicate|unique/i.test(error.message) ? { message: 'A list with this name is there already.' } : error,
    );
  return (data as unknown as { id: string }).id;
}

export async function renameBankList(id: string, name: string): Promise<void> {
  const { error } = await supabase
    .from('lead_bank_lists' as never)
    .update({ name: name.trim() } as never)
    .eq('id', id);
  if (error) throw toError(error);
}

/** The list goes; its numbers stay (with no list) */
export async function deleteBankList(id: string): Promise<void> {
  const { error } = await supabase
    .from('lead_bank_lists' as never)
    .delete()
    .eq('id', id);
  if (error) throw toError(error);
}

// ---------------------------------------------------------------------
// In, out, back
// ---------------------------------------------------------------------
export type BankInput = {
  name?: string;
  phone: string;
  whatsapp_number?: string;
  area?: string;
  note?: string;
  tags?: string[];
};
export type BankImportResult = { added: number; in_bank: number; in_leads: number; invalid: number };

/** In chunks of 2000 (one request each); onStep shows how far */
export async function importToBank(
  listId: string | null,
  rows: BankInput[],
  onStep?: (done: number) => void,
): Promise<BankImportResult> {
  const total: BankImportResult = { added: 0, in_bank: 0, in_leads: 0, invalid: 0 };
  for (let i = 0; i < rows.length; i += 2000) {
    const r = await rpc<BankImportResult>('bank_import', { p_list: listId, p_rows: rows.slice(i, i + 2000) });
    total.added += r.added;
    total.in_bank += r.in_bank;
    total.in_leads += r.in_leads;
    total.invalid += r.invalid;
    onStep?.(Math.min(rows.length, i + 2000));
  }
  return total;
}

/** "name, 017…" / "017…" / "017… name" per line → rows */
export function parsePasted(text: string): BankInput[] {
  const out: BankInput[] = [];
  for (const line of text.split(/\r?\n/)) {
    const t = line.trim();
    if (!t) continue;
    // exactly one number (the digits after it are not part of it)
    const m = t.match(/(?:\+?88)?0?1[3-9](?:[\s-]?\d){8}(?!\d)/);
    if (!m) continue;
    const phone = m[0].replace(/[\s-]/g, '');
    const name = t
      .replace(m[0], '')
      .replace(/^[\s,;:|-]+|[\s,;:|-]+$/g, '')
      .trim();
    out.push({ phone, name: name || undefined });
  }
  return out;
}

/** 500 per request (each new lead runs every lead rule on the server); people take
 *  turns across the parts as if it were one batch. onStep shows how far. */
export async function pullFromBank(
  input: {
    ids: string[];
    courseId: string | null;
    assignees: string[];
    stageId?: string | null;
  },
  onStep?: (done: number) => void,
): Promise<{ created: number; back: number; skipped: number }> {
  const total = { created: 0, back: 0, skipped: 0 };
  const people = input.assignees;
  let turn = 0;
  for (let i = 0; i < input.ids.length; i += 500) {
    const part = input.ids.slice(i, i + 500);
    // the next person in line starts this part
    const start = people.length ? turn % people.length : 0;
    const r = await rpc<{ created: number; back: number; skipped: number }>('bank_pull', {
      p_ids: part,
      p_course: input.courseId,
      p_assignees: [...people.slice(start), ...people.slice(0, start)],
      p_stage: input.stageId ?? null,
    });
    total.created += r.created;
    total.back += r.back;
    total.skipped += r.skipped;
    turn += r.created + r.back;
    onStep?.(Math.min(input.ids.length, i + 500));
  }
  return total;
}

export const RETURN_REASONS = ['Not reachable', 'Not interested now', 'Next session', 'Wrong number', 'Other'];

export async function returnToBank(
  leadIds: string[],
  reason: string | null,
  restDays = 30,
): Promise<{ returned: number; skipped: number }> {
  return rpc('bank_return', { p_lead_ids: leadIds, p_reason: reason, p_rest_days: restDays });
}

/** 200 ids at a time (a long list of ids would make the address too long) */
async function inChunks(ids: string[], work: (part: string[]) => PromiseLike<{ error: { message: string } | null }>) {
  for (let i = 0; i < ids.length; i += 200) {
    const { error } = await work(ids.slice(i, i + 200));
    if (error) throw toError(error);
  }
}

export async function setBankDoNotCall(ids: string[], on: boolean): Promise<void> {
  await inChunks(ids, (part) =>
    supabase
      .from('lead_bank' as never)
      .update({ do_not_call: on } as never)
      .in('id', part),
  );
}

export async function moveBankRows(ids: string[], listId: string | null): Promise<void> {
  await inChunks(ids, (part) =>
    supabase
      .from('lead_bank' as never)
      .update({ list_id: listId } as never)
      .in('id', part),
  );
}

/** Out of the bank for good (numbers now in the leads are left alone) */
export async function deleteBankRows(ids: string[]): Promise<void> {
  await inChunks(ids, (part) =>
    supabase
      .from('lead_bank' as never)
      .delete()
      .in('id', part)
      .neq('status', 'in_leads'),
  );
}

/** Days left resting ("rests 12 more days"), or null */
export function restingDays(r: Pick<BankRow, 'cooldown_until'>): number | null {
  if (!r.cooldown_until) return null;
  const ms = new Date(r.cooldown_until).getTime() - Date.now();
  return ms > 0 ? Math.ceil(ms / 86400000) : null;
}
