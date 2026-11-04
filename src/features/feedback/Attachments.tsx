import { useEffect, useState } from 'react';
import { ActivityIndicator, Alert, Image, Platform, Pressable, StyleSheet, Text, View } from 'react-native';

import {
  MAX_IMAGES,
  MAX_VOICE_SEC,
  feedbackFileUrl,
  uploadFeedbackFile,
  type Attachment,
} from '@/features/feedback/api';
import { clock } from '@/features/voice/format';
import { hasAudio, hasCamera } from '@/features/voice/native';
import { Modal } from '@/shared/ui/Modal';
import { colors, fontSize, fontWeight, radius, spacing } from '@/shared/theme';

// =====================================================================
// 📎 Contact developer files: up to 3 pictures (a screenshot from the
//   gallery, or the camera) and one voice message. Each is uploaded as
//   soon as it is picked, so Send only sends the message.
// =====================================================================

/** A picked file: uploading (no path yet) or ready */
export type Picked = {
  key: string;
  kind: 'image' | 'voice';
  uri?: string;
  path?: string;
  sec?: number;
  failed?: boolean;
};

export const readyAttachments = (list: Picked[]): Attachment[] =>
  list.filter((p) => p.path).map((p) => ({ path: p.path as string, kind: p.kind, sec: p.sec ?? null }));

export const stillUploading = (list: Picked[]) => list.some((p) => !p.path && !p.failed);

type ImagePickerModule = typeof import('expo-image-picker');
const picker = (): ImagePickerModule | null =>
  Platform.OS === 'web' || hasCamera
    ? // eslint-disable-next-line @typescript-eslint/no-require-imports
      (require('expo-image-picker') as ImagePickerModule)
    : null;

export function AttachmentPicker({
  value,
  onChange,
}: {
  value: Picked[];
  /** a setState: takes the change as a function of the newest list */
  onChange: (update: (now: Picked[]) => Picked[]) => void;
}) {
  const [recording, setRecording] = useState(false);
  const images = value.filter((p) => p.kind === 'image');
  const voice = value.find((p) => p.kind === 'voice');
  const room = MAX_IMAGES - images.length;
  const ip = picker();

  const patch = (key: string, p: Partial<Picked>) =>
    onChange((now) => now.map((x) => (x.key === key ? { ...x, ...p } : x)));

  const upload = (items: { uri: string; mime: string }[]) => {
    const added: Picked[] = items.map((it, i) => ({ key: `${Date.now()}-${i}`, kind: 'image', uri: it.uri }));
    onChange((now) => [...now, ...added]);
    added.forEach((a, i) => {
      uploadFeedbackFile(items[i].uri, items[i].mime)
        .then((path) => patch(a.key, { path }))
        .catch((e) => {
          patch(a.key, { failed: true });
          Alert.alert('Could not add the picture', e instanceof Error ? e.message : '');
        });
    });
  };

  const fromGallery = async () => {
    if (!ip || room <= 0) return;
    const res = await ip.launchImageLibraryAsync({
      mediaTypes: ['images'],
      quality: 0.5,
      allowsMultipleSelection: room > 1,
      selectionLimit: room,
    });
    if (res.canceled) return;
    upload(res.assets.slice(0, room).map((a) => ({ uri: a.uri, mime: a.mimeType ?? 'image/jpeg' })));
  };

  const fromCamera = async () => {
    if (!ip || room <= 0) return;
    const perm = await ip.requestCameraPermissionsAsync();
    if (!perm.granted) return Alert.alert('Camera', 'Allow the camera in the phone’s Settings to take a photo.');
    const res = await ip.launchCameraAsync({ mediaTypes: ['images'], quality: 0.5 });
    if (res.canceled) return;
    upload(res.assets.slice(0, 1).map((a) => ({ uri: a.uri, mime: a.mimeType ?? 'image/jpeg' })));
  };

  const remove = (key: string) => onChange((now) => now.filter((x) => x.key !== key));

  const Recorder = recording
    ? // eslint-disable-next-line @typescript-eslint/no-require-imports
      (require('@/features/voice/VoiceRecorderSheet') as typeof import('@/features/voice/VoiceRecorderSheet'))
        .VoiceRecorderSheet
    : null;

  return (
    <View style={styles.wrap}>
      <View style={styles.buttons}>
        {ip && (
          <Pill
            label={`🖼 Screenshot${images.length ? ` (${images.length}/${MAX_IMAGES})` : ''}`}
            onPress={fromGallery}
            disabled={room <= 0}
          />
        )}
        {ip && Platform.OS !== 'web' && <Pill label="📷 Camera" onPress={fromCamera} disabled={room <= 0} />}
        {hasAudio && !voice && <Pill label="🎙 Voice" onPress={() => setRecording(true)} />}
      </View>

      {value.length > 0 && (
        <View style={styles.thumbs}>
          {images.map((p) => (
            <View key={p.key} style={styles.thumb}>
              {p.uri ? <Image source={{ uri: p.uri }} style={styles.thumbImg} /> : null}
              {!p.path && !p.failed && (
                <View style={styles.thumbBusy}>
                  <ActivityIndicator color="#FFFFFF" />
                </View>
              )}
              {p.failed && (
                <View style={styles.thumbBusy}>
                  <Text style={styles.failText}>Not sent</Text>
                </View>
              )}
              <Pressable onPress={() => remove(p.key)} style={styles.x} hitSlop={8} accessibilityLabel="Remove picture">
                <Text style={styles.xText}>✕</Text>
              </Pressable>
            </View>
          ))}
          {voice && (
            <View style={styles.voice}>
              <Text style={styles.voiceText}>🎙 {clock(voice.sec ?? 0)}</Text>
              <Pressable onPress={() => remove(voice.key)} hitSlop={8} accessibilityLabel="Remove voice message">
                <Text style={styles.voiceX}>✕</Text>
              </Pressable>
            </View>
          )}
        </View>
      )}

      {Recorder && (
        <Recorder
          title="🎙 Voice message"
          maxSec={MAX_VOICE_SEC}
          upload={(uri) => uploadFeedbackFile(uri, 'audio/mp4')}
          onClose={() => setRecording(false)}
          onSaved={(sec, path) => {
            setRecording(false);
            onChange((now) => [...now, { key: `v${Date.now()}`, kind: 'voice', path, sec }]);
          }}
        />
      )}
    </View>
  );
}

