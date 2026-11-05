import { Stack, router } from 'expo-router';
import { useEffect, useState } from 'react';
import { ActivityIndicator, Pressable, ScrollView, StyleSheet, Switch, Text, View } from 'react-native';

import { useAuth } from '@/features/auth/AuthProvider';
import {
  DEFAULT_CALL_LOCK,
  getCallLockSettings,
  saveCallLockSettings,
  type CallLockSettings,
} from '@/features/calls/callLock';
import { colors, fontSize, fontWeight, radius, spacing } from '@/shared/theme';
import { Button } from '@/shared/ui/Button';

// =====================================================================
// ⚙️ Settings → Call lock: one person on a call with a lead at a time
// =====================================================================

const MINUTES = [10, 15, 20, 30];
const OVERRIDE: { value: CallLockSettings['override']; label: string }[] = [
  { value: 'none', label: 'Nobody' },
  { value: 'admin', label: 'Admins' },
  { value: 'admin_tl', label: 'Admins + Team Leads' },
];

export default function CallLockSettingsScreen() {
  const { hasPermission } = useAuth();
  const canManage = hasPermission('settings.manage');
  const [s, setS] = useState<CallLockSettings>(DEFAULT_CALL_LOCK);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    getCallLockSettings()
      .then(setS)
      .finally(() => setLoading(false));
  }, []);

  const set = <K extends keyof CallLockSettings>(key: K, value: CallLockSettings[K]) => {
    setS((now) => ({ ...now, [key]: value }));
    setDirty(true);
    setError(null);
  };

  const save = async () => {
    setSaving(true);
    try {
      await saveCallLockSettings(s);
      setDirty(false);
      router.back();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not save.');
    } finally {
      setSaving(false);
    }
  };

  if (!canManage)
    return (
      <View style={styles.center}>
        <Stack.Screen options={{ title: 'Call lock' }} />
        <Text style={styles.muted}>Only admins can change these settings.</Text>
      </View>
    );
  if (loading)
    return (
      <View style={styles.center}>
        <Stack.Screen options={{ title: 'Call lock' }} />
        <ActivityIndicator size="large" color={colors.primary} />
      </View>
    );

  const off = !s.enabled;
  return (
    <ScrollView style={styles.screen} contentContainerStyle={styles.content}>
      <Stack.Screen options={{ title: 'Call lock' }} />

      <Text style={styles.intro}>
        While someone is on a call with a lead, nobody else can call the same lead from the app: “🚫 Rahim is on a call
        with this lead. Try again when the call is over.” The lead is free again when the call ends.
      </Text>

      <View style={styles.card}>
        <SwitchRow
          title="Call lock"
          text={s.enabled ? 'On for everyone.' : 'Off: anyone can call any time.'}
          value={s.enabled}
          onChange={(v) => set('enabled', v)}
          big
        />
      </View>

      <View style={off && styles.dimmed} pointerEvents={off ? 'none' : 'auto'}>
        <Text style={styles.label}>WHEN SOMEONE IS ON A CALL</Text>
        <View style={styles.card}>
          <Chips
            options={[
              { value: 'block', label: '🚫 Stop the call' },
              { value: 'warn', label: '⚠️ Only warn' },
            ]}
            value={s.mode}
            onChange={(v) => set('mode', v as CallLockSettings['mode'])}
          />
          <Text style={styles.hint}>
            {s.mode === 'block'
              ? 'The call does not start (except for the people below).'
              : 'It asks “Call anyway?”; calling anyway goes into the change log.'}
          </Text>
          {s.mode === 'block' && (
            <>
              <Text style={styles.small}>Who may call anyway (written in the change log)</Text>
              <Chips
                options={OVERRIDE}
                value={s.override}
                onChange={(v) => set('override', v as CallLockSettings['override'])}
              />
            </>
          )}
        </View>

        <Text style={styles.label}>⏱ ENDS BY ITSELF AFTER</Text>
        <View style={styles.card}>
          <Chips
            options={MINUTES.map((m) => ({ value: String(m), label: `${m} min` }))}
            value={String(s.minutes)}
            onChange={(v) => set('minutes', Number(v))}
          />
          <Text style={styles.hint}>
            In case the phone never comes back to the app (no internet, phone off). Normally the lead is free again the
            moment the call is over.
          </Text>
        </View>

        <Text style={styles.label}>MORE</Text>
        <View style={styles.card}>
          <SwitchRow
            title="📞 Show it on the cards"
            text="“📞 Rahim is on a call · 3 min” on the Leads list, checked every 15 seconds."
            value={s.cards}
            onChange={(v) => set('cards', v)}
          />
        </View>

        <Text style={styles.note}>
          On app 2.8.0 and newer the phone also marks an answered call from a lead, and frees the lead the moment any
          call ends. A call made from the phone’s own dialer can’t be stopped. With no internet, calls go as before.
        </Text>
      </View>

      {!!error && <Text style={styles.error}>{error}</Text>}
      <Button title="Save" onPress={save} loading={saving} disabled={!dirty} fullWidth />
    </ScrollView>
  );
}

function Chips({
  options,
  value,
  onChange,
}: {
  options: { value: string; label: string }[];
  value: string;
  onChange: (v: string) => void;
}) {
  return (
    <View style={styles.chips}>
      {options.map((o) => {
        const on = o.value === value;
        return (
          <Pressable
            key={o.value}
            onPress={() => onChange(o.value)}
            style={[styles.chip, on && styles.chipOn]}
            accessibilityRole="radio"
            accessibilityState={{ checked: on }}
          >
            <Text style={[styles.chipText, on && styles.chipTextOn]}>{o.label}</Text>
          </Pressable>
        );
      })}
    </View>
  );
}

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

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.background },
  content: { padding: spacing.lg, gap: spacing.md, paddingBottom: spacing.xxl },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: spacing.xl },
  flex: { flex: 1 },
  muted: { fontSize: fontSize.small, color: colors.textMuted, textAlign: 'center' },
  intro: { fontSize: fontSize.small, color: colors.textMuted, lineHeight: 20 },
  card: {
    gap: spacing.md,
    padding: spacing.lg,
    borderRadius: radius.lg,
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.border,
  },
  dimmed: { opacity: 0.45 },
  label: {
    fontSize: fontSize.caption,
    fontWeight: fontWeight.bold,
    letterSpacing: 1,
    color: colors.textMuted,
    marginTop: spacing.md,
    marginBottom: spacing.sm,
  },
  row: { flexDirection: 'row', alignItems: 'center', gap: spacing.md },
  rowTitle: { fontSize: fontSize.body, fontWeight: fontWeight.semibold, color: colors.text },
  rowTitleBig: { fontSize: fontSize.title, fontWeight: fontWeight.bold },
  rowText: { fontSize: fontSize.caption, color: colors.textMuted, marginTop: 2 },
  chips: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.sm },
  chip: {
    paddingVertical: spacing.sm,
    paddingHorizontal: spacing.md,
    borderRadius: radius.pill,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.surface,
  },
  chipOn: { backgroundColor: colors.primary, borderColor: colors.primary },
  chipText: { fontSize: fontSize.small, fontWeight: fontWeight.semibold, color: colors.text },
  chipTextOn: { color: colors.textOnPrimary },
  hint: { fontSize: fontSize.caption, color: colors.textMuted },
  small: { fontSize: fontSize.small, fontWeight: fontWeight.semibold, color: colors.text },
  note: { fontSize: fontSize.caption, color: colors.textMuted, marginTop: spacing.md, lineHeight: 18 },
  error: { color: colors.danger, fontSize: fontSize.small },
});
