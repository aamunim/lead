import { useState } from 'react';
import { Alert, Platform, Pressable, StyleSheet, Text } from 'react-native';

import { downloadLeadFile, openLeadFile, uploadAlumniVoice, type LeadFile } from '@/features/files/api';
import { clock } from '@/features/voice/format';
import { hasAudio } from '@/features/voice/native';
import { useVoiceNotes } from '@/features/voice/useVoiceNotes';
import { colors, fontSize, fontWeight, radius, spacing } from '@/shared/theme';

// =====================================================================
// 🎙 Voice notes on an alumnus: saved to Google Drive (Lead Management /
//   Alumni / Name – Phone / Voice notes) with a "🎙 Voice note 1:05" line
//   on their history. Hidden when files are off, Drive isn't connected or
//   this app build has no microphone part. The recorder / player screens
//   load only when used.
// =====================================================================

export function AlumniVoiceButton({ alumniId, onSaved }: { alumniId: string; onSaved: () => void }) {
  const ok = useVoiceNotes();
  const [open, setOpen] = useState(false);
  if (!ok) return null;
  const Sheet = open
    ? // eslint-disable-next-line @typescript-eslint/no-require-imports
      (require('@/features/voice/VoiceRecorderSheet') as typeof import('@/features/voice/VoiceRecorderSheet'))
        .VoiceRecorderSheet
    : null;
  return (
    <>
      <Pressable
        onPress={() => setOpen(true)}
        style={({ pressed }) => [styles.pill, pressed && styles.pressed]}
        accessibilityRole="button"
        accessibilityLabel="Record a voice note"
      >
        <Text style={styles.pillText}>🎙 Voice note</Text>
      </Pressable>
      {Sheet && (
        <Sheet
          title="Voice note"
          onClose={() => setOpen(false)}
          upload={async (uri, seconds) => (await uploadAlumniVoice(alumniId, uri, seconds)).id}
          onSaved={() => {
            setOpen(false);
            onSaved();
          }}
        />
      )}
    </>
  );
}

/** ▶ Play a voice note from the history */
export function AlumniVoicePlay({ fileId, seconds }: { fileId: string; seconds?: number | null }) {
  const [playing, setPlaying] = useState(false);
  const name = 'Voice note.m4a';
  const play = () => {
    if (hasAudio) return setPlaying(true);
    // the website / an older build: the phone's (browser's) own player
    openLeadFile({ id: fileId, name, mime_type: 'audio/mp4' } as LeadFile, 'alumni_file').catch((e) => {
      const m = e instanceof Error ? e.message : 'Could not open.';
      if (Platform.OS === 'web') window.alert(m);
      else Alert.alert('Could not open', m);
    });
  };
  const Player = playing
    ? // eslint-disable-next-line @typescript-eslint/no-require-imports
      (require('@/features/voice/VoicePlayerSheet') as typeof import('@/features/voice/VoicePlayerSheet'))
        .VoicePlayerSheet
    : null;
  return (
    <>
      <Pressable
        onPress={play}
        style={({ pressed }) => [styles.play, pressed && styles.pressed]}
        accessibilityRole="button"
        accessibilityLabel="Play the voice note"
      >
        <Text style={styles.playText}>▶ Play{seconds ? ` ${clock(seconds)}` : ''}</Text>
      </Pressable>
      {Player && (
        <Player
          file={{ id: fileId, name, duration_sec: seconds ?? null }}
          load={async () => (await downloadLeadFile({ id: fileId, name }, 'alumni_file')).uri}
          onClose={() => setPlaying(false)}
        />
      )}
    </>
  );
}

const styles = StyleSheet.create({
  pill: {
    alignSelf: 'flex-start',
    paddingVertical: spacing.xs,
    paddingHorizontal: spacing.md,
    borderRadius: radius.pill,
    borderWidth: 1,
    borderColor: colors.primary,
  },
  pillText: { fontSize: fontSize.small, fontWeight: fontWeight.semibold, color: colors.primary },
  pressed: { opacity: 0.7 },
  play: {
    alignSelf: 'flex-start',
    marginTop: 4,
    paddingVertical: 4,
    paddingHorizontal: spacing.md,
    borderRadius: radius.pill,
    backgroundColor: colors.primarySoft,
  },
  playText: { fontSize: fontSize.small, fontWeight: fontWeight.bold, color: colors.primary },
});
