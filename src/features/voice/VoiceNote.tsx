import { useEffect, useState } from 'react';
import { Alert, Pressable, StyleSheet, Text, View } from 'react-native';

import { openLeadFile, type LeadFile } from '@/features/files/api';
import { clock } from '@/features/voice/format';
import { hasAudio } from '@/features/voice/native';
import { useVoiceNotes } from '@/features/voice/useVoiceNotes';
import type { PlayableFile } from '@/features/voice/VoicePlayerSheet';
import { colors, fontSize, fontWeight, radius, spacing } from '@/shared/theme';

// =====================================================================
// 🎙 "Voice note" button, placed under every text note. The recording is
//   saved straight to the lead's Google Drive folder (Voice notes) and shows
//   on the lead's timeline; the form it sits in doesn't need to wait for it.
//   Hidden when files are off, Drive isn't connected, or this app build has
//   no microphone part (before 2.6.0).
//   The screens that use the microphone are loaded only when needed
//   (require), so older builds never load them.
// =====================================================================

type Props = {
  leadId: string | null | undefined;
  /** Where it is recorded: call, note, fee, payment, visit, … */
  context: string;
  onSaved?: (message: string) => void;
};

export function VoiceNoteButton({ leadId, context, onSaved }: Props) {
  const ok = useVoiceNotes();
  const [open, setOpen] = useState(false);
  const [saved, setSaved] = useState<number[]>([]);

  if (!ok || !leadId) return null;

  const Sheet = open
    ? // eslint-disable-next-line @typescript-eslint/no-require-imports
      (require('@/features/voice/VoiceRecorderSheet') as typeof import('@/features/voice/VoiceRecorderSheet')).VoiceRecorderSheet
    : null;

  return (
    <View style={styles.row}>
      <Pressable
        onPress={() => setOpen(true)}
        style={({ pressed }) => [styles.pill, pressed && styles.pressed]}
        accessibilityRole="button"
        accessibilityLabel={saved.length > 0 ? 'Record another voice note' : 'Record a voice note'}
      >
        <Text style={styles.pillText}>🎙 {saved.length > 0 ? 'Another voice note' : 'Voice note'}</Text>
      </Pressable>
      {saved.length > 0 && (
        <Text style={styles.saved} numberOfLines={1}>
          ✓ Saved {saved.map(clock).join(', ')}
        </Text>
      )}
      {Sheet && (
        <Sheet
          leadId={leadId}
          context={context}
          onClose={() => setOpen(false)}
          onSaved={(sec) => {
            setOpen(false);
            setSaved((s) => [...s, sec]);
            onSaved?.(`🎙 Voice note saved (${clock(sec)}).`);
          }}
        />
      )}
    </View>
  );
}

/** Is this file something the in-app player can play? */
export const isAudio = (f: Pick<LeadFile, 'kind' | 'mime_type'>) =>
  f.kind === 'voice' || !!f.mime_type?.startsWith('audio/');

/**
 * ▶ Plays a voice note in the app; on builds without the audio part it opens
 * in the phone's own player instead. Render it while `file` is set.
 */
export function VoicePlayer({ file, onClose }: { file: (PlayableFile & { mime_type?: string | null }) | null; onClose: () => void }) {
  useEffect(() => {
    if (!file || hasAudio) return;
    openLeadFile({
      id: file.id,
      name: file.name,
      mime_type: file.mime_type ?? 'audio/mp4',
    } as LeadFile)
      .catch((e) => Alert.alert('Could not open', e instanceof Error ? e.message : ''))
      .finally(onClose);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [file?.id]);

  if (!file || !hasAudio) return null;
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { VoicePlayerSheet } = require('@/features/voice/VoicePlayerSheet') as typeof import('@/features/voice/VoicePlayerSheet');
  return <VoicePlayerSheet file={file} onClose={onClose} />;
}

const styles = StyleSheet.create({
  row: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm, flexWrap: 'wrap' },
  pill: {
    paddingVertical: spacing.xs,
    paddingHorizontal: spacing.md,
    borderRadius: radius.pill,
    borderWidth: 1,
    borderColor: colors.primary,
  },
  pressed: { opacity: 0.7 },
  pillText: { fontSize: fontSize.small, fontWeight: fontWeight.semibold, color: colors.primary },
  saved: { flexShrink: 1, fontSize: fontSize.caption, color: colors.success },
});
