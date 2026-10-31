import {
  RecordingPresets,
  requestRecordingPermissionsAsync,
  setAudioModeAsync,
  useAudioPlayer,
  useAudioPlayerStatus,
  useAudioRecorder,
  type RecordingOptions,
} from 'expo-audio';
import { File } from 'expo-file-system';
import { useEffect, useRef, useState } from 'react';
import { ActivityIndicator, Alert, Modal, Pressable, StyleSheet, Text, View } from 'react-native';

import { uploadLeadFile } from '@/features/files/api';
import { clock } from '@/features/voice/format';
import { colors, fontSize, fontWeight, radius, spacing } from '@/shared/theme';
import { Button } from '@/shared/ui/Button';

// =====================================================================
// 🎙 Record a voice note, listen, then save it to the lead's
//   Google Drive folder (Voice notes). Loaded only on builds that have
//   the microphone part (see native.ts).
// =====================================================================

// Speech: one channel, 64 kbps AAC ≈ 0.5 MB a minute
const OPTIONS: RecordingOptions = {
  ...RecordingPresets.HIGH_QUALITY,
  numberOfChannels: 1,
  bitRate: 64000,
};

// One upload can be ~35 MB: stop by itself after an hour
const MAX_SEC = 60 * 60;

type Props = {
  leadId: string;
  context: string;
  onClose: () => void;
  onSaved: (seconds: number, fileId: string) => void;
};

type Phase = 'asking' | 'denied' | 'ready' | 'recording' | 'paused' | 'done' | 'saving';

function fileName(now = new Date()): string {
  const date = now.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });
  const time = now.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' }).replace(':', '-');
  return `Voice ${date} ${time}.m4a`;
}

export function VoiceRecorderSheet({ leadId, context, onClose, onSaved }: Props) {
  const recorder = useAudioRecorder(OPTIONS);
  const player = useAudioPlayer(null);
  const status = useAudioPlayerStatus(player);
  const [phase, setPhase] = useState<Phase>('asking');
  const [seconds, setSeconds] = useState(0);
  const [uri, setUri] = useState<string | null>(null);
  const tick = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(() => {
    requestRecordingPermissionsAsync()
      .then((p) => setPhase(p.granted ? 'ready' : 'denied'))
      .catch(() => setPhase('denied'));
    return () => {
      if (tick.current) clearInterval(tick.current);
      setAudioModeAsync({ allowsRecording: false }).catch(() => undefined);
    };
  }, []);

  const startTick = () => {
    if (tick.current) clearInterval(tick.current);
    tick.current = setInterval(() => {
      const s = Math.floor(recorder.currentTime);
      setSeconds(s);
      if (s >= MAX_SEC) stop();
    }, 500);
  };
  const stopTick = () => {
    if (tick.current) clearInterval(tick.current);
    tick.current = null;
  };

  const start = async () => {
    try {
      await setAudioModeAsync({ allowsRecording: true, playsInSilentMode: true });
      await recorder.prepareToRecordAsync();
      recorder.record();
      setSeconds(0);
      setPhase('recording');
      startTick();
    } catch (e) {
      Alert.alert('Could not record', e instanceof Error ? e.message : '');
    }
  };

  const pause = () => {
    recorder.pause();
    stopTick();
    setPhase('paused');
  };

  const resume = () => {
    recorder.record();
    setPhase('recording');
    startTick();
  };

  async function stop() {
    stopTick();
    try {
      await recorder.stop();
    } catch {
      // already stopped
    }
    await setAudioModeAsync({ allowsRecording: false }).catch(() => undefined);
    const u = recorder.uri;
    setUri(u);
    if (u) player.replace({ uri: u });
    setPhase('done');
  }

  const discardFile = () => {
    if (!uri) return;
    try {
      new File(uri).delete();
    } catch {
      // already gone
    }
  };

  const save = async () => {
    if (!uri) return;
    player.pause();
    setPhase('saving');
    try {
      const row = await uploadLeadFile({
        leadId,
        kind: 'voice',
        uri,
        name: fileName(),
        mimeType: 'audio/mp4',
        durationSec: Math.max(1, seconds),
        context,
      });
      discardFile();
      onSaved(seconds, row.id);
    } catch (e) {
      setPhase('done');
      Alert.alert('Could not save the voice note', `${e instanceof Error ? e.message : ''}\nThe recording is kept here; try Save again.`);
    }
  };

  const close = () => {
    if (phase === 'recording' || phase === 'paused' || phase === 'done') {
      Alert.alert('Throw away this recording?', undefined, [
        { text: 'Keep', style: 'cancel' },
        {
          text: 'Throw away',
          style: 'destructive',
          onPress: async () => {
            stopTick();
            if (phase !== 'done') await recorder.stop().catch(() => undefined);
            player.pause();
            discardFile();
            onClose();
          },
        },
      ]);
      return;
    }
    if (phase !== 'saving') onClose();
  };

  return (
    <Modal visible transparent animationType="slide" onRequestClose={close}>
      <View style={styles.backdrop}>
        <Pressable style={styles.flex} onPress={close} accessibilityLabel="Close" />
        <View style={styles.sheet}>
          <View style={styles.handle} />
          <Text style={styles.title}>🎙 Voice note</Text>

          {phase === 'asking' && <ActivityIndicator color={colors.primary} />}

          {phase === 'denied' && (
            <>
              <Text style={styles.hint}>
                The app may not use the microphone. Allow it in the phone’s Settings → Apps → Lead Management → Permissions → Microphone.
              </Text>
              <Button title="Close" variant="secondary" onPress={onClose} fullWidth />
            </>
          )}

          {(phase === 'ready' || phase === 'recording' || phase === 'paused') && (
            <>
              <Text style={[styles.timer, phase === 'recording' && styles.timerOn]}>
                {phase === 'recording' ? '● ' : ''}
                {clock(seconds)}
              </Text>
              <Text style={styles.hint}>
                {phase === 'ready'
                  ? 'Press Record and speak. It stops by itself after an hour.'
                  : phase === 'paused'
                    ? 'Paused.'
                    : 'Recording…'}
              </Text>
              <View style={styles.controls}>
                {phase === 'ready' ? (
                  <RoundButton label="Record" icon="●" danger onPress={start} />
                ) : (
                  <>
                    {phase === 'recording' ? (
                      <RoundButton label="Pause" icon="⏸" onPress={pause} />
                    ) : (
                      <RoundButton label="Resume" icon="●" danger onPress={resume} />
                    )}
                    <RoundButton label="Stop" icon="■" onPress={stop} />
                  </>
                )}
              </View>
            </>
          )}

          {(phase === 'done' || phase === 'saving') && (
            <>
              <Text style={styles.timer}>{clock(seconds)}</Text>
              <View style={styles.controls}>
                <RoundButton
                  label={status.playing ? 'Pause' : 'Listen'}
                  icon={status.playing ? '⏸' : '▶'}
                  onPress={() => {
                    if (status.playing) player.pause();
                    else {
                      if (status.didJustFinish || (status.duration > 0 && status.currentTime >= status.duration - 0.2)) {
                        player.seekTo(0);
                      }
                      player.play();
                    }
                  }}
                />
              </View>
              {phase === 'saving' ? (
                <View style={styles.saving}>
                  <ActivityIndicator color={colors.primary} />
                  <Text style={styles.hint}>Saving to Google Drive…</Text>
                </View>
              ) : (
                <View style={styles.row}>
                  <View style={styles.flex}>
                    <Button title="Throw away" variant="secondary" onPress={close} fullWidth />
                  </View>
                  <View style={styles.flex}>
                    <Button title="Save" onPress={save} fullWidth />
                  </View>
                </View>
              )}
            </>
          )}
        </View>
      </View>
    </Modal>
  );
}

