import { router, Stack, type Href } from 'expo-router';
import { useEffect, useState } from 'react';
import { ActivityIndicator, FlatList, StyleSheet, Text, TextInput, View } from 'react-native';

import { alumniSchools, type AlumniSchool } from '@/features/alumni/api';
import { s as ui } from '@/features/alumni/ui';
import { MIcon, md, Tap } from '@/features/home/md';
import { colors, fontSize, fontWeight, radius, spacing } from '@/shared/theme';

// =====================================================================
// 🏫 Schools: where alumni work (the same school written a little
//   differently is one), with the leads from there and how many were
//   admitted. Tap → the alumni of that school. One request (+ search).
// =====================================================================

export default function SchoolsScreen() {
  const [q, setQ] = useState('');
  const [rows, setRows] = useState<AlumniSchool[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    const t = setTimeout(
      () =>
        alumniSchools(q)
          .then((r) => live && (setRows(r), setError(null)))
          .catch((e) => live && (setError(e instanceof Error ? e.message : 'Could not load.'), setRows([]))),
      q ? 300 : 0,
    );
    return () => {
      live = false;
      clearTimeout(t);
    };
  }, [q]);

  return (
    <View style={styles.screen}>
      <Stack.Screen options={{ title: 'Schools' }} />
      <FlatList
        data={rows ?? []}
        keyExtractor={(r) => r.key}
        contentContainerStyle={styles.content}
        keyboardShouldPersistTaps="handled"
        initialNumToRender={20}
        ListHeaderComponent={
          <View style={styles.head}>
            <View style={styles.search}>
              <MIcon name="search" size={22} color={colors.textMuted} />
              <TextInput
                value={q}
                onChangeText={setQ}
                placeholder="Search a school"
                placeholderTextColor={colors.textMuted}
                style={styles.searchInput}
                accessibilityLabel="Search a school"
              />
            </View>
            <Text style={ui.muted}>
              From the alumni’s workplace. Leads count when a lead’s workplace is the same school. A school with alumni
              is a good place to find new students.
            </Text>
            {rows === null && <ActivityIndicator color={colors.primary} />}
            {error && <Text style={ui.error}>{error}</Text>}
          </View>
        }
        ListEmptyComponent={rows !== null && !error ? <Text style={ui.muted}>No schools yet.</Text> : undefined}
        renderItem={({ item }) => (
          <Tap
            onPress={() =>
              router.push(
                `/alumni?school=${encodeURIComponent(item.key)}&schoolName=${encodeURIComponent(item.name ?? '')}` as Href,
              )
            }
            style={styles.row}
            label={item.name}
          >
            <View style={styles.icon}>
              <MIcon name="apartment" size={22} color={md.onSkyC} />
            </View>
            <View style={styles.flex}>
              <Text style={styles.name} numberOfLines={2}>
                {item.name}
              </Text>
              {!!item.district && <Text style={ui.muted}>{item.district}</Text>}
              <Text style={styles.nums}>
                🎓 {item.alumni} alumni · 📨 {item.referrals} referrals · 👤 {item.leads} leads ·{' '}
                <Text style={styles.ok}>✅ {item.admitted}</Text>
              </Text>
            </View>
            <MIcon name="chevron-right" size={22} color={colors.textMuted} />
          </Tap>
        )}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.background },
  content: { padding: spacing.lg, gap: spacing.sm, paddingBottom: spacing.xxl },
  head: { gap: spacing.sm, marginBottom: spacing.sm },
  search: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    height: 48,
    paddingHorizontal: spacing.md,
    borderRadius: 24,
    backgroundColor: md.surface2,
  },
  searchInput: { flex: 1, fontSize: fontSize.body, color: colors.text },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
    padding: spacing.md,
    borderRadius: radius.lg,
    backgroundColor: md.surface1,
    overflow: 'hidden',
  },
  icon: {
    width: 40,
    height: 40,
    borderRadius: 20,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: md.skyC,
  },
  flex: { flex: 1, gap: 2 },
  name: { fontSize: fontSize.body, fontWeight: fontWeight.semibold, color: colors.text },
  nums: { fontSize: fontSize.small, color: colors.textMuted },
  ok: { color: colors.success, fontWeight: fontWeight.bold },
});
