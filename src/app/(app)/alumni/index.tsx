import { router, Stack, useLocalSearchParams, type Href } from 'expo-router';
import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  FlatList,
  Platform,
  Pressable,
  RefreshControl,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  useWindowDimensions,
  View,
} from 'react-native';

import {
  ALL_ALUMNI_FILTERS,
  ALUMNI_PAGE,
  ALUMNI_SORTS,
  alumniBulk,
  alumniFilterValues,
  alumniMatchLine,
  alumniSummary,
  countAlumniFilters,
  deleteAlumniFilter,
  exportAlumni,
  getAlumniSettings,
  listAlumni,
  listAlumniFields,
  listAlumniIds,
  listAlumniSavedFilters,
  setAlumniNextContact,
  type AlumniBulkAction,
  type AlumniField,
  type AlumniFilterKey,
  type AlumniFilters,
  type AlumniQuery,
  type AlumniSavedFilter,
  type AlumniSort,
  type AlumniSummary,
  type Alumnus,
} from '@/features/alumni/api';
import { AlumniCoursePicker } from '@/features/alumni/AlumniCoursePicker';
import { AlumniFilterSheet } from '@/features/alumni/AlumniFilterSheet';
import { AlumniPeekSheet } from '@/features/alumni/AlumniPeekSheet';
import { useAlumniDialer } from '@/features/alumni/useAlumniDialer';
import { campaignDraft } from '@/features/alumni/draft';
import { MenuSheet, NextContactSheet, OwnerSheet, TextSheet, whenText } from '@/features/alumni/sheets';
import { alumniChanged, Avatar, Chip, s as ui, useAlumniAccess, useAlumniVersion } from '@/features/alumni/ui';
import { useAuth } from '@/features/auth/AuthProvider';
import { MIcon, md, Tap, type MIconName } from '@/features/home/md';
import { listAssignableUsers, type AssignableUser } from '@/features/leads/api';
import { listAlumniCourses, type CourseWithDetails } from '@/features/settings/api';
import { useSavedState } from '@/shared/lib/saved';
import { isWeb } from '@/features/web/api';
import { colors, fontSize, fontWeight, radius, spacing } from '@/shared/theme';
import { Button } from '@/shared/ui/Button';
import { Modal } from '@/shared/ui/Modal';

// =====================================================================
// 🎓 Alumni: the list (Material 3, like a native Android app)
//   search (name, numbers, workplace, place, tags, own fields…) · numbers ·
//   Referral inbox · quick chips · 🔍 Filter (every filter, saved filters)
//   · sort · list (next contact, last note) · ＋ button
//   Long-press (or ☑ at the top) → mark → note / next contact / tag /
//   looked after by / do not contact / course / delete
//   ⚡ The list page, the numbers and the courses; the filter sheet asks for
//   its choices only when it opens. Marking asks the server nothing until
//   an action is chosen.
// =====================================================================

