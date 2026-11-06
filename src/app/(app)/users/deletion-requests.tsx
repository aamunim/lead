import { Stack } from 'expo-router';
import { useCallback, useEffect, useState } from 'react';
import { ActivityIndicator, Alert, FlatList, Platform, Pressable, StyleSheet, Text, View } from 'react-native';

import { useAuth } from '@/features/auth/AuthProvider';
import {
  adminDeleteAccount,
  closeDeletionRequest,
  listDeletionRequests,
  type DeletionRequest,
} from '@/features/auth/deleteAccount';
import { colors, fontSize, fontWeight, radius, spacing } from '@/shared/theme';

// =====================================================================
// 🗑 Users → Deletion requests (admins): people who asked on the web page
//   to delete an account they can't sign in to.
// =====================================================================

const when = (iso: string) =>
  new Date(iso).toLocaleString('en-GB', { day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' });

function confirm(title: string, text: string, ok: string, run: () => void) {
  if (Platform.OS === 'web') {
    // eslint-disable-next-line no-alert
    if (window.confirm(`${title}\n\n${text}`)) run();
    return;
  }
  Alert.alert(title, text, [
    { text: 'Cancel', style: 'cancel' },
    { text: ok, style: 'destructive', onPress: run },
  ]);
}

export default function DeletionRequestsScreen() {
  const { hasPermission } = useAuth();
  const [rows, setRows] = useState<DeletionRequest[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const load = useCallback(() => {
    listDeletionRequests()
      .then((r) => {
        setRows(r);
        setError(null);
      })
      .catch((e) => setError(e instanceof Error ? e.message : 'Could not load.'));
  }, []);
  useEffect(() => {
    load();
  }, [load]);

  const act = async (id: string, run: () => Promise<void>) => {
    setBusy(id);
    try {
      await run();
      load();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not do it.');
    } finally {
      setBusy(null);
    }
  };

  if (!hasPermission('users.manage')) {
    return (
      <View style={styles.center}>
        <Stack.Screen options={{ title: 'Deletion requests' }} />
        <Text style={styles.muted}>Only admins can see this.</Text>
      </View>
    );
  }

  return (
    <View style={styles.screen}>
      <Stack.Screen options={{ title: 'Deletion requests' }} />
      {!rows ? (
        error ? (
          <Text style={styles.error}>{error}</Text>
        ) : (
          <ActivityIndicator color={colors.primary} style={styles.loader} />
        )
      ) : (
        <FlatList
          data={rows}
          keyExtractor={(r) => r.id}
          contentContainerStyle={styles.content}
          ListHeaderComponent={
            <View style={styles.head}>
              <Text style={styles.muted}>
                Asked on the web page (lead.ittc.edu.bd/delete-account) by people who can’t sign in. Check it is really
                their account (call the number), then delete it.
              </Text>
              {error && <Text style={styles.error}>{error}</Text>}
            </View>
          }
          ListEmptyComponent={<Text style={styles.muted}>No open requests. 👍</Text>}
          renderItem={({ item: r }) => (
            <View style={styles.card}>
              <Text style={styles.name}>{r.name ?? 'No name given'}</Text>
              <Text style={styles.line}>
                📇 {r.contact} · {when(r.created_at)}
              </Text>
              {!!r.note && <Text style={styles.note}>“{r.note}”</Text>}
              <Text style={[styles.line, !r.user && styles.warn]}>
                {r.user
                  ? `👤 Account: ${r.user.full_name ?? '—'} · ${[r.user.email, r.user.phone].filter(Boolean).join(' · ')}`
                  : '⚠ No account has this e-mail or phone'}
              </Text>
              <View style={styles.buttons}>
                <Pressable
                  onPress={() => act(r.id, () => closeDeletionRequest(r.id, r.user ? 'rejected' : 'not_found'))}
                  disabled={busy === r.id}
                  style={styles.ghost}
                  accessibilityRole="button"
                >
                  <Text style={styles.ghostText}>Close request</Text>
                </Pressable>
                {r.user && (
                  <Pressable
                    onPress={() =>
                      confirm(
                        `Delete ${r.user?.full_name ?? 'this account'}?`,
                        'Their personal data is removed and the login closed for ever. Leads, calls and payments stay, as “Deleted user”; their leads become Unassigned.',
                        'Delete',
                        () => act(r.id, () => adminDeleteAccount(r.id)),
                      )
                    }
                    disabled={busy === r.id}
                    style={styles.danger}
                    accessibilityRole="button"
                  >
                    <Text style={styles.dangerText}>{busy === r.id ? '…' : 'Delete account'}</Text>
                  </Pressable>
                )}
              </View>
            </View>
          )}
        />
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.background },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: spacing.xl },
  content: {
    padding: spacing.lg,
    gap: spacing.sm,
    paddingBottom: spacing.xxl,
    ...(Platform.OS === 'web' ? { maxWidth: 760, width: '100%', alignSelf: 'center' } : {}),
  },
  loader: { marginTop: spacing.xl },
  head: { gap: spacing.sm, marginBottom: spacing.sm },
  muted: { fontSize: fontSize.small, color: colors.textMuted },
  error: { fontSize: fontSize.small, color: colors.danger, margin: spacing.sm },
  card: {
    gap: 4,
    padding: spacing.md,
    borderRadius: radius.lg,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.surface,
  },
  name: { fontSize: fontSize.body, fontWeight: fontWeight.bold, color: colors.text },
  line: { fontSize: fontSize.small, color: colors.text },
  warn: { color: colors.warning },
  note: { fontSize: fontSize.small, color: colors.textMuted, fontStyle: 'italic' },
  buttons: { flexDirection: 'row', justifyContent: 'flex-end', gap: spacing.sm, marginTop: spacing.sm },
  ghost: { paddingVertical: spacing.sm, paddingHorizontal: spacing.md },
  ghostText: { fontSize: fontSize.small, fontWeight: fontWeight.bold, color: colors.textMuted },
  danger: {
    paddingVertical: spacing.sm,
    paddingHorizontal: spacing.lg,
    borderRadius: radius.md,
    backgroundColor: colors.danger,
  },
  dangerText: { fontSize: fontSize.small, fontWeight: fontWeight.bold, color: '#fff' },
});
