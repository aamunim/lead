import { Stack, router } from 'expo-router';
import { useEffect, useState } from 'react';
import { ActivityIndicator, Pressable, ScrollView, StyleSheet, Switch, Text, View } from 'react-native';

import { useAuth } from '@/features/auth/AuthProvider';
import {
  DEFAULT_CAMPUS_VISIT,
  getCampusVisitSettings,
  saveCampusVisitSettings,
  type CampusVisitSettings,
} from '@/features/visits/api';
import { colors, fontSize, fontWeight, radius, spacing } from '@/shared/theme';
import { Button } from '@/shared/ui/Button';

// "Didn't come" → next call after …
const MISSED_CHOICES: { value: number | null; title: string }[] = [
  { value: 1, title: 'Next day, 10 am' },
  { value: 2, title: 'In 2 days, 10 am' },
  { value: 3, title: 'In 3 days, 10 am' },
  { value: 7, title: 'In a week, 10 am' },
  { value: null, title: 'Don’t set a call' },
];

export default function CampusVisitSettingsScreen() {
  const { hasPermission } = useAuth();
  const canManage = hasPermission('settings.manage');

  const [settings, setSettings] = useState<CampusVisitSettings>(DEFAULT_CAMPUS_VISIT);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    getCampusVisitSettings()
      .then(setSettings)
      .finally(() => setLoading(false));
  }, []);

  const set = <K extends keyof CampusVisitSettings>(key: K, value: CampusVisitSettings[K]) => {
    setSettings((s) => ({ ...s, [key]: value }));
    setError(null);
  };

  const handleSave = async () => {
    setSaving(true);
    setError(null);
    try {
      await saveCampusVisitSettings(settings);
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
        <Stack.Screen options={{ title: 'Campus visit' }} />
        <Text style={styles.muted}>Only admins can change these settings.</Text>
      </View>
    );
  }

  if (loading) {
    return (
      <View style={styles.center}>
        <Stack.Screen options={{ title: 'Campus visit' }} />
        <ActivityIndicator size="large" color={colors.primary} />
      </View>
    );
  }

  return (
    <ScrollView style={styles.screen} contentContainerStyle={styles.content}>
      <Stack.Screen options={{ title: 'Campus visit' }} />

      <Text style={styles.intro}>
        A campus visit is separate from the pipeline: a lead in any stage can plan a visit, visit, or never visit.
        Planned visits show on Home on their day.
      </Text>

      <View style={styles.card}>
        <SwitchRow
          title="Campus visits on"
          text={
            settings.enabled
              ? 'Leads show a 🏫 Campus visit card.'
              : 'No new visits can be planned. Old visits are still shown.'
          }
          value={settings.enabled}
          onChange={(v) => set('enabled', v)}
        />
      </View>

      {settings.enabled && (
        <>
          <Text style={styles.sectionLabel}>WHEN THE STUDENT VISITS</Text>
          <View style={styles.card}>
            <SwitchRow
              title="Move to Interested"
              text={
                settings.visited_moves_to_interested
                  ? 'A New or Contacted lead moves to Interested. Other stages stay as they are.'
                  : 'The stage stays as it is.'
              }
              value={settings.visited_moves_to_interested}
              onChange={(v) => set('visited_moves_to_interested', v)}
            />
          </View>

          <Text style={styles.sectionLabel}>WHEN THE STUDENT DIDN’T COME</Text>
          <View style={styles.card}>
            {MISSED_CHOICES.map((c, index) => {
              const on = settings.missed_follow_up_days === c.value;
              return (
                <View key={String(c.value)}>
                  {index > 0 && <View style={styles.divider} />}
                  <Pressable
                    onPress={() => set('missed_follow_up_days', c.value)}
                    style={({ pressed }) => [styles.row, pressed && styles.pressed]}
                    accessibilityRole="radio"
                    accessibilityState={{ checked: on }}
                  >
                    <View style={[styles.radio, on && styles.radioOn]}>{on && <View style={styles.radioDot} />}</View>
                    <Text style={[styles.rowTitle, styles.flex]}>{c.title}</Text>
                  </Pressable>
                </View>
              );
            })}
          </View>
          <Text style={styles.hint}>
            A next call to ask again. If the lead already has an earlier call set, that one is kept.
          </Text>
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
  hint: { fontSize: fontSize.caption, lineHeight: 18, color: colors.textMuted },
  muted: { fontSize: fontSize.small, color: colors.textMuted },
  errorBox: { padding: spacing.md, borderRadius: radius.md, backgroundColor: colors.dangerSoft },
  errorText: { fontSize: fontSize.small, color: colors.danger },
});
