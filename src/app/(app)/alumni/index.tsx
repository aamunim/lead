import { router, Stack, type Href } from 'expo-router';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator,
  FlatList,
  Linking,
  Pressable,
  RefreshControl,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';

import {
  ALUMNI_PAGE,
  alumniSummary,
  listAlumni,
  type AlumniQuery,
  type AlumniSort,
  type AlumniSummary,
  type Alumnus,
} from '@/features/alumni/api';
import { Avatar, Chip, s as ui, Stat, useAlumniAccess, useAlumniVersion } from '@/features/alumni/ui';
import { openWhatsApp } from '@/features/leads/contact';
import { listCourses, type CourseWithDetails } from '@/features/settings/api';
import { isWeb } from '@/features/web/api';
import { colors, fontSize, fontWeight, radius, spacing } from '@/shared/theme';

// =====================================================================
// 🎓 Alumni: the list (search, filters, numbers, the referral inbox)
// =====================================================================

const SHOW: { key: NonNullable<AlumniQuery['only']> | 'all'; label: string }[] = [
  { key: 'all', label: 'All' },
  { key: 'referred', label: '📨 Referred' },
  { key: 'never_contacted', label: '🔕 Never contacted' },
  { key: 'do_not_contact', label: '⛔ Do not contact' },
];
const SORTS: { key: AlumniSort; label: string }[] = [
  { key: 'name', label: 'A–Z' },
  { key: 'referrals', label: 'Most referrals' },
  { key: 'admitted', label: 'Most admitted' },
  { key: 'quiet', label: 'Longest quiet' },
  { key: 'newest', label: 'Newest' },
];

