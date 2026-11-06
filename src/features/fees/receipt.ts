import { Platform } from 'react-native';

import type { PaymentSettings, ReceiptData } from '@/features/fees/api';

// =====================================================================
// 🧾 The printed money receipt (PDF / paper), its look chosen in
//   Settings → Fee & discount → Receipt design:
//   layout, paper size, colour, logo, title, a line under the name,
//   signature boxes, amount in words, a PAID stamp, two copies on A4.
// =====================================================================

export type ReceiptTemplate = 'classic' | 'modern' | 'minimal';
export type ReceiptSize = 'a4' | 'a5' | 'a4_two' | 'pos80';

export type ReceiptDesign = {
  template: ReceiptTemplate;
  size: ReceiptSize;
  /** the main colour (#RRGGBB) */
  accent: string;
  title: string;
  show_logo: boolean;
  /** a line under the institute's name, e.g. "Affiliated to National University" */
  header_line: string;
  /** signature boxes at the bottom, e.g. ["Student", "Accounts"] (0–3) */
  signatures: string[];
  amount_words: boolean;
  paid_stamp: boolean;
};

export const DEFAULT_RECEIPT_DESIGN: ReceiptDesign = {
  template: 'classic',
  size: 'a5',
  accent: '#1F3A8A',
  title: 'Money Receipt',
  show_logo: true,
  header_line: '',
  signatures: ['Student', 'Received by'],
  amount_words: true,
  paid_stamp: false,
};

export const RECEIPT_TEMPLATES: { key: ReceiptTemplate; label: string; hint: string }[] = [
  { key: 'classic', label: 'Classic', hint: 'Bordered, a coloured band on top' },
  { key: 'modern', label: 'Modern', hint: 'Clean, a big amount box' },
  { key: 'minimal', label: 'Minimal', hint: 'Black & white, light on ink' },
];

export const RECEIPT_SIZES: { key: ReceiptSize; label: string }[] = [
  { key: 'a5', label: 'A5 (half page)' },
  { key: 'a4', label: 'A4' },
  { key: 'a4_two', label: 'A4 · 2 copies (student + office)' },
  { key: 'pos80', label: 'Receipt printer (80 mm)' },
];

export const RECEIPT_COLOURS = ['#1F3A8A', '#0F766E', '#7C2D12', '#6D28D9', '#B91C1C', '#111827'];

/** The saved design with the defaults filled in */
export function receiptDesign(s: PaymentSettings): ReceiptDesign {
  const d = (s.receipt as { design?: Partial<ReceiptDesign> }).design ?? {};
  return {
    ...DEFAULT_RECEIPT_DESIGN,
    ...d,
    signatures: Array.isArray(d.signatures) ? d.signatures.slice(0, 3) : DEFAULT_RECEIPT_DESIGN.signatures,
    accent: /^#[0-9a-fA-F]{6}$/.test(d.accent ?? '') ? (d.accent as string) : DEFAULT_RECEIPT_DESIGN.accent,
  };
}

// ---------------------------------------------------------------------
// Amount in words (Bangladesh: lakh, crore)
// ---------------------------------------------------------------------
const ONES = [
  '',
  'One',
  'Two',
  'Three',
  'Four',
  'Five',
  'Six',
  'Seven',
  'Eight',
  'Nine',
  'Ten',
  'Eleven',
  'Twelve',
  'Thirteen',
  'Fourteen',
  'Fifteen',
  'Sixteen',
  'Seventeen',
  'Eighteen',
  'Nineteen',
];
const TENS = ['', '', 'Twenty', 'Thirty', 'Forty', 'Fifty', 'Sixty', 'Seventy', 'Eighty', 'Ninety'];

function belowHundred(n: number): string {
  if (n < 20) return ONES[n];
  return TENS[Math.floor(n / 10)] + (n % 10 ? `-${ONES[n % 10]}` : '');
}
function belowThousand(n: number): string {
  const h = Math.floor(n / 100);
  const rest = n % 100;
  return [h ? `${ONES[h]} hundred` : '', rest ? belowHundred(rest) : ''].filter(Boolean).join(' ');
}

