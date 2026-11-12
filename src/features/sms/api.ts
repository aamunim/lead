import { getSetting, updateSetting } from '@/features/settings/api';
import { supabase } from '@/shared/lib/supabase';
import type { Json } from '@/shared/types/database';

// =====================================================================
// 📨 SMS: your SMS company (API), sender IDs, bulk SMS (alumni for now)
//   The API key stays on the server; the app only sees "abc…wxyz".
//   A send waits in a queue; every minute the server sends the next ones
//   and marks each Sent / Failed from the company's answer.
// =====================================================================

function toError(e: { message: string }): Error {
  if (/could not find the function|relation .* does not exist|schema cache/i.test(e.message)) {
    return new Error('SMS is not ready on the server yet. Please ask the admin to run the database update.');
  }
  if (/network|fetch/i.test(e.message)) return new Error('No internet connection. Please try again.');
  return new Error(e.message);
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function rpc<T>(fn: string, args?: Record<string, unknown>): Promise<T> {
  const { data, error } = await supabase.rpc(fn as never, args as never);
  if (error) throw toError(error);
  return data as T;
}

// ---------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------
export type SmsRule = { all: boolean; roles: string[]; user_ids: string[] };
export type SmsSettings = {
  enabled: boolean;
  /** who may send (admins always) */
  send: SmsRule;
  /** how many SMS go out each minute */
  per_minute: number;
  /** at most this many people in one send */
  max_per_send: number;
};
export const DEFAULT_SMS_SETTINGS: SmsSettings = {
  enabled: false,
  send: { all: false, roles: ['admin'], user_ids: [] },
  per_minute: 60,
  max_per_send: 5000,
};

export async function getSmsSettings(): Promise<SmsSettings> {
  const s = await getSetting<Partial<SmsSettings>>('sms').catch(() => null);
  return {
    ...DEFAULT_SMS_SETTINGS,
    ...(s ?? {}),
    send: { ...DEFAULT_SMS_SETTINGS.send, ...(s?.send ?? {}) },
  };
}
export async function saveSmsSettings(s: SmsSettings): Promise<void> {
  await updateSetting('sms', s as unknown as Json);
}

export type SenderKind = 'masking' | 'non_masking';
export const KIND_LABEL: Record<SenderKind, string> = { masking: 'Masking', non_masking: 'Non-masking' };

export type SmsSender = {
  id: string;
  sender_id: string;
  kind: SenderKind;
  label: string | null;
  is_active: boolean;
  is_default: boolean;
};
export type NumberFormat = '0' | '880' | '+880';
export type SmsProvider = {
  id: string;
  name: string;
  send_url: string;
  method: 'GET' | 'POST';
  balance_url: string | null;
  number_format: NumberFormat;
  success_match: string | null;
  is_active: boolean;
  key_set: boolean;
  key_hint: string | null;
  updated_at: string;
  senders: SmsSender[];
};
export type SmsAdmin = { settings: SmsSettings; providers: SmsProvider[]; pg_net: boolean };

export async function getSmsAdmin(): Promise<SmsAdmin> {
  return rpc<SmsAdmin>('sms_admin_get');
}

export type ProviderInput = {
  name: string;
  send_url: string;
  method: 'GET' | 'POST';
  balance_url: string | null;
  number_format: NumberFormat;
  success_match: string | null;
  is_active: boolean;
  /** only when typed (empty keeps the saved one) */
  api_key?: string;
};
export async function saveProvider(id: string | null, p: ProviderInput): Promise<string> {
  return rpc<string>('sms_provider_save', { p_id: id, p });
}
export async function deleteProvider(id: string): Promise<void> {
  await rpc('sms_provider_delete', { p_id: id });
}
export async function removeProviderKey(id: string): Promise<void> {
  await rpc('sms_provider_remove_key', { p_id: id });
}

export type SenderInput = {
  provider_id: string;
  sender_id: string;
  kind: SenderKind;
  label?: string | null;
  is_active: boolean;
  is_default: boolean;
};
export async function saveSender(id: string | null, p: SenderInput): Promise<string> {
  return rpc<string>('sms_sender_save', { p_id: id, p });
}
export async function deleteSender(id: string): Promise<void> {
  await rpc('sms_sender_delete', { p_id: id });
}

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** 💰 The balance: asks the company, then waits for its answer (a few seconds) */
export async function checkBalance(): Promise<{ status: number | null; body: string | null; error: string | null }> {
  const req = await rpc<number>('sms_balance_request');
  for (let i = 0; i < 10; i++) {
    await wait(1200);
    const r = await rpc<{ status: number | null; body: string | null; error: string | null } | null>(
      'sms_balance_result',
      { p_request: req },
    );
    if (r) return r;
  }
  return { status: null, body: null, error: 'No answer yet. Try again in a minute.' };
}

/** 🧪 A test SMS; then waits for the company's answer (up to ~15 s) */
export async function sendTest(phone: string, message: string, senderId: string): Promise<SmsBatchDetail> {
  const batch = await rpc<string>('sms_send_test', { p_phone: phone, p_message: message, p_sender: senderId });
  let d = await getBatch(batch);
  for (let i = 0; i < 12 && d.counts.waiting > 0; i++) {
    await wait(1300);
    // the server reads answers each minute; this asks it to read now
    await supabase.rpc('sms_check_now' as never).then(
      () => undefined,
      () => undefined,
    );
    d = await getBatch(batch);
  }
  return d;
}

// ---------------------------------------------------------------------
// Sending
// ---------------------------------------------------------------------
export async function canSendSms(): Promise<boolean> {
  return rpc<boolean>('sms_can_send').catch(() => false);
}

export type MySender = { id: string; sender_id: string; kind: SenderKind; label: string | null; is_default: boolean };
export async function mySenders(): Promise<MySender[]> {
  return rpc<MySender[]>('sms_senders_for_me');
}

export type SmsPreview = {
  selected: number;
  can_send: number;
  no_number: number;
  do_not_contact: number;
  got_sms_before: number;
  got_this_before: number;
  /** different numbers that will get it */
  will_get: number;
};
export async function previewAlumniSms(ids: string[], skipBatch?: string | null): Promise<SmsPreview> {
  return rpc<SmsPreview>('alumni_sms_preview', { p_ids: ids, p_batch: skipBatch ?? null });
}

export async function sendAlumniSms(opts: {
  ids: string[];
  message: string;
  senderId: string;
  name?: string | null;
  skipBatch?: string | null;
}): Promise<{ batch_id: string; queued: number; parts: number }> {
  return rpc('alumni_sms_send', {
    p_ids: opts.ids,
    p_message: opts.message,
    p_sender: opts.senderId,
    p_name: opts.name ?? null,
    p_skip_batch: opts.skipBatch ?? null,
  });
}

// ---------------------------------------------------------------------
// The sends
// ---------------------------------------------------------------------
export type SmsGroup = 'active' | 'not_now' | 'admitted';
export const GROUP_LABEL: Record<SmsGroup, string> = { active: 'Active', not_now: 'Not Now', admitted: 'Admitted' };

export type SmsBatch = {
  id: string;
  audience: 'alumni' | 'test' | 'leads';
  group_key?: SmsGroup | null;
  filter_label?: string | null;
  scheduled_at?: string | null;
  name: string | null;
  message: string;
  sender_text: string | null;
  sender_kind: SenderKind | null;
  total: number;
  status: 'sending' | 'done' | 'cancelled';
  created_at: string;
  done_at: string | null;
  by_name: string | null;
  sent: number;
  failed: number;
  waiting: number;
  cancelled: number;
  parts_sent: number;
};
export async function listBatches(limit = 50, before?: string | null): Promise<SmsBatch[]> {
  return rpc<SmsBatch[]>('sms_batches_list', { p_limit: limit, p_before: before ?? null });
}

export type SmsStatus = 'queued' | 'sending' | 'sent' | 'failed' | 'cancelled';
export type SmsMessage = {
  id: string;
  alumni_id: string | null;
  lead_id?: string | null;
  name: string | null;
  phone: string;
  status: SmsStatus;
  parts: number;
  error: string | null;
  response: string | null;
  sent_at: string | null;
  done_at: string | null;
};
export type SmsBatchDetail = {
  batch: Omit<SmsBatch, 'sent' | 'failed' | 'waiting' | 'cancelled' | 'parts_sent'>;
  counts: { sent: number; failed: number; waiting: number; cancelled: number; parts: number };
  messages: SmsMessage[];
};
export type DetailFilter = 'sent' | 'failed' | 'waiting' | 'cancelled' | null;
export async function getBatch(id: string, status: DetailFilter = null): Promise<SmsBatchDetail> {
  return rpc<SmsBatchDetail>('sms_batch_detail', { p_batch: id, p_status: status });
}
export async function cancelBatch(id: string): Promise<number> {
  return rpc<number>('sms_batch_cancel', { p_batch: id });
}
export async function retryBatch(id: string): Promise<number> {
  return rpc<number>('sms_batch_retry', { p_batch: id });
}

export type AlumnusSms = {
  id: string;
  batch_id: string;
  body: string;
  status: SmsStatus;
  error: string | null;
  sender: string | null;
  at: string;
};
export async function alumnusSms(alumniId: string): Promise<AlumnusSms[]> {
  return rpc<AlumnusSms[]>('alumni_sms_list', { p_alumni: alumniId });
}

// ---------------------------------------------------------------------
// Length: English 160 a SMS (153 each when longer); Bangla / emoji 70 (67)
// ---------------------------------------------------------------------
export function smsLength(text: string): { chars: number; parts: number; unicode: boolean } {
  // eslint-disable-next-line no-control-regex
  const unicode = /[^\x01-\x7E]/.test(text);
  const chars = [...text].length;
  if (unicode) return { chars, parts: chars <= 70 ? 1 : Math.ceil(chars / 67), unicode };
  const n7 = chars + (text.match(/[\^{}\\[\]~|]/g)?.length ?? 0);
  return { chars, parts: n7 <= 160 ? 1 : Math.ceil(n7 / 153), unicode };
}

/** {name} {first_name} filled for one person (the preview) */
export function fillSms(text: string, name: string | null | undefined): string {
  const full = (name ?? '').trim();
  return text.replaceAll('{name}', full).replaceAll('{first_name}', full.split(/\s+/)[0] ?? '');
}

export const STATUS_LABEL: Record<SmsStatus, string> = {
  queued: 'Waiting',
  sending: 'Sending',
  sent: 'Sent',
  failed: 'Failed',
  cancelled: 'Stopped',
};

// ---------------------------------------------------------------------
// 📨 SMS Center: leads (Active / Not Now / Admitted)
// ---------------------------------------------------------------------
export type LeadSmsPreview = {
  selected: number;
  visible: number;
  other_group: number;
  no_number: number;
  same_number: number;
  got_sms_before: number;
  will_get: number;
};
export async function previewLeadSms(ids: string[], group: SmsGroup): Promise<LeadSmsPreview> {
  return rpc<LeadSmsPreview>('lead_sms_preview', { p_ids: ids, p_group: group });
}

export async function sendLeadSms(opts: {
  ids: string[];
  group: SmsGroup;
  message: string;
  senderId: string;
  name?: string | null;
  filterLabel?: string | null;
  at?: Date | null;
}): Promise<{ batch_id: string; queued: number; parts: number; scheduled_at: string | null }> {
  return rpc('lead_sms_send', {
    p_ids: opts.ids,
    p_group: opts.group,
    p_message: opts.message,
    p_sender: opts.senderId,
    p_name: opts.name ?? null,
    p_filter_label: opts.filterLabel ?? null,
    p_at: opts.at ? opts.at.toISOString() : null,
  });
}

/** Who got this send (true) / who didn't (false): lead ids, to open in the lead list */
export async function batchLeadIds(batchId: string, got: boolean): Promise<string[]> {
  return rpc<string[]>('sms_batch_lead_ids', { p_batch: batchId, p_got: got });
}

export async function leadSms(leadId: string): Promise<AlumnusSms[]> {
  return rpc<AlumnusSms[]>('lead_sms_list', { p_lead: leadId });
}

/** The placeholders an SMS to leads can use */
export const LEAD_PLACEHOLDERS = [
  '{first_name}',
  '{name}',
  '{course}',
  '{stage}',
  '{student_id}',
  '{fee_due}',
  '{owner}',
  '{owner_phone}',
] as const;

/** One lead's values, for the preview */
export function fillLeadSms(
  text: string,
  v: {
    name: string;
    course?: string | null;
    stage?: string | null;
    student_id?: string | null;
    fee_due?: number | null;
    owner?: string | null;
    owner_phone?: string | null;
  },
): string {
  return fillSms(text, v.name)
    .replaceAll('{course}', v.course ?? '')
    .replaceAll('{stage}', v.stage ?? '')
    .replaceAll('{student_id}', v.student_id ?? '')
    .replaceAll('{fee_due}', Math.round(v.fee_due ?? 0).toLocaleString('en-US'))
    .replaceAll('{owner_phone}', v.owner_phone ?? '')
    .replaceAll('{owner}', v.owner ?? '');
}

// 🤖 three drafts from the AI (Edge Function ai-sms)
export type AiSmsInput = {
  group: SmsGroup | 'alumni';
  goal: string;
  hint?: string;
  tone?: string;
  language: 'bn' | 'en';
  length: number;
  current?: string;
  audience?: { count?: number; filter?: string };
};
export async function aiSmsDrafts(input: AiSmsInput): Promise<string[]> {
  const { data, error } = await supabase.functions.invoke('ai-sms', { body: input });
  if (error) {
    let msg = error.message;
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const body = await (error as any).context?.json?.();
      if (body?.error) msg = body.error;
    } catch {
      /* keep the first message */
    }
    if (/not found|404|failed to send a request/i.test(msg)) {
      msg = 'AI SMS is not ready on the server yet (Edge Function ai-sms). Please ask the admin to deploy it.';
    }
    throw new Error(msg);
  }
  const d = data as { options?: string[]; error?: string };
  if (d?.error) throw new Error(d.error);
  return d?.options ?? [];
}

