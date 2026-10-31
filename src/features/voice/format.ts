// 🎙 Small helpers for voice notes (no native code here)

/** 75 → "1:15", 3725 → "1:02:05" */
export function clock(sec: number): string {
  const s = Math.max(0, Math.floor(sec));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const ss = String(s % 60).padStart(2, '0');
  return h > 0 ? `${h}:${String(m).padStart(2, '0')}:${ss}` : `${m}:${ss}`;
}

/** Where a voice note was recorded, for the timeline */
export const VOICE_CONTEXT: Record<string, string> = {
  call: 'Call',
  whatsapp: 'WhatsApp',
  note: 'Note',
  follow_up: 'Next call',
  fee: 'Fee',
  payment: 'Payment',
  discount: 'Discount',
  visit: 'Campus visit',
  admission: 'Admission',
  papers: 'Papers',
  lost: 'Lost',
  reopen: 'Reopened',
  cancel: 'Admission cancelled',
  stage: 'Stage',
  lead: 'Lead details',
  handover: 'Hand over',
};
