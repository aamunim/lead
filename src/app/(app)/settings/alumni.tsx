import { Stack } from 'expo-router';
import { useCallback, useEffect, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Switch,
  Text,
  TextInput,
  View,
} from 'react-native';

import {
  DEFAULT_ALUMNI_SETTINGS,
  deleteAlumniField,
  FIELD_TYPES,
  fieldKeyFor,
  applyLink,
  getAlumniSettings,
  getPublicForms,
  savePublicForms,
  type PublicForms,
  listAlumniFields,
  saveAlumniField,
  ALUMNI_FILTER_LABEL,
  saveAlumniSettings,
  type AlumniField,
  type AlumniFieldType,
  type AlumniRule,
  type AlumniSettings,
} from '@/features/alumni/api';
import { alumniChanged, Chip, s as ui } from '@/features/alumni/ui';
import { useAuth } from '@/features/auth/AuthProvider';
import { listAssignableUsers, type AssignableUser } from '@/features/leads/api';
import { listCourses, type CourseWithDetails } from '@/features/settings/api';
import { supabase } from '@/shared/lib/supabase';
import { colors, fontSize, fontWeight, radius, spacing } from '@/shared/theme';
import { copyLink, shareLink } from '@/shared/lib/shareLink';
import { COLLEGE } from '@/features/web/brand';
import { Button } from '@/shared/ui/Button';
import { TextField } from '@/shared/ui/TextField';

// =====================================================================
// ⚙️ Settings → Alumni
//   · who sees / who manages (roles and people; admins always)
//   · custom fields (added as needed)
//   · referral rewards (amount by course)
// =====================================================================

