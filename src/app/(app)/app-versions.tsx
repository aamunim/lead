import { Stack, useFocusEffect } from 'expo-router';
import { useCallback, useMemo, useState } from 'react';
import { ActivityIndicator, Alert, Pressable, RefreshControl, ScrollView, StyleSheet, Text, View } from 'react-native';

import { useAuth } from '@/features/auth/AuthProvider';
import {
  askToUpdate,
  listAppVersions,
  newestUpdate,
  shortId,
  stateOf,
  type DeviceVersion,
  type VersionState,
} from '@/features/updates/versions';
import { colors, fontSize, fontWeight, radius, spacing } from '@/shared/theme';

// =====================================================================
// 📱 More → App versions (admins): who runs which build and EAS update,
//   when they last opened the app; ask the ones on an old update.
// =====================================================================

type Filter = 'all' | 'old' | 'never';

const BADGE: Record<VersionState, { text: string; color: string; bg: string }> = {
  latest: { text: '✅ Latest', color: colors.success, bg: colors.successSoft },
  old: { text: '⚠ Old update', color: colors.warning, bg: colors.warningSoft },
  builtin: { text: 'Built in', color: colors.textMuted, bg: colors.background },
  never: { text: 'Not opened yet', color: colors.textMuted, bg: colors.background },
};

