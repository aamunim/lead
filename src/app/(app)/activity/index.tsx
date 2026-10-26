import { Stack, router, type Href } from 'expo-router';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { ActivityIndicator, Pressable, RefreshControl, ScrollView, StyleSheet, Text, View } from 'react-native';

import { useAuth } from '@/features/auth/AuthProvider';
import {
  ACTIVITY_PERIODS,
  DEFAULT_ACTIVITY,
  activityRange,
  canOpenActivity,
  formatDuration,
  getActivitySettings,
  listTeamActivity,
  type ActivityPeriod,
  type ActivitySettings,
  type TeamMember,
} from '@/features/activity/api';
import { getSetting } from '@/features/settings/api';
import { colors, fontSize, fontWeight, radius, spacing } from '@/shared/theme';

// =====================================================================
// 👥 Team activity: everyone I may see, for a day / week / month
// =====================================================================

type Sort = 'name' | 'app' | 'calls' | 'actions';
const SORTS: { value: Sort; label: string }[] = [
  { value: 'name', label: 'Name' },
  { value: 'app', label: 'App time' },
  { value: 'calls', label: 'Calls' },
  { value: 'actions', label: 'Work' },
];

const ONLINE_MS = 6 * 60 * 1000; // a ping every 5 minutes

function ago(iso: string | null): string {
  if (!iso) return 'Never opened';
  const ms = Date.now() - new Date(iso).getTime();
  if (ms < ONLINE_MS) return 'Online now';
  const min = Math.round(ms / 60000);
  if (min < 60) return `${min} min ago`;
  const h = Math.round(min / 60);
  if (h < 24) return `${h} h ago`;
  const d = Math.round(h / 24);
  return d === 1 ? 'Yesterday' : `${d} days ago`;
}

const clock = (iso: string | null) =>
  iso ? new Date(iso).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }) : '—';

/** Is it office time now? (Settings → Working days & hours; Mon = 1 … Sun = 7) */
function inOfficeHours(hours: { start: string; end: string } | null, days: number[] | null): boolean {
  if (!hours || !days) return false;
  const now = new Date();
  const iso = now.getDay() === 0 ? 7 : now.getDay();
  if (!days.includes(iso)) return false;
  const hm = now.getHours() * 60 + now.getMinutes();
  const toMin = (t: string) => {
    const [h, m] = t.split(':').map(Number);
    return h * 60 + (m || 0);
  };
  return hm >= toMin(hours.start) && hm <= toMin(hours.end);
}

