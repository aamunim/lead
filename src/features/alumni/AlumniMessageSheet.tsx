import { useState } from 'react';
import { ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';

import { AI_PURPOSE_LABEL, aiAlumniMessage, type AiPurpose } from '@/features/alumni/api';
import { Sheet } from '@/features/alumni/sheets';
import { Chip, s as ui } from '@/features/alumni/ui';
import { md } from '@/features/home/md';
import { colors, fontSize, radius, spacing } from '@/shared/theme';
import { Button } from '@/shared/ui/Button';

// =====================================================================
// 💬 A WhatsApp message to one alumnus: type it, or ✨ let the AI write
//   it (asks for referrals, catch up, birthday, thanks), then send.
//   For a campaign (no alumnus): the AI keeps {first_name} / {refer_link}.
// =====================================================================

export function AlumniMessageSheet({
  title,
  alumniId,
  initial = '',
  purposes = ['refer', 'reconnect', 'birthday', 'thanks'],
  defaultPurpose = 'refer',
  sendLabel = 'Send on WhatsApp',
  onSend,
  onClose,
}: {
  title: string;
  /** null: a campaign message (for many) */
  alumniId: string | null;
  initial?: string;
  purposes?: AiPurpose[];
  defaultPurpose?: AiPurpose;
  sendLabel?: string;
  onSend: (text: string) => Promise<void> | void;
  onClose: () => void;
}) {
  const [text, setText] = useState(initial);
  const [purpose, setPurpose] = useState<AiPurpose>(defaultPurpose);
  const [writing, setWriting] = useState(false);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const write = async () => {
    setWriting(true);
    setError(null);
    try {
      setText(await aiAlumniMessage({ alumniId, purpose, hint: text.trim() && !text.includes('\n') ? text : '' }));
    } catch (e) {
      setError(e instanceof Error ? e.message : 'The AI could not write it.');
    } finally {
      setWriting(false);
    }
  };

  const send = async () => {
    if (!text.trim()) return;
    setSending(true);
    setError(null);
    try {
      await onSend(text.trim());
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not send.');
      setSending(false);
    }
  };

  return (
    <Sheet title={title} onClose={onClose}>
      {purposes.length > 1 && (
        <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.row}>
          {purposes.map((p) => (
            <Chip key={p} text={AI_PURPOSE_LABEL[p]} on={purpose === p} onPress={() => setPurpose(p)} />
          ))}
        </ScrollView>
      )}
      <TextInput
        value={text}
        onChangeText={setText}
        placeholder={alumniId ? 'Type the message, or let the AI write it' : 'Hi {first_name}, …'}
        placeholderTextColor={colors.textMuted}
        multiline
        maxLength={2000}
        style={styles.input}
        accessibilityLabel="Message"
      />
      <Button
        title={writing ? 'Writing…' : text.trim() ? '✨ Write again with AI' : '✨ Write with AI'}
        variant="secondary"
        onPress={write}
        loading={writing}
        disabled={writing}
        fullWidth
      />
      <Text style={ui.muted}>
        The AI gets the first name, course, batch, workplace and the last notes — no phone numbers. A short line you
        type first is used as a hint.
      </Text>
      {error && <Text style={ui.error}>{error}</Text>}
      <View style={styles.buttons}>
        <View style={styles.flex}>
          <Button title="Cancel" variant="ghost" onPress={onClose} fullWidth />
        </View>
        <View style={styles.flex}>
          <Button title={sendLabel} onPress={send} loading={sending} disabled={!text.trim() || writing} fullWidth />
        </View>
      </View>
    </Sheet>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1 },
  row: { gap: spacing.xs },
  input: {
    minHeight: 140,
    padding: spacing.md,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: md.outline,
    color: colors.text,
    fontSize: fontSize.body,
    textAlignVertical: 'top',
  },
  buttons: { flexDirection: 'row', gap: spacing.sm },
});
