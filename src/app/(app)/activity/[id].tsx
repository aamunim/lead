import { Stack, router, useLocalSearchParams, type Href } from 'expo-router';
import { useCallback, useEffect, useState } from 'react';
import { Pressable, RefreshControl, ScrollView, StyleSheet, Text, View } from 'react-native';

import { ActivityFeedList } from '@/features/activity/ActivityFeedList';
import {
  ACTIVITY_PERIODS,
  FEED_PAGE,
  activityRange,
  formatDuration,
  listActivityFeed,
  listTeamActivity,
  listUserDays,
  listUserSessions,
  type ActivityDay,
  type ActivityPeriod,
  type AppSession,
  type FeedItem,
  type TeamMember,
} from '@/features/activity/api';
import { useActivityLookups } from '@/features/activity/useLookups';
import { colors, fontSize, fontWeight, radius, spacing } from '@/shared/theme';

// =====================================================================
// 🧑 One person's activity: summary, app sessions, 14 days, changes
// =====================================================================

const clock = (iso: string) => new Date(iso).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
const shortDay = (iso: string) => new Date(iso).toLocaleDateString([], { day: 'numeric', month: 'short' });

export default function UserActivityScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const { stages, userNames } = useActivityLookups();

  const [period, setPeriod] = useState<ActivityPeriod>('today');
  const [member, setMember] = useState<TeamMember | null>(null);
  const [days, setDays] = useState<ActivityDay[]>([]);
  const [sessions, setSessions] = useState<AppSession[]>([]);
  const [items, setItems] = useState<FeedItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [hasMore, setHasMore] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!id) return;
    const { from, to } = activityRange(period);
    try {
      setError(null);
      const [team, d, s, feed] = await Promise.all([
        listTeamActivity(from, to),
        listUserDays(id, 14),
        listUserSessions(id, from, to),
        listActivityFeed({ from, to, userId: id }),
      ]);
      setMember(team.find((m) => m.user_id === id) ?? null);
      setDays(d);
      setSessions(s);
      setItems(feed);
      setHasMore(feed.length === FEED_PAGE);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not load the activity.');
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, [id, period]);

  useEffect(() => {
    setLoading(true);
    load();
  }, [load]);

  const loadMore = async () => {
    const last = items[items.length - 1];
    if (!last || !id) return;
    setLoadingMore(true);
    try {
      const rows = await listActivityFeed({ ...activityRange(period), userId: id, before: last.created_at });
      setItems((now) => [...now, ...rows.filter((r) => !now.some((x) => x.id === r.id))]);
      setHasMore(rows.length === FEED_PAGE);
    } catch {
      setHasMore(false);
    } finally {
      setLoadingMore(false);
    }
  };

  const name = member?.name ?? userNames.get(String(id)) ?? 'Activity';
  const maxApp = Math.max(1, ...days.map((d) => d.app_sec));

  const header = (
    <View style={styles.header}>
      <ScrollView horizontal showsHorizontalScrollIndicator={false} style={styles.noShrink} contentContainerStyle={styles.chips}>
        {ACTIVITY_PERIODS.map((p) => {
          const on = period === p.value;
          return (
            <Pressable
              key={p.value}
              onPress={() => setPeriod(p.value)}
              style={[styles.chip, on && styles.chipOn]}
              accessibilityRole="button"
              accessibilityState={{ selected: on }}
            >
              <Text style={[styles.chipText, on && styles.chipTextOn]}>{p.label}</Text>
            </Pressable>
          );
        })}
      </ScrollView>

      {error && <Text style={styles.error}>{error}</Text>}

      {/* Summary */}
      {member && (
        <View style={styles.card}>
          <View style={styles.tiles}>
            <Tile value={formatDuration(member.app_sec)} label="in the app" />
            <Tile value={String(member.sessions)} label="sessions" />
            <Tile value={String(member.calls)} label="calls" />
            <Tile
              value={member.calls > 0 ? `${Math.round((member.connected / member.calls) * 100)}%` : '—'}
              label="answered"
            />
            <Tile value={formatDuration(member.talk_sec)} label="talk time" />
            <Tile value={String(member.wa_calls ?? 0)} label="💬 WA calls" />
            <Tile value={String(member.wa_messages ?? 0)} label="💬 WA messages" />
            <Tile value={String(member.actions)} label="changes" />
            <Tile value={String(member.admitted)} label="admitted" />
          </View>
          <Text style={styles.hint}>
            App time counts only while the app is open and being used; it stops after a few minutes without a touch.
          </Text>
        </View>
      )}

      {/* Last 14 days */}
      {days.length > 0 && (
        <View style={styles.card}>
          <Text style={styles.cardTitle}>Last 14 days · app time</Text>
          {days
            .slice()
            .reverse()
            .map((d) => (
              <View key={d.day} style={styles.dayRow} accessible accessibilityLabel={`${shortDay(d.day)}: ${formatDuration(d.app_sec)} in the app, ${d.calls} calls, ${d.actions} changes`}>
                <Text style={styles.dayLabel}>{shortDay(d.day)}</Text>
                <View style={styles.track}>
                  <View style={[styles.bar, { width: `${Math.max((d.app_sec / maxApp) * 100, d.app_sec > 0 ? 2 : 0)}%` }]} />
                </View>
                <Text style={styles.dayValue}>{formatDuration(d.app_sec)}</Text>
                <Text style={styles.dayMeta}>
                  📞{d.calls}
                  {d.wa ? ` 💬${d.wa}` : ''} ✎{d.actions}
                </Text>
              </View>
            ))}
        </View>
      )}

      {/* App sessions */}
      <View style={styles.card}>
        <Text style={styles.cardTitle}>App sessions</Text>
        {sessions.length === 0 ? (
          <Text style={styles.hint}>No app time in this period.</Text>
        ) : (
          sessions.map((s) => (
            <View key={s.id} style={styles.sessionRow}>
              <Text style={styles.sessionTime}>
                {period === 'today' || period === 'yesterday' ? '' : `${shortDay(s.started_at)} · `}
                {clock(s.started_at)} – {s.ended ? clock(s.last_seen_at) : 'now'}
              </Text>
              <Text style={styles.sessionDur}>{formatDuration(s.active_sec)}</Text>
              <Text style={styles.sessionDevice} numberOfLines={1}>
                {[s.device_label, s.app_version ? `v${s.app_version}` : null].filter(Boolean).join(' · ')}
              </Text>
            </View>
          ))
        )}
      </View>

      <View style={styles.feedTitleRow}>
        <Text style={styles.cardTitle}>Changes</Text>
        <Pressable
          onPress={() => router.push({ pathname: '/changes', params: { userId: String(id) } } as unknown as Href)}
          hitSlop={8}
          accessibilityRole="button"
        >
          <Text style={styles.link}>Filter in Change log ›</Text>
        </Pressable>
      </View>
    </View>
  );

  return (
    <View style={styles.screen}>
      <Stack.Screen options={{ title: name }} />
      <ActivityFeedList
        items={items}
        stages={stages}
        userNames={userNames}
        showUser={false}
        loading={loading}
        loadingMore={loadingMore}
        hasMore={hasMore}
        onLoadMore={loadMore}
        header={header}
        empty="No changes in this period."
        refreshControl={
          <RefreshControl
            refreshing={refreshing}
            onRefresh={() => {
              setRefreshing(true);
              load();
            }}
          />
        }
      />
    </View>
  );
}

