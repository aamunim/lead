import { Stack } from 'expo-router';
import { useEffect, useState } from 'react';
import { ActivityIndicator, Alert, Pressable, StyleSheet, Switch, Text, TextInput, View } from 'react-native';
import { KeyboardAwareScrollView } from 'react-native-keyboard-controller';

import {
  DEFAULT_FEE_SETTINGS,
  RECEIPT_FIELDS,
  getFeeSettings,
  saveFeeSettings,
  type FeeSettings,
  type PaymentSettings,
} from '@/features/fees/api';
import type { WhoRule } from '@/features/pipeline/api';
import { listAssignableUsers, type AssignableUser } from '@/features/leads/api';
import { supabase } from '@/shared/lib/supabase';
import { colors, fontSize, fontWeight, radius, spacing } from '@/shared/theme';
import { Button } from '@/shared/ui/Button';

// =====================================================================
// ⚙️ Settings → Fee & discount
//   On/off, who may use it, each role's discount limit (% of the course
//   fee they may give or approve without asking), how long an approved
//   discount stays valid, and the reasons.
// =====================================================================

type RoleRow = { key: string; name: string; unlimited: boolean };

export default function FeeSettingsScreen() {
  const [settings, setSettings] = useState<FeeSettings>(DEFAULT_FEE_SETTINGS);
  const [roles, setRoles] = useState<RoleRow[]>([]);
  const [users, setUsers] = useState<AssignableUser[]>([]);
  const [newReason, setNewReason] = useState('');
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    Promise.all([
      getFeeSettings(),
      supabase.from('roles').select('key, name, permissions, rank').order('rank'),
      listAssignableUsers().catch(() => []),
    ])
      .then(([s, r, u]) => {
        setSettings(s);
        const rows = (r.data ?? []) as { key: string; name: string; permissions: string[] }[];
        setRoles(
          rows.map((x) => ({
            key: x.key,
            name: x.name,
            unlimited: x.permissions.includes('*') || x.permissions.includes('discounts.approve'),
          })),
        );
        setUsers(u.filter((p) => p.role_key !== 'super_admin'));
      })
      .catch((e) => setError(e instanceof Error ? e.message : 'Could not load.'))
      .finally(() => setLoading(false));
  }, []);

  const set = <K extends keyof FeeSettings>(key: K, value: FeeSettings[K]) => {
    setSettings((s) => ({ ...s, [key]: value }));
    setDirty(true);
  };
  // Payments part
  const pay = settings.payments;
  const [newMethod, setNewMethod] = useState('');
  const setPay = <K extends keyof PaymentSettings>(key: K, value: PaymentSettings[K]) =>
    set('payments', { ...settings.payments, [key]: value });
  const togglePayWho = (rule: 'who' | 'void_who', key: 'roles' | 'user_ids', value: string) => {
    const r: WhoRule = pay[rule];
    setPay(rule, { ...r, [key]: r[key].includes(value) ? r[key].filter((v) => v !== value) : [...r[key], value] });
  };
  const addMethod = () => {
    const m = newMethod.trim();
    if (!m) return;
    if (!pay.methods.some((x) => x.name.toLowerCase() === m.toLowerCase())) setPay('methods', [...pay.methods, { name: m, txn: false }]);
    setNewMethod('');
  };

  const toggleWho = (key: 'roles' | 'user_ids', value: string) =>
    set('who', {
      ...settings.who,
      [key]: settings.who[key].includes(value)
        ? settings.who[key].filter((v) => v !== value)
        : [...settings.who[key], value],
    });

  const addReason = () => {
    const r = newReason.trim();
    if (!r) return;
    if (!settings.reasons.some((x) => x.toLowerCase() === r.toLowerCase())) set('reasons', [...settings.reasons, r]);
    setNewReason('');
  };

  const save = async () => {
    const { who } = settings;
    if (who.mode === 'roles' && who.roles.length === 0) return setError('Choose at least one role.');
    if (who.mode === 'users' && who.user_ids.length === 0) return setError('Choose at least one person.');
    if (settings.reason_required && settings.reasons.length === 0) return setError('Add at least one reason.');
    if (pay.enabled && pay.methods.length === 0) return setError('Add at least one payment method.');
    if (pay.who.mode === 'roles' && pay.who.roles.length === 0) return setError('Choose who may take payments.');
    if (pay.who.mode === 'users' && pay.who.user_ids.length === 0) return setError('Choose who may take payments.');
    setSaving(true);
    setError(null);
    try {
      await saveFeeSettings(settings);
      setDirty(false);
      Alert.alert('Saved', 'Fee & discount settings are saved.');
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not save.');
    } finally {
      setSaving(false);
    }
  };

  if (loading) {
    return (
      <View style={styles.center}>
        <Stack.Screen options={{ title: 'Fee & discount' }} />
        <ActivityIndicator size="large" color={colors.primary} />
      </View>
    );
  }

  return (
    <KeyboardAwareScrollView style={styles.screen} contentContainerStyle={styles.content} bottomOffset={24}>
      <Stack.Screen options={{ title: 'Fee & discount' }} />

      <View style={styles.card}>
        <View style={styles.switchRow}>
          <View style={styles.flex}>
            <Text style={styles.rowTitle}>Fee negotiation & discounts</Text>
            <Text style={styles.rowText}>
              {settings.enabled
                ? 'On. The lead page shows the fee card: what was said, discounts, the final fee.'
                : 'Off for everyone. The fee card is hidden.'}
            </Text>
          </View>
          <Switch value={settings.enabled} onValueChange={(v) => set('enabled', v)} />
        </View>

        {settings.enabled && (
          <>
            <View style={styles.divider} />
            <Text style={styles.label}>WHO CAN USE IT</Text>
            <View style={styles.chips}>
              {(
                [
                  ['all', 'Everyone'],
                  ['roles', 'Some roles'],
                  ['users', 'Some people'],
                ] as const
              ).map(([m, label]) => (
                <Chip key={m} text={label} on={settings.who.mode === m} onPress={() => set('who', { ...settings.who, mode: m })} />
              ))}
            </View>
            {settings.who.mode === 'roles' && (
              <View style={styles.chips}>
                {roles
                  .filter((r) => r.key !== 'super_admin')
                  .map((r) => (
                    <Chip key={r.key} text={r.name} on={settings.who.roles.includes(r.key)} onPress={() => toggleWho('roles', r.key)} />
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
                    onPress={() => toggleWho('user_ids', u.id)}
                  />
                ))}
              </View>
            )}
            <Text style={styles.hint}>Admins can always see the fee card and approve.</Text>
          </>
        )}
      </View>

      <Text style={styles.sectionLabel}>DISCOUNT LIMIT (% OF THE COURSE FEE)</Text>
      <View style={styles.card}>
        <Text style={styles.hint}>
          Up to this much a person can give at once, and approve for others. More than that goes to someone with a
          higher limit. 0 = can only ask.
        </Text>
        {roles.map((r) => (
          <View key={r.key} style={styles.limitRow}>
            <Text style={styles.limitName}>{r.name}</Text>
            {r.unlimited ? (
              <Text style={styles.limitFixed}>No limit</Text>
            ) : (
              <>
                <TextInput
                  value={String(settings.limits[r.key] ?? 0)}
                  onChangeText={(v) => {
                    const n = Math.min(100, Math.max(0, Number(v.replace(/[^0-9.]/g, '')) || 0));
                    set('limits', { ...settings.limits, [r.key]: n });
                  }}
                  keyboardType="numeric"
                  style={styles.limitInput}
                  accessibilityLabel={`${r.name} limit`}
                />
                <Text style={styles.limitPct}>%</Text>
              </>
            )}
          </View>
        ))}
      </View>

      <Text style={styles.sectionLabel}>APPROVED DISCOUNT VALID FOR</Text>
      <View style={styles.card}>
        <View style={styles.chips}>
          {[3, 7, 15, 30, 0].map((d) => (
            <Chip key={d} text={d === 0 ? 'Always' : `${d} days`} on={settings.valid_days === d} onPress={() => set('valid_days', d)} />
          ))}
        </View>
        <Text style={styles.hint}>
          {settings.valid_days === 0
            ? 'An approved discount stays until the lead is admitted.'
            : `If the lead isn’t admitted within ${settings.valid_days} days, the discount runs out and the person who asked gets a message.`}
        </Text>
      </View>

      <Text style={styles.sectionLabel}>REASONS</Text>
      <View style={styles.card}>
        <View style={styles.chips}>
          {settings.reasons.map((r) => (
            <Pressable
              key={r}
              onPress={() => set('reasons', settings.reasons.filter((x) => x !== r))}
              style={styles.reason}
              accessibilityRole="button"
              accessibilityLabel={`Remove ${r}`}
            >
              <Text style={styles.reasonText}>{r}  ✕</Text>
            </Pressable>
          ))}
        </View>
        <View style={styles.addRow}>
          <TextInput
            value={newReason}
            onChangeText={setNewReason}
            placeholder="New reason"
            placeholderTextColor={colors.textMuted}
            style={[styles.input, styles.flex]}
            onSubmitEditing={addReason}
            returnKeyType="done"
          />
          <Button title="Add" variant="secondary" onPress={addReason} />
        </View>
        <View style={styles.switchRow}>
          <Text style={[styles.rowTitle, styles.flex]}>A reason is needed</Text>
          <Switch value={settings.reason_required} onValueChange={(v) => set('reason_required', v)} />
        </View>
      </View>

      {/* 💵 Payments */}
      <Text style={styles.sectionLabel}>PAYMENTS (ADMITTED STUDENTS)</Text>
      <View style={styles.card}>
        <View style={styles.switchRow}>
          <View style={styles.flex}>
            <Text style={styles.rowTitle}>Payments & receipts</Text>
            <Text style={styles.rowText}>
              {pay.enabled
                ? 'On. Admitted students: take payments, receipts, installments.'
                : 'Off. No new payments (old ones still show).'}
            </Text>
          </View>
          <Switch value={pay.enabled} onValueChange={(v) => setPay('enabled', v)} />
        </View>

        {pay.enabled && (
          <>
            <View style={styles.divider} />
            <Text style={styles.label}>WHO CAN TAKE PAYMENTS</Text>
            <WhoPicker
              rule={pay.who}
              modes={[
                ['all', 'Everyone'],
                ['roles', 'Some roles'],
                ['users', 'Some people'],
              ]}
              roles={roles}
              users={users}
              onMode={(m) => setPay('who', { ...pay.who, mode: m })}
              onToggle={(k, v) => togglePayWho('who', k, v)}
            />

            <View style={styles.divider} />
            <Text style={styles.label}>WHO CAN VOID A PAYMENT</Text>
            <WhoPicker
              rule={pay.void_who}
              modes={[
                ['roles', 'Admins / some roles'],
                ['users', 'Some people'],
                ['all', 'Everyone'],
              ]}
              roles={roles}
              users={users}
              onMode={(m) => setPay('void_who', { ...pay.void_who, mode: m })}
              onToggle={(k, v) => togglePayWho('void_who', k, v)}
            />
            <Text style={styles.hint}>Admins can always take and void payments. A void payment stays in the list.</Text>

            <View style={styles.divider} />
            <Text style={styles.label}>PAYMENT METHODS</Text>
            {pay.methods.map((m, i) => (
              <View key={m.name} style={styles.methodRow}>
                <Text style={[styles.limitName]}>{m.name}</Text>
                <Text style={styles.hint}>Txn ID</Text>
                <Switch
                  value={m.txn}
                  onValueChange={(v) => setPay('methods', pay.methods.map((x, j) => (j === i ? { ...x, txn: v } : x)))}
                />
                <Pressable
                  onPress={() => setPay('methods', pay.methods.filter((_, j) => j !== i))}
                  hitSlop={8}
                  accessibilityRole="button"
                  accessibilityLabel={`Remove ${m.name}`}
                >
                  <Text style={styles.remove}>✕</Text>
                </Pressable>
              </View>
            ))}
            <View style={styles.addRow}>
              <TextInput
                value={newMethod}
                onChangeText={setNewMethod}
                placeholder="New method, e.g. Upay"
                placeholderTextColor={colors.textMuted}
                style={[styles.input, styles.flex]}
                onSubmitEditing={addMethod}
                returnKeyType="done"
              />
              <Button title="Add" variant="secondary" onPress={addMethod} />
            </View>
            <Text style={styles.hint}>Txn ID on = a transaction ID must be typed for that method.</Text>

            <View style={styles.divider} />
            <Text style={styles.label}>AT ADMISSION</Text>
            <View style={styles.limitRow}>
              <Text style={styles.limitName}>Least payment to admit (৳)</Text>
              <TextInput
                value={String(pay.min_on_admit)}
                onChangeText={(v) => setPay('min_on_admit', Math.max(0, Number(v.replace(/[^0-9]/g, '')) || 0))}
                keyboardType="numeric"
                style={[styles.limitInput, styles.wideInput]}
              />
            </View>
            <Text style={styles.hint}>
              {pay.min_on_admit > 0
                ? `Mark admitted asks for at least ৳${pay.min_on_admit.toLocaleString('en-IN')} (or the whole fee if it is less).`
                : '0 = a student can be admitted without paying; the payment can be taken later.'}
            </Text>

            <View style={styles.divider} />
            <Text style={styles.label}>PAYMENT DATE MAY GO BACK</Text>
            <View style={styles.chips}>
              {[0, 3, 7, 15, 30].map((d) => (
                <Chip
                  key={d}
                  text={d === 0 ? 'Today only' : `${d} days`}
                  on={pay.backdate_days === d}
                  onPress={() => setPay('backdate_days', d)}
                />
              ))}
            </View>
            <Text style={styles.hint}>Older dates: admins only.</Text>
          </>
        )}
      </View>

      <Text style={styles.sectionLabel}>RECEIPT SHOWS</Text>
      <View style={styles.card}>
        <View style={styles.chips}>
          {RECEIPT_FIELDS.map((f) => (
            <Chip
              key={f.key}
              text={`${pay.receipt.fields[f.key] ? '✓ ' : ''}${f.label}`}
              on={pay.receipt.fields[f.key]}
              onPress={() =>
                setPay('receipt', {
                  ...pay.receipt,
                  fields: { ...pay.receipt.fields, [f.key]: !pay.receipt.fields[f.key] },
                })
              }
            />
          ))}
        </View>
        <Text style={styles.hint}>
          Always shown: receipt number, date, student name and amount. Institute name, address and phone come from
          Message templates → Institute details.
        </Text>
        <TextInput
          value={pay.receipt.footer}
          onChangeText={(v) => setPay('receipt', { ...pay.receipt, footer: v })}
          placeholder="Last line, e.g. Thank you."
          placeholderTextColor={colors.textMuted}
          style={styles.input}
        />
      </View>

      {error && <Text style={styles.error}>{error}</Text>}
      <Button title="Save" onPress={save} loading={saving} disabled={!dirty} fullWidth />
    </KeyboardAwareScrollView>
  );
}