/** 155500 → "One lakh fifty-five thousand five hundred taka only" */
export function amountInWords(amount: number): string {
  let n = Math.round(Math.abs(amount));
  if (n === 0) return 'Zero taka only';
  const parts: string[] = [];
  const crore = Math.floor(n / 10000000);
  n %= 10000000;
  const lakh = Math.floor(n / 100000);
  n %= 100000;
  const thousand = Math.floor(n / 1000);
  n %= 1000;
  if (crore)
    parts.push(`${crore >= 1000 ? amountInWords(crore).replace(/ taka only$/, '') : belowThousand(crore)} crore`);
  if (lakh) parts.push(`${belowHundred(lakh)} lakh`);
  if (thousand) parts.push(`${belowHundred(thousand)} thousand`);
  if (n) parts.push(belowThousand(n));
  const text = parts.join(' ').toLowerCase();
  return `${text.charAt(0).toUpperCase()}${text.slice(1)} taka only`;
}

// ---------------------------------------------------------------------
// The HTML
// ---------------------------------------------------------------------
const esc = (s: unknown) =>
  String(s ?? '').replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!,
  );

const tk = (n: number) => `৳${Math.round(n).toLocaleString('en-IN')}`;

function oneCopy(d: ReceiptData, s: PaymentSettings, design: ReceiptDesign, logo: string | null, copy: string | null) {
  const f = s.receipt.fields as Record<string, boolean>;
  const p = d.payment;
  const refund = p.kind === 'refund';
  const when = new Date(p.paid_at).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });
  const due = Math.max(d.finalFee - d.paidSoFar, 0);
  const rows: [string, string | null | undefined][] = [
    ['Student', d.student.name],
    [f.student_id !== false ? 'College ID' : '', d.student.studentId],
    [f.course !== false ? 'Course' : '', d.student.course],
    [f.batch !== false ? 'Batch' : '', d.student.batch],
    [f.method !== false ? (refund ? 'Returned by' : 'Paid by') : '', p.method],
    [f.txn !== false ? 'Transaction ID' : '', p.txn_id],
    [refund ? 'Reason' : f.note !== false ? 'Note' : '', p.note],
  ];
  const info = rows
    .filter(([k, v]) => k && v)
    .map(([k, v]) => `<tr><td class="k">${esc(k)}</td><td class="v">${esc(v)}</td></tr>`)
    .join('');
  const college =
    f.college_receipt !== false && p.college_receipt_no
      ? `<div class="meta-item"><span>College receipt no.</span><b>${esc(p.college_receipt_no)}</b></div>`
      : '';
  const totals =
    f.paid_due !== false && !refund
      ? `<table class="totals">
          <tr><td>Total fee</td><td>${tk(d.finalFee)}</td></tr>
          <tr><td>Paid so far</td><td>${tk(d.paidSoFar)}</td></tr>
          <tr class="due"><td>Due</td><td>${tk(due)}</td></tr>
        </table>`
      : '';
  const sigs = design.signatures
    .map((x) => x.trim())
    .filter(Boolean)
    .map(
      (x, i) =>
        `<div class="sig"><div class="sig-line"></div>${esc(x)}${
          i === design.signatures.length - 1 && f.received_by !== false && d.receivedByName
            ? `<div class="sig-name">${esc(d.receivedByName)}</div>`
            : ''
        }</div>`,
    )
    .join('');
  const receivedLine =
    !sigs && f.received_by !== false && d.receivedByName
      ? `<div class="received">Received by: <b>${esc(d.receivedByName)}</b></div>`
      : '';

  return `
  <section class="receipt t-${design.template}">
    ${p.voided_at ? '<div class="stamp void">VOID</div>' : design.paid_stamp && !refund ? '<div class="stamp">PAID</div>' : ''}
    <header>
      ${design.show_logo && logo ? `<img class="logo" src="${logo}" alt="" />` : ''}
      <div class="inst">
        ${f.institute !== false && d.institute.name ? `<div class="inst-name">${esc(d.institute.name)}</div>` : ''}
        ${design.header_line ? `<div class="inst-line">${esc(design.header_line)}</div>` : ''}
        ${
          (f.address !== false && d.institute.address) || (f.phone !== false && d.institute.phone)
            ? `<div class="inst-line">${[
                f.address !== false ? esc(d.institute.address) : '',
                f.phone !== false && d.institute.phone ? `📞 ${esc(d.institute.phone)}` : '',
              ]
                .filter(Boolean)
                .join(' · ')}</div>`
            : ''
        }
      </div>
      ${copy ? `<div class="copy">${esc(copy)}</div>` : ''}
    </header>
    <div class="title">${esc(refund ? 'Refund Receipt' : design.title || 'Money Receipt')}</div>
    <div class="meta">
      <div class="meta-item"><span>Receipt no.</span><b>${esc(p.receipt_no)}</b></div>
      ${college}
      <div class="meta-item"><span>Date</span><b>${esc(when)}</b></div>
    </div>
    <table class="info">${info}</table>
    <div class="amount">
      <div class="amount-label">${refund ? 'Amount returned' : 'Amount received'}</div>
      <div class="amount-value">${tk(Number(p.amount))}</div>
      ${design.amount_words ? `<div class="words">${esc(amountInWords(Number(p.amount)))}</div>` : ''}
    </div>
    ${totals}
    ${receivedLine}
    ${sigs ? `<div class="sigs">${sigs}</div>` : ''}
    ${s.receipt.footer ? `<footer>${esc(s.receipt.footer)}</footer>` : ''}
  </section>`;
}