function Tile({ value, label }: { value: string; label: string }) {
  return (
    <View style={styles.tile}>
      <Text style={styles.tileValue}>{value}</Text>
      <Text style={styles.tileLabel}>{label}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.background },
  header: { gap: spacing.md, marginBottom: spacing.sm },
  noShrink: { flexGrow: 0, flexShrink: 0 },
  chips: { flexDirection: 'row', gap: spacing.sm, paddingRight: spacing.xl },
  chip: {
    minHeight: 34,
    justifyContent: 'center',
    paddingHorizontal: spacing.md,
    borderRadius: radius.pill,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.surface,
  },
  chipOn: { backgroundColor: colors.text, borderColor: colors.text },
  chipText: { fontSize: fontSize.small, fontWeight: fontWeight.semibold, color: colors.textMuted },
  chipTextOn: { color: colors.surface },
  error: { fontSize: fontSize.small, color: colors.danger },
  card: {
    gap: spacing.sm,
    padding: spacing.lg,
    borderRadius: radius.lg,
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.border,
  },
  cardTitle: { fontSize: fontSize.body, fontWeight: fontWeight.bold, color: colors.text },
  hint: { fontSize: fontSize.caption, lineHeight: 18, color: colors.textMuted },
  tiles: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.sm },
  tile: { flexGrow: 1, flexBasis: '28%', padding: spacing.sm, borderRadius: radius.md, backgroundColor: colors.background, alignItems: 'center' },
  tileValue: { fontSize: fontSize.body, fontWeight: fontWeight.bold, color: colors.text },
  tileLabel: { fontSize: 11, color: colors.textMuted },
  dayRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm },
  dayLabel: { width: 48, fontSize: fontSize.caption, color: colors.textMuted },
  track: { flex: 1, height: 8, borderRadius: 4, backgroundColor: colors.border, overflow: 'hidden' },
  bar: { height: 8, borderRadius: 4, backgroundColor: colors.primary },
  dayValue: { width: 52, fontSize: fontSize.caption, fontWeight: fontWeight.bold, color: colors.text, textAlign: 'right' },
  dayMeta: { width: 70, fontSize: 11, color: colors.textMuted, textAlign: 'right' },
  sessionRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm, paddingVertical: 4, borderTopWidth: 1, borderTopColor: colors.border },
  sessionTime: { fontSize: fontSize.small, color: colors.text },
  sessionDur: { fontSize: fontSize.small, fontWeight: fontWeight.bold, color: colors.text },
  sessionDevice: { flex: 1, fontSize: 11, color: colors.textMuted, textAlign: 'right' },
  feedTitleRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginTop: spacing.sm },
  link: { fontSize: fontSize.small, fontWeight: fontWeight.bold, color: colors.primary },
});
