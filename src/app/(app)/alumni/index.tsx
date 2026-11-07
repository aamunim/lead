import { router, Stack, type Href } from 'expo-router';
import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  FlatList,
  Linking,
  Platform,
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
  alumniBulk,
  alumniSummary,
  listAlumni,
  listAlumniIds,
  type AlumniBulkAction,
  type AlumniQuery,
  type AlumniSort,
  type AlumniSummary,
  type Alumnus,
} from '@/features/alumni/api';
import { alumniChanged, Avatar, Chip, s as ui, useAlumniAccess, useAlumniVersion } from '@/features/alumni/ui';
import { MIcon, md, Tap, type MIconName } from '@/features/home/md';
import { openWhatsApp } from '@/features/leads/contact';
import { listCourses, type CourseWithDetails } from '@/features/settings/api';
import { isWeb } from '@/features/web/api';
import { colors, fontSize, fontWeight, radius, spacing } from '@/shared/theme';
import { Button } from '@/shared/ui/Button';
import { Modal } from '@/shared/ui/Modal';

// =====================================================================
// 🎓 Alumni: the list (Material 3, like a native Android app)
//   search · numbers · Referral inbox · filters · list · ＋ button
//   Long-press (or ☑ at the top) → mark → course / no course / delete
//   ⚡ Same requests as before: the list page, the numbers, the courses.
//   Marking asks the server nothing until an action is chosen.
// =====================================================================

const SHOW: { key: NonNullable<AlumniQuery['only']> | 'all'; label: string }[] = [
  { key: 'all', label: 'All' },
  { key: 'referred', label: 'Referred' },
  { key: 'never_contacted', label: 'Never contacted' },
  { key: 'no_course', label: 'No course' },
  { key: 'do_not_contact', label: 'Do not contact' },
];
const SORTS: { key: AlumniSort; label: string }[] = [
  { key: 'name', label: 'A–Z' },
  { key: 'referrals', label: 'Most referrals' },
  { key: 'admitted', label: 'Most admitted' },
  { key: 'quiet', label: 'Longest quiet' },
  { key: 'newest', label: 'Newest' },
];

function confirm(title: string, text: string, ok: string): Promise<boolean> {
  if (Platform.OS === 'web') return Promise.resolve(window.confirm(`${title}\n\n${text}`));
  return new Promise((resolve) =>
    Alert.alert(title, text, [
      { text: 'Cancel', style: 'cancel', onPress: () => resolve(false) },
      { text: ok, style: 'destructive', onPress: () => resolve(true) },
    ]),
  );
}

