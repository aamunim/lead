import { File, Paths } from 'expo-file-system';
import * as Sharing from 'expo-sharing';
import { Platform } from 'react-native';
import * as XLSX from 'xlsx';

import { describeChange, type StageInfo } from '@/features/activity/api';
import { formatDuration, outcomeInfo } from '@/features/calls/api';
import { supabase } from '@/shared/lib/supabase';

// =====================================================================
// 📤 One person's work for a period → Excel / text / CSV
//   The server checks who may export whom (yourself; admins everyone;
//   Team Leads their team). Times are shown in Bangladesh time.
// =====================================================================

export type WorkPart = 'summary' | 'calls' | 'notes' | 'changes' | 'added';
export type WorkFormat = 'xlsx' | 'txt' | 'csv';

export const WORK_PARTS: { key: WorkPart; label: string }[] = [
  { key: 'summary', label: '📊 Summary' },
  { key: 'calls', label: '📞 Call log' },
  { key: 'notes', label: '📝 Notes' },
  { key: 'changes', label: '🔄 Changes' },
  { key: 'added', label: '➕ Leads added' },
];

type Summary = {
  calls: number;
  connected: number;
  talk_sec: number;
  outgoing: number;
  incoming: number;
  missed: number;
  wa_calls: number;
  wa_messages: number;
  leads_called: number;
  notes: number;
  follow_ups: number;
  stage_changes: number;
  leads_added: number;
  admitted: number;
  app_sec: number;
  sessions: number;
  first_at: string | null;
  last_at: string | null;
};

type CallRow = {
  called_at: string;
  direction: string;
  outcome: string;
  duration_sec: number | null;
  channel: string;
  media: string | null;
  sim_label: string | null;
  source: string | null;
  notes: string | null;
  lead_name: string;
  lead_phone: string | null;
  stage: string | null;
};

export type WorkData = {
  person: { id: string; name: string | null; role: string; email: string | null };
  from: string;
  to: string;
  summary: Summary;
  calls: CallRow[];
  notes: { created_at: string; note: string | null; lead_name: string; lead_phone: string | null }[];
  changes: {
    created_at: string;
    action: string;
    details: Record<string, unknown>;
    lead_name: string;
    lead_phone: string | null;
  }[];
  leads_added: {
    created_at: string;
    name: string;
    phone: string | null;
    source: string | null;
    stage: string | null;
    imported: boolean;
  }[];
  capped: number;
};

export async function fetchWork(userId: string, from: string, to: string): Promise<WorkData> {
  const { data, error } = await supabase.rpc('user_export', { p_user: userId, p_from: from, p_to: to });
  if (error) throw new Error(error.message);
  return data as unknown as WorkData;
}

// ---------------------------------------------------------------------
// Bangladesh time (UTC+6, no summer time): the same on every phone
// ---------------------------------------------------------------------
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const dhaka = (iso: string) => new Date(new Date(iso).getTime() + 6 * 3600 * 1000);
export function bdDate(iso: string): string {
  const d = dhaka(iso);
  return `${String(d.getUTCDate()).padStart(2, '0')} ${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()}`;
}
export function bdTime(iso: string): string {
  const d = dhaka(iso);
  const h = d.getUTCHours();
  return `${h % 12 || 12}:${String(d.getUTCMinutes()).padStart(2, '0')} ${h < 12 ? 'AM' : 'PM'}`;
}
const bdDay = (ymd: string) => {
  const [y, m, d] = ymd.split('-').map(Number);
  return `${String(d).padStart(2, '0')} ${MONTHS[m - 1]} ${y}`;
};
export const periodText = (from: string, to: string) => (from === to ? bdDay(from) : `${bdDay(from)} – ${bdDay(to)}`);

const ROLE: Record<string, string> = {
  super_admin: 'Super Admin',
  admin: 'Admin',
  team_lead: 'Team Lead',
  caller: 'Caller',
  admission_officer: 'Admission Officer',
};
const roleName = (k: string) => ROLE[k] ?? k.replace(/_/g, ' ');
const dur = (sec: number | null | undefined) => formatDuration(sec ?? 0) ?? '0s';
const pct = (a: number, b: number) => (b > 0 ? `${Math.round((a / b) * 100)}%` : '—');

