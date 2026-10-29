import Ionicons from '@expo/vector-icons/Ionicons';
import { Stack, router } from 'expo-router';
import { useEffect, useState } from 'react';
import { ActivityIndicator, Pressable, ScrollView, StyleSheet, Switch, Text, View } from 'react-native';

import { useAuth } from '@/features/auth/AuthProvider';
import {
    DEFAULT_CALL_SYNC,
    getCallSyncSettings,
    saveCallSyncSettings,
    type CallSyncMode,
    type CallSyncSettings,
} from '@/features/call-sync/api';
import { listAssignableUsers, type AssignableUser } from '@/features/leads/api';
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

const MODES: { value: CallSyncMode; title: string; text: string }[] = [
  { value: 'all', title: 'Everyone', text: 'Every user with the Android app can sync.' },
  { value: 'roles', title: 'Only some roles', text: 'Choose the roles below.' },
  { value: 'users', title: 'Only some people', text: 'Choose the people below.' },
];

const MIN_SECONDS = [3, 5, 10, 15, 30];

export default function CallSyncSettingsScreen() {
  const { hasPermission } = useAuth();
  const canManage = hasPermission('settings.manage');

  const [settings, setSettings] = useState<CallSyncSettings>(DEFAULT_CALL_SYNC);
  const [users, setUsers] = useState<AssignableUser[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    Promise.all([getCallSyncSettings(), listAssignableUsers()])
      .then(([s, u]) => {
        setSettings(s);
        setUsers(u.filter((p) => p.role_key !== 'super_admin'));
      })
      .catch((e) => setError(e instanceof Error ? e.message : 'Could not load the settings.'))
      .finally(() => setLoading(false));
  }, []);

  const set = <K extends keyof CallSyncSettings>(key: K, value: CallSyncSettings[K]) => {
    setSettings((s) => ({ ...s, [key]: value }));
    setDirty(true);
    setError(null);
  };

  const toggleIn = (key: 'roles' | 'user_ids', value: string) =>
    set(
      key,
      settings[key].includes(value) ? settings[key].filter((v) => v !== value) : [...settings[key], value],
    );

  const handleSave = async () => {
    setSaving(true);
    setError(null);
    try {
      await saveCallSyncSettings(settings);
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
        <Stack.Screen options={{ title: 'Call log sync' }} />
        <Text style={styles.muted}>Only admins can change these settings.</Text>
      </View>
    );
  }

  if (loading) {
    return (
      <View style={styles.center}>
        <Stack.Screen options={{ title: 'Call log sync' }} />
        <ActivityIndicator size="large" color={colors.primary} />
      </View>
    );
  }

  const off = !settings.enabled;

  return (
    <ScrollView style={styles.screen} contentContainerStyle={styles.content}>
      <Stack.Screen options={{ title: 'Call log sync' }} />

      <Text style={styles.intro}>
        With this on, the Android app saves calls with leads from each user’s phone: real call length, incoming
        and missed calls, and calls made from the phone’s own dialer. Calls with other numbers are never saved.
      </Text>

      {/* Main switch */}
      <View style={[styles.card, styles.mainCard]}>
        <SwitchRow
          title="Call log sync"
          text={settings.enabled ? 'On. Users can turn it on in More → Call log sync.' : 'Off for everyone.'}
          value={settings.enabled}
          onChange={(v) => set('enabled', v)}
          big
        />
      </View>

      <View style={off && styles.dimmed} pointerEvents={off ? 'none' : 'auto'}>
        {/* Who */}
        <Text style={styles.sectionLabel}>WHO CAN SYNC</Text>
        <View style={styles.card}>
          {MODES.map((m, index) => {
            const on = settings.mode === m.value;
            return (
              <View key={m.value}>
                {index > 0 && <View style={styles.divider} />}
                <Pressable
                  onPress={() => set('mode', m.value)}
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

          {settings.mode === 'roles' && (
            <View style={styles.subList}>
              {ROLES.map((r) => (
                <CheckRow
                  key={r.key}
                  label={r.label}
                  on={settings.roles.includes(r.key)}
                  onPress={() => toggleIn('roles', r.key)}
                />
              ))}
            </View>
          )}

          {settings.mode === 'users' && (
            <View style={styles.subList}>
              {users.map((u) => (
                <CheckRow
                  key={u.id}
                  label={u.full_name ?? 'No name'}
                  sub={ROLE_LABEL[u.role_key] ?? u.role_key}
                  on={settings.user_ids.includes(u.id)}
                  onPress={() => toggleIn('user_ids', u.id)}
                />
              ))}
            </View>
          )}
        </View>

        {/* What to save */}
        <Text style={styles.sectionLabel}>WHAT TO SAVE</Text>
        <View style={styles.card}>
          <SwitchRow
            title="Incoming calls"
            text="Also save calls the lead made to us, including missed ones."
            value={settings.incoming}
            onChange={(v) => set('incoming', v)}
          />
          <View style={styles.divider} />
          <SwitchRow
            title="Missed call → “Call back”"
            text="When a lead calls and nobody answers, add a call-back to Today’s calls."
            value={settings.missed_follow_up}
            onChange={(v) => set('missed_follow_up', v)}
          />
        </View>

        {/* Connected threshold */}
        <Text style={styles.sectionLabel}>COUNT AS “CONNECTED” AFTER</Text>
        <View style={styles.card}>
          <View style={styles.chips}>
            {MIN_SECONDS.map((s) => {
              const on = settings.connected_min_sec === s;
              return (
                <Pressable
                  key={s}
                  onPress={() => set('connected_min_sec', s)}
                  style={[styles.chip, on && styles.chipOn]}
                  accessibilityRole="radio"
                  accessibilityState={{ checked: on }}
                >
                  <Text style={[styles.chipText, on && styles.chipTextOn]}>{s} sec</Text>
                </Pressable>
              );
            })}
          </View>
          <Text style={styles.hint}>
            Outgoing calls shorter than this are saved as “No answer” (e.g. voicemail or a quick hang-up).
          </Text>
        </View>
      </View>

      {/* 💬 WhatsApp */}
      <Text style={styles.sectionLabel}>💬 WHATSAPP</Text>
      <View style={styles.card}>
        <SwitchRow
          title="Ask after WhatsApp"
          text="When someone opens WhatsApp from the app and comes back, ask: message or call, and what happened."
          value={settings.whatsapp_ask_after}
          onChange={(v) => set('whatsapp_ask_after', v)}
        />
      </View>

      <View style={styles.privacy}>
        <Ionicons name="shield-checkmark" size={18} color={colors.success} />
        <Text style={styles.privacyText}>
          Each phone sends a secure code of each number, not the number. Only calls matching a lead the user can
          see are saved. Saved calls can’t be edited or deleted.
        </Text>
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
  dimmed: { opacity: 0.4 },
  pressed: { opacity: 0.7 },
  intro: { fontSize: fontSize.small, lineHeight: 20, color: colors.textMuted },
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
    gap: spacing.sm,
    padding: spacing.lg,
    borderRadius: radius.lg,
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.border,
  },
  mainCard: { borderColor: colors.primary, borderWidth: 1.5 },
  divider: { height: 1, backgroundColor: colors.border, marginVertical: spacing.xs },
  row: { flexDirection: 'row', alignItems: 'center', gap: spacing.md, paddingVertical: spacing.xs },
  rowTitle: { fontSize: fontSize.body, fontWeight: fontWeight.semibold, color: colors.text },
  rowTitleBig: { fontSize: fontSize.title, fontWeight: fontWeight.bold },
  rowText: { fontSize: fontSize.caption, lineHeight: 18, color: colors.textMuted, marginTop: 2 },
  subList: {
    marginTop: spacing.sm,
    paddingTop: spacing.sm,
    borderTopWidth: 1,
    borderTopColor: colors.border,
    gap: spacing.xs,
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
  chips: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.sm },
  chip: {
    paddingVertical: spacing.sm,
    paddingHorizontal: spacing.lg,
    borderRadius: radius.pill,
    borderWidth: 1.5,
    borderColor: colors.border,
  },
  chipOn: { backgroundColor: colors.primary, borderColor: colors.primary },
  chipText: { fontSize: fontSize.small, fontWeight: fontWeight.semibold, color: colors.text },
  chipTextOn: { color: colors.textOnPrimary },
  hint: { fontSize: fontSize.caption, color: colors.textMuted },
  privacy: {
    flexDirection: 'row',
    gap: spacing.sm,
    padding: spacing.md,
    borderRadius: radius.md,
    backgroundColor: colors.successSoft,
  },
  privacyText: { flex: 1, fontSize: fontSize.caption, lineHeight: 18, color: colors.text },
  muted: { fontSize: fontSize.small, color: colors.textMuted },
  errorBox: { padding: spacing.md, borderRadius: radius.md, backgroundColor: colors.dangerSoft },
  errorText: { fontSize: fontSize.small, color: colors.danger },
});