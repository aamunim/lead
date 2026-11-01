import Ionicons from '@expo/vector-icons/Ionicons';
import { Stack, router, type Href } from 'expo-router';
import { useEffect, useMemo, useState } from 'react';
import {
  ActivityIndicator,
  Pressable,
  StyleSheet,
  Switch,
  Text,
  TextInput,
  View,
} from 'react-native';
import { KeyboardAwareScrollView } from 'react-native-keyboard-controller';

import { useAuth } from '@/features/auth/AuthProvider';
import { listAssignableUsers, type AssignableUser } from '@/features/leads/api';
import {
  DEFAULT_ADMISSION,
  formatStudentRef,
  getAdmissionSettings,
  saveAdmissionSettings,
  type AdmissionSettings,
  type PapersOnAdmitRule,
  type StudentIdMode,
  type WhoRule,
} from '@/features/pipeline/api';
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
  { value: 'all', title: 'Everyone', text: 'Anyone who can edit the lead.' },
  { value: 'roles', title: 'Only some roles', text: 'Choose the roles below.' },
  { value: 'users', title: 'Only some people', text: 'Choose the people below.' },
];

const ID_MODES: { value: StudentIdMode; title: string; text: string }[] = [
  { value: 'auto', title: 'Automatic', text: 'The app gives the next number. It can still be typed by hand.' },
  { value: 'manual', title: 'Typed by hand', text: 'The ID must be typed when admitting.' },
  { value: 'off', title: 'No student ID', text: 'Admissions are saved without an ID.' },
];

const PAPER_MODES: { value: PapersOnAdmitRule; title: string; text: string }[] = [
  {
    value: 'block',
    title: '⛔ Block',
    text: 'A lead can’t be admitted until every required paper is ticked (or marked “not needed”).',
  },
  {
    value: 'warn',
    title: '⚠️ Warn',
    text: 'Shows the missing papers and asks “Admit anyway?”. They stay on the to-collect list.',
  },
  { value: 'allow', title: '✓ Allow', text: 'No paper check when admitting.' },
];