const when = (d: Date | null) =>
  d
    ? d.toLocaleString('en-GB', { day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit', hour12: true })
    : '—';

function ago(d: Date | null): string {
  if (!d) return 'never';
  const m = Math.round((Date.now() - d.getTime()) / 60000);
  if (m < 2) return 'just now';
  if (m < 60) return `${m} min ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h} h ago`;
  const days = Math.round(h / 24);
  return `${days} day${days === 1 ? '' : 's'} ago`;
}

export default function AppVersionsScreen() {
  const { hasPermission } = useAuth();
  const isAdmin = hasPermission('settings.manage');
  const [rows, setRows] = useState<DeviceVersion[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState<Filter>('all');
  const [refreshing, setRefreshing] = useState(false);
  const [asking, setAsking] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setRows(await listAppVersions());
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not load.');
    }
  }, []);

  useFocusEffect(
    useCallback(() => {
      if (isAdmin) load();
    }, [isAdmin, load]),
  );

  const newest = useMemo(() => (rows ? newestUpdate(rows) : null), [rows]);
  const withState = useMemo(() => (rows ?? []).map((r) => ({ ...r, state: stateOf(r, newest) })), [rows, newest]);

  // The summary counts people (their newest phone), not phones
  const people = useMemo(() => {
    const best = new Map<string, VersionState>();
    const rank: Record<VersionState, number> = { latest: 3, builtin: 2, old: 1, never: 0 };
    for (const r of withState) {
      const now = best.get(r.userId);
      if (now == null || rank[r.state] > rank[now]) best.set(r.userId, r.state);
    }
    return best;
  }, [withState]);
  const total = people.size;
  const latest = [...people.values()].filter((s) => s === 'latest').length;
  const oldIds = [...people.entries()].filter(([, s]) => s === 'old' || s === 'builtin').map(([id]) => id);

  const shown = withState.filter((r) =>
    filter === 'all' ? true : filter === 'old' ? r.state === 'old' || r.state === 'builtin' : r.state === 'never',
  );

  const ask = (ids: string[], label: string) =>
    Alert.alert('Ask to update?', `${label} will get a notification: “Please close the app and open it again”.`, [
      { text: 'Cancel', style: 'cancel' },
      {
        text: '🔔 Send',
        onPress: async () => {
          setAsking(ids.length === 1 ? ids[0] : 'all');
          try {
            const n = await askToUpdate(ids);
            Alert.alert(
              'Sent',
              n > 0 ? `${n} ${n === 1 ? 'person was' : 'people were'} told.` : 'Already sent this hour.',
            );
          } catch (e) {
            Alert.alert('Could not send', e instanceof Error ? e.message : '');
          } finally {
            setAsking(null);
          }
        },
      },
    ]);

  if (!isAdmin)
    return (
      <View style={styles.center}>
        <Text style={styles.muted}>Only admins can see this.</Text>
      </View>
    );

  return (
    <ScrollView
      style={styles.screen}
      contentContainerStyle={styles.content}
      refreshControl={
        <RefreshControl
          refreshing={refreshing}
          onRefresh={async () => {
            setRefreshing(true);
            await load();
            setRefreshing(false);
          }}
        />
      }
    >
      <Stack.Screen options={{ title: 'App versions' }} />

      {error && <Text style={styles.error}>{error}</Text>}
      {!rows && !error && <ActivityIndicator color={colors.primary} style={{ marginTop: spacing.xl }} />}

      {rows && (
        <>
          {/* Summary */}
          <View style={styles.card}>
            <Text style={styles.big}>
              {latest} of {total} on the newest update
            </Text>
            {newest ? (
              <Text style={styles.muted}>
                Newest: {when(newest.updateAt)} · <Text style={styles.mono}>{shortId(newest.updateId)}</Text>
                {newest.build ? ` · build ${newest.build}` : ''}
              </Text>
            ) : (
              <Text style={styles.muted}>No phone has sent its update yet.</Text>
            )}
            <View style={styles.bar}>
              <View style={[styles.barFill, { flex: latest }]} />
              <View style={{ flex: Math.max(0, total - latest) }} />
            </View>
            {oldIds.length > 0 && (
              <Pressable
                onPress={() =>
                  ask(oldIds, `${oldIds.length} ${oldIds.length === 1 ? 'person' : 'people'} on an old update`)
                }
                style={styles.askAll}
                disabled={asking != null}
                accessibilityRole="button"
              >
                <Text style={styles.askAllText}>
                  {asking === 'all' ? 'Sending…' : `🔔 Ask all ${oldIds.length} on an old update`}
                </Text>
              </Pressable>
            )}
          </View>

          {/* Filter */}
          <View style={styles.chips}>
            {(
              [
                ['all', 'All'],
                ['old', 'Old update'],
                ['never', 'Not opened yet'],
              ] as [Filter, string][]
            ).map(([k, label]) => (
              <Pressable
                key={k}
                onPress={() => setFilter(k)}
                style={[styles.chip, filter === k && styles.chipOn]}
                accessibilityRole="radio"
                accessibilityState={{ selected: filter === k }}
              >
                <Text style={[styles.chipText, filter === k && styles.chipTextOn]}>{label}</Text>
              </Pressable>
            ))}
          </View>

          {/* People and phones */}
          <View style={styles.list}>
            {shown.length === 0 && <Text style={styles.muted}>Nobody here.</Text>}
            {shown.map((r, i) => {
              const b = BADGE[r.state];
              return (
                <View key={`${r.userId}-${r.device ?? i}`} style={[styles.row, i > 0 && styles.divider]}>
                  <View style={styles.flex}>
                    <View style={styles.nameRow}>
                      <Text style={styles.name} numberOfLines={1}>
                        {r.name}
                      </Text>
                      <View style={[styles.badge, { backgroundColor: b.bg }]}>
                        <Text style={[styles.badgeText, { color: b.color }]}>{b.text}</Text>
                      </View>
                    </View>
                    {r.lastSeen ? (
                      <>
                        <Text style={styles.line}>
                          {r.device?.startsWith('🌐') ? r.device : `📱 ${r.device ?? 'Phone'}`}
                          {r.build ? ` · build ${r.build}` : ''}
                        </Text>
                        <Text style={styles.line}>
                          🔄 {r.updateId ? `${when(r.updateAt)} · ` : 'Built in (no update yet)'}
                          {r.updateId && <Text style={styles.mono}>{shortId(r.updateId)}</Text>}
                        </Text>
                        <Text style={styles.small}>Last opened {ago(r.lastSeen)}</Text>
                      </>
                    ) : (
                      <Text style={styles.small}>{r.role ? `${r.role} · ` : ''}has not opened the new app yet</Text>
                    )}
                  </View>
                  {(r.state === 'old' || r.state === 'builtin') && (
                    <Pressable
                      onPress={() => ask([r.userId], r.name)}
                      disabled={asking != null}
                      hitSlop={8}
                      style={styles.ask}
                      accessibilityRole="button"
                      accessibilityLabel={`Ask ${r.name} to update`}
                    >
                      <Text style={styles.askText}>{asking === r.userId ? '…' : '🔔'}</Text>
                    </Pressable>
                  )}
                </View>
              );
            })}
          </View>
          <Text style={styles.small}>
            A phone shows here after it opens this version of the app once. Pull down to refresh.
          </Text>
        </>
      )}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.background },
  content: { padding: spacing.lg, gap: spacing.md, paddingBottom: spacing.xxl },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: spacing.xl },
  flex: { flex: 1 },
  error: { fontSize: fontSize.small, color: colors.danger },
  card: {
    padding: spacing.lg,
    gap: spacing.xs,
    borderRadius: radius.lg,
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.border,
  },
  big: { fontSize: fontSize.title, fontWeight: fontWeight.bold, color: colors.text },
  muted: { fontSize: fontSize.small, color: colors.textMuted },
  small: { fontSize: fontSize.caption, color: colors.textMuted },
  mono: { fontFamily: 'monospace', fontWeight: fontWeight.semibold, color: colors.text },
  bar: {
    flexDirection: 'row',
    height: 8,
    borderRadius: 4,
    overflow: 'hidden',
    backgroundColor: colors.border,
    marginTop: spacing.sm,
  },
  barFill: { backgroundColor: colors.success },
  askAll: {
    marginTop: spacing.sm,
    alignSelf: 'flex-start',
    paddingVertical: 8,
    paddingHorizontal: spacing.md,
    borderRadius: radius.md,
    backgroundColor: colors.primary,
  },
  askAllText: { fontSize: fontSize.small, fontWeight: fontWeight.bold, color: colors.textOnPrimary },
  chips: { flexDirection: 'row', gap: spacing.sm, flexWrap: 'wrap' },
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
  list: {
    borderRadius: radius.lg,
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.border,
    paddingHorizontal: spacing.lg,
  },
  row: { flexDirection: 'row', alignItems: 'center', gap: spacing.md, paddingVertical: spacing.md },
  divider: { borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: colors.border },
  nameRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm, flexWrap: 'wrap' },
  name: { fontSize: fontSize.body, fontWeight: fontWeight.semibold, color: colors.text, flexShrink: 1 },
  badge: { paddingVertical: 2, paddingHorizontal: spacing.sm, borderRadius: radius.pill },
  badgeText: { fontSize: fontSize.caption, fontWeight: fontWeight.bold },
  line: { fontSize: fontSize.small, color: colors.text, marginTop: 2 },
  ask: {
    width: 40,
    height: 40,
    borderRadius: 20,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: colors.primarySoft,
  },
  askText: { fontSize: 18 },
});