export default function AlumniScreen() {
  const access = useAlumniAccess();
  const version = useAlumniVersion();
  const [search, setSearch] = useState('');
  const [only, setOnly] = useState<(typeof SHOW)[number]['key']>('all');
  const [sort, setSort] = useState<AlumniSort>('name');
  const [courseId, setCourseId] = useState<string | null>(null);
  const [batchId, setBatchId] = useState<string | null>(null);
  const [courses, setCourses] = useState<CourseWithDetails[]>([]);
  const [rows, setRows] = useState<Alumnus[] | null>(null);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(0);
  const [more, setMore] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [sum, setSum] = useState<AlumniSummary | null>(null);
  const reqId = useRef(0);

  useEffect(() => {
    listCourses()
      .then(setCourses)
      .catch(() => undefined);
  }, []);

  const query = useMemo<AlumniQuery>(
    () => ({ search, only: only === 'all' ? null : only, sort, courseId, batchId }),
    [search, only, sort, courseId, batchId],
  );

  const load = useCallback(
    async (p = 0) => {
      const id = ++reqId.current;
      try {
        const res = await listAlumni({ ...query, page: p });
        if (id !== reqId.current) return;
        setRows((old) => (p === 0 ? res.rows : [...(old ?? []), ...res.rows]));
        setTotal(res.total);
        setPage(p);
        setMore(res.rows.length === ALUMNI_PAGE);
        setError(null);
      } catch (e) {
        if (id === reqId.current) setError(e instanceof Error ? e.message : 'Could not load.');
      }
    },
    [query],
  );

  // search: wait until typing stops
  useEffect(() => {
    if (!access.view) return;
    const t = setTimeout(() => load(0), search ? 300 : 0);
    return () => clearTimeout(t);
  }, [load, access.view, version, search]);

  useEffect(() => {
    if (!access.view) return;
    alumniSummary()
      .then(setSum)
      .catch(() => undefined);
  }, [access.view, version]);

  const refresh = async () => {
    setRefreshing(true);
    await Promise.all([
      load(0),
      alumniSummary()
        .then(setSum)
        .catch(() => undefined),
    ]);
    setRefreshing(false);
  };

  const batches = useMemo(() => courses.find((c) => c.id === courseId)?.batches ?? [], [courses, courseId]);

  if (!access.view) {
    return (
      <View style={styles.center}>
        <Stack.Screen options={{ title: 'Alumni' }} />
        <Text style={styles.big}>🎓</Text>
        <Text style={ui.muted}>You don’t have access to Alumni. An admin can give it in Settings → Alumni.</Text>
      </View>
    );
  }

  const header = (
    <View style={styles.head}>
      {/* Numbers */}
      {sum && (
        <View style={styles.stats}>
          <Stat value={sum.alumni} label="Alumni" />
          <Stat value={sum.referrals_month} label={'Referrals\nthis month'} />
          <Stat value={sum.admitted_month} label={'Admitted\nthis month'} tint={colors.success} />
          {sum.rewards_due !== null && sum.rewards_due > 0 && (
            <Stat value={`৳${Math.round(sum.rewards_due)}`} label="Rewards due" tint={colors.warning} />
          )}
        </View>
      )}

      {/* Inbox + actions */}
      <View style={styles.actions}>
        <Pressable
          onPress={() => router.push('/alumni/referrals' as Href)}
          style={[styles.inbox, (sum?.waiting ?? 0) > 0 && styles.inboxOn]}
          accessibilityRole="button"
        >
          <Text style={[styles.inboxText, (sum?.waiting ?? 0) > 0 && styles.inboxTextOn]}>
            📨 Referral inbox{(sum?.waiting ?? 0) > 0 ? ` · ${sum?.waiting} new` : ''}
          </Text>
        </Pressable>
        {access.manage && (
          <>
            <Pressable
              onPress={() => router.push('/alumni/edit' as Href)}
              style={styles.action}
              accessibilityRole="button"
            >
              <Text style={styles.actionText}>＋ Add</Text>
            </Pressable>
            <Pressable
              onPress={() => router.push('/alumni/import' as Href)}
              style={styles.action}
              accessibilityRole="button"
            >
              <Text style={styles.actionText}>📥 Import</Text>
            </Pressable>
          </>
        )}
      </View>

      {/* Search */}
      <View style={styles.searchBox}>
        <Text style={styles.searchIcon}>🔍</Text>
        <TextInput
          value={search}
          onChangeText={setSearch}
          placeholder="Name, phone, school, roll or code"
          placeholderTextColor={colors.textMuted}
          style={styles.searchInput}
          autoCorrect={false}
          accessibilityLabel="Search alumni"
        />
        {!!search && (
          <Pressable onPress={() => setSearch('')} hitSlop={8} accessibilityLabel="Clear search">
            <Text style={ui.muted}>✕</Text>
          </Pressable>
        )}
      </View>

      {/* Filters */}
      <ScrollView
        horizontal
        showsHorizontalScrollIndicator={false}
        style={styles.row}
        contentContainerStyle={styles.rowIn}
      >
        {SHOW.map((o) => (
          <Chip key={o.key} text={o.label} on={only === o.key} onPress={() => setOnly(o.key)} />
        ))}
      </ScrollView>
      {courses.length > 0 && (
        <ScrollView
          horizontal
          showsHorizontalScrollIndicator={false}
          style={styles.row}
          contentContainerStyle={styles.rowIn}
        >
          <Chip
            text="All courses"
            on={!courseId}
            onPress={() => {
              setCourseId(null);
              setBatchId(null);
            }}
          />
          {courses.map((c) => (
            <Chip
              key={c.id}
              text={c.name}
              on={courseId === c.id}
              onPress={() => {
                setCourseId(courseId === c.id ? null : c.id);
                setBatchId(null);
              }}
            />
          ))}
        </ScrollView>
      )}
      {batches.length > 0 && (
        <ScrollView
          horizontal
          showsHorizontalScrollIndicator={false}
          style={styles.row}
          contentContainerStyle={styles.rowIn}
        >
          {batches.map((b) => (
            <Chip
              key={b.id}
              text={b.name}
              on={batchId === b.id}
              onPress={() => setBatchId(batchId === b.id ? null : b.id)}
            />
          ))}
        </ScrollView>
      )}
      <ScrollView
        horizontal
        showsHorizontalScrollIndicator={false}
        style={styles.row}
        contentContainerStyle={styles.rowIn}
      >
        <Text style={[ui.muted, styles.sortLabel]}>Sort:</Text>
        {SORTS.map((o) => (
          <Chip key={o.key} text={o.label} on={sort === o.key} onPress={() => setSort(o.key)} />
        ))}
      </ScrollView>
      <Text style={[ui.muted, styles.count]}>
        {rows === null ? '' : `${total} ${total === 1 ? 'alumnus' : 'alumni'}`}
      </Text>
      {error && <Text style={ui.error}>{error}</Text>}
    </View>
  );

  return (
    <View style={styles.screen}>
      <Stack.Screen options={{ title: 'Alumni', headerShown: !isWeb }} />
      {rows === null && !error ? (
        <>
          {header}
          <ActivityIndicator color={colors.primary} style={styles.loader} />
        </>
      ) : (
        <FlatList
          data={rows ?? []}
          keyExtractor={(a) => a.id}
          ListHeaderComponent={header}
          contentContainerStyle={styles.content}
          refreshControl={<RefreshControl refreshing={refreshing} onRefresh={refresh} />}
          keyboardShouldPersistTaps="handled"
          onEndReachedThreshold={0.4}
          onEndReached={() => more && load(page + 1)}
          ListEmptyComponent={
            <View style={styles.empty}>
              <Text style={styles.big}>🎓</Text>
              <Text style={ui.muted}>
                {search || only !== 'all' || courseId
                  ? 'Nobody matches.'
                  : access.manage
                    ? 'No alumni yet. Add one, or Import: from Students (a whole batch), Excel or phone contacts.'
                    : 'No alumni yet.'}
              </Text>
            </View>
          }
          renderItem={({ item }) => <AlumnusRow a={item} />}
        />
      )}
    </View>
  );
}

