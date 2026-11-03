import { Stack } from 'expo-router';
import { useEffect, useState } from 'react';
import { ActivityIndicator, Alert, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';

import { DEFAULT_CARD_SETTINGS, getCardSettings, saveCardSettings, type CardSettings } from '@/features/leads/lastActivity';
import { colors, fontSize, fontWeight, radius, spacing } from '@/shared/theme';
import { Button } from '@/shared/ui/Button';
import { useAuth } from '@/features/auth/AuthProvider';
import { DESIGN_LABEL, saveListDesignForAll, type ListDesign } from '@/features/leads/design';

// =====================================================================
// ⚙️ Settings → Lead cards: after how many days without contact an open
//   lead's card says "⏳ No contact for N days" (in orange)
// =====================================================================

const DAYS = [3, 5, 7, 10, 15, 30, 0];

export default function CardSettingsScreen() {
  const [settings, setSettings] = useState<CardSettings>(DEFAULT_CARD_SETTINGS);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [dirty, setDirty] = useState(false);
  const { refreshProfile } = useAuth();

  // 🎨 Everyone's list design at once (each person can change theirs later: More → List design)
  const setEveryone = (design: ListDesign) => {
    Alert.alert(
      `${DESIGN_LABEL[design]} design for everyone?`,
      'Every user’s Leads and Students lists change to it. Anyone can switch back for themselves in More → List design.',
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Change for everyone',
          onPress: async () => {
            try {
              const n = await saveListDesignForAll(design);
              await refreshProfile();
              Alert.alert('Done', `${n} ${n === 1 ? 'user' : 'users'} changed.`);
            } catch (e) {
              Alert.alert('Could not change', e instanceof Error ? e.message : '');
            }
          },
        },
      ],
    );
  };

  useEffect(() => {
    getCardSettings()
      .then(setSettings)
      .finally(() => setLoading(false));
  }, []);

  const save = async () => {
    setSaving(true);
    try {
      await saveCardSettings(settings);
      setDirty(false);
      Alert.alert('Saved', 'The lists show it the next time they are opened.');
    } catch (e) {
      Alert.alert('Could not save', e instanceof Error ? e.message : '');
    } finally {
      setSaving(false);
    }
  };

  if (loading) {
    return (
      <View style={styles.center}>
        <Stack.Screen options={{ title: 'Lead cards' }} />
        <ActivityIndicator size="large" color={colors.primary} />
      </View>
    );
  }

  return (
    <ScrollView style={styles.screen} contentContainerStyle={styles.content}>
      <Stack.Screen options={{ title: 'Lead cards' }} />
      <View style={styles.card}>
        <Text style={styles.title}>⏳ No contact for a while</Text>
        <Text style={styles.text}>
          On the Leads list, an open lead nobody has talked to for this many days shows “⏳ No contact for N days” in
          orange, and a lead never called shows “🆕 Not called yet”.
        </Text>
        <View style={styles.chips}>
          {DAYS.map((d) => {
            const on = settings.stale_days === d;
            return (
              <Pressable
                key={d}
                onPress={() => {
                  setSettings({ ...settings, stale_days: d });
                  setDirty(true);
                }}
                style={[styles.chip, on && styles.chipOn]}
                accessibilityRole="radio"
                accessibilityState={{ checked: on }}
              >
                <Text style={[styles.chipText, on && styles.chipTextOn]}>{d === 0 ? 'Off' : `${d} days`}</Text>
              </Pressable>
            );
          })}
        </View>
        <Text style={styles.hint}>
          Everyone can switch their own list between Compact and Detailed (last call and last note): the 📄 button
          next to the sort (classic design) or ⋮ → Show the latest on cards (new design).
        </Text>
      </View>
      <Button title="Save" onPress={save} loading={saving} disabled={!dirty} fullWidth />

      {/* 🎨 List design for everyone */}
      <View style={styles.card}>
        <Text style={styles.title}>🎨 List design</Text>
        <Text style={styles.text}>
          The new design is on for everyone unless they chose Classic. Each person can switch in More → List design;
          you can set one person’s on their page in Users, or everyone’s here.
        </Text>
        <View style={styles.chips}>
          {(['new', 'classic'] as ListDesign[]).map((d) => (
            <Pressable key={d} onPress={() => setEveryone(d)} style={styles.chip} accessibilityRole="button">
              <Text style={styles.chipText}>{DESIGN_LABEL[d]} for everyone</Text>
            </Pressable>
          ))}
        </View>
      </View>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.background },
  content: { padding: spacing.lg, gap: spacing.lg },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  card: {
    gap: spacing.md,
    padding: spacing.lg,
    borderRadius: radius.lg,
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.border,
  },
  title: { fontSize: fontSize.body, fontWeight: fontWeight.bold, color: colors.text },
  text: { fontSize: fontSize.small, color: colors.textMuted },
  hint: { fontSize: fontSize.caption, color: colors.textMuted },
  chips: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.sm },
  chip: {
    paddingVertical: spacing.sm,
    paddingHorizontal: spacing.md,
    borderRadius: radius.pill,
    borderWidth: 1,
    borderColor: colors.border,
  },
  chipOn: { backgroundColor: colors.text, borderColor: colors.text },
  chipText: { fontSize: fontSize.small, fontWeight: fontWeight.semibold, color: colors.textMuted },
  chipTextOn: { color: colors.surface },
});
