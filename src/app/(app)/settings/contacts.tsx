import Ionicons from '@expo/vector-icons/Ionicons';
import { Stack, router } from 'expo-router';
import { useEffect, useState } from 'react';
import { ActivityIndicator, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';

import { useAuth } from '@/features/auth/AuthProvider';
import {
    DEFAULT_CONTACTS_ACCESS,
    getContactsAccess,
    saveContactsAccess,
    type ContactsAccess,
    type ContactsAccessMode,
} from '@/features/contacts/api';
import { listAssignableUsers, type AssignableUser } from '@/features/leads/api';
import { colors, fontSize, fontWeight, radius, spacing } from '@/shared/theme';
import { Button } from '@/shared/ui/Button';

// Super Admins and Admins can always use it, so only these are listed
const ROLES: { key: string; label: string }[] = [
  { key: 'team_lead', label: 'Team Leads' },
  { key: 'caller', label: 'Callers' },
];

const ROLE_LABEL: Record<string, string> = {
  super_admin: 'Super Admin',
  admin: 'Admin',
  team_lead: 'Team Lead',
  caller: 'Caller',
};

const MODES: { value: ContactsAccessMode; title: string; text: string }[] = [
  { value: 'all', title: 'Everyone', text: 'All active users can add leads from their phone contacts.' },
  { value: 'roles', title: 'Only some roles', text: 'Choose the roles below.' },
  { value: 'users', title: 'Only some people', text: 'Choose the people below.' },
];

export default function ContactsAccessScreen() {
  const { hasPermission } = useAuth();
  const canManage = hasPermission('settings.manage');

  const [access, setAccess] = useState<ContactsAccess>(DEFAULT_CONTACTS_ACCESS);
  const [users, setUsers] = useState<AssignableUser[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    Promise.all([getContactsAccess(), listAssignableUsers()])
      .then(([a, u]) => {
        setAccess(a);
        // Admins always have access, so the list shows everyone else
        setUsers(u.filter((p) => p.role_key !== 'super_admin' && p.role_key !== 'admin'));
      })
      .catch((e) => setError(e instanceof Error ? e.message : 'Could not load the settings.'))
      .finally(() => setLoading(false));
  }, []);

  const change = (next: ContactsAccess) => {
    setAccess(next);
    setDirty(true);
    setError(null);
  };

  const toggleRole = (key: string) =>
    change({
      ...access,
      roles: access.roles.includes(key) ? access.roles.filter((r) => r !== key) : [...access.roles, key],
    });

  const toggleUser = (id: string) =>
    change({
      ...access,
      user_ids: access.user_ids.includes(id) ? access.user_ids.filter((u) => u !== id) : [...access.user_ids, id],
    });

  const handleSave = async () => {
    setSaving(true);
    setError(null);
    try {
      await saveContactsAccess(access);
      setDirty(false);
      router.back();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not save.');
    } finally {
      setSaving(false);
    }
  };

  // --- states -------------------------------------------------------------
  if (!canManage) {
    return (
      <View style={styles.center}>
        <Stack.Screen options={{ title: 'Phone contacts access' }} />
        <Text style={styles.muted}>Only admins can change these settings.</Text>
      </View>
    );
  }

  if (loading) {
    return (
      <View style={styles.center}>
        <Stack.Screen options={{ title: 'Phone contacts access' }} />
        <ActivityIndicator size="large" color={colors.primary} />
      </View>
    );
  }

  const summary =
    access.mode === 'all'
      ? 'Everyone can use it.'
      : access.mode === 'roles'
        ? access.roles.length === 0
          ? 'Only admins can use it (no role chosen).'
          : `Admins and ${ROLES.filter((r) => access.roles.includes(r.key)).map((r) => r.label).join(', ')} can use it.`
        : access.user_ids.length === 0
          ? 'Only admins can use it (nobody chosen).'
          : `Admins and ${access.user_ids.length} ${access.user_ids.length === 1 ? 'person' : 'people'} can use it.`;

  return (
    <ScrollView style={styles.screen} contentContainerStyle={styles.content}>
      <Stack.Screen options={{ title: 'Phone contacts access' }} />

      <Text style={styles.intro}>
        “Phone contacts” lets people pick contacts from their own phone and save them as leads. Choose who can use
        it. Admins can always use it.
      </Text>

      {/* Mode */}
      <View style={styles.card}>
        {MODES.map((m, index) => {
          const on = access.mode === m.value;
          return (
            <View key={m.value}>
              {index > 0 && <View style={styles.divider} />}
              <Pressable
                onPress={() => change({ ...access, mode: m.value })}
                style={({ pressed }) => [styles.row, pressed && styles.pressed]}
                accessibilityRole="radio"
                accessibilityState={{ checked: on }}
              >
                <View style={[styles.radio, on && styles.radioOn]}>{on && <View style={styles.radioDot} />}</View>
                <View style={styles.flex}>
                  <Text style={styles.rowTitle}>{m.title}</Text>
                  <Text style={styles.rowText}>{m.text}</Text>
                </View>
              </Pressable>
            </View>
          );
        })}
      </View>

      {/* Roles */}
      {access.mode === 'roles' && (
        <>
          <Text style={styles.sectionLabel}>ROLES</Text>
          <View style={styles.card}>
            {ROLES.map((r, index) => (
              <View key={r.key}>
                {index > 0 && <View style={styles.divider} />}
                <CheckRow label={r.label} on={access.roles.includes(r.key)} onPress={() => toggleRole(r.key)} />
              </View>
            ))}
          </View>
        </>
      )}

      {/* People */}
      {access.mode === 'users' && (
        <>
          <Text style={styles.sectionLabel}>PEOPLE ({access.user_ids.length} chosen)</Text>
          <View style={styles.card}>
            {users.length === 0 ? (
              <Text style={styles.muted}>No Team Leads or Callers yet.</Text>
            ) : (
              users.map((u, index) => (
                <View key={u.id}>
                  {index > 0 && <View style={styles.divider} />}
                  <CheckRow
                    label={u.full_name ?? 'No name'}
                    sub={ROLE_LABEL[u.role_key] ?? u.role_key}
                    on={access.user_ids.includes(u.id)}
                    onPress={() => toggleUser(u.id)}
                  />
                </View>
              ))
            )}
          </View>
        </>
      )}

      <View style={styles.summary}>
        <Ionicons name="information-circle" size={18} color={colors.info} />
        <Text style={styles.summaryText}>{summary}</Text>
      </View>

      {error && (
        <View style={styles.errorBox}>
          <Text style={styles.errorText}>{error}</Text>
        </View>
      )}

      <Button title="Save" onPress={handleSave} loading={saving} disabled={!dirty} fullWidth />
    </ScrollView>
  );
}