function say(title: string, text: string) {
  if (Platform.OS === 'web') window.alert(`${title}\n\n${text}`);
  else Alert.alert(title, text);
}

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

  // ☑ Marking
  const [selecting, setSelecting] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);
  const [coursePicker, setCoursePicker] = useState(false);

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

  // A different filter: the marks stay only on what can still be seen
  useEffect(() => {
    setSelected(new Set());
  }, [query]);

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

  // --- marking -------------------------------------------------------------
  const toggle = useCallback((id: string) => {
    setSelected((now) => {
      const next = new Set(now);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);
  const startSelect = useCallback(
    (id?: string) => {
      if (!access.manage) return;
      setSelecting(true);
      if (id) toggle(id);
    },
    [access.manage, toggle],
  );
  const stopSelect = () => {
    setSelecting(false);
    setSelected(new Set());
  };
  const allLoaded = (rows ?? []).length > 0 && (rows ?? []).every((r) => selected.has(r.id));
  const selectAllMatching = async () => {
    setBusy(true);
    try {
      setSelected(new Set(await listAlumniIds(query)));
    } catch (e) {
      say('Could not mark', e instanceof Error ? e.message : 'Try again.');
    } finally {
      setBusy(false);
    }
  };

  const run = async (a: AlumniBulkAction, done: (n: number) => string) => {
    setBusy(true);
    try {
      const n = await alumniBulk([...selected], a);
      stopSelect();
      alumniChanged();
      say('Done', done(n));
    } catch (e) {
      say('Could not change', e instanceof Error ? e.message : 'Try again.');
    } finally {
      setBusy(false);
    }
  };
  const unassign = async () => {
    if (
      !(await confirm('Remove the course?', `${selected.size} marked alumni will have no course and batch.`, 'Remove'))
    )
      return;
    run({ action: 'unassign' }, (n) => `${n} alumni have no course now.`);
  };
  const remove = async () => {
    if (
      !(await confirm(
        `Delete ${selected.size} alumni?`,
        'They leave the alumni list. Leads they referred keep their history.',
        'Delete',
      ))
    )
      return;
    run({ action: 'delete' }, (n) => `${n} alumni deleted.`);
  };

  if (!access.view) {
    return (
      <View style={styles.center}>
        <Stack.Screen options={{ title: 'Alumni' }} />
        <View style={styles.emptyIcon}>
          <MIcon name="school" size={36} color={md.onPrimaryC} />
        </View>
        <Text style={ui.muted}>You don’t have access to Alumni. An admin can give it in Settings → Alumni.</Text>
      </View>
    );
  }

  const waiting = sum?.waiting ?? 0;

  const header = (
    <View style={styles.head}>
      {/* Search (Material search bar) */}
      <View style={styles.searchBar}>
        <MIcon name="search" size={22} color={colors.textMuted} />
        <TextInput
          value={search}
          onChangeText={setSearch}
          placeholder="Search name, phone, school, roll, code"
          placeholderTextColor={colors.textMuted}
          style={styles.searchInput}
          autoCorrect={false}
          accessibilityLabel="Search alumni"
        />
        {!!search && (
          <Tap onPress={() => setSearch('')} borderless label="Clear search">
            <MIcon name="close" size={20} color={colors.textMuted} />
          </Tap>
        )}
      </View>

      {/* Numbers (tonal tiles) */}
      {sum && (
        <View style={styles.tiles}>
          <Tile value={sum.alumni} label="Alumni" bg={md.primaryC} fg={md.onPrimaryC} icon="school" />
          <Tile
            value={sum.referrals_month}
            label={'Referred\nthis month'}
            bg={md.skyC}
            fg={md.onSkyC}
            icon="campaign"
          />
          <Tile value={sum.admitted_month} label={'Admitted\nthis month'} bg={md.okC} fg={md.onOkC} icon="verified" />
          {sum.rewards_due !== null && sum.rewards_due > 0 && (
            <Tile
              value={`৳${Math.round(sum.rewards_due)}`}
              label={'Rewards\ndue'}
              bg={md.goldC}
              fg={md.onGoldC}
              icon="payments"
            />
          )}
        </View>
      )}

      {/* Referral inbox */}
      <Tap
        onPress={() => router.push('/alumni/referrals' as Href)}
        style={[styles.inbox, waiting > 0 && styles.inboxOn]}
        label="Referral inbox"
      >
        <MIcon name="move-to-inbox" size={22} color={waiting > 0 ? md.onPrimaryC : colors.text} />
        <Text style={[styles.inboxText, waiting > 0 && styles.inboxTextOn]}>Referral inbox</Text>
        {waiting > 0 && (
          <View style={styles.badge}>
            <Text style={styles.badgeText}>{waiting} new</Text>
          </View>
        )}
        <MIcon name="chevron-right" size={22} color={waiting > 0 ? md.onPrimaryC : colors.textMuted} />
      </Tap>

      {/* Website: the actions here (the phone has them in the top bar / ＋ button) */}
      {isWeb && access.manage && (
        <View style={styles.webActions}>
          <Button title="＋ Add alumnus" onPress={() => router.push('/alumni/edit' as Href)} />
          <Button title="Import" variant="secondary" onPress={() => router.push('/alumni/import' as Href)} />
          <Button
            title={selecting ? 'Done' : 'Select'}
            variant="ghost"
            onPress={() => (selecting ? stopSelect() : startSelect())}
          />
        </View>
      )}

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
        <MIcon name="sort" size={20} color={colors.textMuted} />
        {SORTS.map((o) => (
          <Chip key={o.key} text={o.label} on={sort === o.key} onPress={() => setSort(o.key)} />
        ))}
      </ScrollView>

      <View style={styles.countRow}>
        <Text style={styles.count}>{rows === null ? '' : `${total} ${total === 1 ? 'alumnus' : 'alumni'}`}</Text>
        {selecting && total > (rows?.length ?? 0) && selected.size < total && (
          <Pressable onPress={selectAllMatching} disabled={busy} hitSlop={8} accessibilityRole="button">
            <Text style={styles.link}>Mark all {total}</Text>
          </Pressable>
        )}
      </View>
      {error && <Text style={ui.error}>{error}</Text>}
    </View>
  );

  return (
    <View style={styles.screen}>
      <Stack.Screen
        options={{
          headerShown: !isWeb,
          title: selecting ? `${selected.size} marked` : 'Alumni',
          // marking: a tonal bar (like Android's own "2 selected"); else the app's blue bar
          headerStyle: { backgroundColor: selecting ? md.primaryC : colors.primary },
          headerTintColor: selecting ? md.onPrimaryC : colors.textOnPrimary,
          headerLeft: selecting
            ? () => (
                <Tap onPress={stopSelect} borderless label="Stop marking" style={styles.headerBtn}>
                  <MIcon name="close" color={md.onPrimaryC} />
                </Tap>
              )
            : undefined,
          headerRight: () =>
            selecting ? (
              <Tap
                onPress={() => setSelected(allLoaded ? new Set() : new Set((rows ?? []).map((r) => r.id)))}
                borderless
                label={allLoaded ? 'Unmark all' : 'Mark all shown'}
                style={styles.headerBtn}
              >
                <MIcon name={allLoaded ? 'deselect' : 'select-all'} color={md.onPrimaryC} />
              </Tap>
            ) : access.manage ? (
              <View style={styles.headerRow}>
                <Tap
                  onPress={() => router.push('/alumni/import' as Href)}
                  borderless
                  label="Import"
                  style={styles.headerBtn}
                >
                  <MIcon name="file-download" color={colors.textOnPrimary} />
                </Tap>
                <Tap onPress={() => startSelect()} borderless label="Mark alumni" style={styles.headerBtn}>
                  <MIcon name="checklist" color={colors.textOnPrimary} />
                </Tap>
              </View>
            ) : null,
        }}
      />
      {rows === null && !error ? (
        <View style={styles.content}>
          {header}
          <ActivityIndicator color={colors.primary} style={styles.loader} />
        </View>
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
          extraData={selecting ? selected : null}
          initialNumToRender={12}
          windowSize={7}
          ListEmptyComponent={
            <View style={styles.empty}>
              <View style={styles.emptyIcon}>
                <MIcon name="school" size={36} color={md.onPrimaryC} />
              </View>
              <Text style={[ui.muted, styles.centerText]}>
                {search || only !== 'all' || courseId
                  ? 'Nobody matches.'
                  : access.manage
                    ? 'No alumni yet. Tap ＋ to add one, or Import: from Students (a whole batch), Excel or phone contacts.'
                    : 'No alumni yet.'}
              </Text>
            </View>
          }
          renderItem={({ item }) => (
            <AlumnusRow
              a={item}
              selecting={selecting}
              marked={selecting && selected.has(item.id)}
              onToggle={toggle}
              onLongPress={startSelect}
            />
          )}
        />
      )}

      {/* ＋ Add (Material FAB) */}
      {!isWeb && access.manage && !selecting && (
        <Pressable
          onPress={() => router.push('/alumni/edit' as Href)}
          android_ripple={{ color: md.ripple }}
          style={styles.fab}
          accessibilityRole="button"
          accessibilityLabel="Add an alumnus"
        >
          <MIcon name="person-add-alt-1" color={md.onPrimaryC} />
          <Text style={styles.fabText}>Add</Text>
        </Pressable>
      )}

      {/* ☑ Actions for the marked ones */}
      {selecting && (
        <View style={styles.actionBar}>
          {busy ? (
            <ActivityIndicator color={colors.primary} style={styles.flex} />
          ) : (
            <>
              <BarAction
                icon="school"
                label="Course"
                disabled={selected.size === 0}
                onPress={() => setCoursePicker(true)}
              />
              <BarAction icon="layers-clear" label="No course" disabled={selected.size === 0} onPress={unassign} />
              <BarAction icon="delete-outline" label="Delete" danger disabled={selected.size === 0} onPress={remove} />
            </>
          )}
        </View>
      )}

      {coursePicker && (
        <CoursePicker
          courses={courses}
          count={selected.size}
          onClose={() => setCoursePicker(false)}
          onPick={(c, b) => {
            setCoursePicker(false);
            const name = courses.find((x) => x.id === c)?.name ?? 'the course';
            run({ action: 'course', courseId: c, batchId: b }, (n) => `${n} alumni are in ${name} now.`);
          }}
        />
      )}
    </View>
  );
}

function Tile({
  value,
  label,
  bg,
  fg,
  icon,
}: {
  value: string | number;
  label: string;
  bg: string;
  fg: string;
  icon: MIconName;
}) {
  return (
    <View style={[styles.tile, { backgroundColor: bg }]}>
      <MIcon name={icon} size={18} color={fg} />
      <Text style={[styles.tileValue, { color: fg }]}>{value}</Text>
      <Text style={[styles.tileLabel, { color: fg }]} numberOfLines={2}>
        {label}
      </Text>
    </View>
  );
}

function BarAction({
  icon,
  label,
  onPress,
  disabled,
  danger,
}: {
  icon: MIconName;
  label: string;
  onPress: () => void;
  disabled?: boolean;
  danger?: boolean;
}) {
  const c = disabled ? colors.textMuted : danger ? colors.danger : colors.text;
  return (
    <Tap onPress={disabled ? undefined : onPress} style={styles.barAction} label={label}>
      <MIcon name={icon} color={c} />
      <Text style={[styles.barLabel, { color: c }]}>{label}</Text>
    </Tap>
  );
}

// ⚡ A row draws again only when its own data or mark changes
const AlumnusRow = memo(function AlumnusRow({
  a,
  selecting,
  marked,
  onToggle,
  onLongPress,
}: {
  a: Alumnus;
  selecting: boolean;
  marked: boolean;
  onToggle: (id: string) => void;
  onLongPress: (id: string) => void;
}) {
  const line = [a.batch_name ?? a.course_name, a.session, a.passing_year ? `Passed ${a.passing_year}` : null]
    .filter(Boolean)
    .join(' · ');
  const work = [a.designation, a.workplace, a.district].filter(Boolean).join(' · ');
  return (
    <Pressable
      onPress={() => (selecting ? onToggle(a.id) : router.push(`/alumni/${a.id}` as Href))}
      onLongPress={() => onLongPress(a.id)}
      delayLongPress={350}
      android_ripple={{ color: md.ripple }}
      style={({ pressed }) => [
        styles.item,
        marked && styles.itemOn,
        Platform.OS !== 'android' && pressed && styles.pressed,
        a.do_not_contact && styles.dnc,
      ]}
      accessibilityRole={selecting ? 'checkbox' : 'button'}
      accessibilityState={selecting ? { checked: marked } : undefined}
      accessibilityLabel={selecting ? a.name : `Open ${a.name}`}
    >
      {marked ? (
        <View style={styles.check}>
          <MIcon name="check" color={colors.textOnPrimary} />
        </View>
      ) : (
        <Avatar name={a.name} />
      )}
      <View style={styles.flex}>
        <View style={styles.nameRow}>
          <Text style={styles.name} numberOfLines={1}>
            {a.name}
          </Text>
          {a.do_not_contact && <MIcon name="do-not-disturb-on" size={16} color={colors.danger} />}
        </View>
        {!!line && (
          <Text style={styles.line} numberOfLines={1}>
            {line}
          </Text>
        )}
        {!!work && (
          <Text style={styles.line} numberOfLines={1}>
            {work}
          </Text>
        )}
        {(a.referrals > 0 || a.referred_admitted > 0) && (
          <View style={styles.badges}>
            {a.referrals > 0 && <Pill text={`${a.referrals} referred`} bg={md.skyC} fg={md.onSkyC} />}
            {a.referred_leads > 0 && <Pill text={`${a.referred_leads} leads`} bg={md.surface2} fg={colors.text} />}
            {a.referred_admitted > 0 && <Pill text={`${a.referred_admitted} admitted`} bg={md.okC} fg={md.onOkC} />}
            {a.referrals_waiting > 0 && (
              <Pill text={`${a.referrals_waiting} new`} bg={md.primaryC} fg={md.onPrimaryC} />
            )}
          </View>
        )}
      </View>
      {!selecting && !!a.phone && !a.do_not_contact && (
        <View style={styles.quick}>
          <Tap onPress={() => Linking.openURL(`tel:${a.phone}`)} style={styles.quickBtn} label={`Call ${a.name}`}>
            <MIcon name="call" size={20} color={md.onOkC} />
          </Tap>
          <Tap
            onPress={() => openWhatsApp({ phone: a.phone, whatsapp_number: a.whatsapp_number })}
            style={[styles.quickBtn, styles.quickWa]}
            label={`WhatsApp ${a.name}`}
          >
            <MIcon name="chat" size={20} color={md.onWaC} />
          </Tap>
        </View>
      )}
    </Pressable>
  );
});

function Pill({ text, bg, fg }: { text: string; bg: string; fg: string }) {
  return (
    <View style={[styles.pill, { backgroundColor: bg }]}>
      <Text style={[styles.pillText, { color: fg }]}>{text}</Text>
    </View>
  );
}

// 🎓 Choose the course (and, if wanted, the batch) for the marked ones
function CoursePicker({
  courses,
  count,
  onClose,
  onPick,
}: {
  courses: CourseWithDetails[];
  count: number;
  onClose: () => void;
  onPick: (courseId: string, batchId: string | null) => void;
}) {
  const [course, setCourse] = useState<string | null>(null);
  const [batch, setBatch] = useState<string | null>(null);
  const batches = courses.find((c) => c.id === course)?.batches ?? [];
  return (
    <Modal visible transparent animationType="slide" onRequestClose={onClose}>
      <Pressable style={styles.backdrop} onPress={onClose} accessibilityLabel="Close" />
      <View style={styles.sheet}>
        <View style={styles.handle} />
        <Text style={styles.sheetTitle}>Course for {count} alumni</Text>
        <ScrollView contentContainerStyle={styles.sheetBody}>
          {courses.length === 0 && <Text style={ui.muted}>No courses yet (Settings → Courses).</Text>}
          {courses.map((c) => {
            const on = course === c.id;
            return (
              <Tap
                key={c.id}
                onPress={() => {
                  setCourse(c.id);
                  setBatch(null);
                }}
                style={[styles.option, on && styles.optionOn]}
                label={c.name}
              >
                <MIcon
                  name={on ? 'radio-button-checked' : 'radio-button-unchecked'}
                  color={on ? colors.primary : colors.textMuted}
                />
                <Text style={styles.optionText}>{c.name}</Text>
              </Tap>
            );
          })}
          {batches.length > 0 && (
            <>
              <Text style={[ui.label, styles.batchLabel]}>BATCH (IF YOU WANT)</Text>
              <View style={ui.chips}>
                <Chip text="No batch" on={!batch} onPress={() => setBatch(null)} />
                {batches.map((b) => (
                  <Chip key={b.id} text={b.name} on={batch === b.id} onPress={() => setBatch(b.id)} />
                ))}
              </View>
            </>
          )}
        </ScrollView>
        <View style={styles.sheetButtons}>
          <View style={styles.flex}>
            <Button title="Cancel" variant="ghost" onPress={onClose} fullWidth />
          </View>
          <View style={styles.flex}>
            <Button title="Save" onPress={() => course && onPick(course, batch)} disabled={!course} fullWidth />
          </View>
        </View>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1 },
  screen: { flex: 1, backgroundColor: colors.background },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: spacing.xl, gap: spacing.md },
  centerText: { textAlign: 'center' },
  loader: { marginTop: spacing.xl },
  content: {
    paddingHorizontal: spacing.lg,
    paddingTop: spacing.sm,
    paddingBottom: 120,
    ...(isWeb ? { maxWidth: 900, width: '100%', alignSelf: 'center' } : {}),
  },
  head: { gap: spacing.md, marginBottom: spacing.sm },
  headerRow: { flexDirection: 'row' },
  headerBtn: { width: 44, height: 44, alignItems: 'center', justifyContent: 'center', borderRadius: 22 },
  searchBar: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    height: 52,
    paddingHorizontal: spacing.lg,
    borderRadius: 28,
    backgroundColor: md.surface2,
  },
  searchInput: { flex: 1, fontSize: fontSize.body, color: colors.text, paddingVertical: 0 },
  tiles: { flexDirection: 'row', gap: spacing.sm },
  tile: { flex: 1, padding: spacing.md, borderRadius: radius.lg, gap: 2 },
  tileValue: { fontSize: fontSize.title, fontWeight: fontWeight.bold },
  tileLabel: { fontSize: 11, fontWeight: fontWeight.medium, opacity: 0.85 },
  inbox: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
    height: 56,
    paddingHorizontal: spacing.lg,
    borderRadius: radius.lg,
    backgroundColor: md.surface1,
    overflow: 'hidden',
  },
  inboxOn: { backgroundColor: md.primaryC },
  inboxText: { flex: 1, fontSize: fontSize.body, fontWeight: fontWeight.semibold, color: colors.text },
  inboxTextOn: { color: md.onPrimaryC },
  badge: { paddingHorizontal: 8, paddingVertical: 2, borderRadius: radius.pill, backgroundColor: colors.primary },
  badgeText: { fontSize: fontSize.caption, fontWeight: fontWeight.bold, color: colors.textOnPrimary },
  webActions: { flexDirection: 'row', gap: spacing.sm, flexWrap: 'wrap' },
  row: { flexGrow: 0, flexShrink: 0, marginHorizontal: -spacing.lg },
  rowIn: { gap: spacing.sm, alignItems: 'center', paddingHorizontal: spacing.lg },
  countRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  count: { fontSize: fontSize.small, fontWeight: fontWeight.semibold, color: colors.textMuted },
  link: { fontSize: fontSize.small, fontWeight: fontWeight.bold, color: colors.primary },
  empty: { alignItems: 'center', padding: spacing.xl, gap: spacing.md },
  emptyIcon: {
    width: 72,
    height: 72,
    borderRadius: 36,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: md.primaryC,
  },
  // Material list item
  item: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.lg,
    paddingVertical: spacing.md,
    paddingHorizontal: spacing.sm,
    marginHorizontal: -spacing.sm,
    borderRadius: radius.md,
    overflow: 'hidden',
  },
  itemOn: { backgroundColor: md.primaryC },
  pressed: { backgroundColor: md.surface1 },
  dnc: { opacity: 0.6 },
  check: {
    width: 44,
    height: 44,
    borderRadius: 22,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: colors.primary,
  },
  nameRow: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  name: { flexShrink: 1, fontSize: fontSize.body, fontWeight: fontWeight.semibold, color: colors.text },
  line: { fontSize: fontSize.small, color: colors.textMuted, marginTop: 1 },
  badges: { flexDirection: 'row', flexWrap: 'wrap', gap: 6, marginTop: 6 },
  pill: { paddingHorizontal: 8, paddingVertical: 2, borderRadius: radius.sm },
  pillText: { fontSize: 11, fontWeight: fontWeight.semibold },
  quick: { flexDirection: 'row', gap: spacing.sm },
  quickBtn: {
    width: 40,
    height: 40,
    borderRadius: 20,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: md.okC,
    overflow: 'hidden',
  },
  quickWa: { backgroundColor: md.waC },
  fab: {
    position: 'absolute',
    right: spacing.lg,
    bottom: spacing.lg,
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    height: 56,
    paddingHorizontal: spacing.lg + 4,
    borderRadius: radius.lg,
    backgroundColor: md.primaryC,
    elevation: 3,
    shadowColor: '#000',
    shadowOpacity: 0.15,
    shadowRadius: 6,
    shadowOffset: { width: 0, height: 3 },
    overflow: 'hidden',
  },
  fabText: { fontSize: fontSize.body, fontWeight: fontWeight.semibold, color: md.onPrimaryC },
  // Bottom action bar while marking
  actionBar: {
    position: 'absolute',
    left: 0,
    right: 0,
    bottom: 0,
    flexDirection: 'row',
    paddingVertical: spacing.sm,
    paddingHorizontal: spacing.md,
    backgroundColor: md.surface2,
    borderTopLeftRadius: radius.lg,
    borderTopRightRadius: radius.lg,
    elevation: 8,
    minHeight: 72,
    alignItems: 'center',
  },
  barAction: {
    flex: 1,
    alignItems: 'center',
    gap: 4,
    paddingVertical: spacing.sm,
    borderRadius: radius.md,
    overflow: 'hidden',
  },
  barLabel: { fontSize: fontSize.caption, fontWeight: fontWeight.semibold },
  // Bottom sheet
  backdrop: { flex: 1, backgroundColor: 'rgba(0,0,0,0.35)' },
  sheet: {
    maxHeight: '80%',
    paddingBottom: spacing.lg,
    backgroundColor: colors.surface,
    borderTopLeftRadius: 28,
    borderTopRightRadius: 28,
    ...(isWeb ? { width: '100%', maxWidth: 520, alignSelf: 'center' } : {}),
  },
  handle: {
    alignSelf: 'center',
    width: 32,
    height: 4,
    borderRadius: 2,
    backgroundColor: md.outline,
    marginTop: spacing.md,
  },
  sheetTitle: {
    fontSize: fontSize.title,
    fontWeight: fontWeight.bold,
    color: colors.text,
    paddingHorizontal: spacing.xl,
    paddingTop: spacing.lg,
    paddingBottom: spacing.sm,
  },
  sheetBody: { paddingHorizontal: spacing.lg, gap: 2 },
  option: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
    paddingVertical: spacing.md,
    paddingHorizontal: spacing.md,
    borderRadius: radius.md,
    overflow: 'hidden',
  },
  optionOn: { backgroundColor: md.primaryC },
  optionText: { flex: 1, fontSize: fontSize.body, color: colors.text },
  batchLabel: { marginTop: spacing.md, marginBottom: spacing.xs, paddingHorizontal: spacing.xs },
  sheetButtons: { flexDirection: 'row', gap: spacing.sm, paddingHorizontal: spacing.lg, paddingTop: spacing.md },
});
