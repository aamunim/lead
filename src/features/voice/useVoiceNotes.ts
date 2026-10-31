import { useEffect, useState } from 'react';

import { getDriveStatus, getFilesSettings } from '@/features/files/api';
import { hasAudio } from '@/features/voice/native';

// =====================================================================
// 🎙 May voice notes be recorded here? (this build has the microphone part,
//   files are on, Google Drive is connected). Asked once, then shared by
//   every 🎙 button for a minute.
// =====================================================================
let cached: { at: number; value: Promise<boolean> } | null = null;

function check(): Promise<boolean> {
  if (!hasAudio) return Promise.resolve(false);
  if (cached && Date.now() - cached.at < 60_000) return cached.value;
  const value = Promise.all([getFilesSettings(), getDriveStatus()])
    .then(([s, d]) => s.enabled && d.connected)
    .catch(() => false);
  cached = { at: Date.now(), value };
  return value;
}

export function useVoiceNotes(): boolean {
  const [ok, setOk] = useState(false);
  useEffect(() => {
    let live = true;
    check().then((v) => live && setOk(v));
    return () => {
      live = false;
    };
  }, []);
  return ok;
}

// ---------------------------------------------------------------------
// A voice note was saved (from any sheet): the lead page shows it at once
// ---------------------------------------------------------------------
type VoiceListener = (leadId: string) => void;
const listeners = new Set<VoiceListener>();

export function onVoiceSaved(listener: VoiceListener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function emitVoiceSaved(leadId: string): void {
  listeners.forEach((l) => l(leadId));
}
