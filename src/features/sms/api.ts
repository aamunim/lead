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
export type SmsBatch = {
  id: string;
  audience: 'alumni' | 'test';
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