const PAGE: Record<ReceiptSize, { page: string; width: string; scale: number }> = {
  a4: { page: 'A4', width: '180mm', scale: 1 },
  a5: { page: 'A5', width: '128mm', scale: 0.86 },
  a4_two: { page: 'A4', width: '180mm', scale: 0.82 },
  pos80: { page: '80mm auto', width: '72mm', scale: 0.72 },
};

/** The whole printable page (also used for the preview in Settings) */
export function receiptHtml(d: ReceiptData, s: PaymentSettings, logo: string | null): string {
  const design = receiptDesign(s);
  const size = PAGE[design.size];
  const a = design.accent;
  const copies =
    design.size === 'a4_two'
      ? `${oneCopy(d, s, design, logo, 'Student copy')}<div class="cut">✂ - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - -</div>${oneCopy(d, s, design, logo, 'Office copy')}`
      : oneCopy(d, s, design, logo, null);
  const mono = design.template === 'minimal';
  const ink = mono ? '#111' : a;
  return `<!doctype html><html><head><meta charset="utf-8" />
<title>${esc(d.payment.receipt_no)}</title>
<style>
  @page { size: ${size.page}; margin: ${design.size === 'pos80' ? '4mm' : '10mm'}; }
  * { box-sizing: border-box; }
  body { margin: 0; font-family: -apple-system, 'Segoe UI', Roboto, 'Noto Sans', 'Noto Sans Bengali', Arial, sans-serif;
         color: #1f2430; font-size: ${Math.round(13 * size.scale)}px; -webkit-print-color-adjust: exact; print-color-adjust: exact; }
  .receipt { position: relative; width: ${size.width}; margin: 0 auto; padding: 14px 16px; overflow: hidden; page-break-inside: avoid; }
  .t-classic { border: 1.5px solid ${ink}; border-radius: 6px; }
  .t-classic header { background: ${ink}; color: #fff; margin: -14px -16px 10px; padding: 12px 16px; }
  .t-classic header .inst-line { color: rgba(255,255,255,.85); }
  .t-modern { border: 1px solid #e4e7ee; border-radius: 14px; box-shadow: 0 1px 0 #eef0f5; }
  .t-modern header { border-bottom: 3px solid ${ink}; padding-bottom: 10px; margin-bottom: 10px; }
  .t-minimal { border: 1px solid #222; }
  .t-minimal header { border-bottom: 1px solid #222; padding-bottom: 8px; margin-bottom: 8px; }
  header { display: flex; align-items: center; gap: 12px; }
  .logo { width: 48px; height: 48px; object-fit: contain; border-radius: 8px; background: #fff; padding: 2px; }
  .inst { flex: 1; }
  .inst-name { font-size: 1.35em; font-weight: 800; letter-spacing: .2px; }
  .inst-line { font-size: .85em; color: #5b6170; margin-top: 2px; }
  .copy { font-size: .75em; font-weight: 700; text-transform: uppercase; letter-spacing: 1px; border: 1px solid currentColor; padding: 3px 8px; border-radius: 99px; }
  .title { text-align: center; font-size: 1.2em; font-weight: 800; letter-spacing: 2px; text-transform: uppercase; color: ${ink}; margin: 6px 0 10px; }
  .meta { display: flex; flex-wrap: wrap; gap: 6px 18px; justify-content: space-between; padding: 8px 10px; border-radius: 8px; background: ${mono ? '#f3f3f3' : `${a}12`}; margin-bottom: 10px; }
  .meta-item span { display: block; font-size: .75em; color: #6b7080; }
  .meta-item b { font-size: 1em; }
  table { width: 100%; border-collapse: collapse; }
  .info td { padding: 5px 2px; border-bottom: 1px dashed #dde1ea; vertical-align: top; }
  .info .k { width: 36%; color: #6b7080; }
  .info .v { font-weight: 600; }
  .amount { margin: 12px 0 8px; padding: 10px 12px; border-radius: 10px; border: 1.5px solid ${ink}; text-align: center; }
  .t-modern .amount { background: ${a}; color: #fff; border: none; }
  .t-modern .amount .amount-label, .t-modern .amount .words { color: rgba(255,255,255,.9); }
  .amount-label { font-size: .8em; color: #6b7080; text-transform: uppercase; letter-spacing: 1px; }
  .amount-value { font-size: 2em; font-weight: 800; margin: 2px 0; }
  .words { font-size: .85em; font-style: italic; color: #4b5060; }
  .totals { margin-top: 6px; }
  .totals td { padding: 3px 2px; }
  .totals td:last-child { text-align: right; font-weight: 600; }
  .totals .due td { border-top: 1px solid #cfd4de; font-weight: 800; color: ${mono ? '#111' : '#B45309'}; }
  .received { margin-top: 10px; }
  .sigs { display: flex; gap: 18px; margin-top: 34px; }
  .sig { flex: 1; text-align: center; font-size: .85em; color: #4b5060; }
  .sig-line { border-top: 1px solid #555; margin-bottom: 4px; }
  .sig-name { font-weight: 700; color: #1f2430; }
  footer { margin-top: 12px; text-align: center; font-size: .85em; color: #6b7080; }
  .stamp { position: absolute; top: 42%; left: 50%; transform: translate(-50%,-50%) rotate(-18deg); font-size: 4.2em; font-weight: 900;
           color: ${mono ? 'rgba(0,0,0,.08)' : `${a}22`}; border: 6px solid currentColor; padding: 2px 22px; border-radius: 12px; pointer-events: none; }
  .stamp.void { color: rgba(185,28,28,.25); }
  .cut { text-align: center; color: #9aa0ad; margin: 10mm 0; font-size: .8em; letter-spacing: 1px; }
</style></head><body>${copies}</body></html>`;
}

