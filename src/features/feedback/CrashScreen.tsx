import { router } from 'expo-router';
import { useEffect, useState } from 'react';
import { ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';

import { sendFeedback } from '@/features/feedback/api';
import { reportCrash } from '@/features/feedback/crash';
import { colors, fontSize, fontWeight, radius, spacing } from '@/shared/theme';
import { Button } from '@/shared/ui/Button';

// =====================================================================
// 💥 A screen broke: the error is already sent to the developer by itself.
//   Try again · Go home · or add a few words about what you were doing.
//   (expo-router shows this in place of the screen: ErrorBoundary)
// =====================================================================

export function CrashScreen({ error, retry }: { error: Error; retry: () => Promise<void> }) {
  const [note, setNote] = useState('');
  const [writing, setWriting] = useState(false);
  const [sending, setSending] = useState(false);
  const [sent, setSent] = useState(false);
  const [failed, setFailed] = useState<string | null>(null);

  useEffect(() => {
    reportCrash(error, { fatal: false });
  }, [error]);

  const send = async () => {
    setSending(true);
    setFailed(null);
    try {
      const what = `${error.name || 'Error'}: ${String(error.message ?? '').slice(0, 300)}`;
      await sendFeedback('bug', `${note.trim() || 'The app showed “Something went wrong”.'}\n\n💥 ${what}`, [], {
        crash: 'yes',
      });
      setSent(true);
      setWriting(false);
    } catch (e) {
      setFailed(e instanceof Error ? e.message : 'Could not send.');
    } finally {
      setSending(false);
    }
  };

  return (
    <ScrollView style={styles.screen} contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
      <Text style={styles.icon}>😵</Text>
      <Text style={styles.title}>Something went wrong</Text>
      <Text style={styles.text}>
        The developer has been told about it. Try again; if it happens again, write what you were doing.
      </Text>
      <Text style={styles.error} numberOfLines={3} selectable>
        {error.name}: {error.message}
      </Text>

      <View style={styles.buttons}>
        <Button title="Try again" onPress={() => retry()} fullWidth />
        <Button
          title="Go to Home"
          variant="secondary"
          onPress={() => {
            retry().catch(() => undefined);
            try {
              router.replace('/');
            } catch {
              // the navigator itself is broken: Try again is the way
            }
          }}
          fullWidth
        />
      </View>

      {sent ? (
        <Text style={styles.ok}>✅ Sent to the developer. Thank you!</Text>
      ) : writing ? (
        <View style={styles.card}>
          <TextInput
            value={note}
            onChangeText={setNote}
            placeholder="What were you doing when it happened?"
            placeholderTextColor={colors.textMuted}
            multiline
            style={styles.input}
            textAlignVertical="top"
            autoFocus
          />
          {failed && <Text style={styles.failed}>{failed}</Text>}
          <Button title="Send to developer" onPress={send} loading={sending} fullWidth />
        </View>
      ) : (
        <Button
          title="✍️ Tell the developer what happened"
          variant="ghost"
          onPress={() => setWriting(true)}
          fullWidth
        />
      )}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.background },
  content: { flexGrow: 1, justifyContent: 'center', padding: spacing.xl, gap: spacing.md },
  icon: { fontSize: 56, textAlign: 'center' },
  title: { fontSize: fontSize.title, fontWeight: fontWeight.bold, color: colors.text, textAlign: 'center' },
  text: { fontSize: fontSize.body, color: colors.textMuted, textAlign: 'center', lineHeight: 22 },
  error: {
    fontSize: fontSize.caption,
    color: colors.textMuted,
    textAlign: 'center',
    fontFamily: 'monospace',
  },
  buttons: { gap: spacing.sm, marginTop: spacing.md },
  card: {
    gap: spacing.sm,
    padding: spacing.md,
    borderRadius: radius.lg,
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.border,
  },
  input: {
    minHeight: 90,
    padding: spacing.md,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.border,
    color: colors.text,
    fontSize: fontSize.body,
  },
  failed: { fontSize: fontSize.small, color: colors.danger },
  ok: { fontSize: fontSize.body, fontWeight: fontWeight.semibold, color: colors.success, textAlign: 'center' },
});