function WhoPicker({
  rule,
  modes,
  roles,
  users,
  onMode,
  onToggle,
}: {
  rule: WhoRule;
  modes: [WhoRule['mode'], string][];
  roles: RoleRow[];
  users: AssignableUser[];
  onMode: (m: WhoRule['mode']) => void;
  onToggle: (key: 'roles' | 'user_ids', value: string) => void;
}) {
  return (
    <>
      <View style={styles.chips}>
        {modes.map(([m, label]) => (
          <Chip key={m} text={label} on={rule.mode === m} onPress={() => onMode(m)} />
        ))}
      </View>
      {rule.mode === 'roles' && (
        <View style={styles.chips}>
          {roles
            .filter((r) => !r.unlimited)
            .map((r) => (
              <Chip key={r.key} text={r.name} on={rule.roles.includes(r.key)} onPress={() => onToggle('roles', r.key)} />
            ))}
        </View>
      )}
      {rule.mode === 'users' && (
        <View style={styles.chips}>
          {users.map((u) => (
            <Chip
              key={u.id}
              text={u.full_name ?? 'No name'}
              on={rule.user_ids.includes(u.id)}
              onPress={() => onToggle('user_ids', u.id)}
            />
          ))}
        </View>
      )}
    </>
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
  sectionLabel: { fontSize: fontSize.caption, fontWeight: fontWeight.bold, letterSpacing: 1, color: colors.textMuted },
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
  limitRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm, minHeight: 44 },
  limitName: { flex: 1, fontSize: fontSize.body, color: colors.text },
  limitFixed: { fontSize: fontSize.small, fontWeight: fontWeight.semibold, color: colors.success },
  limitInput: {
    width: 64,
    minHeight: 40,
    paddingHorizontal: spacing.sm,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.border,
    textAlign: 'right',
    fontSize: fontSize.body,
    color: colors.text,
    backgroundColor: colors.background,
  },
  limitPct: { fontSize: fontSize.body, color: colors.textMuted },
  reason: {
    paddingVertical: 6,
    paddingHorizontal: spacing.md,
    borderRadius: radius.pill,
    backgroundColor: colors.primarySoft,
  },
  reasonText: { fontSize: fontSize.small, fontWeight: fontWeight.semibold, color: colors.primary },
  addRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm },
  methodRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm, minHeight: 40 },
  remove: { fontSize: fontSize.body, color: colors.danger, paddingHorizontal: spacing.xs },
  wideInput: { width: 96 },
  input: {
    minHeight: 42,
    paddingHorizontal: spacing.md,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.border,
    fontSize: fontSize.body,
    color: colors.text,
    backgroundColor: colors.background,
  },
});