const SHOW: { key: NonNullable<AlumniQuery['only']> | 'all'; label: string }[] = [
  { key: 'all', label: 'All' },
  { key: 'due', label: '⏰ Due today' },
  { key: 'call_week', label: '🎯 Call this week' },
  { key: 'referred', label: 'Referred' },
  { key: 'never_contacted', label: 'Never contacted' },
  { key: 'no_course', label: 'No course' },
  { key: 'do_not_contact', label: 'Do not contact' },
];
/** Next contact, grouped: Late / Today / Tomorrow / This week / Later / None */
function nextGroup(iso: string | null | undefined): string {
  if (!iso) return 'No next contact';
  const t = new Date(iso).getTime();
  const now = Date.now();
  const end = new Date();
  end.setHours(24, 0, 0, 0);
  if (t < now) return '⚠ Late';
  if (t < end.getTime()) return 'Today';
  if (t < end.getTime() + 86400000) return 'Tomorrow';
  if (t < end.getTime() + 6 * 86400000) return 'This week';
  return 'Later';
}

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
  const { profile } = useAuth();
  const [search, setSearch] = useState('');
  const [only, setOnly] = useState<(typeof SHOW)[number]['key']>('all');
  // 🏫 opened from Schools: the alumni of that school
  const { school, schoolName } = useLocalSearchParams<{ school?: string; schoolName?: string }>();
  // the sort and the filters stay as they were left (per phone)
  const [sort, setSort] = useSavedState<AlumniSort>('alumni:sort', 'name');
  const [filters, setFilters] = useSavedState<AlumniFilters>('alumni:filters', {});
  const [filterOpen, setFilterOpen] = useState(false);
  const [schoolLabel, setSchoolLabel] = useSavedState<string | null>('alumni:school', null);
  const [exporting, setExporting] = useState(false);
  // 👁 peek, and "next contact" for one alumnus from the peek
  const [peek, setPeek] = useState<Alumnus | null>(null);
  const dialer = useAlumniDialer();
  const [nextFor, setNextFor] = useState<Alumnus | null>(null);
  // 🌐 a wide browser window: a table (one line per alumnus)
  const { width } = useWindowDimensions();
  const table = isWeb && width >= 1000;
  const [saved, setSaved] = useState<AlumniSavedFilter[]>([]);
  const [order, setOrder] = useState<AlumniFilterKey[]>(ALL_ALUMNI_FILTERS);
  const [fields, setFields] = useState<AlumniField[]>([]);
  const [people, setPeople] = useState<AssignableUser[]>([]);
  const [tags, setTags] = useState<string[]>([]);
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
  const [sheet, setSheet] = useState<null | 'note' | 'next' | 'tag_add' | 'tag_remove' | 'owner' | 'more'>(null);

  useEffect(() => {
    listAlumniCourses()
      .then(setCourses)
      .catch(() => undefined);
    getAlumniSettings()
      .then((st) => setOrder(st.filters.filter((x) => x.enabled).map((x) => x.key)))
      .catch(() => undefined);
    listAlumniFields()
      .then(setFields)
      .catch(() => undefined);
    listAssignableUsers()
      .then(setPeople)
      .catch(() => undefined);
  }, []);

  const loadSaved = useCallback(() => {
    listAlumniSavedFilters()
      .then(setSaved)
      .catch(() => undefined);
  }, []);
  useEffect(() => {
    if (access.view) loadSaved();
  }, [access.view, loadSaved]);

  const query = useMemo<AlumniQuery>(
    () => ({ search, only: only === 'all' ? null : only, sort, filters }),
    [search, only, sort, filters],
  );
  const nFilters = countAlumniFilters(filters);
  const sorts = ALUMNI_SORTS.filter((o) => !o.manage || access.manage);

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

  useEffect(() => {
    if (typeof school !== 'string' || !school) return;
    setFilters({ workplaceKey: school });
    setSchoolLabel(typeof schoolName === 'string' && schoolName ? schoolName : 'School');
    setOnly('all');
    router.setParams({ school: undefined, schoolName: undefined });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [school]);
  useEffect(() => {
    if (!filters.workplaceKey) setSchoolLabel(null);
  }, [filters.workplaceKey]);

  // 📤 Excel: the marked ones, or everyone the list shows now
  const exportExcel = async (ids?: string[]) => {
    setExporting(true);
    try {
      const n = await exportAlumni(query, ids);
      if (Platform.OS === 'web') say('Done', `${n} alumni exported.`);
    } catch (e) {
      say('Could not export', e instanceof Error ? e.message : 'Try again.');
    } finally {
      setExporting(false);
    }
  };
  const startCampaign = () => {
    campaignDraft.set([...selected]);
    setSheet(null);
    stopSelect();
    router.push('/alumni/campaigns?new=1' as Href);
  };

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

  // --- marking -------------------------------------------------------------
  const toggle = useCallback((id: string) => {
    setSelected((now) => {
      const next = new Set(now);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);
  // anyone who sees alumni can mark (note, next contact); the rest needs "manage"
  const startSelect = useCallback(
    (id?: string) => {
      setSelecting(true);
      if (id) toggle(id);
    },
    [toggle],
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
  /** for the sheets: an error stays in the sheet */
  const runIn = async (a: AlumniBulkAction, done: (n: number) => string) => {
    const n = await alumniBulk([...selected], a);
    setSheet(null);
    stopSelect();
    alumniChanged();
    say('Done', done(n));
  };
  const openTagSheet = (kind: 'tag_add' | 'tag_remove') => {
    alumniFilterValues()
      .then((v) => setTags(v.tags))
      .catch(() => undefined);
    setSheet(kind);
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

  const manageItems: { label: string; icon: MIconName; danger?: boolean; onPress: () => void }[] = [
    { label: 'Remove a tag', icon: 'label-off', onPress: () => openTagSheet('tag_remove') },
    { label: 'Looked after by…', icon: 'person', onPress: () => setSheet('owner') },
    { label: 'Course & batch', icon: 'school', onPress: () => (setSheet(null), setCoursePicker(true)) },
    {
      label: 'Do not contact: on',
      icon: 'do-not-disturb-on',
      onPress: () => (setSheet(null), run({ action: 'dnc_on' }, (n) => `${n} alumni: do not contact.`)),
    },
    {
      label: 'Do not contact: off',
      icon: 'do-not-disturb-off',
      onPress: () => (setSheet(null), run({ action: 'dnc_off' }, (n) => `${n} alumni can be contacted.`)),
    },
    { label: 'Delete', icon: 'delete-outline', danger: true, onPress: () => (setSheet(null), remove()) },
  ];

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

      {/* More alumni screens */}
      <ScrollView
        horizontal
        showsHorizontalScrollIndicator={false}
        style={styles.row}
        contentContainerStyle={styles.rowIn}
      >
        <Shortcut icon="insights" label="Dashboard" to="/alumni/dashboard" />
        <Shortcut icon="emoji-events" label="Top referrers" to="/alumni/top" />
        <Shortcut icon="campaign" label="Campaigns" to="/alumni/campaigns" />
        <Shortcut icon="apartment" label="Schools" to="/alumni/schools" />
        {access.manage && <Shortcut icon="how-to-reg" label="Updates" to="/alumni/updates" />}
        {access.manage && <Shortcut icon="people-alt" label="Duplicates" to="/alumni/duplicates" />}
        <Tap onPress={() => !exporting && exportExcel()} style={styles.shortcut} label="Export to Excel">
          {exporting ? (
            <ActivityIndicator size="small" color={colors.primary} />
          ) : (
            <MIcon name="table-view" size={18} color={colors.text} />
          )}
          <Text style={styles.shortcutText}>Excel</Text>
        </Tap>
      </ScrollView>

      {/* Website: the actions here (the phone has them in the top bar / ＋ button) */}
      {isWeb && (
        <View style={styles.webActions}>
          {access.manage && <Button title="＋ Add alumnus" onPress={() => router.push('/alumni/edit' as Href)} />}
          {access.manage && (
            <Button title="Import" variant="secondary" onPress={() => router.push('/alumni/import' as Href)} />
          )}
          <Button
            title={selecting ? 'Done' : 'Select'}
            variant="ghost"
            onPress={() => (selecting ? stopSelect() : startSelect())}
          />
        </View>
      )}

      {/* Quick chips */}
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

      {/* 🔍 Filter + saved filters */}
      <ScrollView
        horizontal
        showsHorizontalScrollIndicator={false}
        style={styles.row}
        contentContainerStyle={styles.rowIn}
      >
        <Tap
          onPress={() => setFilterOpen(true)}
          style={[styles.filterBtn, nFilters > 0 && styles.filterBtnOn]}
          label="Filter alumni"
        >
          <MIcon name="tune" size={18} color={nFilters > 0 ? md.onPrimaryC : colors.text} />
          <Text style={[styles.filterText, nFilters > 0 && styles.filterTextOn]}>
            Filter{nFilters > 0 ? ` · ${nFilters}` : ''}
          </Text>
        </Tap>
        {!!filters.workplaceKey && (
          <Chip
            text={`🏫 ${schoolLabel ?? 'One school'} ✕`}
            on
            onPress={() => setFilters({ ...filters, workplaceKey: null })}
          />
        )}
        {nFilters > 0 && <Chip text="✕ Clear" on={false} onPress={() => setFilters({})} />}
        {saved.map((sf) => (
          <Pressable
            key={sf.id}
            onLongPress={() => {
              if (sf.owner_id !== profile?.id && !access.manage) return;
              confirm('Delete this saved filter?', sf.name, 'Delete').then((ok) => {
                if (ok)
                  deleteAlumniFilter(sf.id)
                    .then(loadSaved)
                    .catch((e) => say('Could not delete', e instanceof Error ? e.message : ''));
              });
            }}
          >
            <Chip
              text={`${sf.is_shared ? '👥 ' : '💾 '}${sf.name}`}
              on={false}
              onPress={() => {
                setFilters(sf.filters.filters ?? {});
                if (sf.filters.sort) setSort(sf.filters.sort);
              }}
            />
          </Pressable>
        ))}
      </ScrollView>

      <ScrollView
        horizontal
        showsHorizontalScrollIndicator={false}
        style={styles.row}
        contentContainerStyle={styles.rowIn}
      >
        <MIcon name="sort" size={20} color={colors.textMuted} />
        {sorts.map((o) => (
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
      {table && (rows?.length ?? 0) > 0 && <TableHead />}
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
            ) : (
              <View style={styles.headerRow}>
                {access.manage && (
                  <Tap
                    onPress={() => router.push('/alumni/import' as Href)}
                    borderless
                    label="Import"
                    style={styles.headerBtn}
                  >
                    <MIcon name="file-download" color={colors.textOnPrimary} />
                  </Tap>
                )}
                <Tap onPress={() => startSelect()} borderless label="Mark alumni" style={styles.headerBtn}>
                  <MIcon name="checklist" color={colors.textOnPrimary} />
                </Tap>
              </View>
            ),
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
          initialNumToRender={12}
          windowSize={7}
          ListEmptyComponent={
            <View style={styles.empty}>
              <View style={styles.emptyIcon}>
                <MIcon name="school" size={36} color={md.onPrimaryC} />
              </View>
              <Text style={[ui.muted, styles.centerText]}>
                {search || only !== 'all' || nFilters > 0
                  ? 'Nobody matches.'
                  : access.manage
                    ? 'No alumni yet. Tap ＋ to add one, or Import: from Students (a whole batch), Excel or phone contacts.'
                    : 'No alumni yet.'}
              </Text>
            </View>
          }
          extraData={selecting ? selected : search}
          renderItem={({ item, index }) => {
            // next-contact sort: a small heading where the group changes
            const group = sort === 'next_contact' ? nextGroup(item.next_contact_at) : null;
            const prev = sort === 'next_contact' && index > 0 ? nextGroup(rows?.[index - 1]?.next_contact_at) : null;
            return (
              <>
                {group && group !== prev && <Text style={styles.group}>{group}</Text>}
                {table ? (
                  <AlumnusTableRow
                    a={item}
                    selecting={selecting}
                    marked={selecting && selected.has(item.id)}
                    onToggle={toggle}
                  />
                ) : (
                  <AlumnusRow
                    a={item}
                    search={search}
                    selecting={selecting}
                    marked={selecting && selected.has(item.id)}
                    onToggle={toggle}
                    onLongPress={startSelect}
                    onPeek={setPeek}
                    onCall={dialer.call}
                    onWa={dialer.whatsapp}
                  />
                )}
              </>
            );
          }}
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
                icon="edit-note"
                label="Note"
                disabled={selected.size === 0}
                onPress={() => setSheet('note')}
              />
              <BarAction
                icon="alarm"
                label="Next contact"
                disabled={selected.size === 0}
                onPress={() => setSheet('next')}
              />
              {access.manage && (
                <BarAction
                  icon="sell"
                  label="Tag"
                  disabled={selected.size === 0}
                  onPress={() => openTagSheet('tag_add')}
                />
              )}
              <BarAction
                icon="more-horiz"
                label="More"
                disabled={selected.size === 0}
                onPress={() => setSheet('more')}
              />
            </>
          )}
        </View>
      )}

      {sheet === 'note' && (
        <TextSheet
          title={`Note on ${selected.size} alumni`}
          placeholder="e.g. Sent the admission season message"
          multiline
          saveLabel="Add note"
          onClose={() => setSheet(null)}
          onSave={(text) => runIn({ action: 'note', text }, (n) => `Note added to ${n} alumni.`)}
        />
      )}
      {sheet === 'next' && (
        <NextContactSheet
          title={`Next contact · ${selected.size} alumni`}
          canClear
          onClose={() => setSheet(null)}
          onSave={async (at, note) => {
            const n = await setAlumniNextContact([...selected], at, note);
            setSheet(null);
            stopSelect();
            alumniChanged();
            say('Done', at ? `Next contact set for ${n} alumni.` : `Next contact removed for ${n} alumni.`);
          }}
        />
      )}
      {(sheet === 'tag_add' || sheet === 'tag_remove') && (
        <TextSheet
          title={sheet === 'tag_add' ? `Tag ${selected.size} alumni` : `Remove a tag from ${selected.size}`}
          placeholder="Tag, e.g. season27"
          maxLength={40}
          suggestions={tags}
          saveLabel={sheet === 'tag_add' ? 'Add tag' : 'Remove tag'}
          onClose={() => setSheet(null)}
          onSave={(tag) =>
            runIn({ action: sheet, tag }, (n) =>
              sheet === 'tag_add' ? `“${tag}” added to ${n} alumni.` : `“${tag}” removed from ${n} alumni.`,
            )
          }
        />
      )}
      {sheet === 'owner' && (
        <OwnerSheet
          people={people}
          onClose={() => setSheet(null)}
          onPick={(ownerId) => runIn({ action: 'owner', ownerId }, (n) => `${n} alumni changed.`)}
        />
      )}
      {sheet === 'more' && (
        <MenuSheet
          title={`${selected.size} marked`}
          onClose={() => setSheet(null)}
          items={[
            { label: '📣 Campaign (WhatsApp)', icon: 'campaign', onPress: startCampaign },
            {
              label: 'Export to Excel',
              icon: 'table-view',
              onPress: () => (setSheet(null), exportExcel([...selected])),
            },
            ...(access.manage ? manageItems : []),
          ]}
        />
      )}
      {peek && (
        <AlumniPeekSheet
          a={peek}
          onClose={() => setPeek(null)}
          onCall={() => (setPeek(null), dialer.call(peek))}
          onWa={() => (setPeek(null), dialer.whatsapp(peek))}
          onNextContact={() => {
            setNextFor(peek);
            setPeek(null);
          }}
        />
      )}
      {dialer.sheet}
      {nextFor && (
        <NextContactSheet
          title={`Next contact · ${nextFor.name}`}
          canClear={!!nextFor.next_contact_at}
          onClose={() => setNextFor(null)}
          onSave={async (at, n) => {
            await setAlumniNextContact([nextFor.id], at, n);
            setNextFor(null);
            alumniChanged();
          }}
        />
      )}
      {filterOpen && (
        <AlumniFilterSheet
          value={filters}
          sort={sort}
          order={order}
          courses={courses}
          people={people}
          fields={fields}
          manage={access.manage}
          onClose={() => setFilterOpen(false)}
          onSaved={loadSaved}
          onApply={(f) => {
            setFilters(f);
            setFilterOpen(false);
          }}
        />
      )}

      {coursePicker && (
        <AlumniCoursePicker
          title={`Course for ${selected.size} alumni`}
          courses={courses}
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

// 🌐 The table (website, wide window)
const COLS: { label: string; flex: number }[] = [
  { label: 'Name', flex: 2.2 },
  { label: 'Phone', flex: 1.3 },
  { label: 'Course · batch', flex: 1.6 },
  { label: 'Workplace', flex: 2 },
  { label: 'District', flex: 1 },
  { label: 'Referred', flex: 0.8 },
  { label: 'Admitted', flex: 0.8 },
  { label: 'Last contact', flex: 1.1 },
  { label: 'Next contact', flex: 1.3 },
];

function TableHead() {
  return (
    <View style={[styles.tRow, styles.tHead]}>
      <View style={styles.tCheck} />
      {COLS.map((c) => (
        <Text key={c.label} style={[styles.tHeadText, { flex: c.flex }]} numberOfLines={1}>
          {c.label}
        </Text>
      ))}
    </View>
  );
}

const AlumnusTableRow = memo(function AlumnusTableRow({
  a,
  selecting,
  marked,
  onToggle,
}: {
  a: Alumnus;
  selecting: boolean;
  marked: boolean;
  onToggle: (id: string) => void;
}) {
  const next = a.next_contact_at ? new Date(a.next_contact_at) : null;
  const late = !!next && next.getTime() < Date.now();
  const cells: (string | number | null)[] = [
    a.name,
    a.phone,
    [a.course_name, a.batch_name].filter(Boolean).join(' · ') || null,
    [a.workplace, a.designation].filter(Boolean).join(' · ') || null,
    a.district,
    a.referrals || null,
    a.referred_admitted || null,
    a.last_contacted_at
      ? new Date(a.last_contacted_at).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: '2-digit' })
      : 'never',
    next ? whenText(next) : null,
  ];
  return (
    <Pressable
      onPress={() => (selecting ? onToggle(a.id) : router.push(`/alumni/${a.id}` as Href))}
      style={(state) => [
        styles.tRow,
        (state.pressed || (state as { hovered?: boolean }).hovered) && styles.tHover,
        marked && styles.itemOn,
      ]}
      accessibilityRole={selecting ? 'checkbox' : 'button'}
      accessibilityState={selecting ? { checked: marked } : undefined}
      accessibilityLabel={selecting ? a.name : `Open ${a.name}`}
    >
      <Pressable
        onPress={() => onToggle(a.id)}
        style={styles.tCheck}
        accessibilityRole="checkbox"
        accessibilityLabel={`Mark ${a.name}`}
      >
        <MIcon
          name={marked ? 'check-box' : 'check-box-outline-blank'}
          size={20}
          color={marked ? colors.primary : colors.textMuted}
        />
      </Pressable>
      {cells.map((v, i) => (
        <Text
          key={COLS[i].label}
          style={[
            styles.tCell,
            { flex: COLS[i].flex },
            i === 0 && styles.tName,
            i === 8 && late && styles.tLate,
            a.do_not_contact && i === 0 && styles.tDnc,
          ]}
          numberOfLines={1}
        >
          {v ?? '—'}
        </Text>
      ))}
    </Pressable>
  );
});

function Shortcut({ icon, label, to }: { icon: MIconName; label: string; to: string }) {
  return (
    <Tap onPress={() => router.push(to as Href)} style={styles.shortcut} label={label}>
      <MIcon name={icon} size={18} color={colors.text} />
      <Text style={styles.shortcutText}>{label}</Text>
    </Tap>
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
  search,
  selecting,
  marked,
  onToggle,
  onLongPress,
  onPeek,
  onCall,
  onWa,
}: {
  a: Alumnus;
  search: string;
  selecting: boolean;
  marked: boolean;
  onToggle: (id: string) => void;
  onLongPress: (id: string) => void;
  /** 👁 the peek sheet (tap the picture or the last note) */
  onPeek: (a: Alumnus) => void;
  /** 📞 / 💬 right here: the popup asks what happened when you come back */
  onCall: (a: Alumnus) => void;
  onWa: (a: Alumnus) => void;
}) {
  const course = [a.course_name, a.batch_name].filter(Boolean).join(' · ');
  const line = [course, a.passing_year ? `Passed ${a.passing_year}` : null].filter(Boolean).join(' · ');
  const work = [a.designation, a.workplace, a.district].filter(Boolean).join(' · ');
  const match = search ? alumniMatchLine(a, search) : null;
  const next = a.next_contact_at ? new Date(a.next_contact_at) : null;
  const late = !!next && next.getTime() < Date.now();
  const quietDays = a.last_contacted_at ? (Date.now() - new Date(a.last_contacted_at).getTime()) / 86400000 : null;
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
      ) : selecting ? (
        <Avatar name={a.name} />
      ) : (
        <Pressable
          onPress={() => onPeek(a)}
          hitSlop={6}
          accessibilityRole="button"
          accessibilityLabel={`Peek ${a.name}`}
        >
          <Avatar name={a.name} />
          <View style={styles.peekDot}>
            <MIcon name="visibility" size={12} color={md.onPrimaryC} />
          </View>
        </Pressable>
      )}
      <View style={styles.flex}>
        <View style={styles.nameRow}>
          <Text style={styles.name} numberOfLines={1}>
            {a.name}
          </Text>
          {a.do_not_contact && <MIcon name="do-not-disturb-on" size={16} color={colors.danger} />}
        </View>
        <Text style={styles.phone} numberOfLines={1}>
          {a.phone ? `📞 ${a.phone}` : '📵 No number'}
        </Text>
        {course ? (
          <Text style={styles.line} numberOfLines={1}>
            🎓 {line}
          </Text>
        ) : (
          <View style={styles.badges}>
            <Pill text="⚠ No course" bg={md.errorC} fg={md.onErrorC} />
            {!!a.passing_year && <Pill text={`Passed ${a.passing_year}`} bg={md.surface2} fg={colors.textMuted} />}
          </View>
        )}
        {!!work && (
          <Text style={styles.line} numberOfLines={1}>
            {work}
          </Text>
        )}
        {!!match && (
          <Text style={styles.match} numberOfLines={1}>
            🔎 {match}
          </Text>
        )}
        {!!a.last_note && (
          <Text style={styles.note} numberOfLines={2} onPress={selecting ? undefined : () => onPeek(a)}>
            📝 {a.last_note}
          </Text>
        )}
        {(!!next || quietDays === null || quietDays > 180 || a.tags.length > 0) && (
          <View style={styles.badges}>
            {quietDays === null && <Pill text="Never contacted" bg={md.warnC} fg={md.onWarnC} />}
            {a.tags.slice(0, 2).map((t) => (
              <Pill key={t} text={`#${t}`} bg={md.surface2} fg={colors.text} />
            ))}
            {!!next && (
              <Pill
                text={`⏰ ${whenText(next)}${a.next_contact_note ? ` · ${a.next_contact_note}` : ''}`}
                bg={late ? md.warnC : md.primaryC}
                fg={late ? md.onWarnC : md.onPrimaryC}
              />
            )}
            {quietDays !== null && quietDays > 180 && (
              <Pill text={`⏳ ${Math.floor(quietDays / 30)} months quiet`} bg={md.surface2} fg={colors.textMuted} />
            )}
          </View>
        )}
        {(a.referrals > 0 || a.referred_admitted > 0 || (a.refer_score ?? 0) >= 70) && (
          <View style={styles.badges}>
            {(a.refer_score ?? 0) >= 70 && !a.do_not_contact && (
              <Pill text={`🎯 ${a.refer_score}`} bg={md.goldC} fg={md.onGoldC} />
            )}
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
          {/* the page calls / opens WhatsApp and asks what happened when you come back */}
          <Tap onPress={() => onCall(a)} style={styles.quickBtn} label={`Call ${a.name}`}>
            <MIcon name="call" size={20} color={md.onOkC} />
          </Tap>
          <Tap onPress={() => onWa(a)} style={[styles.quickBtn, styles.quickWa]} label={`WhatsApp ${a.name}`}>
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
  match: { fontSize: fontSize.small, color: colors.primary, marginTop: 1 },
  note: { fontSize: fontSize.small, color: colors.text, marginTop: 2 },
  group: {
    fontSize: fontSize.caption,
    fontWeight: fontWeight.bold,
    letterSpacing: 0.8,
    color: colors.primary,
    marginTop: spacing.md,
    marginBottom: spacing.xs,
  },
  filterBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    height: 32,
    paddingHorizontal: spacing.md,
    borderRadius: radius.sm,
    borderWidth: 1,
    borderColor: md.outline,
    overflow: 'hidden',
  },
  filterBtnOn: { backgroundColor: md.primaryC, borderColor: md.primaryC },
  tRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    minHeight: 40,
    paddingHorizontal: spacing.sm,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.border,
  },
  tHead: {
    minHeight: 34,
    backgroundColor: md.surface2,
    borderTopLeftRadius: radius.sm,
    borderTopRightRadius: radius.sm,
  },
  tHover: { backgroundColor: md.surface1 },
  tCheck: { width: 24, alignItems: 'center' },
  tHeadText: { fontSize: fontSize.caption, fontWeight: fontWeight.bold, color: colors.textMuted },
  tCell: { fontSize: fontSize.small, color: colors.text },
  tName: { fontWeight: fontWeight.semibold },
  tLate: { color: colors.danger, fontWeight: fontWeight.semibold },
  tDnc: { textDecorationLine: 'line-through', color: colors.textMuted },
  shortcut: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    height: 36,
    paddingHorizontal: spacing.md,
    borderRadius: 18,
    backgroundColor: md.surface2,
    overflow: 'hidden',
  },
  shortcutText: { fontSize: fontSize.small, fontWeight: fontWeight.semibold, color: colors.text },
  filterText: { fontSize: fontSize.small, fontWeight: fontWeight.semibold, color: colors.text },
  filterTextOn: { color: md.onPrimaryC },
  badges: { flexDirection: 'row', flexWrap: 'wrap', gap: 6, marginTop: 6 },
  pill: { paddingHorizontal: 8, paddingVertical: 2, borderRadius: radius.sm },
  phone: { fontSize: fontSize.small, color: colors.text, marginTop: 1 },
  peekDot: {
    position: 'absolute',
    right: -2,
    bottom: -2,
    width: 18,
    height: 18,
    borderRadius: 9,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: md.primaryC,
    borderWidth: 1.5,
    borderColor: colors.surface,
  },
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
