import Ionicons from '@expo/vector-icons/Ionicons';
import { Stack, router } from 'expo-router';
import { useEffect, useState } from 'react';
import { ActivityIndicator, Pressable, ScrollView, StyleSheet, Switch, Text, View } from 'react-native';

import { useAuth } from '@/features/auth/AuthProvider';
import { DEFAULT_BOARD, getBoardSettings, saveBoardSettings, type BoardSettings } from '@/features/board/api';
import { listAssignableUsers, type AssignableUser } from '@/features/leads/api';
import type { WhoRule } from '@/features/pipeline/api';
import { colors, fontSize, fontWeight, radius, spacing } from '@/shared/theme';
import { Button } from '@/shared/ui/Button';

const ROLES: { key: string; label: string }[] = [
  { key: 'admin', label: 'Admins' },
  { key: 'team_lead', label: 'Team Leads' },
  { key: 'caller', label: 'Callers' },
];

const ROLE_LABEL: Record<string, string> = {
  super_admin: 'Super Admin',
  admin: 'Admin',
  team_lead: 'Team Lead',
  caller: 'Caller',
};

const WHO_MODES: { value: WhoRule['mode']; title: string; text: string }[] = [
  { value: 'all', title: 'Everyone', text: 'Each person sees the leads they can see in the list.' },
  { value: 'roles', title: 'Only some roles', text: 'Choose the roles below.' },
  { value: 'users', title: 'Only some people', text: 'Choose the people below.' },
];

export default function BoardSettingsScreen() {
  const { hasPermission } = useAuth();
  const canManage = hasPermission('settings.manage');

  const [settings, setSettings] = useState<BoardSettings>(DEFAULT_BOARD);
  const [users, setUsers] = useState<AssignableUser[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    Promise.all([getBoardSettings(), listAssignableUsers().catch(() => [])])
      .then(([s, u]) => {
        setSettings(s);
        setUsers(u.filter((p) => p.role_key !== 'super_admin'));
      })
      .finally(() => setLoading(false));
  }, []);

  const set = <K extends keyof BoardSettings>(key: K, value: BoardSettings[K]) => {
    setSettings((s) => ({ ...s, [key]: value }));
    setError(null);
  };

  const handleSave = async () => {
    const { who } = settings;
    if (settings.enabled && who.mode === 'roles' && who.roles.length === 0) {
      setError('Choose at least one role who can use the board.');
      return;
    }
    if (settings.enabled && who.mode === 'users' && who.user_ids.length === 0) {
      setError('Choose at least one person who can use the board.');
      return;
    }
    setSaving(true);
    setError(null);
    try {
      await saveBoardSettings(settings);
      router.back();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not save.');
    } finally {
      setSaving(false);
    }
  };

  if (!canManage) {
    return (
      <View style={styles.center}>
        <Stack.Screen options={{ title: 'Pipeline board' }} />
        <Text style={styles.muted}>Only admins can change these settings.</Text>
      </View>
    );
  }

  if (loading) {
    return (
      <View style={styles.center}>
        <Stack.Screen options={{ title: 'Pipeline board' }} />
        <ActivityIndicator size="large" color={colors.primary} />
      </View>
    );
  }

  const toggle = (key: 'roles' | 'user_ids', value: string) => {
    const who = settings.who;
    set('who', {
      ...who,
      [key]: who[key].includes(value) ? who[key].filter((v) => v !== value) : [...who[key], value],
    });
  };

  return (
    <ScrollView style={styles.screen} contentContainerStyle={styles.content}>
      <Stack.Screen options={{ title: 'Pipeline board' }} />

      <Text style={styles.intro}>
        Leads → Board shows one column per pipeline stage. Press and hold a card to move the lead, mark it admitted or
        lost, or set the next call.
      </Text>

      <View style={styles.card}>
        <SwitchRow
          title="Board view on"
          text={settings.enabled ? 'A List / Board switch shows on the Leads tab.' : 'Only the list is shown.'}
          value={settings.enabled}
          onChange={(v) => set('enabled', v)}
        />
      </View>

      {settings.enabled && (
        <>
          <Text style={styles.sectionLabel}>COLUMNS</Text>
          <View style={styles.card}>
            <SwitchRow
              title="Admitted and Lost columns"
              text={
                settings.closed_columns
                  ? '🎓 Admitted and ✕ Lost come after the open stages.'
                  : 'Only open stages. Closed leads are under the “Closed” chip.'
              }
              value={settings.closed_columns}
              onChange={(v) => set('closed_columns', v)}
            />
          </View>
          <Text style={styles.hint}>The open stages and their order come from Settings → Pipeline stages.</Text>

          <Text style={styles.sectionLabel}>WHO CAN USE THE BOARD</Text>
          <View style={styles.card}>
            {WHO_MODES.map((m, index) => (
              <View key={m.value}>
                {index > 0 && <View style={styles.divider} />}
                <RadioRow
                  title={m.title}
                  text={m.text}
                  on={settings.who.mode === m.value}
                  onPress={() => set('who', { ...settings.who, mode: m.value })}
                />
              </View>
            ))}

            {settings.who.mode === 'roles' && (
              <View style={styles.subList}>
                {ROLES.map((r) => (
                  <CheckRow
                    key={r.key}
                    label={r.label}
                    on={settings.who.roles.includes(r.key)}
                    onPress={() => toggle('roles', r.key)}
                  />
                ))}
              </View>
            )}

            {settings.who.mode === 'users' && (
              <View style={styles.subList}>
                {users.length === 0 ? (
                  <Text style={styles.hint}>No users yet.</Text>
                ) : (
                  users.map((u) => (
                    <CheckRow
                      key={u.id}
                      label={u.full_name ?? 'No name'}
                      sub={ROLE_LABEL[u.role_key] ?? u.role_key}
                      on={settings.who.user_ids.includes(u.id)}
                      onPress={() => toggle('user_ids', u.id)}
                    />
                  ))
                )}
              </View>
            )}
          </View>
          <Text style={styles.hint}>Admins can always use the board.</Text>
        </>
      )}

      {error && (
        <View style={styles.errorBox}>
          <Text style={styles.errorText}>{error}</Text>
        </View>
      )}
      <Button title="Save" onPress={handleSave} loading={saving} fullWidth />
    </ScrollView>
  );
}

