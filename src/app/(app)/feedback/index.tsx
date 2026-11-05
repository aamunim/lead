import { Stack, useFocusEffect } from 'expo-router';
import { useCallback, useEffect, useState } from 'react';
import {
  ActivityIndicator,
  Pressable,
  RefreshControl,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';

import { useAuth } from '@/features/auth/AuthProvider';
import {
  KINDS,
  STATUS,
  dayTime,
  listMyFeedback,
  sendFeedback,
  solveFeedback,
  uploadFeedbackFile,
  type Feedback,
  type FeedbackKind,
} from '@/features/feedback/api';
import { hasScreenShot, takePendingShot } from '@/features/feedback/screenShot';
import { AttachmentPicker, AttachmentView, readyAttachments, stillUploading, type Picked } from '@/features/feedback/Attachments';
import { colors, fontSize, fontWeight, radius, spacing } from '@/shared/theme';
import { Button } from '@/shared/ui/Button';

// =====================================================================
// 💬 More → Contact developer: write a problem, an idea or a question;
//   the app version and phone go with it. Below: what you sent, its
//   status and the developer's answer.
// =====================================================================

export default function ContactDeveloperScreen() {
  const { profile } = useAuth();
  const [kind, setKind] = useState<FeedbackKind>('bug');
  const [text, setText] = useState('');
  // 📸 pictures and 🎙 a voice message (uploaded as soon as they are picked)
  const [files, setFiles] = useState<Picked[]>([]);

  // 📸 Opened with three fingers: the screen picture is added already
  useEffect(() => {
    const shot = takePendingShot();
    if (!shot) return;
    const key = `shot-${Date.now()}`;
    setFiles((now) => [...now, { key, kind: 'image', uri: shot }]);
    uploadFeedbackFile(shot, 'image/jpeg')
      .then((path) => setFiles((now) => now.map((x) => (x.key === key ? { ...x, path } : x))))
      .catch(() => setFiles((now) => now.map((x) => (x.key === key ? { ...x, failed: true } : x))));
  }, []);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [sent, setSent] = useState(false);
  const [mine, setMine] = useState<Feedback[] | null>(null);
  const [refreshing, setRefreshing] = useState(false);

  const load = useCallback(async () => {
    if (!profile?.id) return;
    try {
      setMine(await listMyFeedback(profile.id));
    } catch (e) {
      setMine([]);
      setError(e instanceof Error ? e.message : 'Could not load.');
    }
  }, [profile?.id]);

  useFocusEffect(
    useCallback(() => {
      load();
    }, [load]),
  );

  const send = async () => {
    const ready = readyAttachments(files);
    if (text.trim().length < 3 && ready.length === 0) return setError('Please write a little more.');
    if (stillUploading(files)) return setError('Wait a moment: the files are still being added.');
    setSending(true);
    setError(null);
    try {
      await sendFeedback(kind, text.trim(), ready);
      setText('');
      setFiles([]);
      setSent(true);
      setTimeout(() => setSent(false), 4000);
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not send.');
    } finally {
      setSending(false);
    }
  };

  const hint = KINDS.find((k) => k.kind === kind)?.hint ?? '';

  return (
    <ScrollView
      style={styles.screen}
      contentContainerStyle={styles.content}
      keyboardShouldPersistTaps="handled"
      refreshControl={
        <RefreshControl
          refreshing={refreshing}
          onRefresh={async () => {
            setRefreshing(true);
            await load();
            setRefreshing(false);
          }}
        />
      }
    >
      <Stack.Screen options={{ title: 'Contact developer' }} />

      <View style={styles.card}>
        <Text style={styles.title}>💬 Write to the developer</Text>
        <Text style={styles.muted}>Problems, ideas or questions about the app. The developer will answer here.</Text>

        <View style={styles.kinds}>
          {KINDS.map((k) => (
            <Pressable
              key={k.kind}
              onPress={() => setKind(k.kind)}
              style={[styles.kind, kind === k.kind && styles.kindOn]}
              accessibilityRole="radio"
              accessibilityState={{ selected: kind === k.kind }}
            >
              <Text style={styles.kindIcon}>{k.icon}</Text>
              <Text style={[styles.kindText, kind === k.kind && styles.kindTextOn]}>{k.label}</Text>
            </Pressable>
          ))}
        </View>

        <TextInput
          value={text}
          onChangeText={(t) => {
            setText(t);
            if (error) setError(null);
          }}
          placeholder={hint}
          placeholderTextColor={colors.textMuted}
          multiline
          maxLength={4000}
          style={styles.input}
          textAlignVertical="top"
        />
        <AttachmentPicker value={files} onChange={setFiles} />
        <Text style={styles.small}>Your name, the app version and your phone model are sent with it.</Text>
        {hasScreenShot && (
          <Text style={styles.small}>📸 Tip: on any screen, tap with three fingers to send a picture of it.</Text>
        )}
        {error && <Text style={styles.error}>{error}</Text>}
        {sent && <Text style={styles.ok}>✅ Sent to the developer. Thank you!</Text>}
        <Button title="Send" onPress={send} loading={sending} fullWidth />
      </View>

      <Text style={styles.section}>WHAT YOU SENT</Text>
      {mine === null ? (
        <ActivityIndicator color={colors.primary} />
      ) : mine.length === 0 ? (
        <Text style={styles.muted}>Nothing yet.</Text>
      ) : (
        mine.map((f) => {
          const k = KINDS.find((x) => x.kind === f.kind);
          const s = STATUS[f.status];
          return (
            <View key={f.id} style={styles.item}>
              <View style={styles.itemHead}>
                <Text style={styles.itemKind}>
                  {k?.icon} {k?.label}
                </Text>
                <View style={[styles.status, f.status === 'done' && styles.statusDone]}>
                  <Text style={styles.statusText}>
                    {s.icon} {s.label}
                  </Text>
                </View>
              </View>
              <Text style={styles.message}>{f.message}</Text>
              <AttachmentView files={f.attachments} />
              <Text style={styles.small}>
                {dayTime(f.createdAt)}
                {f.solvedAt ? ` · ✅ solved ${dayTime(f.solvedAt)}` : ''}
              </Text>
              {!!f.reply && (
                <View style={styles.reply}>
                  <Text style={styles.replyLabel}>💬 Developer{f.repliedAt ? ` · ${dayTime(f.repliedAt)}` : ''}</Text>
                  <Text style={styles.message}>{f.reply}</Text>
                </View>
              )}
              {f.status !== 'done' && f.status !== 'wont' && (
                <Pressable
                  onPress={async () => {
                    try {
                      await solveFeedback(f.id);
                      await load();
                    } catch (e) {
                      setError(e instanceof Error ? e.message : 'Could not save.');
                    }
                  }}
                  style={styles.solve}
                  accessibilityRole="button"
                >
                  <Text style={styles.solveText}>✅ It’s solved</Text>
                </Pressable>
              )}
            </View>
          );
        })
      )}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.background },
  content: { padding: spacing.lg, gap: spacing.md, paddingBottom: spacing.xxl },
  card: {
    padding: spacing.lg,
    gap: spacing.md,
    borderRadius: radius.lg,
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.border,
  },
  title: { fontSize: fontSize.title, fontWeight: fontWeight.bold, color: colors.text },
  muted: { fontSize: fontSize.small, color: colors.textMuted },
  small: { fontSize: fontSize.caption, color: colors.textMuted },
  kinds: { flexDirection: 'row', gap: spacing.sm },
  kind: {
    flex: 1,
    alignItems: 'center',
    gap: 2,
    paddingVertical: spacing.sm,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.border,
  },
  kindOn: { backgroundColor: colors.primarySoft, borderColor: colors.primary },
  kindIcon: { fontSize: 22 },
  kindText: { fontSize: fontSize.small, fontWeight: fontWeight.semibold, color: colors.text },
  kindTextOn: { color: colors.primary },
  input: {
    minHeight: 130,
    padding: spacing.md,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.background,
    color: colors.text,
    fontSize: fontSize.body,
  },
  error: { fontSize: fontSize.small, color: colors.danger },
  ok: { fontSize: fontSize.small, fontWeight: fontWeight.semibold, color: colors.success },
  section: {
    fontSize: fontSize.caption,
    fontWeight: fontWeight.bold,
    color: colors.textMuted,
    letterSpacing: 0.6,
    marginTop: spacing.sm,
  },
  item: {
    padding: spacing.lg,
    gap: spacing.xs,
    borderRadius: radius.lg,
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.border,
  },
  itemHead: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: spacing.sm },
  itemKind: { fontSize: fontSize.small, fontWeight: fontWeight.bold, color: colors.text },
  status: {
    paddingVertical: 2,
    paddingHorizontal: spacing.sm,
    borderRadius: radius.pill,
    backgroundColor: colors.background,
  },
  statusDone: { backgroundColor: colors.successSoft },
  statusText: { fontSize: fontSize.caption, fontWeight: fontWeight.semibold, color: colors.text },
  message: { fontSize: fontSize.small, color: colors.text, lineHeight: 20 },
  reply: {
    marginTop: spacing.sm,
    padding: spacing.md,
    gap: 2,
    borderRadius: radius.md,
    backgroundColor: colors.primarySoft,
  },
  solve: {
    alignSelf: 'flex-start',
    marginTop: spacing.xs,
    paddingVertical: 6,
    paddingHorizontal: spacing.md,
    borderRadius: radius.pill,
    backgroundColor: colors.successSoft,
  },
  solveText: { fontSize: fontSize.small, fontWeight: fontWeight.semibold, color: colors.success },
  replyLabel: { fontSize: fontSize.caption, fontWeight: fontWeight.bold, color: colors.primary },
});
