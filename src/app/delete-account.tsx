import { router, Stack, type Href } from 'expo-router';
import { useState } from 'react';
import { Platform, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';

import { useAuth } from '@/features/auth/AuthProvider';
import { deleteAccountWithLogin, deleteMyAccount, requestAccountDeletion } from '@/features/auth/deleteAccount';
import { APP_NAME } from '@/features/web/brand';
import { colors, fontSize, fontWeight, radius, spacing } from '@/shared/theme';
import { Button } from '@/shared/ui/Button';

// =====================================================================
// 🗑 Delete my account: in the app (More → Delete my account) and on the
//   web, also without signing in (lead.ittc.edu.bd/delete-account).
//   Google Play asks for both.
// =====================================================================

const GONE = [
  'Your name, e-mail, phone number and photo',
  'Your login (you can never sign in with it again)',
  'Your notifications, phones and app sessions',
  'Your saved filters, ⭐ stars and your chat with the developer',
];
const KEPT = [
  'Leads, calls, notes, payments and their history stay with the institute (they are its records), shown as “Deleted user”',
  'Leads that were with you become Unassigned, so an admin can give them to someone',
];

export default function DeleteAccountScreen() {
  const { status, session } = useAuth();
  const signedIn = !!session?.user && status !== 'signed_out';
  const [mode, setMode] = useState<'login' | 'request'>('login');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [reason, setReason] = useState('');
  const [confirm, setConfirm] = useState('');
  const [name, setName] = useState('');
  const [contact, setContact] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<'deleted' | 'requested' | null>(null);

  const remove = async () => {
    if (confirm.trim().toUpperCase() !== 'DELETE') return setError('Type DELETE to confirm.');
    setBusy(true);
    setError(null);
    try {
      if (signedIn) await deleteMyAccount(password, reason);
      else await deleteAccountWithLogin(email, password, reason);
      setDone('deleted');
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not delete the account.');
    } finally {
      setBusy(false);
    }
  };

  const request = async () => {
    setBusy(true);
    setError(null);
    try {
      await requestAccountDeletion(name, contact, reason);
      setDone('requested');
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not send the request.');
    } finally {
      setBusy(false);
    }
  };

  const leave = () => {
    if (router.canGoBack()) router.back();
    else router.replace('/' as Href);
  };

  if (done) {
    return (
      <View style={styles.screen}>
        <Stack.Screen options={{ title: 'Delete account', headerShown: true }} />
        <View style={[styles.card, styles.center]}>
          <Text style={styles.big}>{done === 'deleted' ? '✅' : '📨'}</Text>
          <Text style={styles.title}>{done === 'deleted' ? 'Your account is deleted' : 'Request sent'}</Text>
          <Text style={styles.text}>
            {done === 'deleted'
              ? 'Your personal data was removed and the login is closed. You can uninstall the app.'
              : 'An admin will delete the account and may contact you to confirm it is yours. This is usually done within 7 days.'}
          </Text>
          <Button title="OK" onPress={() => router.replace('/' as Href)} fullWidth />
        </View>
      </View>
    );
  }

  return (
    <ScrollView style={styles.screen} contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
      <Stack.Screen options={{ title: 'Delete account', headerShown: true }} />
      <Text style={styles.h1}>🗑 Delete your account</Text>
      <Text style={styles.text}>{APP_NAME}</Text>

      <View style={styles.card}>
        <Text style={styles.cardTitle}>What is deleted</Text>
        {GONE.map((t) => (
          <Text key={t} style={styles.item}>
            ✕ {t}
          </Text>
        ))}
        <Text style={[styles.cardTitle, styles.gap]}>What stays</Text>
        {KEPT.map((t) => (
          <Text key={t} style={styles.item}>
            • {t}
          </Text>
        ))}
      </View>

      {!signedIn && (
        <View style={styles.seg}>
          {(
            [
              ['login', 'Sign in and delete now'],
              ['request', 'I can’t sign in'],
            ] as const
          ).map(([k, label]) => (
            <Pressable
              key={k}
              onPress={() => {
                setMode(k);
                setError(null);
              }}
              style={[styles.segBtn, mode === k && styles.segOn]}
              accessibilityRole="radio"
              accessibilityState={{ selected: mode === k }}
            >
              <Text style={[styles.segText, mode === k && styles.segTextOn]}>{label}</Text>
            </Pressable>
          ))}
        </View>
      )}

      {signedIn || mode === 'login' ? (
        <View style={styles.card}>
          {signedIn ? (
            <Text style={styles.text}>
              Account: <Text style={styles.strong}>{session?.user.email}</Text>
            </Text>
          ) : (
            <Field label="E-mail" value={email} onChange={setEmail} keyboard="email-address" />
          )}
          <Field label="Password" value={password} onChange={setPassword} secure />
          <Field label="Why are you leaving? (optional)" value={reason} onChange={setReason} />
          <Field label="Type DELETE to confirm" value={confirm} onChange={setConfirm} caps />
          {error && <Text style={styles.error}>{error}</Text>}
          <Pressable
            onPress={remove}
            disabled={busy}
            style={({ pressed }) => [styles.danger, (pressed || busy) && styles.dim]}
            accessibilityRole="button"
          >
            <Text style={styles.dangerText}>{busy ? 'Deleting…' : 'Delete my account for ever'}</Text>
          </Pressable>
          {signedIn && <Button title="Cancel" variant="ghost" onPress={leave} fullWidth />}
        </View>
      ) : (
        <View style={styles.card}>
          <Text style={styles.text}>
            Forgot the password or lost the phone? Send a request: an admin deletes the account after checking it is
            yours.
          </Text>
          <Field label="Your name" value={name} onChange={setName} />
          <Field label="E-mail or phone of the account" value={contact} onChange={setContact} />
          <Field label="Anything to add? (optional)" value={reason} onChange={setReason} />
          {error && <Text style={styles.error}>{error}</Text>}
          <Button title="Send the request" onPress={request} loading={busy} fullWidth />
        </View>
      )}
      {!signedIn && (
        <Button title="Back to sign in" variant="ghost" onPress={() => router.replace('/login' as Href)} fullWidth />
      )}
      <Text style={styles.privacy} onPress={() => router.push('/privacy' as Href)}>
        🔒 Privacy policy
      </Text>
    </ScrollView>
  );
}

function Field({
  label,
  value,
  onChange,
  secure,
  keyboard,
  caps,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  secure?: boolean;
  keyboard?: 'email-address';
  caps?: boolean;
}) {
  return (
    <View style={styles.field}>
      <Text style={styles.label}>{label}</Text>
      <TextInput
        value={value}
        onChangeText={onChange}
        secureTextEntry={secure}
        keyboardType={keyboard}
        autoCapitalize={caps ? 'characters' : 'none'}
        autoCorrect={false}
        style={styles.input}
        accessibilityLabel={label}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.background },
  content: {
    padding: spacing.lg,
    gap: spacing.md,
    paddingBottom: spacing.xxl,
    ...(Platform.OS === 'web' ? { maxWidth: 560, width: '100%', alignSelf: 'center', paddingTop: spacing.xl } : {}),
  },
  center: {
    alignItems: 'center',
    margin: spacing.lg,
    ...(Platform.OS === 'web' ? { maxWidth: 520, alignSelf: 'center' } : {}),
  },
  h1: { fontSize: fontSize.heading, fontWeight: fontWeight.bold, color: colors.text },
  big: { fontSize: 44 },
  title: { fontSize: fontSize.title, fontWeight: fontWeight.bold, color: colors.text, textAlign: 'center' },
  card: {
    gap: spacing.sm,
    padding: spacing.lg,
    borderRadius: radius.lg,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.surface,
  },
  cardTitle: { fontSize: fontSize.body, fontWeight: fontWeight.bold, color: colors.text },
  gap: { marginTop: spacing.sm },
  item: { fontSize: fontSize.small, color: colors.text, lineHeight: 20 },
  text: { fontSize: fontSize.small, color: colors.textMuted },
  strong: { fontWeight: fontWeight.bold, color: colors.text },
  field: { gap: 4 },
  label: { fontSize: fontSize.small, fontWeight: fontWeight.semibold, color: colors.text },
  input: {
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radius.md,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm + 2,
    fontSize: fontSize.body,
    color: colors.text,
    backgroundColor: colors.background,
  },
  error: { fontSize: fontSize.small, color: colors.danger },
  danger: {
    alignItems: 'center',
    paddingVertical: spacing.md,
    borderRadius: radius.md,
    backgroundColor: colors.danger,
    marginTop: spacing.sm,
  },
  dangerText: { fontSize: fontSize.body, fontWeight: fontWeight.bold, color: '#fff' },
  dim: { opacity: 0.6 },
  privacy: { fontSize: fontSize.small, color: colors.textMuted, textAlign: 'center' },
  seg: { flexDirection: 'row', gap: spacing.sm },
  segBtn: {
    flex: 1,
    alignItems: 'center',
    paddingVertical: spacing.sm + 2,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.surface,
  },
  segOn: { backgroundColor: colors.primary, borderColor: colors.primary },
  segText: { fontSize: fontSize.small, fontWeight: fontWeight.bold, color: colors.text },
  segTextOn: { color: colors.textOnPrimary },
});
