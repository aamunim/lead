import { Stack, useFocusEffect } from 'expo-router';
import { useCallback, useState } from 'react';
import { ActivityIndicator, Alert, Pressable, ScrollView, StyleSheet, Switch, Text, View } from 'react-native';

import {
  DEFAULT_FILES_SETTINGS,
  connectDrive,
  disconnectDrive,
  getDriveStatus,
  getFilesSettings,
  saveFilesSettings,
  type DriveStatus,
  type FilesSettings,
} from '@/features/files/api';
import { listAssignableUsers, type AssignableUser } from '@/features/leads/api';
import { supabase } from '@/shared/lib/supabase';
import { colors, fontSize, fontWeight, radius, spacing } from '@/shared/theme';
import { Button } from '@/shared/ui/Button';

// =====================================================================
// ⚙️ Settings → Google Drive
//   Connect the institute's Google account (once, by an admin), files
//   on/off, and who sees everyone's files (others see the ones they added).
// =====================================================================

export default function DriveSettingsScreen() {
  const [status, setStatus] = useState<DriveStatus | null>(null);
  const [settings, setSettings] = useState<FilesSettings>(DEFAULT_FILES_SETTINGS);
  const [roles, setRoles] = useState<{ key: string; name: string }[]>([]);
  const [users, setUsers] = useState<AssignableUser[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const [st, s, r, u] = await Promise.all([
        getDriveStatus(),
        getFilesSettings(),
        supabase.from('roles').select('key, name, rank').order('rank'),
        listAssignableUsers().catch(() => []),
      ]);
      setStatus(st);
      setSettings(s);
      setRoles(((r.data ?? []) as { key: string; name: string }[]).filter((x) => !['super_admin', 'admin'].includes(x.key)));
      setUsers(u.filter((p) => p.role_key !== 'super_admin'));
      setDirty(false);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not load.');
    } finally {
      setLoading(false);
    }
  }, []);

  useFocusEffect(
    useCallback(() => {
      load();
    }, [load]),
  );

  const connect = async () => {
    setBusy(true);
    setError(null);
    try {
      const r = await connectDrive();
      if (r.message) Alert.alert(r.ok ? 'Connected' : 'Not connected', r.message);
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not connect.');
    } finally {
      setBusy(false);
    }
  };

  const disconnect = () =>
    Alert.alert(
      'Disconnect Google Drive?',
      'New files can’t be added or opened until it is connected again. Files already in Drive stay there.',
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Disconnect',
          style: 'destructive',
          onPress: async () => {
            try {
              await disconnectDrive();
              await load();
            } catch (e) {
              setError(e instanceof Error ? e.message : 'Could not disconnect.');
            }
          },
        },
      ],
    );

  const set = (next: FilesSettings) => {
    setSettings(next);
    setDirty(true);
  };
  const toggle = (key: 'roles' | 'user_ids', v: string) =>
    set({
      ...settings,
      view_all: {
        ...settings.view_all,
        [key]: settings.view_all[key].includes(v)
          ? settings.view_all[key].filter((x) => x !== v)
          : [...settings.view_all[key], v],
      },
    });

  const save = async () => {
    setBusy(true);
    setError(null);
    try {
      await saveFilesSettings(settings);
      setDirty(false);
      Alert.alert('Saved', 'File settings are saved.');
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not save.');
    } finally {
      setBusy(false);
    }
  };

  if (loading) {
    return (
      <View style={styles.center}>
        <Stack.Screen options={{ title: 'Google Drive' }} />
        <ActivityIndicator size="large" color={colors.primary} />
      </View>
    );
  }

  return (
    <ScrollView style={styles.screen} contentContainerStyle={styles.content}>
      <Stack.Screen options={{ title: 'Google Drive' }} />

      <View style={styles.card}>
        <Text style={styles.rowTitle}>{status?.connected ? '✓ Connected' : 'Not connected'}</Text>
        <Text style={styles.rowText}>
          {status?.connected
            ? `${status.email ?? 'Google account'}${status.connected_by ? ` · by ${status.connected_by}` : ''}${
                status.connected_at ? ` · ${new Date(status.connected_at).toLocaleDateString('en-GB')}` : ''
              }`
            : 'Connect the institute’s Google account once. Papers (and voice notes later) are saved in its Drive, in a "Lead Management" folder. Staff don’t need to sign in to Google.'}
        </Text>
        {status?.connected ? (
          <View style={styles.row}>
            <View style={styles.flex}>
              <Button title="Connect again" variant="secondary" onPress={connect} loading={busy} fullWidth />
            </View>
            <View style={styles.flex}>
              <Button title="Disconnect" variant="ghost" onPress={disconnect} fullWidth />
            </View>
          </View>
        ) : (
          <Button title="🔗 Connect Google Drive" onPress={connect} loading={busy} fullWidth />
        )}
        <Text style={styles.hint}>
          Files open through the app only (not with a Drive link), so the rules below decide who sees them.
        </Text>
      </View>

      <View style={styles.card}>
        <View style={styles.switchRow}>
          <View style={styles.flex}>
            <Text style={styles.rowTitle}>📎 Files on leads</Text>
            <Text style={styles.rowText}>{settings.enabled ? 'On: the lead page shows Files.' : 'Off: Files are hidden.'}</Text>
          </View>
          <Switch value={settings.enabled} onValueChange={(v) => set({ ...settings, enabled: v })} />
        </View>

        <View style={styles.divider} />
        <Text style={styles.label}>WHO SEES EVERYONE’S FILES</Text>
        <Text style={styles.hint}>Admins always. Everyone else sees the files they added themselves.</Text>
        <View style={styles.chips}>
          {(
            [
              ['roles', 'Admins / some roles'],
              ['users', 'Some people'],
              ['all', 'Everyone'],
            ] as const
          ).map(([m, label]) => (
            <Chip key={m} text={label} on={settings.view_all.mode === m} onPress={() => set({ ...settings, view_all: { ...settings.view_all, mode: m } })} />
          ))}
        </View>
        {settings.view_all.mode === 'roles' && (
          <View style={styles.chips}>
            {roles.map((r) => (
              <Chip key={r.key} text={r.name} on={settings.view_all.roles.includes(r.key)} onPress={() => toggle('roles', r.key)} />
            ))}
          </View>
        )}
        {settings.view_all.mode === 'users' && (
          <View style={styles.chips}>
            {users.map((u) => (
              <Chip
                key={u.id}
                text={u.full_name ?? 'No name'}
                on={settings.view_all.user_ids.includes(u.id)}
                onPress={() => toggle('user_ids', u.id)}
              />
            ))}
          </View>
        )}
      </View>

      {error && <Text style={styles.error}>{error}</Text>}
      <Button title="Save" onPress={save} loading={busy && dirty} disabled={!dirty} fullWidth />
    </ScrollView>
  );
}

