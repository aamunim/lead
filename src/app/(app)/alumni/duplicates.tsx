import { router, Stack, type Href } from 'expo-router';
import { useCallback, useEffect, useState } from 'react';
import { ActivityIndicator, Alert, Platform, ScrollView, StyleSheet, Text, View } from 'react-native';

import { alumniDuplicates, mergeAlumni, type DuplicateAlumnus } from '@/features/alumni/api';
import { alumniChanged, s as ui, useAlumniAccess } from '@/features/alumni/ui';
import { MIcon, md, Tap } from '@/features/home/md';
import { colors, fontSize, fontWeight, radius, spacing } from '@/shared/theme';
import { Button } from '@/shared/ui/Button';

// =====================================================================
// 👥 Alumni who look like the same person: the same name in the same
//   batch / passing year, or one's phone is another's WhatsApp.
//   Choose the one to keep → Merge: the others' notes, calls, referrals,
//   rewards, files and details move to it; the others are removed.
// =====================================================================

function confirm(title: string, text: string): Promise<boolean> {
  if (Platform.OS === 'web') return Promise.resolve(window.confirm(`${title}\n\n${text}`));
  return new Promise((resolve) =>
    Alert.alert(title, text, [
      { text: 'Cancel', style: 'cancel', onPress: () => resolve(false) },
      { text: 'Merge', style: 'destructive', onPress: () => resolve(true) },
    ]),
  );
}

export default function AlumniDuplicatesScreen() {
  const access = useAlumniAccess();
  const [groups, setGroups] = useState<DuplicateAlumnus[][] | null>(null);
  const [keep, setKeep] = useState<Record<number, string>>({});
  const [busy, setBusy] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const g = await alumniDuplicates();
      setGroups(g);
      // keep: the one with the most referrals, else the oldest
      setKeep(
        Object.fromEntries(
          g.map((list, i) => [
            i,
            [...list].sort((x, y) => y.referrals - x.referrals || x.created_at.localeCompare(y.created_at))[0].id,
          ]),
        ),
      );
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not load.');
      setGroups([]);
    }
  }, []);
  useEffect(() => {
    if (access.manage) load();
  }, [load, access.manage]);

  const merge = async (i: number) => {
    const list = groups?.[i];
    const k = keep[i];
    if (!list || !k) return;
    const kept = list.find((x) => x.id === k);
    const others = list.filter((x) => x.id !== k);
    if (
      !(await confirm(
        `Keep ${kept?.name}?`,
        `${others.map((o) => o.name).join(', ')} will be merged into it and removed.`,
      ))
    )
      return;
    setBusy(i);
    setError(null);
    try {
      await mergeAlumni(
        k,
        others.map((o) => o.id),
      );
      alumniChanged();
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not merge.');
    } finally {
      setBusy(null);
    }
  };

  if (!access.manage) {
    return (
      <View style={styles.center}>
        <Stack.Screen options={{ title: 'Duplicates' }} />
        <Text style={ui.muted}>Only people who manage alumni can merge.</Text>
      </View>
    );
  }

  return (
    <ScrollView style={styles.screen} contentContainerStyle={styles.content}>
      <Stack.Screen options={{ title: 'Duplicates' }} />
      <Text style={ui.muted}>Tap the one to keep in each group, then Merge.</Text>
      {groups === null && <ActivityIndicator color={colors.primary} />}
      {error && <Text style={ui.error}>{error}</Text>}
      {groups?.length === 0 && <Text style={ui.muted}>No duplicates found. ✓</Text>}
      {groups?.map((list, i) => (
        <View key={list.map((x) => x.id).join()} style={ui.card}>
          {list.map((a) => {
            const on = keep[i] === a.id;
            return (
              <Tap
                key={a.id}
                onPress={() => setKeep((k) => ({ ...k, [i]: a.id }))}
                style={[styles.row, on && styles.rowOn]}
                label={a.name}
              >
                <MIcon
                  name={on ? 'radio-button-checked' : 'radio-button-unchecked'}
                  color={on ? md.onPrimaryC : colors.textMuted}
                />
                <View style={styles.flex}>
                  <Text style={[styles.name, on && styles.onText]}>{a.name}</Text>
                  <Text style={[ui.muted, on && styles.onText]}>
                    {[
                      a.phone,
                      a.whatsapp && a.whatsapp !== a.phone ? `WA ${a.whatsapp}` : null,
                      a.batch,
                      a.passing_year,
                      a.workplace,
                    ]
                      .filter(Boolean)
                      .join(' · ')}
                    {a.referrals ? ` · ${a.referrals} referrals` : ''}
                  </Text>
                </View>
                <Tap onPress={() => router.push(`/alumni/${a.id}` as Href)} label="Open" style={styles.open}>
                  <MIcon name="open-in-new" size={18} color={on ? md.onPrimaryC : colors.textMuted} />
                </Tap>
              </Tap>
            );
          })}
          <Button
            title="Merge into the chosen one"
            onPress={() => merge(i)}
            loading={busy === i}
            disabled={busy !== null}
            fullWidth
          />
        </View>
      ))}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.background },
  center: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    padding: spacing.xl,
    backgroundColor: colors.background,
  },
  content: { padding: spacing.lg, gap: spacing.md, paddingBottom: spacing.xxl },
  flex: { flex: 1, gap: 2 },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
    padding: spacing.sm,
    borderRadius: radius.md,
    overflow: 'hidden',
  },
  rowOn: { backgroundColor: md.primaryC },
  name: { fontSize: fontSize.body, fontWeight: fontWeight.semibold, color: colors.text },
  onText: { color: md.onPrimaryC },
  open: { padding: spacing.xs, borderRadius: radius.sm, overflow: 'hidden' },
});