export default function TeamActivityScreen() {
  const { hasPermission } = useAuth();
  const [settings, setSettings] = useState<ActivitySettings>(DEFAULT_ACTIVITY);
  const [allowed, setAllowed] = useState<boolean | null>(null);
  const [office, setOffice] = useState(false);

  const [period, setPeriod] = useState<ActivityPeriod>('today');
  const [sort, setSort] = useState<Sort>('name');
  const [rows, setRows] = useState<TeamMember[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    Promise.all([
      getActivitySettings(),
      getSetting<{ start: string; end: string }>('working_hours').catch(() => null),
      getSetting<number[]>('working_days').catch(() => null),
    ]).then(([s, hours, days]) => {
      setSettings(s);
      setAllowed(canOpenActivity(s, hasPermission));
      setOffice(inOfficeHours(hours, days));
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const load = useCallback(async () => {
    const { from, to } = activityRange(period);
    try {
      setError(null);
      setRows(await listTeamActivity(from, to));
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not load the activity.');
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, [period]);

  useEffect(() => {
    if (!allowed) return;
    setLoading(true);
    load();
  }, [allowed, load]);

  const sorted = useMemo(() => {
    const list = [...rows];
    switch (sort) {
      case 'app':
        return list.sort((a, b) => b.app_sec - a.app_sec);
      case 'calls':
        return list.sort((a, b) => b.calls - a.calls);
      case 'actions':
        return list.sort((a, b) => b.actions - a.actions);
      default:
        return list.sort((a, b) => (a.name ?? '').localeCompare(b.name ?? ''));
    }
  }, [rows, sort]);

  if (allowed === false) {
    return (
      <View style={styles.center}>
        <Stack.Screen options={{ title: 'Team activity' }} />
        <Text style={styles.muted}>Only admins and Team Leads can see team activity. (Settings → Team activity)</Text>
      </View>
    );
  }

  // ⚠ Today, in office hours: no work for a long time, or nothing yet
  const quietFor = (m: TeamMember): string | null => {
    if (period !== 'today' || !office) return null;
    const last = m.last_at ? new Date(m.last_at).getTime() : null;
    if (last === null) return 'No work today';
    const min = Math.round((Date.now() - last) / 60000);
    return min >= settings.alert_minutes ? `No work for ${formatDuration(min * 60)}` : null;
  };

  const totals = rows.reduce(
    (t, m) => ({ app: t.app + m.app_sec, calls: t.calls + m.calls, actions: t.actions + m.actions, admitted: t.admitted + m.admitted }),
    { app: 0, calls: 0, actions: 0, admitted: 0 },
  );

  return (
    <ScrollView
      style={styles.screen}
      contentContainerStyle={styles.content}
      refreshControl={
        <RefreshControl
          refreshing={refreshing}
          onRefresh={() => {
            setRefreshing(true);
            load();
          }}
        />
      }
    >
      <Stack.Screen options={{ title: 'Team activity' }} />

      <ScrollView horizontal showsHorizontalScrollIndicator={false} style={styles.noShrink} contentContainerStyle={styles.chips}>
        {ACTIVITY_PERIODS.map((p) => (
          <Chip key={p.value} label={p.label} on={period === p.value} onPress={() => setPeriod(p.value)} />
        ))}
      </ScrollView>

      <View style={styles.sortRow}>
        <Text style={styles.sortLabel}>Sort:</Text>
        {SORTS.map((s) => (
          <Pressable key={s.value} onPress={() => setSort(s.value)} hitSlop={6} accessibilityRole="button">
            <Text style={[styles.sortText, sort === s.value && styles.sortOn]}>{s.label}</Text>
          </Pressable>
        ))}
      </View>

      {!loading && rows.length > 0 && (
        <View style={styles.totals}>
          <Total value={formatDuration(totals.app)} label="app time" />
          <Total value={String(totals.calls)} label="calls" />
          <Total value={String(totals.actions)} label="changes" />
          <Total value={String(totals.admitted)} label="admitted" />
        </View>
      )}

      {error && <Text style={styles.error}>{error}</Text>}

      {loading || allowed === null ? (
        <ActivityIndicator size="large" color={colors.primary} style={styles.loader} />
      ) : sorted.length === 0 ? (
        <Text style={styles.muted}>No one to show.</Text>
      ) : (
        sorted.map((m) => {
          const online = !!m.last_seen_at && Date.now() - new Date(m.last_seen_at).getTime() < ONLINE_MS;
          const quiet = quietFor(m);
          return (
            <Pressable
              key={m.user_id}
              onPress={() => router.push(`/activity/${m.user_id}` as Href)}
              style={({ pressed }) => [styles.card, quiet && styles.cardQuiet, pressed && styles.pressed]}
              accessibilityRole="button"
              accessibilityLabel={`${m.name ?? 'No name'}, ${ago(m.last_seen_at)}${quiet ? `, ${quiet}` : ''}`}
            >
              <View style={styles.top}>
                <View style={[styles.dot, online ? styles.dotOn : styles.dotOff]} />
                <Text style={styles.name} numberOfLines={1}>
                  {m.name ?? 'No name'}
                </Text>
                <Text style={[styles.seen, online && styles.seenOn]}>{online ? '● Online now' : ago(m.last_seen_at)}</Text>
              </View>

              <View style={styles.stats}>
                <Stat value={formatDuration(m.app_sec)} label="app" />
                <Stat value={String(m.calls)} label="calls" />
                <Stat value={String(m.actions)} label="changes" />
                <Stat value={String(m.admitted)} label="🎓" />
              </View>

              <Text style={styles.meta}>
                {m.first_at ? `${clock(m.first_at)} → ${online ? 'now' : clock(m.last_at)}` : 'No work in this period'}
                {m.calls > 0 ? ` · ${Math.round((m.connected / m.calls) * 100)}% answered · ${formatDuration(m.talk_sec)} talk` : ''}
              </Text>
              {quiet && <Text style={styles.quiet}>⚠ {quiet}</Text>}
            </Pressable>
          );
        })
      )}

      <Pressable
        onPress={() => router.push('/changes' as Href)}
        style={({ pressed }) => [styles.link, pressed && styles.pressed]}
        accessibilityRole="button"
      >
        <Text style={styles.linkText}>📜 Change log: who changed what ›</Text>
      </Pressable>
    </ScrollView>
  );
}

function Chip({ label, on, onPress }: { label: string; on: boolean; onPress: () => void }) {
  return (
    <Pressable onPress={onPress} style={[styles.chip, on && styles.chipOn]} accessibilityRole="button" accessibilityState={{ selected: on }}>
      <Text style={[styles.chipText, on && styles.chipTextOn]}>{label}</Text>
    </Pressable>
  );
}

function Stat({ value, label }: { value: string; label: string }) {
  return (
    <View style={styles.stat}>
      <Text style={styles.statValue}>{value}</Text>
      <Text style={styles.statLabel}>{label}</Text>
    </View>
  );
}

function Total({ value, label }: { value: string; label: string }) {
  return (
    <View style={styles.total}>
      <Text style={styles.totalValue}>{value}</Text>
      <Text style={styles.statLabel}>{label}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.background },
  content: { padding: spacing.lg, gap: spacing.md, paddingBottom: spacing.xxl },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: spacing.xl, backgroundColor: colors.background },
  muted: { fontSize: fontSize.small, color: colors.textMuted, textAlign: 'center' },
  error: { fontSize: fontSize.small, color: colors.danger },
  loader: { paddingVertical: spacing.xxl },
  pressed: { opacity: 0.7 },
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
  sortRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.md },
  sortLabel: { fontSize: fontSize.caption, color: colors.textMuted },
  sortText: { fontSize: fontSize.caption, fontWeight: fontWeight.semibold, color: colors.textMuted },
  sortOn: { color: colors.primary, fontWeight: fontWeight.bold },
  totals: { flexDirection: 'row', gap: spacing.sm },
  total: { flex: 1, alignItems: 'center', paddingVertical: spacing.sm, borderRadius: radius.md, backgroundColor: colors.surface, borderWidth: 1, borderColor: colors.border },
  totalValue: { fontSize: fontSize.body, fontWeight: fontWeight.bold, color: colors.text },
  card: {
    gap: spacing.sm,
    padding: spacing.lg,
    borderRadius: radius.lg,
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.border,
  },
  cardQuiet: { borderColor: colors.warning },
  top: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm },
  dot: { width: 10, height: 10, borderRadius: radius.pill },
  dotOn: { backgroundColor: colors.success },
  dotOff: { backgroundColor: colors.border },
  name: { flex: 1, fontSize: fontSize.body, fontWeight: fontWeight.bold, color: colors.text },
  seen: { fontSize: fontSize.caption, color: colors.textMuted },
  seenOn: { color: colors.success, fontWeight: fontWeight.bold },
  stats: { flexDirection: 'row', gap: spacing.sm },
  stat: { flex: 1, alignItems: 'center', paddingVertical: spacing.xs, borderRadius: radius.md, backgroundColor: colors.background },
  statValue: { fontSize: fontSize.small, fontWeight: fontWeight.bold, color: colors.text },
  statLabel: { fontSize: 11, color: colors.textMuted },
  meta: { fontSize: fontSize.caption, color: colors.textMuted },
  quiet: { fontSize: fontSize.caption, fontWeight: fontWeight.bold, color: colors.warning },
  link: { paddingVertical: spacing.md, alignItems: 'center' },
  linkText: { fontSize: fontSize.small, fontWeight: fontWeight.bold, color: colors.primary },
});