function Pill({ label, onPress, disabled }: { label: string; onPress: () => void; disabled?: boolean }) {
  return (
    <Pressable
      onPress={onPress}
      disabled={disabled}
      style={({ pressed }) => [styles.pill, disabled && styles.pillOff, pressed && styles.pressed]}
      accessibilityRole="button"
    >
      <Text style={styles.pillText}>{label}</Text>
    </Pressable>
  );
}

// ---------------------------------------------------------------------
// Showing the files of a sent message (the sender and the developer)
// ---------------------------------------------------------------------
export function AttachmentView({ files }: { files: Attachment[] }) {
  const [urls, setUrls] = useState<Record<string, string>>({});
  const [big, setBig] = useState<string | null>(null);
  const [playing, setPlaying] = useState<Attachment | null>(null);

  useEffect(() => {
    let live = true;
    files
      .filter((f) => f.kind === 'image')
      .forEach((f) =>
        feedbackFileUrl(f.path)
          .then((u) => live && setUrls((now) => ({ ...now, [f.path]: u })))
          .catch(() => undefined),
      );
    return () => {
      live = false;
    };
  }, [files]);

  if (files.length === 0) return null;

  const Player = playing
    ? // eslint-disable-next-line @typescript-eslint/no-require-imports
      (require('@/features/voice/VoicePlayerSheet') as typeof import('@/features/voice/VoicePlayerSheet'))
        .VoicePlayerSheet
    : null;

  return (
    <View style={styles.thumbs}>
      {files.map((f) =>
        f.kind === 'image' ? (
          <Pressable
            key={f.path}
            onPress={() => urls[f.path] && setBig(urls[f.path])}
            style={styles.thumb}
            accessibilityRole="imagebutton"
            accessibilityLabel="Open picture"
          >
            {urls[f.path] ? (
              <Image source={{ uri: urls[f.path] }} style={styles.thumbImg} />
            ) : (
              <ActivityIndicator style={styles.thumbImg} color={colors.primary} />
            )}
          </Pressable>
        ) : (
          <Pressable
            key={f.path}
            onPress={() => (hasAudio || Platform.OS === 'web' ? setPlaying(f) : undefined)}
            style={styles.voice}
            accessibilityRole="button"
            accessibilityLabel="Play voice message"
          >
            <Text style={styles.voiceText}>▶ 🎙 {clock(f.sec ?? 0)}</Text>
          </Pressable>
        ),
      )}

      <Modal visible={!!big} transparent animationType="fade" onRequestClose={() => setBig(null)}>
        <Pressable style={styles.bigWrap} onPress={() => setBig(null)} accessibilityLabel="Close picture">
          {big ? <Image source={{ uri: big }} style={styles.bigImg} resizeMode="contain" /> : null}
          <Text style={styles.bigClose}>✕ Close</Text>
        </Pressable>
      </Modal>

      {Player && playing && (
        <Player
          file={{ id: playing.path, name: 'Voice message', duration_sec: playing.sec ?? null }}
          load={() => feedbackFileUrl(playing.path)}
          onClose={() => setPlaying(null)}
        />
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { gap: spacing.sm },
  buttons: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.sm },
  pill: {
    paddingVertical: 7,
    paddingHorizontal: spacing.md,
    borderRadius: radius.pill,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.surface,
  },
  pillOff: { opacity: 0.4 },
  pressed: { opacity: 0.7 },
  pillText: { fontSize: fontSize.small, fontWeight: fontWeight.semibold, color: colors.text },
  thumbs: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.sm, alignItems: 'center' },
  thumb: { width: 72, height: 96, borderRadius: radius.md, overflow: 'hidden', backgroundColor: colors.border },
  thumbImg: { width: 72, height: 96 },
  thumbBusy: {
    ...StyleSheet.absoluteFill,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: 'rgba(0,0,0,0.35)',
  },
  failText: { fontSize: 11, color: '#FFFFFF', fontWeight: fontWeight.bold },
  x: {
    position: 'absolute',
    top: 3,
    right: 3,
    width: 22,
    height: 22,
    borderRadius: 11,
    backgroundColor: 'rgba(0,0,0,0.6)',
    alignItems: 'center',
    justifyContent: 'center',
  },
  xText: { color: '#FFFFFF', fontSize: 12, fontWeight: fontWeight.bold },
  voice: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    paddingVertical: 8,
    paddingHorizontal: spacing.md,
    borderRadius: radius.pill,
    backgroundColor: colors.primarySoft,
  },
  voiceText: { fontSize: fontSize.small, fontWeight: fontWeight.semibold, color: colors.primary },
  voiceX: { fontSize: 13, color: colors.textMuted },
  bigWrap: { flex: 1, backgroundColor: 'rgba(0,0,0,0.92)', alignItems: 'center', justifyContent: 'center' },
  bigImg: { width: '100%', height: '85%' },
  bigClose: { color: '#FFFFFF', fontSize: fontSize.body, fontWeight: fontWeight.semibold, marginTop: spacing.md },
});