const DIRECTION: Record<string, string> = {
  outgoing: 'Outgoing',
  incoming: 'Incoming',
  missed: 'Missed',
  rejected: 'Rejected',
};
function callWhat(c: CallRow): string {
  if (c.channel === 'whatsapp') {
    return c.outcome === 'message' ? 'WhatsApp message' : `WhatsApp ${c.media === 'video' ? 'video call' : 'call'}`;
  }
  return 'Phone';
}
const callFrom = (c: CallRow) =>
  c.source === 'phone' ? "Phone's dialer" : c.source === 'whatsapp' ? 'WhatsApp' : 'App';

// ---------------------------------------------------------------------
// Rows (the same for Excel and CSV)
// ---------------------------------------------------------------------
const SUMMARY_HEAD = [
  'Person',
  'Role',
  'From',
  'To',
  'Calls',
  'Connected',
  'Connected %',
  'Talk time',
  'Outgoing',
  'Incoming',
  'Missed',
  'WhatsApp calls',
  'WhatsApp messages',
  'Leads called',
  'Leads added',
  'Admitted',
  'Notes',
  'Next calls set',
  'Stage changes',
  'App time',
  'Sessions',
  'First',
  'Last',
];
function summaryRow(w: WorkData): (string | number)[] {
  const s = w.summary;
  return [
    w.person.name ?? 'No name',
    roleName(w.person.role),
    bdDay(w.from),
    bdDay(w.to),
    s.calls,
    s.connected,
    pct(s.connected, s.calls),
    dur(s.talk_sec),
    s.outgoing,
    s.incoming,
    s.missed,
    s.wa_calls,
    s.wa_messages,
    s.leads_called,
    s.leads_added,
    s.admitted,
    s.notes,
    s.follow_ups,
    s.stage_changes,
    dur(s.app_sec),
    s.sessions,
    s.first_at ? `${bdDate(s.first_at)} ${bdTime(s.first_at)}` : '',
    s.last_at ? `${bdDate(s.last_at)} ${bdTime(s.last_at)}` : '',
  ];
}

const CALL_HEAD = [
  'Date',
  'Time',
  'Lead',
  'Phone',
  'Type',
  'Direction',
  'Result',
  'Length',
  'Seconds',
  'SIM',
  'From',
  'Stage now',
  'Call note',
];
const callRow = (c: CallRow): (string | number)[] => [
  bdDate(c.called_at),
  bdTime(c.called_at),
  c.lead_name,
  c.lead_phone ?? '',
  callWhat(c),
  DIRECTION[c.direction] ?? c.direction,
  outcomeInfo(c.outcome).label,
  c.outcome === 'connected' ? dur(c.duration_sec) : '',
  c.duration_sec ?? 0,
  c.sim_label ?? '',
  callFrom(c),
  c.stage ?? '',
  c.notes ?? '',
];

type Lookups = { stages: Map<string, StageInfo>; userNames: Map<string, string> };

// ---------------------------------------------------------------------
// Excel
// ---------------------------------------------------------------------
function sheetOf(head: string[], rows: (string | number | null)[][]) {
  const sheet = XLSX.utils.aoa_to_sheet([head, ...rows.map((r) => r.map((v) => v ?? ''))]);
  sheet['!cols'] = head.map((h, i) => ({
    wch: Math.min(50, Math.max(h.length, ...rows.slice(0, 300).map((r) => String(r[i] ?? '').length)) + 2),
  }));
  return sheet;
}

