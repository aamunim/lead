import * as Clipboard from 'expo-clipboard';
import { Platform, Share } from 'react-native';

import { sharePdf } from '@/features/activity/workExport';

// =====================================================================
// 💬 An AI supervisor answer out of the app: copy, share (WhatsApp,
//   e-mail…), or a PDF report (the chairman, the board)
// =====================================================================

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

const when = (iso: string) =>
  new Date(iso).toLocaleString('en-GB', {
    day: 'numeric',
    month: 'long',
    year: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  });

/** The answer as plain text (with the data it was based on) */
export function answerText(body: string, sources: string[] = []): string {
  return sources.length ? `${body}\n\n— তথ্য: ${sources.join(' · ')}` : body;
}

export async function copyAnswer(body: string, sources?: string[]): Promise<void> {
  await Clipboard.setStringAsync(answerText(body, sources));
}

/** The phone's share sheet (WhatsApp, Messenger, e-mail…); the website copies it */
export async function shareAnswer(body: string, sources?: string[]): Promise<'shared' | 'copied'> {
  const text = answerText(body, sources);
  if (Platform.OS === 'web') {
    const nav =
      typeof navigator !== 'undefined'
        ? (navigator as Navigator & { share?: (d: { text: string }) => Promise<void> })
        : null;
    if (nav?.share) {
      await nav.share({ text });
      return 'shared';
    }
    await Clipboard.setStringAsync(text);
    return 'copied';
  }
  await Share.share({ message: text });
  return 'shared';
}

/** A one-page (or more) PDF: the question, the answer, the data it used, the date */
export async function pdfAnswer(opts: {
  question: string | null;
  body: string;
  sources?: string[];
  at: string;
}): Promise<void> {
  // the first line: the title; a line with "• / - / ১." : a point; any other short line: a section heading
  const firstText = opts.body.split(/\r?\n/).findIndex((l) => l.trim());
  const line = (l: string, i: number) => {
    const t = l.trim();
    if (!t) return '<div class="gap"></div>';
    if (i === firstText && t.length <= 120) return `<h1>${esc(t)}</h1>`;
    if (/^([•\-–*]|[0-9০-৯]+[.)।])\s*/.test(t)) return `<p class="li">${esc(t)}</p>`;
    if (t.length <= 60) return `<h2>${esc(t)}</h2>`;
    return `<p>${esc(t)}</p>`;
  };
  const lines = opts.body.split(/\r?\n/);
  const html = `<!doctype html><html><head><meta charset="utf-8"><style>
    @page { margin: 18mm 16mm; }
    body { font-family: -apple-system, Roboto, 'Noto Sans Bengali', 'Hind Siliguri', sans-serif; color: #1b1b1f;
           font-size: 13.5px; line-height: 1.7; }
    h1 { font-size: 18px; margin: 0 0 10px; color: #14213d; }
    h2 { font-size: 14.5px; margin: 12px 0 4px; color: #3557d4; }
    .li { padding-left: 12px; }
    .brand { display: flex; justify-content: space-between; align-items: flex-end;
             border-bottom: 2px solid #3557d4; padding-bottom: 6px; margin-bottom: 14px; }
    .brand .n { font-size: 17px; font-weight: 700; color: #14213d; }
    .brand .s { font-size: 10.5px; color: #6b6b75; }
    .q { background: #eef1fb; border-radius: 6px; padding: 8px 10px; margin-bottom: 14px; font-size: 11.5px; }
    .q b { color: #3557d4; }
    p { margin: 0 0 4px; }
    .gap { height: 8px; }
    .src { margin-top: 16px; padding-top: 8px; border-top: 1px solid #e2e2ea; font-size: 10px; color: #6b6b75; }
  </style></head><body>
    <div class="brand">
      <div><div class="n">ITTC · AI সুপারভাইজার রিপোর্ট</div><div class="s">Ideal Teachers' Training College</div></div>
      <div class="s">${esc(when(opts.at))}</div>
    </div>
    ${opts.question ? `<div class="q"><b>প্রশ্ন:</b> ${esc(opts.question)}</div>` : ''}
    ${lines.map(line).join('')}
    <div class="src">
      ${opts.sources?.length ? `যে তথ্য দেখে লেখা: ${esc(opts.sources.join(' · '))}<br>` : ''}
      AI-এর তৈরি। বড় সিদ্ধান্তের আগে সংখ্যাগুলো অ্যাপে যাচাই করে নিন।
    </div>
  </body></html>`;
  const stamp = new Date(opts.at).toISOString().slice(0, 10);
  await sharePdf(`ITTC-AI-report-${stamp}.pdf`, html);
}