export default function AlumniSettingsScreen() {
  const { hasPermission } = useAuth();
  const [settings, setSettings] = useState<AlumniSettings>(DEFAULT_ALUMNI_SETTINGS);
  const [roles, setRoles] = useState<{ key: string; name: string }[]>([]);
  const [users, setUsers] = useState<AssignableUser[]>([]);
  const [courses, setCourses] = useState<CourseWithDetails[]>([]);
  const [fields, setFields] = useState<AlumniField[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const loadFields = useCallback(() => listAlumniFields(true).then(setFields), []);

  useEffect(() => {
    Promise.all([
      getAlumniSettings(),
      supabase.from('roles').select('key, name, rank').order('rank'),
      listAssignableUsers().catch(() => []),
      listCourses().catch(() => []),
      loadFields().catch(() => undefined),
    ])
      .then(([s, r, u, c]) => {
        setSettings(s);
        setRoles(((r.data ?? []) as { key: string; name: string }[]).filter((x) => x.key !== 'super_admin'));
        setUsers(u.filter((p) => p.role_key !== 'super_admin' && p.is_active));
        setCourses(c);
      })
      .catch((e) => setError(e instanceof Error ? e.message : 'Could not load.'))
      .finally(() => setLoading(false));
  }, [loadFields]);

  const set = (next: AlumniSettings) => {
    setSettings(next);
    setDirty(true);
  };
  const setRule = (which: 'view' | 'manage', rule: AlumniRule) => set({ ...settings, [which]: rule });

  const save = async () => {
    setSaving(true);
    setError(null);
    try {
      await saveAlumniSettings(settings);
      setDirty(false);
      alumniChanged();
      if (Platform.OS === 'web') window.alert('Saved');
      else Alert.alert('Saved', 'People see the change when they open the app again.');
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not save.');
    } finally {
      setSaving(false);
    }
  };

  if (!hasPermission('settings.manage')) {
    return (
      <View style={styles.center}>
        <Stack.Screen options={{ title: 'Alumni' }} />
        <Text style={ui.muted}>Only admins can change this.</Text>
      </View>
    );
  }
  if (loading) {
    return (
      <View style={styles.center}>
        <Stack.Screen options={{ title: 'Alumni' }} />
        <ActivityIndicator size="large" color={colors.primary} />
      </View>
    );
  }

  return (
    <ScrollView style={styles.screen} contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
      <Stack.Screen options={{ title: 'Alumni' }} />

      <RuleCard
        title="👀 Who sees Alumni"
        hint="They see the list, call or WhatsApp, add notes and add referrals. Admins always see it."
        rule={settings.view}
        roles={roles}
        users={users}
        onChange={(r) => setRule('view', r)}
      />
      <RuleCard
        title="🛠 Who manages Alumni"
        hint="They also add, change, import and delete alumni, import referrals as leads (choosing the person), give credit and pay rewards."
        rule={settings.manage}
        roles={roles}
        users={users}
        onChange={(r) => setRule('manage', r)}
      />

      {/* 🎁 Rewards */}
      <View style={ui.card}>
        <View style={styles.switchRow}>
          <View style={styles.flex}>
            <Text style={styles.title}>🎁 Referral rewards</Text>
            <Text style={ui.muted}>
              {settings.rewards.enabled
                ? 'When a referred lead is admitted, the alumnus gets a reward (due until marked paid).'
                : 'Off. No reward is counted.'}
            </Text>
          </View>
          <Switch
            value={settings.rewards.enabled}
            onValueChange={(v) => set({ ...settings, rewards: { ...settings.rewards, enabled: v } })}
          />
        </View>
        {settings.rewards.enabled && (
          <>
            <Amount
              label="Amount (every course)"
              value={settings.rewards.default_amount}
              onChange={(v) => set({ ...settings, rewards: { ...settings.rewards, default_amount: v ?? 0 } })}
            />
            <Text style={ui.label}>BY COURSE (EMPTY = THE AMOUNT ABOVE)</Text>
            {courses.map((c) => (
              <Amount
                key={c.id}
                label={c.name}
                value={settings.rewards.by_course[c.id] ?? null}
                onChange={(v) => {
                  const by = { ...settings.rewards.by_course };
                  if (v === null) delete by[c.id];
                  else by[c.id] = v;
                  set({ ...settings, rewards: { ...settings.rewards, by_course: by } });
                }}
              />
            ))}
          </>
        )}
      </View>

      {/* ⏰ Reminders */}
      <View style={ui.card}>
        <Text style={styles.title}>⏰ Reminders</Text>
        <View style={styles.switchRow}>
          <View style={styles.flex}>
            <Text style={ui.muted}>Next contact is due → a notification to the one who looks after them</Text>
          </View>
          <Switch
            value={settings.reminders.next_contact}
            onValueChange={(v) => set({ ...settings, reminders: { ...settings.reminders, next_contact: v } })}
          />
        </View>
        <View style={styles.switchRow}>
          <View style={styles.flex}>
            <Text style={ui.muted}>🎂 Birthdays (9 am) → to the one who looks after them, else the managers</Text>
          </View>
          <Switch
            value={settings.reminders.birthdays}
            onValueChange={(v) => set({ ...settings, reminders: { ...settings.reminders, birthdays: v } })}
          />
        </View>
      </View>

      {/* 🔍 Filters on the list */}
      <View style={ui.card}>
        <Text style={styles.title}>🔍 Filters on the alumni list</Text>
        <Text style={ui.muted}>Switch off the ones you don’t use; ↑ moves one up.</Text>
        {settings.filters.map((f, i) => (
          <View key={f.key} style={styles.switchRow}>
            <Pressable
              onPress={() => {
                if (i === 0) return;
                const list = [...settings.filters];
                [list[i - 1], list[i]] = [list[i], list[i - 1]];
                set({ ...settings, filters: list });
              }}
              disabled={i === 0}
              hitSlop={6}
              accessibilityRole="button"
              accessibilityLabel={`Move ${ALUMNI_FILTER_LABEL[f.key]} up`}
            >
              <Text style={[styles.up, i === 0 && styles.upOff]}>↑</Text>
            </Pressable>
            <Text style={[styles.flex, styles.filterName]}>{ALUMNI_FILTER_LABEL[f.key]}</Text>
            <Switch
              value={f.enabled}
              onValueChange={(v) =>
                set({ ...settings, filters: settings.filters.map((x) => (x.key === f.key ? { ...x, enabled: v } : x)) })
              }
            />
          </View>
        ))}
      </View>

      {error && <Text style={ui.error}>{error}</Text>}
      <Button title="Save" onPress={save} loading={saving} disabled={!dirty} fullWidth />

      <PublicLinksCard />

      {/* 🧩 Custom fields (saved one by one) */}
      <FieldsCard fields={fields} reload={() => loadFields().then(alumniChanged)} />
    </ScrollView>
  );
}

function RuleCard({
  title,
  hint,
  rule,
  roles,
  users,
  onChange,
}: {
  title: string;
  hint: string;
  rule: AlumniRule;
  roles: { key: string; name: string }[];
  users: AssignableUser[];
  onChange: (r: AlumniRule) => void;
}) {
  const toggle = (key: 'roles' | 'user_ids', v: string) =>
    onChange({ ...rule, [key]: rule[key].includes(v) ? rule[key].filter((x) => x !== v) : [...rule[key], v] });
  return (
    <View style={ui.card}>
      <Text style={styles.title}>{title}</Text>
      <Text style={ui.muted}>{hint}</Text>
      <View style={styles.switchRow}>
        <Text style={[styles.flex, styles.text]}>Everyone</Text>
        <Switch value={rule.all} onValueChange={(v) => onChange({ ...rule, all: v })} />
      </View>
      {!rule.all && (
        <>
          <Text style={ui.label}>ROLES</Text>
          <View style={ui.chips}>
            {roles.map((r) => (
              <Chip key={r.key} text={r.name} on={rule.roles.includes(r.key)} onPress={() => toggle('roles', r.key)} />
            ))}
          </View>
          <Text style={ui.label}>AND THESE PEOPLE</Text>
          <View style={ui.chips}>
            {users.map((u) => (
              <Chip
                key={u.id}
                text={u.full_name ?? 'No name'}
                on={rule.user_ids.includes(u.id)}
                onPress={() => toggle('user_ids', u.id)}
              />
            ))}
          </View>
        </>
      )}
    </View>
  );
}

function Amount({
  label,
  value,
  onChange,
}: {
  label: string;
  value: number | null;
  onChange: (v: number | null) => void;
}) {
  return (
    <View style={styles.amountRow}>
      <Text style={[styles.flex, styles.text]} numberOfLines={1}>
        {label}
      </Text>
      <Text style={ui.muted}>৳</Text>
      <TextInput
        value={value === null ? '' : String(value)}
        onChangeText={(t) => {
          const d = t.replace(/[^0-9]/g, '');
          onChange(d === '' ? null : Number(d));
        }}
        keyboardType="number-pad"
        placeholder="—"
        placeholderTextColor={colors.textMuted}
        style={styles.amount}
        accessibilityLabel={`${label} amount`}
      />
    </View>
  );
}

function FieldsCard({ fields, reload }: { fields: AlumniField[]; reload: () => Promise<void> }) {
  const [label, setLabel] = useState('');
  const [type, setType] = useState<AlumniFieldType>('text');
  const [options, setOptions] = useState('');
  const [required, setRequired] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const add = async () => {
    if (!label.trim()) return setError('Type the field name.');
    if (type === 'select' && options.split(',').filter((o) => o.trim()).length < 2) {
      return setError('Type at least two options, with a comma between.');
    }
    setBusy(true);
    setError(null);
    try {
      await saveAlumniField({
        key: fieldKeyFor(
          label,
          fields.map((f) => f.key),
        ),
        label,
        type,
        options: type === 'select' ? options.split(',') : [],
        required,
        sort_order: fields.length + 1,
      });
      setLabel('');
      setOptions('');
      setRequired(false);
      setType('text');
      await reload();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not add.');
    } finally {
      setBusy(false);
    }
  };

  const change = async (f: AlumniField, patch: Partial<AlumniField>) => {
    try {
      await saveAlumniField({ ...f, ...patch });
      await reload();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not save.');
    }
  };

  return (
    <View style={ui.card}>
      <Text style={styles.title}>🧩 Custom fields</Text>
      <Text style={ui.muted}>
        Add what you need (NID, Blood group, Current school type…). They show on the alumni form and page.
      </Text>
      {fields.map((f) => (
        <View key={f.id} style={[styles.fieldRow, !f.is_active && styles.off]}>
          <View style={styles.flex}>
            <Text style={styles.text}>
              {f.label}
              {f.required ? ' *' : ''}
            </Text>
            <Text style={ui.muted}>
              {FIELD_TYPES.find((t) => t.key === f.type)?.label}
              {f.options.length ? `: ${f.options.join(', ')}` : ''}
              {!f.is_active ? ' · hidden' : ''}
            </Text>
          </View>
          {f.is_active ? (
            <>
              <Pressable onPress={() => change(f, { required: !f.required })} hitSlop={6} accessibilityRole="button">
                <Text style={styles.small}>{f.required ? 'Optional' : 'Required'}</Text>
              </Pressable>
              <Pressable onPress={() => deleteAlumniField(f.id).then(reload)} hitSlop={6} accessibilityRole="button">
                <Text style={[styles.small, { color: colors.danger }]}>Hide</Text>
              </Pressable>
            </>
          ) : (
            <Pressable onPress={() => change(f, { is_active: true })} hitSlop={6} accessibilityRole="button">
              <Text style={styles.small}>Show</Text>
            </Pressable>
          )}
        </View>
      ))}

      <Text style={ui.label}>ADD A FIELD</Text>
      <TextField label="Name" value={label} onChangeText={setLabel} placeholder="e.g. Blood group" />
      <View style={ui.chips}>
        {FIELD_TYPES.map((t) => (
          <Chip key={t.key} text={t.label} on={type === t.key} onPress={() => setType(t.key)} />
        ))}
      </View>
      {type === 'select' && (
        <TextField
          label="Options (comma between)"
          value={options}
          onChangeText={setOptions}
          placeholder="Govt, Private, Madrasa"
        />
      )}
      <View style={styles.switchRow}>
        <Text style={[styles.flex, styles.text]}>Required</Text>
        <Switch value={required} onValueChange={setRequired} />
      </View>
      {error && <Text style={ui.error}>{error}</Text>}
      <Button title="Add field" variant="secondary" onPress={add} loading={busy} fullWidth />
    </View>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1 },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center', backgroundColor: colors.background },
  screen: { flex: 1, backgroundColor: colors.background },
  content: { padding: spacing.lg, gap: spacing.md, paddingBottom: spacing.xxl },
  title: { fontSize: fontSize.body, fontWeight: fontWeight.bold, color: colors.text },
  up: { width: 28, fontSize: fontSize.title, fontWeight: fontWeight.bold, color: colors.primary, textAlign: 'center' },
  upOff: { color: colors.border },
  filterName: { fontSize: fontSize.body, color: colors.text },
  text: { fontSize: fontSize.small, color: colors.text },
  small: { fontSize: fontSize.caption, fontWeight: fontWeight.bold, color: colors.primary },
  switchRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.md },
  amountRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm },
  amount: {
    width: 110,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radius.md,
    paddingHorizontal: spacing.sm,
    paddingVertical: 6,
    fontSize: fontSize.body,
    color: colors.text,
    textAlign: 'right',
    backgroundColor: colors.background,
  },
  fieldRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
    paddingVertical: spacing.xs,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.border,
  },
  off: { opacity: 0.55 },
});

