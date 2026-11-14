import { Stack } from 'expo-router';
import { useEffect, useState } from 'react';
import { ActivityIndicator, Alert, Platform, Pressable, StyleSheet, Switch, Text, TextInput, View } from 'react-native';
import { KeyboardAwareScrollView } from 'react-native-keyboard-controller';

import { useAuth } from '@/features/auth/AuthProvider';
import {
  DEFAULT_SCORE_SETTINGS,
  getScoreSettings,
  recalcScores,
  saveScoreSettings,
  SCORE_RULES,
  type ScoreRuleKey,
  type ScoreSettings,
} from '@/features/leads/score';
import { colors, fontSize, fontWeight, radius, spacing } from '@/shared/theme';
import { Button } from '@/shared/ui/Button';

// =====================================================================
// ⚙️ Settings → Lead score (admission chance)
//   Start value + points for each sign. Saving works every lead out again.
// =====================================================================

function say(title: string, text: string) {
  if (Platform.OS === 'web') window.alert(`${title}\n\n${text}`);
  else Alert.alert(title, text);
}

export default function LeadScoreSettingsScreen() {
  const { hasPermission } = useAuth();
  const [s, setS] = useState<ScoreSettings>(DEFAULT_SCORE_SETTINGS);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    getScoreSettings()
      .then(setS)
      .catch((e) => setError(e instanceof Error ? e.message : 'Could not load.'))
      .finally(() => setLoading(false));
  }, []);

  const set = (next: ScoreSettings) => {
    setS(next);
    setDirty(true);
  };
  const setRule = (key: ScoreRuleKey, v: number) => set({ ...s, rules: { ...s.rules, [key]: v } });

  const save = async () => {
    setSaving(true);
    setError(null);
    try {
      await saveScoreSettings(s);
      const n = s.enabled ? await recalcScores() : 0;
      setDirty(false);
      say('Saved', s.enabled ? `Every lead’s score was worked out again (${n}).` : 'The score stays as it is now.');
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not save.');
    } finally {
      setSaving(false);
    }
  };

  if (!hasPermission('settings.manage')) {
    return (
      <View style={styles.center}>
        <Stack.Screen options={{ title: 'Lead score' }} />
        <Text style={styles.muted}>Only admins can change this.</Text>
      </View>
    );
  }
  if (loading) {
    return (
      <View style={styles.center}>
        <Stack.Screen options={{ title: 'Lead score' }} />
        <ActivityIndicator size="large" color={colors.primary} />
      </View>
    );
  }

  // the highest and lowest an open lead can get (shown as a hint)
  const values = Object.values(s.rules);
  const best = Math.min(100, s.base + values.filter((v) => v > 0).reduce((a, b) => a + b, 0));

  return (
    <KeyboardAwareScrollView
      bottomOffset={spacing.xl}
      style={styles.screen}
      contentContainerStyle={styles.content}
      keyboardShouldPersistTaps="handled"
    >
      <Stack.Screen options={{ title: 'Lead score' }} />

      <View style={styles.card}>
        <View style={styles.switchRow}>
          <View style={styles.flex}>
            <Text style={styles.title}>🔥 Admission chance</Text>
            <Text style={styles.muted}>
              A number from 0 to 100 on every open lead, from its own calls, visits, fee talk, stage and rating. No AI,
              no cost. Admitted = 100, Not Now = 0.
            </Text>
          </View>
          <Switch value={s.enabled} onValueChange={(v) => set({ ...s, enabled: v })} />
        </View>
      </View>

      {s.enabled && (
        <View style={styles.card}>
          <PointsRow
            icon="🏁"
            label="Start value"
            text="Every open lead starts here"
            value={s.base}
            min={0}
            onChange={(v) => set({ ...s, base: v })}
          />
          <Text style={styles.label}>POINTS FOR EACH SIGN (− TAKES AWAY)</Text>
          {SCORE_RULES.map((r) => (
            <PointsRow
              key={r.key}
              icon={r.icon}
              label={r.label}
              text={r.text}
              value={s.rules[r.key]}
              onChange={(v) => setRule(r.key, v)}
            />
          ))}
          <Text style={styles.muted}>
            The best a lead can get with these points: {best}. 0 points switches a sign off. Scores move by themselves
            when calls, visits or the lead change, and every night (for “no contact” days).
          </Text>
          <Pressable
            onPress={() => set({ ...DEFAULT_SCORE_SETTINGS })}
            accessibilityRole="button"
            style={styles.resetBtn}
          >
            <Text style={styles.reset}>Back to the starting points</Text>
          </Pressable>
        </View>
      )}

      {error && <Text style={styles.error}>{error}</Text>}
      <Button title="Save" onPress={save} loading={saving} disabled={!dirty} fullWidth />
    </KeyboardAwareScrollView>
  );
}

