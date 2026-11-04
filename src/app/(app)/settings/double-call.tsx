import { Stack, router } from 'expo-router';
import { useEffect, useState } from 'react';
import { ActivityIndicator, Pressable, ScrollView, StyleSheet, Switch, Text, View } from 'react-native';

import { useAuth } from '@/features/auth/AuthProvider';
import {
  DEFAULT_DOUBLE_CALL,
  getDoubleCallSettings,
  saveDoubleCallSettings,
  type DoubleCallSettings,
} from '@/features/calls/doubleCall';
import { colors, fontSize, fontWeight, radius, spacing } from '@/shared/theme';
import { Button } from '@/shared/ui/Button';

// =====================================================================
// ⚙️ Settings → Double-call warning
//   Before a call from the app: "Rahim called 12 minutes ago. Call again?"
// =====================================================================

const MINUTES = [10, 15, 30, 60, 120];

export default function DoubleCallSettingsScreen() {
  const { hasPermission } = useAuth();
  const canManage = hasPermission('settings.manage');
  const [s, setS] = useState<DoubleCallSettings>(DEFAULT_DOUBLE_CALL);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    getDoubleCallSettings()
      .then(setS)
      .finally(() => setLoading(false));
  }, []);

  const set = <K extends keyof DoubleCallSettings>(key: K, value: DoubleCallSettings[K]) => {
    setS((now) => ({ ...now, [key]: value }));
    setDirty(true);
    setError(null);
  };

  const save = async () => {
    setSaving(true);
    try {
      await saveDoubleCallSettings(s);
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
        <Stack.Screen options={{ title: 'Double-call warning' }} />
        <Text style={styles.muted}>Only admins can change these settings.</Text>
      </View>
    );
  if (loading)
    return (
      <View style={styles.center}>
        <Stack.Screen options={{ title: 'Double-call warning' }} />
        <ActivityIndicator size="large" color={colors.primary} />
      </View>
    );

  const off = !s.enabled;
  return (
    <ScrollView style={styles.screen} contentContainerStyle={styles.content}>
      <Stack.Screen options={{ title: 'Double-call warning' }} />

      <Text style={styles.intro}>
        When someone taps Call on a lead that another person talked to (or wrote a note on) a moment ago, the app asks
        first: “⚠️ Rahim called 12 minutes ago. Read the notes before calling again. Call anyway?”
      </Text>

      <View style={styles.card}>
        <SwitchRow
          title="Double-call warning"
          text={s.enabled ? 'On for everyone (admins too).' : 'Off: calls start right away.'}
          value={s.enabled}
          onChange={(v) => set('enabled', v)}
          big
        />
      </View>

      <View style={off && styles.dimmed} pointerEvents={off ? 'none' : 'auto'}>
        <Text style={styles.label}>⏱ WITHIN</Text>
        <View style={styles.card}>
          <View style={styles.chips}>
            {MINUTES.map((m) => {
              const on = s.minutes === m;
              return (
                <Pressable
                  key={m}
                  onPress={() => set('minutes', m)}
                  style={[styles.chip, on && styles.chipOn]}
                  accessibilityRole="radio"
                  accessibilityState={{ checked: on }}
                >
                  <Text style={[styles.chipText, on && styles.chipTextOn]}>
                    {m >= 60 ? `${m / 60} hour${m > 60 ? 's' : ''}` : `${m} min`}
                  </Text>
                </Pressable>
              );
            })}
          </View>
          <Text style={styles.hint}>A call or note older than this doesn’t warn.</Text>
        </View>

        <Text style={styles.label}>📋 WHAT COUNTS</Text>
        <View style={styles.card}>
          <SwitchRow
            title="📞 Calls where they talked"
            text="Always counted (Connected calls)."
            value
            onChange={() => undefined}
            disabled
          />
          <SwitchRow
            title="📵 Calls nobody answered too"
            text="No answer, busy, switched off… (a try counts as contact)"
            value={s.count_attempts}
            onChange={(v) => set('count_attempts', v)}
          />
          <SwitchRow
            title="📝 Notes and voice notes"
            text="Someone wrote or recorded a note on the lead."
            value={s.count_notes}
            onChange={(v) => set('count_notes', v)}
          />
          <SwitchRow
            title="💬 WhatsApp"
            text="WhatsApp calls and messages with the lead."
            value={s.count_whatsapp}
            onChange={(v) => set('count_whatsapp', v)}
          />
          <SwitchRow
            title="🙋 My own calls too"
            text="Also warn when it was you who called a moment ago."
            value={s.own}
            onChange={(v) => set('own', v)}
          />
        </View>

        <Text style={styles.label}>📜 CHANGE LOG</Text>
        <View style={styles.card}>
          <SwitchRow
            title="Write “Call anyway” in the change log"
            text="“⚠️ Called anyway · Rahim called 12 min before”, so admins can see it (More → Change log)."
            value={s.log_anyway}
            onChange={(v) => set('log_anyway', v)}
          />
        </View>

        <Text style={styles.note}>
          Calls started from the phone’s own dialer can’t be stopped by the app, but with Call log sync on they count
          for everyone else’s warning. With no internet the app calls right away.
        </Text>
      </View>

      {!!error && <Text style={styles.error}>{error}</Text>}
      <Button title="Save" onPress={save} loading={saving} disabled={!dirty} fullWidth />
    </ScrollView>
  );
}

function SwitchRow({
  title,
  text,
  value,
  onChange,
  big,
  disabled,
}: {
  title: string;
  text: string;
  value: boolean;
  onChange: (v: boolean) => void;
  big?: boolean;
  disabled?: boolean;
}) {
  return (
    <View style={styles.row}>
      <View style={styles.flex}>
        <Text style={[styles.rowTitle, big && styles.rowTitleBig]}>{title}</Text>
        <Text style={styles.rowText}>{text}</Text>
      </View>
      <Switch value={value} onValueChange={onChange} disabled={disabled} />
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
  note: { fontSize: fontSize.caption, color: colors.textMuted, marginTop: spacing.md, lineHeight: 18 },
  error: { color: colors.danger, fontSize: fontSize.small },
});