// ---------------------------------------------------------------------
// 🖼 The institute logo as a data link (works in the PDF on phones too)
// ---------------------------------------------------------------------
let logoCache: string | null | undefined;
export async function receiptLogo(): Promise<string | null> {
  if (logoCache !== undefined) return logoCache;
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const mod = require('../../../assets/web/ittc-logo-192.png');
    if (Platform.OS === 'web') {
      const url = typeof mod === 'string' ? mod : (mod?.uri ?? mod?.default ?? null);
      if (!url) return (logoCache = null);
      const blob = await (await fetch(url)).blob();
      logoCache = await new Promise<string>((resolve, reject) => {
        const r = new FileReader();
        r.onload = () => resolve(String(r.result));
        r.onerror = () => reject(r.error);
        r.readAsDataURL(blob);
      });
      return logoCache;
    }
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { Asset } = require('expo-asset') as typeof import('expo-asset');
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { File } = require('expo-file-system') as typeof import('expo-file-system');
    const asset = await Asset.fromModule(mod).downloadAsync();
    if (!asset.localUri) return (logoCache = null);
    logoCache = `data:image/png;base64,${await new File(asset.localUri).base64()}`;
    return logoCache;
  } catch {
    logoCache = null;
    return null;
  }
}

/** 🖨 Print the receipt (website: the browser's print / Save as PDF; phone: print or share the PDF) */
export async function printReceipt(d: ReceiptData, s: PaymentSettings): Promise<void> {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const Print = require('expo-print') as typeof import('expo-print');
  const html = receiptHtml(d, s, await receiptLogo());
  if (Platform.OS === 'web') {
    printInFrame(html);
    return;
  }
  await Print.printAsync({ html });
}

/** 🌐 A hidden frame with the page, then the browser's print window */
function printInFrame(html: string) {
  const frame = document.createElement('iframe');
  frame.style.position = 'fixed';
  frame.style.right = '0';
  frame.style.bottom = '0';
  frame.style.width = '0';
  frame.style.height = '0';
  frame.style.border = '0';
  document.body.appendChild(frame);
  const doc = frame.contentWindow?.document;
  if (!doc) return;
  doc.open();
  doc.write(html);
  doc.close();
  const go = () => {
    frame.contentWindow?.focus();
    frame.contentWindow?.print();
    setTimeout(() => frame.remove(), 60_000);
  };
  // wait for the logo to load
  const img = doc.querySelector('img');
  if (img && !(img as HTMLImageElement).complete) img.addEventListener('load', go, { once: true });
  else setTimeout(go, 50);
}