// =====================================================================
// Row with a tick box
// =====================================================================
function CheckRow({
  label,
  sub,
  on,
  onPress,
}: {
  label: string;
  sub?: string;
  on: boolean;
  onPress: () => void;
}) {
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
    marginTop: spacing.sm,
    marginLeft: spacing.xs,
  },
  card: {
    padding: spacing.lg,
    borderRadius: radius.lg,
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.border,
  },
  divider: { height: 1, backgroundColor: colors.border, marginVertical: spacing.sm },
  row: { flexDirection: 'row', alignItems: 'center', gap: spacing.md, paddingVertical: spacing.xs },
  rowTitle: { fontSize: fontSize.body, fontWeight: fontWeight.semibold, color: colors.text },
  rowText: { fontSize: fontSize.caption, color: colors.textMuted, marginTop: 2 },
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
  summary: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    padding: spacing.md,
    borderRadius: radius.md,
    backgroundColor: colors.infoSoft,
  },
  summaryText: { flex: 1, fontSize: fontSize.small, color: colors.info },
  muted: { fontSize: fontSize.small, color: colors.textMuted },
  errorBox: { padding: spacing.md, borderRadius: radius.md, backgroundColor: colors.dangerSoft },
  errorText: { fontSize: fontSize.small, color: colors.danger },
});