function AlumnusRow({ a }: { a: Alumnus }) {
  const line = [a.batch_name ?? a.course_name, a.session, a.passing_year ? `Passed ${a.passing_year}` : null]
    .filter(Boolean)
    .join(' · ');
  const work = [a.designation, a.workplace].filter(Boolean).join(', ');
  return (
    <Pressable
      onPress={() => router.push(`/alumni/${a.id}` as Href)}
      style={({ pressed }) => [styles.card, pressed && styles.pressed, a.do_not_contact && styles.dnc]}
      accessibilityRole="button"
      accessibilityLabel={`Open ${a.name}`}
    >
      <Avatar name={a.name} />
      <View style={styles.flex}>
        <Text style={styles.name} numberOfLines={1}>
          {a.name}
          {a.do_not_contact ? '  ⛔' : ''}
        </Text>
        {!!line && (
          <Text style={styles.line} numberOfLines={1}>
            🎓 {line}
          </Text>
        )}
        {!!work && (
          <Text style={styles.line} numberOfLines={1}>
            🏫 {work}
            {a.district ? ` · ${a.district}` : ''}
          </Text>
        )}
        {(a.referrals > 0 || a.referred_admitted > 0) && (
          <View style={styles.badges}>
            {a.referrals > 0 && <Text style={styles.badge}>📨 {a.referrals}</Text>}
            {a.referred_leads > 0 && <Text style={styles.badge}>🎯 {a.referred_leads} leads</Text>}
            {a.referred_admitted > 0 && (
              <Text style={[styles.badge, styles.badgeOk]}>🎉 {a.referred_admitted} admitted</Text>
            )}
            {a.referrals_waiting > 0 && <Text style={[styles.badge, styles.badgeNew]}>{a.referrals_waiting} new</Text>}
          </View>
        )}
      </View>
      {!!a.phone && !a.do_not_contact && (
        <View style={styles.quick}>
          <Pressable
            onPress={() => Linking.openURL(`tel:${a.phone}`)}
            style={styles.quickBtn}
            hitSlop={4}
            accessibilityLabel={`Call ${a.name}`}
          >
            <Text style={styles.quickIcon}>📞</Text>
          </Pressable>
          <Pressable
            onPress={() => openWhatsApp({ phone: a.phone, whatsapp_number: a.whatsapp_number })}
            style={styles.quickBtn}
            hitSlop={4}
            accessibilityLabel={`WhatsApp ${a.name}`}
          >
            <Text style={styles.quickIcon}>💬</Text>
          </Pressable>
        </View>
      )}
    </Pressable>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1 },
  screen: { flex: 1, backgroundColor: colors.background },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: spacing.xl, gap: spacing.sm },
  big: { fontSize: 44, textAlign: 'center' },
  loader: { marginTop: spacing.xl },
  content: {
    padding: spacing.lg,
    gap: spacing.sm,
    paddingBottom: spacing.xxl,
    ...(isWeb ? { maxWidth: 900, width: '100%', alignSelf: 'center' } : {}),
  },
  head: { gap: spacing.sm, marginBottom: spacing.xs },
  stats: {
    flexDirection: 'row',
    paddingVertical: spacing.md,
    borderRadius: radius.lg,
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.border,
  },
  actions: { flexDirection: 'row', gap: spacing.sm, flexWrap: 'wrap' },
  inbox: {
    flexGrow: 1,
    paddingVertical: spacing.sm + 2,
    paddingHorizontal: spacing.md,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.surface,
    alignItems: 'center',
  },
  inboxOn: { backgroundColor: colors.primary, borderColor: colors.primary },
  inboxText: { fontSize: fontSize.small, fontWeight: fontWeight.bold, color: colors.text },
  inboxTextOn: { color: colors.textOnPrimary },
  action: {
    paddingVertical: spacing.sm + 2,
    paddingHorizontal: spacing.md,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.surface,
  },
  actionText: { fontSize: fontSize.small, fontWeight: fontWeight.bold, color: colors.primary },
  searchBox: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    paddingHorizontal: spacing.md,
    borderRadius: radius.pill,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.surface,
  },
  searchIcon: { fontSize: 14 },
  searchInput: { flex: 1, paddingVertical: spacing.sm + 2, fontSize: fontSize.body, color: colors.text },
  row: { flexGrow: 0, flexShrink: 0 },
  rowIn: { gap: spacing.xs, alignItems: 'center', paddingVertical: 2 },
  sortLabel: { marginRight: 2 },
  count: { marginTop: 2 },
  empty: { alignItems: 'center', padding: spacing.xl, gap: spacing.sm },
  card: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
    padding: spacing.md,
    borderRadius: radius.lg,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.surface,
  },
  pressed: { opacity: 0.75 },
  dnc: { opacity: 0.7 },
  name: { fontSize: fontSize.body, fontWeight: fontWeight.bold, color: colors.text },
  line: { fontSize: fontSize.small, color: colors.textMuted, marginTop: 1 },
  badges: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.xs, marginTop: 4 },
  badge: {
    fontSize: fontSize.caption,
    fontWeight: fontWeight.semibold,
    color: colors.text,
    paddingHorizontal: 6,
    paddingVertical: 2,
    borderRadius: radius.sm,
    backgroundColor: colors.background,
    overflow: 'hidden',
  },
  badgeOk: { color: colors.success },
  badgeNew: { color: colors.textOnPrimary, backgroundColor: colors.primary },
  quick: { gap: spacing.xs },
  quickBtn: {
    width: 36,
    height: 36,
    borderRadius: 18,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: colors.background,
  },
  quickIcon: { fontSize: 16 },
});