// 🔗 Public links (website, no sign-in): each alumnus's referral link, and
//   the interested-person form. Saved as soon as a switch changes.
function PublicLinksCard() {
  const [v, setV] = useState<PublicForms | null>(null);
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => {
    getPublicForms()
      .then(setV)
      .catch(() => setV({ refer: true, apply: true }));
  }, []);
  const change = async (next: PublicForms) => {
    const before = v;
    setV(next);
    setErr(null);
    try {
      await savePublicForms(next);
    } catch (e) {
      setV(before);
      setErr(e instanceof Error ? e.message : 'Could not save.');
    }
  };
  if (!v) return null;
  return (
    <View style={ui.card}>
      <Text style={ui.label}>🔗 PUBLIC LINKS</Text>
      <View style={linkStyles.row}>
        <View style={linkStyles.flex}>
          <Text style={linkStyles.title}>Alumni referral links</Text>
          <Text style={ui.muted}>
            Each alumnus shares their own link; friends who fill it come to the Referral inbox.
          </Text>
        </View>
        <Switch value={v.refer} onValueChange={(x) => change({ ...v, refer: x })} />
      </View>
      <View style={linkStyles.row}>
        <View style={linkStyles.flex}>
          <Text style={linkStyles.title}>Interested-person form</Text>
          <Text style={ui.muted}>
            For the college page, posters and QR codes. Each form becomes a new lead (source “Website form”), given out
            by the usual assignment rules. A known number adds a line to that lead instead.
          </Text>
        </View>
        <Switch value={v.apply} onValueChange={(x) => change({ ...v, apply: x })} />
      </View>
      {v.apply && (
        <View style={linkStyles.linkRow}>
          <Text style={linkStyles.link} onPress={() => copyLink(applyLink())} numberOfLines={1}>
            {applyLink().replace('https://', '')}
          </Text>
          <Button
            title="Share"
            variant="secondary"
            onPress={() => shareLink(`Admission at ${COLLEGE}: leave your number and we will call you.`, applyLink())}
          />
        </View>
      )}
      {err && <Text style={ui.error}>{err}</Text>}
    </View>
  );
}

const linkStyles = StyleSheet.create({
  flex: { flex: 1 },
  row: { flexDirection: 'row', alignItems: 'center', gap: spacing.md },
  title: { fontSize: fontSize.small, fontWeight: fontWeight.bold, color: colors.text },
  linkRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm },
  link: { flex: 1, fontSize: fontSize.small, fontWeight: fontWeight.bold, color: colors.primary },
});
