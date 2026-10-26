import Ionicons from '@expo/vector-icons/Ionicons';
import { Stack, useLocalSearchParams } from 'expo-router';
import { useCallback, useEffect, useRef, useState } from 'react';
import {
  Modal,
  Pressable,
  RefreshControl,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';

import { useAuth } from '@/features/auth/AuthProvider';
import { ActivityFeedList } from '@/features/activity/ActivityFeedList';
import {
  ACTIVITY_PERIODS,
  CHANGE_KINDS,
  activityRange,
  canOpenActivity,
  countActivity,
  getActivitySettings,
  listActivityFeed,
  FEED_PAGE,
  type ActivityPeriod,
  type ChangeKind,
  type FeedItem,
} from '@/features/activity/api';
import { useActivityLookups } from '@/features/activity/useLookups';
import { colors, fontSize, fontWeight, radius, spacing } from '@/shared/theme';

// =====================================================================
// 📜 Change log: who changed what on which lead
// =====================================================================
export default function ChangeLogScreen() {
  const { hasPermission } = useAuth();
  const { userId: userParam } = useLocalSearchParams<{ userId?: string }>();
  const { stages, people, userNames } = useActivityLookups();

  const [allowed, setAllowed] = useState<boolean | null>(null);
  const [period, setPeriod] = useState<ActivityPeriod>('today');
  const [userId, setUserId] = useState<string | null>(userParam ? String(userParam) : null);
  const [kinds, setKinds] = useState<Set<ChangeKind>>(new Set());
  const [search, setSearch] = useState('');
  const [debounced, setDebounced] = useState('');
  const [picker, setPicker] = useState(false);

  const [items, setItems] = useState<FeedItem[]>([]);
  const [counts, setCounts] = useState<Map<string, number>>(new Map());
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [hasMore, setHasMore] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const request = useRef(0);

  useEffect(() => {
    getActivitySettings().then((s) => setAllowed(canOpenActivity(s, hasPermission)));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    const t = setTimeout(() => setDebounced(search), 350);
    return () => clearTimeout(t);
  }, [search]);

  const actions = CHANGE_KINDS.filter((k) => kinds.has(k.kind)).flatMap((k) => k.actions);
  const actionsKey = actions.join(',');

  const load = useCallback(async () => {
    const mine = ++request.current;
    const q = { ...activityRange(period), userId, actions, search: debounced };
    try {
      setError(null);
      const [rows, c] = await Promise.all([listActivityFeed(q), countActivity(q)]);
      if (mine !== request.current) return;
      setItems(rows);
      setCounts(c);
      setHasMore(rows.length === FEED_PAGE);
    } catch (e) {
      if (mine === request.current) setError(e instanceof Error ? e.message : 'Could not load the changes.');
    } finally {
      if (mine === request.current) {
        setLoading(false);
        setRefreshing(false);
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [period, userId, actionsKey, debounced]);

  useEffect(() => {
    if (!allowed) return;
    setLoading(true);
    load();
  }, [allowed, load]);

  const loadMore = async () => {
    const last = items[items.length - 1];
    if (!last) return;
    setLoadingMore(true);
    try {
      const rows = await listActivityFeed({
        ...activityRange(period),
        userId,
        actions,
        search: debounced,
        before: last.created_at,
      });
      setItems((now) => [...now, ...rows.filter((r) => !now.some((x) => x.id === r.id))]);
      setHasMore(rows.length === FEED_PAGE);
    } catch {
      setHasMore(false);
    } finally {
      setLoadingMore(false);
    }
  };

  const toggleKind = (k: ChangeKind) =>
    setKinds((now) => {
      const next = new Set(now);
      if (next.has(k)) next.delete(k);
      else next.add(k);
      return next;
    });

  if (allowed === false) {
    return (
      <View style={styles.center}>
        <Stack.Screen options={{ title: 'Change log' }} />
        <Text style={styles.muted}>Only admins and Team Leads can see the change log. (Settings → Team activity)</Text>
      </View>
    );
  }

  const total = [...counts.values()].reduce((s, n) => s + n, 0);
  const personName = userId ? userNames.get(userId) ?? 'One person' : 'Everyone';

  const header = (
    <View style={styles.header}>
      {/* Period */}
      <ScrollView horizontal showsHorizontalScrollIndicator={false} style={styles.noShrink} contentContainerStyle={styles.chips}>
        {ACTIVITY_PERIODS.map((p) => (
          <Chip key={p.value} label={p.label} on={period === p.value} onPress={() => setPeriod(p.value)} />
        ))}
      </ScrollView>

      {/* Person + search */}
      <View style={styles.row}>
        <Pressable
          onPress={() => setPicker(true)}
          style={({ pressed }) => [styles.pick, !!userId && styles.pickOn, pressed && styles.pressed]}
          accessibilityRole="button"
        >
          <Ionicons name="person" size={14} color={userId ? colors.primary : colors.textMuted} />
          <Text style={[styles.pickText, !!userId && styles.pickTextOn]} numberOfLines={1}>
            {personName}
          </Text>
          <Ionicons name="chevron-down" size={12} color={userId ? colors.primary : colors.textMuted} />
        </Pressable>
        <View style={styles.searchBox}>
          <Ionicons name="search" size={14} color={colors.textMuted} />
          <TextInput
            value={search}
            onChangeText={setSearch}
            placeholder="Lead name or phone"
            placeholderTextColor={colors.textMuted}
            style={styles.search}
            autoCorrect={false}
          />
        </View>
      </View>

      {/* Kinds with counts (tap to filter) */}
      <Text style={styles.total}>
        {total} {total === 1 ? 'change' : 'changes'}
        {kinds.size > 0 ? ' · tap a kind again to remove it' : ''}
      </Text>
      <View style={styles.kinds}>
        {CHANGE_KINDS.map((k) => {
          const n = k.actions.reduce((s, a) => s + (counts.get(a) ?? 0), 0);
          if (n === 0 && !kinds.has(k.kind)) return null;
          return (
            <Chip
              key={k.kind}
              label={`${k.icon} ${k.label} ${n}`}
              on={kinds.has(k.kind)}
              onPress={() => toggleKind(k.kind)}
            />
          );
        })}
      </View>
      {error && <Text style={styles.error}>{error}</Text>}
    </View>
  );

  return (
    <View style={styles.screen}>
      <Stack.Screen options={{ title: 'Change log' }} />
      <ActivityFeedList
        items={items}
        stages={stages}
        userNames={userNames}
        showUser={!userId}
        loading={loading || allowed === null}
        loadingMore={loadingMore}
        hasMore={hasMore}
        onLoadMore={loadMore}
        header={header}
        empty="No changes for these choices."
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

      <Modal visible={picker} transparent animationType="slide" onRequestClose={() => setPicker(false)}>
        <View style={styles.backdrop}>
          <Pressable style={styles.flex} onPress={() => setPicker(false)} accessibilityLabel="Close" />
          <View style={styles.sheet}>
            <View style={styles.handle} />
            <Text style={styles.sheetTitle}>Whose changes?</Text>
            <ScrollView contentContainerStyle={styles.sheetList}>
              {[{ id: '', name: 'Everyone' }, ...people].map((p) => {
                const on = (p.id || null) === userId;
                return (
                  <Pressable
                    key={p.id || 'all'}
                    onPress={() => {
                      setUserId(p.id || null);
                      setPicker(false);
                    }}
                    style={({ pressed }) => [styles.sheetRow, on && styles.sheetRowOn, pressed && styles.pressed]}
                    accessibilityRole="radio"
                    accessibilityState={{ checked: on }}
                  >
                    <Text style={[styles.sheetRowText, on && styles.sheetRowTextOn]}>{p.name}</Text>
                    {on && <Text style={styles.tick}>✓</Text>}
                  </Pressable>
                );
              })}
            </ScrollView>
          </View>
        </View>
      </Modal>
    </View>
  );
}

function Chip({ label, on, onPress }: { label: string; on: boolean; onPress: () => void }) {
  return (
    <Pressable
      onPress={onPress}
      style={[styles.chip, on && styles.chipOn]}
      accessibilityRole="button"
      accessibilityState={{ selected: on }}
    >
      <Text style={[styles.chipText, on && styles.chipTextOn]}>{label}</Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1 },
  screen: { flex: 1, backgroundColor: colors.background },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: spacing.xl, backgroundColor: colors.background },
  muted: { fontSize: fontSize.small, color: colors.textMuted, textAlign: 'center' },
  pressed: { opacity: 0.7 },
  error: { fontSize: fontSize.small, color: colors.danger },
  header: { gap: spacing.sm, marginBottom: spacing.sm },
  noShrink: { flexGrow: 0, flexShrink: 0 },
  chips: { flexDirection: 'row', gap: spacing.sm, paddingRight: spacing.xl },
  kinds: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.sm },
  chip: {
    minHeight: 32,
    justifyContent: 'center',
    paddingHorizontal: spacing.md,
    borderRadius: radius.pill,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.surface,
  },
  chipOn: { backgroundColor: colors.text, borderColor: colors.text },
  chipText: { fontSize: fontSize.caption, fontWeight: fontWeight.semibold, color: colors.textMuted },
  chipTextOn: { color: colors.surface },
  row: { flexDirection: 'row', gap: spacing.sm },
  pick: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    maxWidth: '45%',
    minHeight: 38,
    paddingHorizontal: spacing.md,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.surface,
  },
  pickOn: { borderColor: colors.primary, backgroundColor: colors.primarySoft },
  pickText: { flexShrink: 1, fontSize: fontSize.small, fontWeight: fontWeight.semibold, color: colors.textMuted },
  pickTextOn: { color: colors.primary },
  searchBox: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    minHeight: 38,
    paddingHorizontal: spacing.md,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.surface,
  },
  search: { flex: 1, fontSize: fontSize.small, color: colors.text, paddingVertical: 0 },
  total: { fontSize: fontSize.caption, fontWeight: fontWeight.semibold, color: colors.textMuted },
  backdrop: { flex: 1, backgroundColor: 'rgba(0,0,0,0.4)' },
  sheet: {
    maxHeight: '75%',
    backgroundColor: colors.surface,
    borderTopLeftRadius: radius.lg,
    borderTopRightRadius: radius.lg,
  },
  handle: {
    alignSelf: 'center',
    width: 40,
    height: 4,
    borderRadius: radius.pill,
    backgroundColor: colors.border,
    marginTop: spacing.sm,
  },
  sheetTitle: {
    fontSize: fontSize.title,
    fontWeight: fontWeight.bold,
    color: colors.text,
    paddingHorizontal: spacing.lg,
    paddingTop: spacing.md,
  },
  sheetList: { padding: spacing.lg, gap: spacing.sm, paddingBottom: spacing.xxl },
  sheetRow: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: spacing.md,
    paddingHorizontal: spacing.md,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.border,
  },
  sheetRowOn: { borderColor: colors.primary, backgroundColor: colors.primarySoft },
  sheetRowText: { flex: 1, fontSize: fontSize.body, fontWeight: fontWeight.semibold, color: colors.text },
  sheetRowTextOn: { color: colors.primary },
  tick: { fontSize: fontSize.body, fontWeight: fontWeight.bold, color: colors.primary },
});