/** One workbook. With several people each row also says whose it is. */
export function toWorkbook(list: WorkData[], parts: Set<WorkPart>, lk: Lookups): Uint8Array {
  const many = list.length > 1;
  const who = (w: WorkData) => (many ? [w.person.name ?? 'No name'] : []);
  const P = many ? ['Person'] : [];
  const wb = XLSX.utils.book_new();
  if (parts.has('summary')) XLSX.utils.book_append_sheet(wb, sheetOf(SUMMARY_HEAD, list.map(summaryRow)), 'Summary');
  if (parts.has('calls'))
    XLSX.utils.book_append_sheet(
      wb,
      sheetOf(
        [...P, ...CALL_HEAD],
        list.flatMap((w) => w.calls.map((c) => [...who(w), ...callRow(c)])),
      ),
      'Calls',
    );
  if (parts.has('notes'))
    XLSX.utils.book_append_sheet(
      wb,
      sheetOf(
        [...P, 'Date', 'Time', 'Lead', 'Phone', 'Note'],
        list.flatMap((w) =>
          w.notes.map((n) => [
            ...who(w),
            bdDate(n.created_at),
            bdTime(n.created_at),
            n.lead_name,
            n.lead_phone ?? '',
            n.note ?? '',
          ]),
        ),
      ),
      'Notes',
    );
  if (parts.has('changes'))
    XLSX.utils.book_append_sheet(
      wb,
      sheetOf(
        [...P, 'Date', 'Time', 'Lead', 'Phone', 'What changed'],
        list.flatMap((w) =>
          w.changes.map((c) => [
            ...who(w),
            bdDate(c.created_at),
            bdTime(c.created_at),
            c.lead_name,
            c.lead_phone ?? '',
            describeChange(c, lk.stages, lk.userNames).text,
          ]),
        ),
      ),
      'Changes',
    );
  if (parts.has('added'))
    XLSX.utils.book_append_sheet(
      wb,
      sheetOf(
        [...P, 'Date', 'Time', 'Lead', 'Phone', 'Source', 'Stage now', 'How'],
        list.flatMap((w) =>
          w.leads_added.map((l) => [
            ...who(w),
            bdDate(l.created_at),
            bdTime(l.created_at),
            l.name,
            l.phone ?? '',
            l.source ?? '',
            l.stage ?? '',
            l.imported ? 'Imported' : 'Typed',
          ]),
        ),
      ),
      'Leads added',
    );
  return new Uint8Array(XLSX.write(wb, { type: 'array', bookType: 'xlsx' }) as ArrayBuffer);
}

// ---------------------------------------------------------------------
// CSV: the call log (with the person when several)
// ---------------------------------------------------------------------
const csvCell = (v: string | number) => {
  const s = String(v ?? '');
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};
export function toCsv(list: WorkData[]): string {
  const many = list.length > 1;
  const rows = [
    [...(many ? ['Person'] : []), ...CALL_HEAD],
    ...list.flatMap((w) => w.calls.map((c) => [...(many ? [w.person.name ?? 'No name'] : []), ...callRow(c)])),
  ];
  // BOM so Excel opens Bangla text correctly
  return '﻿' + rows.map((r) => r.map(csvCell).join(',')).join('\r\n');
}

