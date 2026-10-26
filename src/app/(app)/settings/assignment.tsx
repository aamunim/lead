import Ionicons from '@expo/vector-icons/Ionicons';
import { Stack, router } from 'expo-router';
import { useEffect, useState } from 'react';
import { ActivityIndicator, Pressable, ScrollView, StyleSheet, Switch, Text, View } from 'react-native';

import { useAuth } from '@/features/auth/AuthProvider';
import { listAssignableUsers, type AssignableUser } from '@/features/leads/api';
import {
  DEFAULT_ASSIGNMENT,
  getAssignmentSettings,
  saveAssignmentSettings,
  type AssignmentSettings,
  type Visibility,
} from '@/features/settings/assignment';
import { colors, fontSize, fontWeight, radius, spacing } from '@/shared/theme';
import { Button } from '@/shared/ui/Button';

const ROLE_LABEL: Record<string, string> = {
  super_admin: 'Super Admin',
  admin: 'Admin',
  team_lead: 'Team Lead',
  caller: 'Caller',
};

export default function AssignmentSettingsScreen() {
  const { hasPermission, refreshAssignment } = useAuth();
  const canManage = hasPermission('settings.manage');

  const [settings, setSettings] = useState<AssignmentSettings>(DEFAULT_ASSIGNMENT);
  const [users, setUsers] = useState<AssignableUser[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [choosingUser, setChoosingUser] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    Promise.all([getAssignmentSettings(), listAssignableUsers({ includeInactive: true })])
      .then(([s, u]) => {
        setSettings(s);
        setUsers(u);
      })
      .catch((e) => setError(e instanceof Error ? e.message : 'Could not load the settings.'))
      .finally(() => setLoading(false));
  }, []);

  const set = <K extends keyof AssignmentSettings>(key: K, value: AssignmentSettings[K]) => {
    setSettings((s) => ({ ...s, [key]: value }));
    setDirty(true);
    setError(null);
  };

  const autoUser = users.find((u) => u.id === settings.admin_auto_user_id) ?? null;
  const autoUserInactive = !!autoUser && !autoUser.is_active;
  const activeUsers = users.filter((u) => u.is_active);

  const handleSave = async () => {
    if (settings.enabled && settings.admin_auto && !settings.admin_auto_user_id) {
      setError('Choose who gets the leads added by admins, or switch that rule off.');
      return;
    }
    setSaving(true);
    setError(null);
    try {
      await saveAssignmentSettings(settings);
      await refreshAssignment(); // use the new setting in this app straight away
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
        <Stack.Screen options={{ title: 'Lead assignment' }} />
        <Text style={styles.muted}>Only admins can change these settings.</Text>
      </View>
    );
  }

  if (loading) {
    return (
      <View style={styles.center}>
        <Stack.Screen options={{ title: 'Lead assignment' }} />
        <ActivityIndicator size="large" color={colors.primary} />
      </View>
    );
  }

  const off = !settings.enabled;

  return (
    <ScrollView style={styles.screen} contentContainerStyle={styles.content}>
      <Stack.Screen options={{ title: 'Lead assignment' }} />

      {/* Main switch */}
      <View style={[styles.card, styles.mainCard]}>
        <SwitchRow
          title="Assignment"
          text={
            settings.enabled
              ? 'Leads are given to people. Each user sees leads by their role.'
              : 'Off: nobody is assigned, and everyone sees and works on every lead.'
          }
          value={settings.enabled}
          onChange={(v) => set('enabled', v)}
          big
        />
      </View>

      <View style={off && styles.dimmed} pointerEvents={off ? 'none' : 'auto'}>
        {/* Visibility */}
        <Text style={styles.sectionLabel}>WHO SEES WHICH LEADS</Text>
        <View style={styles.card}>
          <RadioRow
            title="Assigned only"
            text="Callers see their own leads, Team Leads see their team's, Admins see all."
            on={settings.visibility === 'assigned'}
            onPress={() => set('visibility', 'assigned' as Visibility)}
          />
          <View style={styles.divider} />
          <RadioRow
            title="Everyone sees all leads"
            text="Everyone can see and work on every lead. Assignment still shows who owns it."
            on={settings.visibility === 'everyone'}
            onPress={() => set('visibility', 'everyone' as Visibility)}
          />
        </View>

        {/* Automatic assignment */}
        <Text style={styles.sectionLabel}>AUTOMATIC ASSIGNMENT</Text>
        <View style={styles.card}>
          <SwitchRow
            title="Leads added by admins go to"
            text="Applies when an admin leaves “Assigned to” on Auto."
            value={settings.admin_auto}
            onChange={(v) => {
              set('admin_auto', v);
              if (v && !settings.admin_auto_user_id) setChoosingUser(true);
            }}
          />

          {settings.admin_auto && (
            <View style={styles.userBox}>
              <Pressable
                onPress={() => setChoosingUser((c) => !c)}
                style={({ pressed }) => [styles.userPicked, pressed && styles.pressed]}
                accessibilityRole="button"
              >
                <Ionicons name="person-circle" size={22} color={colors.primary} />
                <Text style={styles.userPickedText}>{autoUser ? autoUser.full_name ?? 'No name' : 'Choose a user'}</Text>
                <Text style={styles.link}>{choosingUser ? 'Close' : 'Change'}</Text>
              </Pressable>

              {autoUserInactive && (
                <Text style={styles.warn}>
                  ⚠️ This user is deactivated. New leads will stay Unassigned until you choose someone else.
                </Text>
              )}

              {choosingUser && (
                <View style={styles.userList}>
                  {activeUsers.map((u) => {
                    const on = u.id === settings.admin_auto_user_id;
                    return (
                      <Pressable
                        key={u.id}
                        onPress={() => {
                          set('admin_auto_user_id', u.id);
                          setChoosingUser(false);
                        }}
                        style={({ pressed }) => [styles.userRow, on && styles.userRowOn, pressed && styles.pressed]}
                        accessibilityRole="radio"
                        accessibilityState={{ checked: on }}
                      >
                        <View style={styles.flex}>
                          <Text style={styles.userName}>{u.full_name ?? 'No name'}</Text>
                          <Text style={styles.userRole}>{ROLE_LABEL[u.role_key] ?? u.role_key}</Text>
                        </View>
                        {on && <Ionicons name="checkmark-circle" size={20} color={colors.primary} />}
                      </Pressable>
                    );
                  })}
                </View>
              )}
            </View>
          )}

          <View style={styles.divider} />
          <SwitchRow
            title="Callers get the leads they add"
            text="Off: leads added by Callers stay Unassigned for an admin to give out."
            value={settings.caller_self}
            onChange={(v) => set('caller_self', v)}
          />
        </View>

        {/* Team Leads */}
        <Text style={styles.sectionLabel}>TEAM LEADS</Text>
        <View style={styles.card}>
          <SwitchRow
            title="Can assign within their team"
            text="Team Leads can give leads to themselves and their own Callers."
            value={settings.team_lead_assign}
            onChange={(v) => set('team_lead_assign', v)}
          />
          <View style={styles.divider} />
          <SwitchRow
            title="Get the leads they add"
            text="Off: leads added by Team Leads stay Unassigned."
            value={settings.team_lead_self}
            onChange={(v) => set('team_lead_self', v)}
          />
        </View>
      </View>

      {/* Notes */}
      <View style={styles.note}>
        <Text style={styles.noteText}>ℹ️ Assigning by hand always wins over the automatic rules.</Text>
        <Text style={styles.noteText}>ℹ️ The person who added a lead can always see it.</Text>
        <Text style={styles.noteText}>
          ℹ️ To move a user's leads to someone else: Leads → Filter → Assigned to → Mark all → Assign.
        </Text>
        {off && (
          <Text style={styles.noteText}>
            ℹ️ Turning assignment off keeps old assignments. Turn it back on and every lead returns to its owner.
          </Text>
        )}
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
// Rows
// =====================================================================
function SwitchRow({
  title,
  text,
  value,
  onChange,
  big,
}: {
  title: string;
  text: string;
  value: boolean;
  onChange: (v: boolean) => void;
  big?: boolean;
}) {
  return (
    <View style={styles.row}>
      <View style={styles.flex}>
        <Text style={[styles.rowTitle, big && styles.rowTitleBig]}>{title}</Text>
        <Text style={styles.rowText}>{text}</Text>
      </View>
      <Switch value={value} onValueChange={onChange} />
    </View>
  );
}

function RadioRow({
  title,
  text,
  on,
  onPress,
}: {
  title: string;
  text: string;
  on: boolean;
  onPress: () => void;
}) {
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

const styles = StyleSheet.create({
  flex: { flex: 1 },
  screen: { flex: 1, backgroundColor: colors.background },
  content: { padding: spacing.lg, gap: spacing.md, paddingBottom: spacing.xxl },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: spacing.xl, backgroundColor: colors.background },
  dimmed: { opacity: 0.4 },
  pressed: { opacity: 0.7 },
  sectionLabel: {
    fontSize: fontSize.caption,
    fontWeight: fontWeight.bold,
    letterSpacing: 1.2,
    color: colors.textMuted,
    marginTop: spacing.md,
    marginBottom: spacing.sm,
    marginLeft: spacing.xs,
  },
  card: {
    padding: spacing.lg,
    gap: spacing.sm,
    borderRadius: radius.lg,
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.border,
  },
  mainCard: { borderColor: colors.primary, borderWidth: 1.5 },
  divider: { height: 1, backgroundColor: colors.border, marginVertical: spacing.xs },
  row: { flexDirection: 'row', alignItems: 'center', gap: spacing.md },
  rowTitle: { fontSize: fontSize.body, fontWeight: fontWeight.semibold, color: colors.text },
  rowTitleBig: { fontSize: fontSize.title, fontWeight: fontWeight.bold },
  rowText: { fontSize: fontSize.caption, lineHeight: 18, color: colors.textMuted, marginTop: 2 },
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
  userBox: { gap: spacing.sm, marginLeft: spacing.xs },
  userPicked: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    padding: spacing.md,
    borderRadius: radius.md,
    backgroundColor: colors.primarySoft,
  },
  userPickedText: { flex: 1, fontSize: fontSize.body, fontWeight: fontWeight.semibold, color: colors.text },
  link: { fontSize: fontSize.small, fontWeight: fontWeight.semibold, color: colors.primary },
  userList: { gap: spacing.xs },
  userRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    paddingVertical: spacing.sm,
    paddingHorizontal: spacing.md,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.border,
  },
  userRowOn: { borderColor: colors.primary },
  userName: { fontSize: fontSize.small, fontWeight: fontWeight.semibold, color: colors.text },
  userRole: { fontSize: fontSize.caption, color: colors.textMuted },
  warn: { fontSize: fontSize.caption, fontWeight: fontWeight.semibold, color: colors.warning },
  note: { gap: spacing.xs, padding: spacing.md, borderRadius: radius.md, backgroundColor: colors.surface },
  noteText: { fontSize: fontSize.caption, lineHeight: 18, color: colors.textMuted },
  muted: { fontSize: fontSize.small, color: colors.textMuted },
  errorBox: { padding: spacing.md, borderRadius: radius.md, backgroundColor: colors.dangerSoft },
  errorText: { fontSize: fontSize.small, color: colors.danger },
});