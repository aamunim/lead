import { setAudioModeAsync, useAudioPlayer, useAudioPlayerStatus } from 'expo-audio';
import { useEffect, useState } from 'react';
import { ActivityIndicator, Modal, Pressable, StyleSheet, Text, View } from 'react-native';

import { downloadLeadFile } from '@/features/files/api';
import { clock } from '@/features/voice/format';
import { colors, fontSize, fontWeight, radius, spacing } from '@/shared/theme';

// =====================================================================
// ▶ Listen to a voice note (or any audio file of a lead) inside the app:
//   play / pause, tap the bar to jump, speed 1x · 1.5x · 2x.
//   Loaded only on builds that have the audio part (see native.ts).
// =====================================================================

export type PlayableFile = { id: string; name: string; duration_sec?: number | null };

const SPEEDS = [1, 1.5, 2];

export function VoicePlayerSheet({ file, onClose }: { file: PlayableFile; onClose: () => void }) {
  const player = useAudioPlayer(null, { updateInterval: 250 });
  const status = useAudioPlayerStatus(player);
  const [error, setError] = useState<string | null>(null);
  const [ready, setReady] = useState(false);
  const [speed, setSpeed] = useState(1);
  const [barWidth, setBarWidth] = useState(1);

  useEffect(() => {
    let live = true;
    setAudioModeAsync({ playsInSilentMode: true }).catch(() => undefined);
    downloadLeadFile(file)
      .then((f) => {
        if (!live) return;
        player.replace({ uri: f.uri });
        setReady(true);
        player.play();
      })
      .catch((e) => live && setError(e instanceof Error ? e.message : 'Could not open the voice note.'));
    return () => {
      live = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [file.id]);

  const duration = status.duration > 0 ? status.duration : (file.duration_sec ?? 0);
  const at = Math.min(status.currentTime, duration || status.currentTime);
  const share = duration > 0 ? at / duration : 0;

  const toggle = () => {
    if (status.playing) {
      player.pause();
      return;
    }
    if (status.didJustFinish || (duration > 0 && at >= duration - 0.2)) player.seekTo(0);
    player.play();
  };

  const pickSpeed = (s: number) => {
    setSpeed(s);
    player.setPlaybackRate(s);
  };

  const close = () => {
    player.pause();
    onClose();
  };

  return (
    <Modal visible transparent animationType="slide" onRequestClose={close}>
      <View style={styles.backdrop}>
        <Pressable style={styles.flex} onPress={close} accessibilityLabel="Close" />
        <View style={styles.sheet}>
          <View style={styles.handle} />
          <Text style={styles.title} numberOfLines={1}>
            🎙 {file.name}
          </Text>

          {error ? (
            <Text style={styles.error}>{error}</Text>
          ) : !ready ? (
            <View style={styles.loading}>
              <ActivityIndicator color={colors.primary} />
              <Text style={styles.muted}>Getting it from Google Drive…</Text>
            </View>
          ) : (
            <>
              <Pressable
                onLayout={(e) => setBarWidth(Math.max(1, e.nativeEvent.layout.width))}
                onPress={(e) => duration > 0 && player.seekTo((e.nativeEvent.locationX / barWidth) * duration)}
                style={styles.track}
                accessibilityRole="adjustable"
                accessibilityLabel={`${clock(at)} of ${clock(duration)}`}
              >
                <View style={[styles.bar, { width: `${Math.round(share * 100)}%` }]} />
              </Pressable>
              <View style={styles.times}>
                <Text style={styles.muted}>{clock(at)}</Text>
                <Text style={styles.muted}>{clock(duration)}</Text>
              </View>

              <View style={styles.controls}>
                <Pressable
                  onPress={() => player.seekTo(Math.max(0, at - 10))}
                  style={styles.skip}
                  accessibilityRole="button"
                  accessibilityLabel="Back 10 seconds"
                >
                  <Text style={styles.skipText}>↺ 10</Text>
                </Pressable>
                <Pressable
                  onPress={toggle}
                  style={styles.play}
                  accessibilityRole="button"
                  accessibilityLabel={status.playing ? 'Pause' : 'Play'}
                >
                  <Text style={styles.playText}>{status.playing ? '⏸' : '▶'}</Text>
                </Pressable>
                <Pressable
                  onPress={() => player.seekTo(duration > 0 ? Math.min(duration, at + 10) : at + 10)}
                  style={styles.skip}
                  accessibilityRole="button"
                  accessibilityLabel="Forward 10 seconds"
                >
                  <Text style={styles.skipText}>10 ↻</Text>
                </Pressable>
              </View>

              <View style={styles.speeds}>
                {SPEEDS.map((s) => (
                  <Pressable
                    key={s}
                    onPress={() => pickSpeed(s)}
                    style={[styles.speed, speed === s && styles.speedOn]}
                    accessibilityRole="button"
                    accessibilityState={{ selected: speed === s }}
                  >
                    <Text style={[styles.speedText, speed === s && styles.speedTextOn]}>{s}x</Text>
                  </Pressable>
                ))}
              </View>
            </>
          )}
        </View>
      </View>
    </Modal>
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
  },
  handle: { alignSelf: 'center', width: 40, height: 4, borderRadius: radius.pill, backgroundColor: colors.border },
  title: { fontSize: fontSize.body, fontWeight: fontWeight.bold, color: colors.text },
  muted: { fontSize: fontSize.caption, color: colors.textMuted, fontVariant: ['tabular-nums'] },
  error: { fontSize: fontSize.small, color: colors.danger },
  loading: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm, paddingVertical: spacing.lg },
  track: { height: 24, justifyContent: 'center', borderRadius: radius.pill, backgroundColor: colors.background, overflow: 'hidden' },
  bar: { height: 24, backgroundColor: colors.primary, opacity: 0.85 },
  times: { flexDirection: 'row', justifyContent: 'space-between' },
  controls: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: spacing.xl },
  play: {
    width: 64,
    height: 64,
    borderRadius: 32,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: colors.primary,
  },
  playText: { fontSize: 26, color: colors.textOnPrimary },
  skip: { padding: spacing.sm },
  skipText: { fontSize: fontSize.small, fontWeight: fontWeight.bold, color: colors.textMuted },
  speeds: { flexDirection: 'row', justifyContent: 'center', gap: spacing.sm },
  speed: {
    paddingVertical: spacing.xs,
    paddingHorizontal: spacing.md,
    borderRadius: radius.pill,
    borderWidth: 1,
    borderColor: colors.border,
  },
  speedOn: { backgroundColor: colors.text, borderColor: colors.text },
  speedText: { fontSize: fontSize.small, fontWeight: fontWeight.semibold, color: colors.textMuted },
  speedTextOn: { color: colors.surface },
});
