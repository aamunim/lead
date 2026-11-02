import { Stack } from 'expo-router';
import { useEffect, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  Pressable,
  ScrollView,
  StyleSheet,
  Switch,
  Text,
  TextInput,
  View,
} from 'react-native';

import { listAssignableUsers, type AssignableUser } from '@/features/leads/api';
import {
  DEFAULT_APPROVAL_SETTINGS,
  getApprovalSettings,
  saveApprovalSettings,
  type ApprovalSettings,
} from '@/features/approval/api';
import { supabase } from '@/shared/lib/supabase';
import { colors, fontSize, fontWeight, radius, spacing } from '@/shared/theme';
import { Button } from '@/shared/ui/Button';

// =====================================================================
// ⚙️ Settings → Admission approval: on/off and who approves (the
//   Admission Officer). Admins always may. Admitted students only.
// =====================================================================

export default function ApprovalSettingsScreen() {
  const [settings, setSettings] = useState<ApprovalSettings>(DEFAULT_APPROVAL_SETTINGS);
  const [roles, setRoles] = useState<{ key: string; name: string }[]>([]);
  const [users, setUsers] = useState<AssignableUser[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    Promise.all([
      getApprovalSettings(),
      supabase.from('roles').select('key, name, rank').order('rank'),
      listAssignableUsers().catch(() => []),
    ])
      .then(([s, r, u]) => {
        setSettings(s);
        setRoles(((r.data ?? []) as { key: string; name: string }[]).filter((x) => x.key !== 'super_admin'));
        setUsers(u.filter((p) => p.role_key !== 'super_admin'));
      })
      .catch((e) => setError(e instanceof Error ? e.message : 'Could not load.'))
      .finally(() => setLoading(false));
  }, []);

  const set = (next: ApprovalSettings) => {
    setSettings(next);
    setDirty(true);
  };
  const toggle = (key: 'roles' | 'user_ids', v: string) =>
    set({
      ...settings,
      who: {
        ...settings.who,
        [key]: settings.who[key].includes(v) ? settings.who[key].filter((x) => x !== v) : [...settings.who[key], v],
      },
    });

  const save = async () => {
    const { who } = settings;
    if (who.mode === 'roles' && who.roles.length === 0) return setError('Choose at least one role.');
    if (who.mode === 'users' && who.user_ids.length === 0) return setError('Choose at least one person.');
    setSaving(true);
    setError(null);
    try {
      await saveApprovalSettings(settings);
      setDirty(false);
      Alert.alert('Saved', 'It applies the next time a student page is opened.');
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not save.');
    } finally {
      setSaving(false);
    }
  };

  if (loading) {
    return (
      <View style={styles.center}>
        <Stack.Screen options={{ title: 'Admission approval' }} />
        <ActivityIndicator size="large" color={colors.primary} />
      </View>
    );
  }

  return (
    <ScrollView style={styles.screen} contentContainerStyle={styles.content}>
      <Stack.Screen options={{ title: 'Admission approval' }} />
      <View style={styles.card}>
        <View style={styles.switchRow}>
          <View style={styles.flex}>
            <Text style={styles.rowTitle}>🎓 Admission approval</Text>
            <Text style={styles.rowText}>
              {settings.enabled
                ? 'On. After Mark admitted the Admission Officer approves the admission (choosing the section), then the registration. Either can be sent back.'
                : 'Off. Admitted students need no approval (admins can still use it).'}
            </Text>
          </View>
          <Switch value={settings.enabled} onValueChange={(v) => set({ ...settings, enabled: v })} />
        </View>

        {settings.enabled && (
          <>
            <View style={styles.divider} />
            <Text style={styles.label}>WHO APPROVES (ADMISSION OFFICER)</Text>
            <View style={styles.chips}>
              {(
                [
                  ['all', 'Everyone'],
                  ['roles', 'Some roles'],
                  ['users', 'Some people'],
                ] as const
              ).map(([m, label]) => (
                <Chip
                  key={m}
                  text={label}
                  on={settings.who.mode === m}
                  onPress={() => set({ ...settings, who: { ...settings.who, mode: m } })}
                />
              ))}
            </View>
            {settings.who.mode === 'roles' && (
              <View style={styles.chips}>
                {roles.map((r) => (
                  <Chip
                    key={r.key}
                    text={r.name}
                    on={settings.who.roles.includes(r.key)}
                    onPress={() => toggle('roles', r.key)}
                  />
                ))}
              </View>
            )}
            {settings.who.mode === 'users' && (
              <View style={styles.chips}>
                {users.map((u) => (
                  <Chip
                    key={u.id}
                    text={u.full_name ?? 'No name'}
                    on={settings.who.user_ids.includes(u.id)}
                    onPress={() => toggle('user_ids', u.id)}
                  />
                ))}
              </View>
            )}
            <Text style={styles.hint}>
              Admins always may. They get a notification for each new admission; the person who admitted the student is
              told when it is approved or sent back.
            </Text>
            <View style={styles.divider} />
            <Text style={styles.label}>MONEY NEEDED (TOTAL PAID)</Text>
            <MoneyRow
              title="Admission approval"
              value={settings.admission_min_paid}
              onChange={(n) => set({ ...settings, admission_min_paid: n })}
            />
            <MoneyRow
              title="Registration approval"
              value={settings.registration_min_paid}
              onChange={(n) => set({ ...settings, registration_min_paid: n })}
            />
            <Text style={styles.hint}>
              Approve stays locked until the student has paid this much in total (refunds taken off). Registration comes
              after the admission is approved.
            </Text>
          </>
        )}
      </View>

      {error && <Text style={styles.error}>{error}</Text>}
      <Button title="Save" onPress={save} loading={saving} disabled={!dirty} fullWidth />
    </ScrollView>
  );
}

function MoneyRow({ title, value, onChange }: { title: string; value: number; onChange: (n: number) => void }) {
  return (
    <View style={styles.moneyRow}>
      <Text style={[styles.rowTitle, styles.flex]}>{title}</Text>
      <Text style={styles.taka}>৳</Text>
      <TextInput
        value={String(value)}
        onChangeText={(t) => onChange(Number(t.replace(/[^\d]/g, '')) || 0)}
        keyboardType="number-pad"
        style={styles.moneyInput}
        accessibilityLabel={`${title}: taka needed`}
      />
    </View>
  );
}

function Chip({ text, on, onPress }: { text: string; on: boolean; onPress: () => void }) {
  return (
    <Pressable
      onPress={onPress}
      style={[styles.chip, on && styles.chipOn]}
      accessibilityRole="button"
      accessibilityState={{ selected: on }}
    >
      <Text style={[styles.chipText, on && styles.chipTextOn]}>{text}</Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  moneyRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm },
  taka: { fontSize: fontSize.body, color: colors.textMuted },
  moneyInput: {
    width: 110,
    height: 40,
    paddingHorizontal: spacing.md,
    borderRadius: radius.sm,
    borderWidth: 1,
    borderColor: colors.border,
    color: colors.text,
    backgroundColor: colors.surface,
    fontSize: fontSize.body,
    textAlign: 'right',
  },
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