function RoundButton({ label, icon, danger, onPress }: { label: string; icon: string; danger?: boolean; onPress: () => void }) {
  return (
    <Pressable onPress={onPress} style={styles.round} accessibilityRole="button" accessibilityLabel={label}>
      <View style={[styles.roundIcon, danger && styles.roundDanger]}>
        <Text style={[styles.roundIconText, danger && styles.roundIconTextDanger]}>{icon}</Text>
      </View>
      <Text style={styles.roundLabel}>{label}</Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1 },
  backdrop: { flex: 1, backgroundColor: 'rgba(0,0,0,0.4)' },
  sheet: {
    backgroundColor: colors.surface,
    borderTopLeftRadius: radius.lg,
    borderTopRightRadius: radius.lg,
    padding: spacing.lg,
    paddingBottom: spacing.xxl,
    gap: spacing.md,
    alignItems: 'stretch',
  },
  handle: { alignSelf: 'center', width: 40, height: 4, borderRadius: radius.pill, backgroundColor: colors.border },
  title: { fontSize: fontSize.title, fontWeight: fontWeight.bold, color: colors.text },
  hint: { fontSize: fontSize.small, color: colors.textMuted, textAlign: 'center' },
  timer: { fontSize: 40, fontWeight: fontWeight.bold, color: colors.text, textAlign: 'center', fontVariant: ['tabular-nums'] },
  timerOn: { color: colors.danger },
  controls: { flexDirection: 'row', justifyContent: 'center', gap: spacing.xxl, paddingVertical: spacing.sm },
  round: { alignItems: 'center', gap: spacing.xs },
  roundIcon: {
    width: 64,
    height: 64,
    borderRadius: 32,
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 2,
    borderColor: colors.border,
    backgroundColor: colors.background,
  },
  roundDanger: { borderColor: colors.danger },
  roundIconText: { fontSize: 24, color: colors.text },
  roundIconTextDanger: { color: colors.danger },
  roundLabel: { fontSize: fontSize.caption, fontWeight: fontWeight.semibold, color: colors.textMuted },
  saving: { flexDirection: 'row', justifyContent: 'center', alignItems: 'center', gap: spacing.sm },
  row: { flexDirection: 'row', gap: spacing.md },
});
