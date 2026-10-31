import * as Clipboard from 'expo-clipboard';
import { useState } from 'react';
import { Linking, Modal, Pressable, ScrollView, StyleSheet, Switch, Text, View } from 'react-native';

import { makePassword, resetUserPassword } from '@/features/users/api';
import { colors, fontSize, fontWeight, radius, spacing } from '@/shared/theme';
import { Button } from '@/shared/ui/Button';
import { TextField } from '@/shared/ui/TextField';

// =====================================================================
// 🔑 Users → a user → Reset password (admins)
//   A new password (made for you, or typed), shown once to copy or send
//   on WhatsApp. The user is signed out everywhere and, by default, picks
//   their own password at the next sign-in.
// =====================================================================

type Props = {
  user: { id: string; full_name: string | null; phone: string | null };
  onClose: () => void;
  onDone: (message: string) => void;
};

export function ResetPasswordSheet({ user, onClose, onDone }: Props) {
  const [mode, setMode] = useState<'auto' | 'own'>('auto');
  const [own, setOwn] = useState('');
  const [made] = useState(makePassword);
  const [mustChange, setMustChange] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  const name = user.full_name ?? 'this user';

  const reset = async () => {
    const password = mode === 'auto' ? made : own.trim();
    if (password.length < 8) return setError('The password must be at least 8 characters.');
    setSaving(true);
    setError(null);
    try {
      await resetUserPassword(user.id, password, mustChange);
      setDone(password);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not reset the password.');
    } finally {
      setSaving(false);
    }
  };

  const message = (password: string) =>
    `Your Lead Management password was reset.\nNew password: ${password}${
      mustChange ? '\nYou will be asked to set your own password after signing in.' : ''
    }`;

  const sendWhatsApp = (password: string) => {
    const phone = (user.phone ?? '').replace(/\D/g, '').replace(/^0/, '880');
    const text = encodeURIComponent(message(password));
    Linking.openURL(phone ? `https://wa.me/${phone}?text=${text}` : `https://wa.me/?text=${text}`).catch(() => undefined);
  };

  const finish = () => {
    onDone(`🔑 ${name}'s password was reset.`);
    onClose();
  };

  return (
    <Modal visible transparent animationType="slide" onRequestClose={done ? finish : onClose}>
      <View style={styles.backdrop}>
        <Pressable style={styles.flex} onPress={done ? finish : saving ? undefined : onClose} accessibilityLabel="Close" />
        <View style={styles.sheet}>
          <View style={styles.handle} />
          <ScrollView contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
            <Text style={styles.title}>🔑 Reset password · {name}</Text>

            {done ? (
              <>
                <Text style={styles.text}>
                  Done. {name} is signed out on every phone and the website. Give them this password (it is shown only
                  now):
                </Text>
                <Pressable
                  onPress={() => Clipboard.setStringAsync(done).then(() => setCopied(true))}
                  style={styles.passwordBox}
                  accessibilityRole="button"
                  accessibilityLabel="Copy the password"
                >
                  <Text style={styles.password} selectable>
                    {done}
                  </Text>
                  <Text style={styles.copy}>{copied ? '✓ Copied' : 'Tap to copy'}</Text>
                </Pressable>
                <Button title="💬 Send on WhatsApp" variant="secondary" onPress={() => sendWhatsApp(done)} fullWidth />
                <Button title="Done" onPress={finish} fullWidth />
              </>
            ) : (
              <>
                <View style={styles.chips}>
                  {(
                    [
                      ['auto', 'Make one for me'],
                      ['own', 'I’ll type it'],
                    ] as const
                  ).map(([m, label]) => (
                    <Pressable
                      key={m}
                      onPress={() => setMode(m)}
                      style={[styles.chip, mode === m && styles.chipOn]}
                      accessibilityRole="radio"
                      accessibilityState={{ checked: mode === m }}
                    >
                      <Text style={[styles.chipText, mode === m && styles.chipTextOn]}>{label}</Text>
                    </Pressable>
                  ))}
                </View>

                {mode === 'auto' ? (
                  <Text style={styles.text}>
                    New password: <Text style={styles.strong}>{made}</Text>
                  </Text>
                ) : (
                  <TextField
                    label="New password"
                    value={own}
                    onChangeText={setOwn}
                    autoCapitalize="none"
                    autoCorrect={false}
                    placeholder="At least 8 characters"
                  />
                )}

                <View style={styles.switchRow}>
                  <View style={styles.flex}>
                    <Text style={styles.rowTitle}>Ask for a new password at sign-in</Text>
                    <Text style={styles.rowText}>
                      They sign in with this one, then pick their own (you won’t know it).
                    </Text>
                  </View>
                  <Switch value={mustChange} onValueChange={setMustChange} />
                </View>

                <Text style={styles.hint}>{name} is signed out on every phone and the website.</Text>
                {error && <Text style={styles.error}>{error}</Text>}
                <Button title="Reset password" variant="danger" onPress={reset} loading={saving} fullWidth />
              </>
            )}
          </ScrollView>
        </View>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1 },
  backdrop: { flex: 1, backgroundColor: 'rgba(0,0,0,0.4)' },
  sheet: {
    maxHeight: '85%',
    backgroundColor: colors.surface,
    borderTopLeftRadius: radius.lg,
    borderTopRightRadius: radius.lg,
  },
  handle: {
    alignSelf: 'center',
    width: 40,
    height: 4,
    borderRadius: radius.pill,
    backgroundColor: colors.border,
    marginTop: spacing.sm,
  },
  content: { padding: spacing.lg, gap: spacing.md, paddingBottom: spacing.xxl },
  title: { fontSize: fontSize.title, fontWeight: fontWeight.bold, color: colors.text },
  text: { fontSize: fontSize.body, color: colors.text },
  strong: { fontWeight: fontWeight.bold },
  hint: { fontSize: fontSize.caption, color: colors.textMuted },
  error: { fontSize: fontSize.small, color: colors.danger },
  chips: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.sm },
  chip: {
    paddingVertical: spacing.sm,
    paddingHorizontal: spacing.md,
    borderRadius: radius.pill,
    borderWidth: 1,
    borderColor: colors.border,
  },
  chipOn: { backgroundColor: colors.text, borderColor: colors.text },
  chipText: { fontSize: fontSize.small, fontWeight: fontWeight.semibold, color: colors.textMuted },
  chipTextOn: { color: colors.surface },
  switchRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.md },
  rowTitle: { fontSize: fontSize.body, fontWeight: fontWeight.semibold, color: colors.text },
  rowText: { fontSize: fontSize.caption, color: colors.textMuted },
  passwordBox: {
    alignItems: 'center',
    gap: spacing.xs,
    padding: spacing.lg,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.primary,
    backgroundColor: colors.primarySoft,
  },
  password: { fontSize: 24, fontWeight: fontWeight.bold, color: colors.text, letterSpacing: 1 },
  copy: { fontSize: fontSize.caption, fontWeight: fontWeight.bold, color: colors.primary },
});