function RadioRow({ title, text, on, onPress }: { title: string; text: string; on: boolean; onPress: () => void }) {
  return (
    <Pressable
      onPress={onPress}
      style={({ pressed }) => [styles.row, pressed && styles.pressed]}
      accessibilityRole="radio"
      accessibilityState={{ checked: on }}
    >
      <View style={[styles.radio, on && styles.radioOn]}>{on && <View style={styles.radioDot} />}</View>
      <View style={styles.flex}>
        <Text style={styles.rowTitle}>{title}</Text>
        <Text style={styles.rowText}>{text}</Text>
      </View>
    </Pressable>
  );
}

function SwitchRow({
  title,
  text,
  value,
  onChange,
}: {
  title: string;
  text: string;
  value: boolean;
  onChange: (v: boolean) => void;
}) {
  return (
    <View style={styles.row}>
      <View style={styles.flex}>
        <Text style={styles.rowTitle}>{title}</Text>
        <Text style={styles.rowText}>{text}</Text>
      </View>
      <Switch value={value} onValueChange={onChange} />
    </View>
  );
}

function CheckRow({ label, sub, on, onPress }: { label: string; sub?: string; on: boolean; onPress: () => void }) {
  return (
    <Pressable
      onPress={onPress}
      style={({ pressed }) => [styles.row, pressed && styles.pressed]}
      accessibilityRole="checkbox"
      accessibilityState={{ checked: on }}
    >
      <View style={[styles.check, on && styles.checkOn]}>
        {on && <Ionicons name="checkmark" size={16} color={colors.textOnPrimary} />}
      </View>
      <View style={styles.flex}>
        <Text style={styles.rowTitle}>{label}</Text>
        {sub && <Text style={styles.rowText}>{sub}</Text>}
      </View>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1 },
  screen: { flex: 1, backgroundColor: colors.background },
  content: { padding: spacing.lg, gap: spacing.md, paddingBottom: spacing.xxl },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: spacing.xl, backgroundColor: colors.background },
  pressed: { opacity: 0.7 },
  intro: { fontSize: fontSize.small, lineHeight: 20, color: colors.textMuted },
  sectionLabel: {
    fontSize: fontSize.caption,
    fontWeight: fontWeight.bold,
    letterSpacing: 1.2,
    color: colors.textMuted,
    marginTop: spacing.md,
    marginLeft: spacing.xs,
  },
  card: {
    gap: spacing.sm,
    padding: spacing.lg,
    borderRadius: radius.lg,
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.border,
  },
  divider: { height: 1, backgroundColor: colors.border, marginVertical: spacing.xs },
  row: { flexDirection: 'row', alignItems: 'center', gap: spacing.md, paddingVertical: spacing.xs },
  rowTitle: { fontSize: fontSize.body, fontWeight: fontWeight.semibold, color: colors.text },
  rowText: { fontSize: fontSize.caption, lineHeight: 18, color: colors.textMuted, marginTop: 2 },
  subList: {
    marginTop: spacing.sm,
    paddingTop: spacing.sm,
    borderTopWidth: 1,
    borderTopColor: colors.border,
    gap: spacing.sm,
  },
  radio: {
    width: 22,
    height: 22,
    borderRadius: radius.pill,
    borderWidth: 2,
    borderColor: colors.border,
    alignItems: 'center',
    justifyContent: 'center',
  },
  radioOn: { borderColor: colors.primary },
  radioDot: { width: 10, height: 10, borderRadius: radius.pill, backgroundColor: colors.primary },
  check: {
    width: 24,
    height: 24,
    borderRadius: radius.sm,
    borderWidth: 2,
    borderColor: colors.border,
    alignItems: 'center',
    justifyContent: 'center',
  },
  checkOn: { backgroundColor: colors.primary, borderColor: colors.primary },
  hint: { fontSize: fontSize.caption, lineHeight: 18, color: colors.textMuted },
  muted: { fontSize: fontSize.small, color: colors.textMuted },
  errorBox: { padding: spacing.md, borderRadius: radius.md, backgroundColor: colors.dangerSoft },
  errorText: { fontSize: fontSize.small, color: colors.danger },
});