// A choice handed from the lead list to SMS Center (too many ids for a link)
let draftIds: { ids: string[]; group: SmsGroup } | null = null;
export const smsDraft = {
  set(ids: string[], group: SmsGroup) {
    draftIds = { ids, group };
  },
  take(): { ids: string[]; group: SmsGroup } | null {
    const d = draftIds;
    draftIds = null;
    return d;
  },
};

// ---------------------------------------------------------------------
// 🤖 AI suggestions: "which leads should get which SMS today?"
//   The server's ready groups of my leads; the AI picks and writes
// ---------------------------------------------------------------------
export type SmsSuggestion = {
  key: string;
  group: SmsGroup;
  title: string;
  count: number;
  skipped_recent_sms?: number;
  lead_ids: string[];
  why?: string;
  message?: string;
  priority?: number;
};
export async function aiSmsPlan(opts: {
  question: string;
  language: 'bn' | 'en';
  skipDays: number;
}): Promise<{ suggestions: SmsSuggestion[]; others: SmsSuggestion[]; note?: string }> {
  const { data, error } = await supabase.functions.invoke('ai-sms', {
    body: { mode: 'plan', question: opts.question, language: opts.language, skip_days: opts.skipDays },
  });
  if (error) {
    let msg = error.message;
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const body = await (error as any).context?.json?.();
      if (body?.error) msg = body.error;
    } catch {
      /* keep the first message */
    }
    if (/not found|404|failed to send a request/i.test(msg)) {
      msg = 'AI SMS is not ready on the server yet (Edge Function ai-sms). Please ask the admin to deploy it.';
    }
    throw new Error(msg);
  }
  const d = data as { suggestions?: SmsSuggestion[]; others?: SmsSuggestion[]; note?: string; error?: string };
  if (d?.error) throw new Error(d.error);
  return { suggestions: d?.suggestions ?? [], others: d?.others ?? [], note: d?.note };
}