function Chip({ text, on, onPress }: { text: string; on: boolean; onPress: () => void }) {
  return (
    <Pressable onPress={onPress} style={[styles.chip, on && styles.chipOn]} accessibilityRole="button" accessibilityState={{ selected: on }}>
      <Text style={[styles.chipText, on && styles.chipTextOn]}>{text}</Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1 },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center', backgroundColor: colors.background },
  screen: { flex: 1, backgroundColor: colors.background },
  content: { padding: spacing.lg, gap: spacing.md, paddingBottom: spacing.xxl },
  card: {
    gap: spacing.sm,
    padding: spacing.lg,
    borderRadius: radius.lg,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.surface,
  },
  row: { flexDirection: 'row', gap: spacing.sm },
  divider: { height: 1, backgroundColor: colors.border, marginVertical: spacing.xs },
  switchRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.md },
  rowTitle: { fontSize: fontSize.body, fontWeight: fontWeight.bold, color: colors.text },
  rowText: { fontSize: fontSize.caption, color: colors.textMuted, marginTop: 2 },
  label: { fontSize: fontSize.caption, fontWeight: fontWeight.bold, letterSpacing: 1, color: colors.textMuted },
  hint: { fontSize: fontSize.caption, color: colors.textMuted },
  error: { fontSize: fontSize.small, color: colors.danger },
  chips: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.xs },
  chip: {
    paddingVertical: 6,
    paddingHorizontal: spacing.md,
    borderRadius: radius.pill,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.surface,
  },
  chipOn: { backgroundColor: colors.primary, borderColor: colors.primary },
  chipText: { fontSize: fontSize.small, fontWeight: fontWeight.semibold, color: colors.text },
  chipTextOn: { color: colors.textOnPrimary },
});