// ---------------------------------------------------------------------
// Text: a report to read or send on WhatsApp
// ---------------------------------------------------------------------
export function toText(list: WorkData[], parts: Set<WorkPart>, lk: Lookups): string {
  const out: string[] = [];
  for (const w of list) {
    const s = w.summary;
    out.push(
      '══════════════════════════════',
      'ITTC Admission · Work report',
      `${w.person.name ?? 'No name'} (${roleName(w.person.role)})`,
      periodText(w.from, w.to),
      '══════════════════════════════',
      '',
    );
    if (parts.has('summary')) {
      out.push(
        'SUMMARY',
        `📞 Calls: ${s.calls} · Connected ${s.connected} (${pct(s.connected, s.calls)}) · Talk time ${dur(s.talk_sec)}`,
        `   Outgoing ${s.outgoing} · Incoming ${s.incoming} · Missed ${s.missed} · Leads called ${s.leads_called}`,
        `💬 WhatsApp: ${s.wa_calls} calls · ${s.wa_messages} messages`,
        `➕ Leads added: ${s.leads_added} · 🎓 Admitted: ${s.admitted}`,
        `📝 Notes: ${s.notes} · ⏰ Next calls set: ${s.follow_ups} · 🚩 Stage changes: ${s.stage_changes}`,
        `📱 App time: ${dur(s.app_sec)} (${s.sessions} sessions)${s.first_at ? ` · First ${bdTime(s.first_at)}` : ''}${s.last_at ? ` · Last ${bdTime(s.last_at)}` : ''}`,
        '',
      );
    }
    if (parts.has('calls')) {
      out.push(`CALL LOG (${w.calls.length})`);
      let day = '';
      for (const c of w.calls) {
        const d = bdDate(c.called_at);
        if (d !== day) out.push(`— ${(day = d)} —`);
        const res = `${outcomeInfo(c.outcome).label}${c.outcome === 'connected' && c.duration_sec ? ` ${dur(c.duration_sec)}` : ''}`;
        out.push(
          `${bdTime(c.called_at)} · ${c.lead_name}${c.lead_phone ? ` · ${c.lead_phone}` : ''} · ${c.channel === 'whatsapp' ? '💬 ' : ''}${DIRECTION[c.direction] ?? c.direction} · ${res}${c.notes ? `\n    “${c.notes.replace(/\s+/g, ' ').trim()}”` : ''}`,
        );
      }
      if (w.calls.length === 0) out.push('No calls.');
      out.push('');
    }
    if (parts.has('notes')) {
      out.push(`NOTES (${w.notes.length})`);
      for (const n of w.notes)
        out.push(
          `${bdDate(n.created_at)} ${bdTime(n.created_at)} · ${n.lead_name}: “${(n.note ?? '').replace(/\s+/g, ' ').trim()}”`,
        );
      if (w.notes.length === 0) out.push('No notes.');
      out.push('');
    }
    if (parts.has('changes')) {
      out.push(`CHANGES (${w.changes.length})`);
      for (const c of w.changes)
        out.push(
          `${bdDate(c.created_at)} ${bdTime(c.created_at)} · ${c.lead_name}: ${describeChange(c, lk.stages, lk.userNames).text}`,
        );
      if (w.changes.length === 0) out.push('No changes.');
      out.push('');
    }
    if (parts.has('added')) {
      out.push(`LEADS ADDED (${w.leads_added.length})`);
      for (const l of w.leads_added)
        out.push(
          `${bdDate(l.created_at)} ${bdTime(l.created_at)} · ${l.name}${l.phone ? ` · ${l.phone}` : ''}${l.source ? ` · ${l.source}` : ''}${l.imported ? ' · imported' : ''}`,
        );
      if (w.leads_added.length === 0) out.push('No leads added.');
      out.push('');
    }
    const capped = [w.calls, w.notes, w.changes, w.leads_added].some((a) => a.length >= w.capped);
    if (capped)
      out.push(`(Only the first ${w.capped} of each list are included: choose a shorter period for the rest.)`, '');
    out.push('');
  }
  return out.join('\n');
}

// ---------------------------------------------------------------------
// Save / share the file
// ---------------------------------------------------------------------
const MIME: Record<WorkFormat, string> = {
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  txt: 'text/plain',
  csv: 'text/csv',
};

export async function shareFile(name: string, body: Uint8Array | string, format: WorkFormat): Promise<void> {
  if (Platform.OS === 'web') {
    const blob = new Blob([body as BlobPart], { type: `${MIME[format]};charset=utf-8` });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = name;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 10000);
    return;
  }
  const file = new File(Paths.cache, name);
  file.create({ overwrite: true });
  file.write(body);
  if (!(await Sharing.isAvailableAsync())) throw new Error('Sharing is not available on this phone.');
  await Sharing.shareAsync(file.uri, { mimeType: MIME[format], dialogTitle: name });
}

export const safeName = (s: string) =>
  s
    .replace(/[^\wঀ-৿-]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '') || 'user';