export default function AdmissionSettingsScreen() {
  const { hasPermission } = useAuth();
  const canManage = hasPermission('settings.manage');

  const [settings, setSettings] = useState<AdmissionSettings>(DEFAULT_ADMISSION);
  const [users, setUsers] = useState<AssignableUser[]>([]);

  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    Promise.all([getAdmissionSettings(), listAssignableUsers()])
      .then(([s, u]) => {
        setSettings(s);
        setUsers(u.filter((p) => p.role_key !== 'super_admin'));
      })
      .catch((e) => setError(e instanceof Error ? e.message : 'Could not load the settings.'))
      .finally(() => setLoading(false));
  }, []);

  const set = <K extends keyof AdmissionSettings>(key: K, value: AdmissionSettings[K]) => {
    setSettings((s) => ({ ...s, [key]: value }));
    setDirty(true);
    setError(null);
  };

  const preview = useMemo(
    () => formatStudentRef(settings.student_id.pattern, 42),
    [settings.student_id.pattern],
  );

  const handleSave = async () => {
    // A "who" rule with nobody chosen would lock everyone out (except the Super Admin)
    for (const [label, rule] of [
      ['mark admitted', settings.mark],
      ['cancel admissions', settings.cancel],
    ] as const) {
      if (rule.mode === 'roles' && rule.roles.length === 0) {
        setError(`Choose at least one role who can ${label}.`);
        return;
      }
      if (rule.mode === 'users' && rule.user_ids.length === 0) {
        setError(`Choose at least one person who can ${label}.`);
        return;
      }
    }
    if (settings.student_id.mode === 'auto' && !/\{0+\}/.test(settings.student_id.pattern)) {
      setError('The student ID pattern needs a number part, e.g. {0000}.');
      return;
    }

    setSaving(true);
    setError(null);
    try {
      await saveAdmissionSettings({
        ...settings,
        student_id: { ...settings.student_id, pattern: settings.student_id.pattern.trim() },
      });
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
        <Stack.Screen options={{ title: 'Admission rules' }} />
        <Text style={styles.muted}>Only admins can change these settings.</Text>
      </View>
    );
  }

  if (loading) {
    return (
      <View style={styles.center}>
        <Stack.Screen options={{ title: 'Admission rules' }} />
        <ActivityIndicator size="large" color={colors.primary} />
      </View>
    );
  }

  return (
    <KeyboardAwareScrollView
      bottomOffset={spacing.xl}
      style={styles.screen}
      contentContainerStyle={styles.content}
      keyboardShouldPersistTaps="handled"
    >
      <Stack.Screen options={{ title: 'Admission rules' }} />

      <Text style={styles.intro}>Rules for marking leads Admitted or Lost, papers, and student IDs.</Text>

      {/* Who can admit */}
      <Text style={styles.sectionLabel}>WHO CAN MARK ADMITTED</Text>
      <WhoPicker rule={settings.mark} users={users} onChange={(r) => set('mark', r)} />

      {/* Who can cancel */}
      <Text style={styles.sectionLabel}>WHO CAN CANCEL AN ADMISSION</Text>
      <WhoPicker rule={settings.cancel} users={users} onChange={(r) => set('cancel', r)} />
      <Text style={styles.hint}>The Super Admin can always admit and cancel.</Text>

      {/* Batch */}
      <Text style={styles.sectionLabel}>BATCH</Text>
      <View style={styles.card}>
        <SwitchRow
          title="Batch required"
          text={
            settings.batch_required
              ? 'A batch must be chosen when admitting.'
              : 'A batch can be chosen later (“No batch yet”).'
          }
          value={settings.batch_required}
          onChange={(v) => set('batch_required', v)}
        />
        <View style={styles.divider} />
        <SwitchRow
          title="Allow overbooking"
          text={
            settings.allow_overbooking
              ? 'Full batches can still take admissions.'
              : 'A full batch takes no more admissions.'
          }
          value={settings.allow_overbooking}
          onChange={(v) => set('allow_overbooking', v)}
        />
      </View>

      {/* Papers */}
      <Text style={styles.sectionLabel}>PAPERS MISSING WHEN ADMITTING</Text>
      <View style={styles.card}>
        {PAPER_MODES.map((m, index) => (
          <View key={m.value}>
            {index > 0 && <View style={styles.divider} />}
            <RadioRow
              title={m.title}
              text={m.text}
              on={settings.papers_on_admit === m.value}
              onPress={() => set('papers_on_admit', m.value)}
            />
          </View>
        ))}
      </View>
      <Text style={styles.hint}>Only required papers for the chosen course are checked.</Text>

      <Pressable
        onPress={() => router.push('/settings/papers' as Href)}
        style={({ pressed }) => [styles.linkCard, pressed && styles.pressed]}
        accessibilityRole="button"
      >
        <Text style={styles.linkIcon}>📄</Text>
        <View style={styles.flex}>
          <Text style={styles.rowTitle}>Required papers</Text>
          <Text style={styles.rowText}>The list of papers, which are required, and for which courses.</Text>
        </View>
        <Ionicons name="chevron-forward" size={18} color={colors.textMuted} />
      </Pressable>

      {/* Student ID */}
      <Text style={styles.sectionLabel}>STUDENT ID</Text>
      <View style={styles.card}>
        {ID_MODES.map((m, index) => {
          const on = settings.student_id.mode === m.value;
          return (
            <View key={m.value}>
              {index > 0 && <View style={styles.divider} />}
              <RadioRow
                title={m.title}
                text={m.text}
                on={on}
                onPress={() => set('student_id', { ...settings.student_id, mode: m.value })}
              />
            </View>
          );
        })}

        {settings.student_id.mode === 'auto' && (
          <View style={styles.subList}>
            <Text style={styles.label}>Pattern</Text>
            <TextInput
              value={settings.student_id.pattern}
              onChangeText={(t) => set('student_id', { ...settings.student_id, pattern: t })}
              placeholder="{YY}{000}"
              placeholderTextColor={colors.textMuted}
              autoCapitalize="characters"
              autoCorrect={false}
              style={styles.input}
            />
            <View style={styles.previewBox}>
              <Text style={styles.hint}>Looks like</Text>
              <Text style={styles.previewText}>{preview}</Text>
            </View>
            <Text style={styles.hint}>
              {'{YY}'} = short year · {'{YYYY}'} = year · {'{000}'} = running number (as many digits as zeros). With a
              year in it, numbers start again from 1 each year: {'{YY}{000}'} gives 26001, 26002 … then 27001 in 2027.
            </Text>
          </View>
        )}
      </View>

      {/* Closed leads */}
      <Text style={styles.sectionLabel}>ADMITTED AND LOST LEADS IN THE LIST</Text>
      <View style={styles.card}>
        <RadioRow
          title="Hide them"
          text="The Leads list shows open leads. Use the “Closed” chip or a filter to see the rest."
          on={settings.closed_in_list === 'hide'}
          onPress={() => set('closed_in_list', 'hide')}
        />
        <View style={styles.divider} />
        <RadioRow
          title="Show everything"
          text="Admitted and lost leads stay in the list, with a 🎓 / ✕ badge."
          on={settings.closed_in_list === 'show'}
          onPress={() => set('closed_in_list', 'show')}
        />
      </View>

      {/* Stage rules moved */}
      <Pressable
        onPress={() => router.push('/settings/stages' as Href)}
        style={({ pressed }) => [styles.linkCard, pressed && styles.pressed]}
        accessibilityRole="button"
      >
        <Text style={styles.linkIcon}>🪜</Text>
        <View style={styles.flex}>
          <Text style={styles.rowTitle}>Stage rules</Text>
          <Text style={styles.rowText}>Next call, note required, ask for a date: in Pipeline stages.</Text>
        </View>
        <Ionicons name="chevron-forward" size={18} color={colors.textMuted} />
      </Pressable>

      {error && (
        <View style={styles.errorBox}>
          <Text style={styles.errorText}>{error}</Text>
        </View>
      )}

      <Button title="Save" onPress={handleSave} loading={saving} disabled={!dirty} fullWidth />
    </KeyboardAwareScrollView>
  );
}

