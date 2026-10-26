import { Stack, router } from 'expo-router';
import { useEffect, useState } from 'react';
import { ActivityIndicator, Pressable, ScrollView, StyleSheet, Switch, Text, View } from 'react-native';

import { useAuth } from '@/features/auth/AuthProvider';
import {
  DEFAULT_ACTIVITY,
  getActivitySettings,
  saveActivitySettings,
  type ActivitySettings,
} from '@/features/activity/api';
import { colors, fontSize, fontWeight, radius, spacing } from '@/shared/theme';
import { Button } from '@/shared/ui/Button';

const IDLE = [5, 10, 15, 30];
const ALERT = [30, 60, 120];
const KEEP = [30, 90, 180];

export default function ActivitySettingsScreen() {
  const { hasPermission } = useAuth();
  const canManage = hasPermission('settings.manage');

  const [settings, setSettings] = useState<ActivitySettings>(DEFAULT_ACTIVITY);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    getActivitySettings()
      .then(setSettings)
      .finally(() => setLoading(false));
  }, []);

  const set = <K extends keyof ActivitySettings>(key: K, value: ActivitySettings[K]) => {
    setSettings((s) => ({ ...s, [key]: value }));
    setError(null);
  };

  const handleSave = async () => {
    setSaving(true);
    setError(null);
    try {
      await saveActivitySettings(settings);
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
        <Stack.Screen options={{ title: 'Team activity' }} />
        <Text style={styles.muted}>Only admins can change these settings.</Text>
      </View>
    );
  }

  if (loading) {
    return (
      <View style={styles.center}>
        <Stack.Screen options={{ title: 'Team activity' }} />
        <ActivityIndicator size="large" color={colors.primary} />
      </View>
    );
  }

  return (
    <ScrollView style={styles.screen} contentContainerStyle={styles.content}>
      <Stack.Screen options={{ title: 'Team activity' }} />

      <Text style={styles.intro}>
        More → Team activity and Change log. Only the time spent in this app is counted (no other apps). Callers can’t
        see activity, not even their own.
      </Text>

      <View style={styles.card}>
        <SwitchRow
          title="Count app time"
          text={
            settings.enabled
              ? 'Phones send how long the app is used. The change log always works.'
              : 'App time is not counted. The change log still works.'
          }
          value={settings.enabled}
          onChange={(v) => set('enabled', v)}
        />
        <View style={styles.divider} />
        <SwitchRow
          title="Team Leads see their team"
          text={settings.team_leads ? 'Team Leads see their team’s activity and changes.' : 'Only admins see activity.'}
          value={settings.team_leads}
          onChange={(v) => set('team_leads', v)}
        />
      </View>

      <Text style={styles.sectionLabel}>STOP COUNTING AFTER NO TOUCH FOR</Text>
      <Choices values={IDLE} value={settings.idle_minutes} unit="min" onPick={(v) => set('idle_minutes', v)} />
      <Text style={styles.hint}>
        If the app is left open with no touch or scroll for this long, the time stops. It starts again on the next touch.
      </Text>

      <Text style={styles.sectionLabel}>⚠ IN OFFICE HOURS, NO WORK FOR</Text>
      <Choices values={ALERT} value={settings.alert_minutes} unit="min" onPick={(v) => set('alert_minutes', v)} />
      <Text style={styles.hint}>Shown on Team activity (Today). Office hours: Settings → Working days & holidays.</Text>

      <Text style={styles.sectionLabel}>KEEP APP SESSIONS FOR</Text>
      <Choices values={KEEP} value={settings.keep_days} unit="days" onPick={(v) => set('keep_days', v)} />
      <Text style={styles.hint}>The change log (lead history) is kept forever and can’t be changed or deleted.</Text>

      {error && (
        <View style={styles.errorBox}>
          <Text style={styles.errorText}>{error}</Text>
        </View>
      )}
      <Button title="Save" onPress={handleSave} loading={saving} fullWidth />
    </ScrollView>
  );
}

function Choices({
  values,
  value,
  unit,
  onPick,
}: {
  values: number[];
  value: number;
  unit: string;
  onPick: (v: number) => void;
}) {
  return (
    <View style={styles.choices}>
      {values.map((v) => {
        const on = v === value;
        return (
          <Pressable
            key={v}
            onPress={() => onPick(v)}
            style={[styles.choice, on && styles.choiceOn]}
            accessibilityRole="radio"
            accessibilityState={{ checked: on }}
          >
            <Text style={[styles.choiceText, on && styles.choiceTextOn]}>
              {v} {unit}
            </Text>
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

const styles = StyleSheet.create({
  flex: { flex: 1 },
  screen: { flex: 1, backgroundColor: colors.background },
  content: { padding: spacing.lg, gap: spacing.md, paddingBottom: spacing.xxl },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: spacing.xl, backgroundColor: colors.background },
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
  choices: { flexDirection: 'row', gap: spacing.sm, flexWrap: 'wrap' },
  choice: {
    minHeight: 38,
    justifyContent: 'center',
    paddingHorizontal: spacing.lg,
    borderRadius: radius.pill,
    borderWidth: 1.5,
    borderColor: colors.border,
    backgroundColor: colors.surface,
  },
  choiceOn: { backgroundColor: colors.primary, borderColor: colors.primary },
  choiceText: { fontSize: fontSize.small, fontWeight: fontWeight.semibold, color: colors.text },
  choiceTextOn: { color: colors.textOnPrimary },
  hint: { fontSize: fontSize.caption, lineHeight: 18, color: colors.textMuted },
  muted: { fontSize: fontSize.small, color: colors.textMuted },
  errorBox: { padding: spacing.md, borderRadius: radius.md, backgroundColor: colors.dangerSoft },
  errorText: { fontSize: fontSize.small, color: colors.danger },
});