function PointsRow({
  icon,
  label,
  text,
  value,
  min = -100,
  onChange,
}: {
  icon: string;
  label: string;
  text: string;
  value: number;
  min?: number;
  onChange: (v: number) => void;
}) {
  const clamp = (v: number) => Math.max(min, Math.min(100, v));
  return (
    <View style={styles.rule}>
      <Text style={styles.icon}>{icon}</Text>
      <View style={styles.flex}>
        <Text style={styles.ruleLabel}>{label}</Text>
        <Text style={styles.small}>{text}</Text>
      </View>
      <Pressable onPress={() => onChange(clamp(value - 5))} style={styles.step} accessibilityLabel={`${label}: 5 less`}>
        <Text style={styles.stepText}>−</Text>
      </Pressable>
      <TextInput
        value={String(value)}
        onChangeText={(t) => {
          const n = parseInt(t.replace(/[^0-9-]/g, ''), 10);
          onChange(Number.isNaN(n) ? 0 : clamp(n));
        }}
        keyboardType="numbers-and-punctuation"
        style={[styles.input, { color: value > 0 ? colors.success : value < 0 ? colors.danger : colors.textMuted }]}
        accessibilityLabel={`${label} points`}
      />
      <Pressable onPress={() => onChange(clamp(value + 5))} style={styles.step} accessibilityLabel={`${label}: 5 more`}>
        <Text style={styles.stepText}>+</Text>
      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1 },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center', backgroundColor: colors.background },
  screen: { flex: 1, backgroundColor: colors.background },
  content: {
    padding: spacing.lg,
    gap: spacing.md,
    paddingBottom: spacing.xxl,
    ...(Platform.OS === 'web' ? { maxWidth: 720, width: '100%', alignSelf: 'center' } : {}),
  },
  card: {
    gap: spacing.sm,
    padding: spacing.lg,
    borderRadius: radius.lg,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.surface,
  },
  switchRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.md },
  title: { fontSize: fontSize.body, fontWeight: fontWeight.bold, color: colors.text },
  muted: { fontSize: fontSize.small, color: colors.textMuted },
  small: { fontSize: fontSize.caption, color: colors.textMuted },
  label: {
    fontSize: fontSize.caption,
    fontWeight: fontWeight.bold,
    letterSpacing: 1,
    color: colors.textMuted,
    marginTop: spacing.sm,
  },
  error: { fontSize: fontSize.small, color: colors.danger },
  rule: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    paddingVertical: 6,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.border,
  },
  icon: { width: 24, fontSize: 16, textAlign: 'center' },
  ruleLabel: { fontSize: fontSize.small, fontWeight: fontWeight.semibold, color: colors.text },
  step: {
    width: 30,
    height: 30,
    borderRadius: 15,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: colors.background,
  },
  stepText: { fontSize: 18, fontWeight: fontWeight.bold, color: colors.primary },
  input: {
    width: 52,
    textAlign: 'center',
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radius.md,
    paddingVertical: 4,
    fontSize: fontSize.body,
    fontWeight: fontWeight.bold,
    backgroundColor: colors.background,
  },
  resetBtn: { alignSelf: 'flex-start', marginTop: spacing.xs },
  reset: { fontSize: fontSize.small, fontWeight: fontWeight.bold, color: colors.primary },
});