// =====================================================================
// "Who can…" picker: everyone / roles / people
// =====================================================================
function WhoPicker({
  rule,
  users,
  onChange,
}: {
  rule: WhoRule;
  users: AssignableUser[];
  onChange: (rule: WhoRule) => void;
}) {
  const toggle = (key: 'roles' | 'user_ids', value: string) =>
    onChange({
      ...rule,
      [key]: rule[key].includes(value) ? rule[key].filter((v) => v !== value) : [...rule[key], value],
    });

  return (
    <View style={styles.card}>
      {WHO_MODES.map((m, index) => (
        <View key={m.value}>
          {index > 0 && <View style={styles.divider} />}
          <RadioRow
            title={m.title}
            text={m.text}
            on={rule.mode === m.value}
            onPress={() => onChange({ ...rule, mode: m.value })}
          />
        </View>
      ))}

      {rule.mode === 'roles' && (
        <View style={styles.subList}>
          {ROLES.map((r) => (
            <CheckRow key={r.key} label={r.label} on={rule.roles.includes(r.key)} onPress={() => toggle('roles', r.key)} />
          ))}
        </View>
      )}

      {rule.mode === 'users' && (
        <View style={styles.subList}>
          {users.length === 0 ? (
            <Text style={styles.hint}>No users yet.</Text>
          ) : (
            users.map((u) => (
              <CheckRow
                key={u.id}
                label={u.full_name ?? 'No name'}
                sub={ROLE_LABEL[u.role_key] ?? u.role_key}
                on={rule.user_ids.includes(u.id)}
                onPress={() => toggle('user_ids', u.id)}
              />
            ))
          )}
        </View>
      )}
    </View>
  );
}

// =====================================================================
// Rows
// =====================================================================
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
  linkCard: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
    padding: spacing.lg,
    marginTop: spacing.md,
    borderRadius: radius.lg,
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.border,
  },
  linkIcon: { fontSize: 20 },
  divider: { height: 1, backgroundColor: colors.border, marginVertical: spacing.xs },
  row: { flexDirection: 'row', alignItems: 'center', gap: spacing.md, paddingVertical: spacing.xs },
  rowTitle: { fontSize: fontSize.body, fontWeight: fontWeight.semibold, color: colors.text },
  rowText: { fontSize: fontSize.caption, lineHeight: 18, color: colors.textMuted, marginTop: 2 },
  label: { fontSize: fontSize.small, fontWeight: fontWeight.semibold, color: colors.text },
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
  input: {
    minHeight: 44,
    paddingHorizontal: spacing.md,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.border,
    fontSize: fontSize.body,
    color: colors.text,
    letterSpacing: 0.5,
  },
  previewBox: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    padding: spacing.md,
    borderRadius: radius.md,
    backgroundColor: colors.successSoft,
  },
  previewText: { fontSize: fontSize.body, fontWeight: fontWeight.bold, color: colors.success, letterSpacing: 0.5 },
  hint: { fontSize: fontSize.caption, lineHeight: 18, color: colors.textMuted },
  muted: { fontSize: fontSize.small, color: colors.textMuted },
  errorBox: { padding: spacing.md, borderRadius: radius.md, backgroundColor: colors.dangerSoft },
  errorText: { fontSize: fontSize.small, color: colors.danger },
});