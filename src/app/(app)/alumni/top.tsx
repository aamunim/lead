import { router, Stack, type Href } from 'expo-router';
import { useCallback, useEffect, useState } from 'react';
import { ActivityIndicator, FlatList, RefreshControl, StyleSheet, Text, View } from 'react-native';

import { alumniTop, type TopPeriod, type TopReferrer } from '@/features/alumni/api';
import { Avatar, Chip, s as ui, useAlumniAccess } from '@/features/alumni/ui';
import { md, Tap } from '@/features/home/md';
import { colors, fontSize, fontWeight, radius, spacing } from '@/shared/theme';

// =====================================================================
// 🏆 Top referrers: this month / this year / all time
//   🔗 link opens → 📨 referrals → 👤 leads → 🎓 admitted (one request)
// =====================================================================

const PERIODS: { key: TopPeriod; label: string }[] = [
  { key: 'month', label: 'This month' },
  { key: 'year', label: 'This year' },
  { key: 'all', label: 'All time' },
];
const MEDAL = ['🥇', '🥈', '🥉'];

export default function TopReferrersScreen() {
  const access = useAlumniAccess();
  const [period, setPeriod] = useState<TopPeriod>('month');
  const [rows, setRows] = useState<TopReferrer[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);

  const load = useCallback(async () => {
    try {
      setRows(await alumniTop(period, 50));
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not load.');
      setRows([]);
    }
  }, [period]);

  useEffect(() => {
    setRows(null);
    load();
  }, [load]);

  return (
    <View style={styles.screen}>
      <Stack.Screen options={{ title: 'Top referrers' }} />
      <FlatList
        data={rows ?? []}
        keyExtractor={(r) => r.id}
        contentContainerStyle={styles.content}
        refreshControl={
          <RefreshControl
            refreshing={refreshing}
            onRefresh={() => (setRefreshing(true), load().finally(() => setRefreshing(false)))}
          />
        }
        ListHeaderComponent={
          <View style={styles.head}>
            <View style={ui.chips}>
              {PERIODS.map((p) => (
                <Chip key={p.key} text={p.label} on={period === p.key} onPress={() => setPeriod(p.key)} />
              ))}
            </View>
            <Text style={ui.muted}>Ranked by admitted, then referrals. 🔗 how many times their link was opened.</Text>
            {rows === null && <ActivityIndicator color={colors.primary} style={styles.loader} />}
            {error && <Text style={ui.error}>{error}</Text>}
          </View>
        }
        ListEmptyComponent={
          rows !== null && !error ? (
            <Text style={[ui.muted, styles.center]}>
              {access.view ? 'No referrals in this time yet.' : 'No access.'}
            </Text>
          ) : undefined
        }
        renderItem={({ item, index }) => (
          <Tap onPress={() => router.push(`/alumni/${item.id}` as Href)} style={styles.row} label={item.name}>
            <Text style={styles.rank}>{MEDAL[index] ?? `${index + 1}`}</Text>
            <Avatar name={item.name} size={40} />
            <View style={styles.flex}>
              <Text style={styles.name} numberOfLines={1}>
                {item.name}
              </Text>
              {!!(item.batch_name || item.workplace) && (
                <Text style={ui.muted} numberOfLines={1}>
                  {[item.batch_name, item.workplace].filter(Boolean).join(' · ')}
                </Text>
              )}
              <Text style={styles.nums}>
                🔗 {item.opens} · 📨 {item.referrals} · 👤 {item.leads} ·{' '}
                <Text style={styles.admitted}>🎓 {item.admitted}</Text>
              </Text>
            </View>
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
  loader: { marginTop: spacing.xl },
  center: { textAlign: 'center', marginTop: spacing.xl },
  flex: { flex: 1, gap: 2 },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
    padding: spacing.md,
    borderRadius: radius.lg,
    backgroundColor: md.surface1,
    overflow: 'hidden',
  },
  rank: { width: 28, textAlign: 'center', fontSize: fontSize.body, fontWeight: fontWeight.bold, color: colors.text },
  name: { fontSize: fontSize.body, fontWeight: fontWeight.semibold, color: colors.text },
  nums: { fontSize: fontSize.small, color: colors.textMuted },
  admitted: { color: colors.success, fontWeight: fontWeight.bold },
});
