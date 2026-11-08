import { Stack, router, type Href } from 'expo-router';
import { useCallback, useEffect, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Pressable,
  RefreshControl,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';

import { shareFile } from '@/features/activity/workExport';
import {
  canSeeContribution,
  contribCsv,
  credits,
  getContribSummary,
  listContribStudents,
  periodRange,
  personColor,
  type ContribFilters,
  type ContribStudent,
  type ContribSummary,
  type Period,
  type StudentStatus,
} from '@/features/contribution/api';
import { Chip, ContribFilterBar, Dot, ShareBar, ShareLegend, Stat, cs } from '@/features/contribution/ui';
import { colors, fontSize, fontWeight, radius, spacing } from '@/shared/theme';

// =====================================================================
// 🤝 Admission Contribution: at a glance, who did how much in the
//   admissions of a period — each person's total (1 = one whole
//   admission), every student with the shares, and who leads in each
//   source / course. Tap a person or a student for the details.
//   For the people Settings → AI allows to see the shares.
// =====================================================================

type Tab = 'people' | 'students' | 'groups';

const STATUSES: { key: StudentStatus; label: string }[] = [
  { key: 'all', label: 'All' },
  { key: 'done', label: '✅ Worked out' },
  { key: 'waiting', label: '⏳ Waiting' },
  { key: 'not_started', label: 'Not started' },
  { key: 'manual', label: '✍️ By hand' },
  { key: 'failed', label: '⚠️ Failed' },
];
const PAGE = 40;

export default function ContributionScreen() {
  const [allowed, setAllowed] = useState<boolean | null>(null);
  const [period, setPeriod] = useState<Period>('this_month');
  const [f, setF] = useState<ContribFilters>({ ...periodRange('this_month'), courseId: null, batchId: null });
  const [tab, setTab] = useState<Tab>('people');
  const [sum, setSum] = useState<ContribSummary | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);

  // students
  const [status, setStatus] = useState<StudentStatus>('all');
  const [person, setPerson] = useState<{ id: string; name: string | null } | null>(null);
  const [search, setSearch] = useState('');
  const [rows, setRows] = useState<ContribStudent[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(0);
  const [loadingRows, setLoadingRows] = useState(false);
  const [exporting, setExporting] = useState(false);
  const ask = useRef(0);

  useEffect(() => {
    canSeeContribution().then(setAllowed);
  }, []);

  const loadSummary = useCallback(
    (force = false) => {
      setError(null);
      return getContribSummary(f, force)
        .then(setSum)
        .catch((e) => setError(e instanceof Error ? e.message : 'Could not load.'));
    },
    [f],
  );

  const loadRows = useCallback(
    (nextPage: number) => {
      const id = ++ask.current;
      setLoadingRows(true);
      return listContribStudents({ ...f, userId: person?.id ?? null, status, search }, nextPage, PAGE)
        .then((r) => {
          if (id !== ask.current) return;
          setTotal(r.total);
          setPage(nextPage);
          setRows((now) => (nextPage === 0 ? r.items : [...now, ...r.items]));
        })
        .catch((e) => id === ask.current && setError(e instanceof Error ? e.message : 'Could not load.'))
        .finally(() => id === ask.current && setLoadingRows(false));
    },
    [f, person, status, search],
  );

  useEffect(() => {
    if (allowed) loadSummary();
  }, [allowed, loadSummary]);

  // the students list: after a short pause while typing
  useEffect(() => {
    if (!allowed || tab !== 'students') return;
    const t = setTimeout(() => loadRows(0), search ? 300 : 0);
    return () => clearTimeout(t);
  }, [allowed, tab, loadRows, search]);

  const refresh = async () => {
    setRefreshing(true);
    await Promise.all([loadSummary(true), tab === 'students' ? loadRows(0) : Promise.resolve()]);
    setRefreshing(false);
  };

  const exportCsv = async () => {
    setExporting(true);
    try {
      const csv = await contribCsv({ ...f, userId: person?.id ?? null, status });
      await shareFile(`admission-contribution-${f.from}-${f.to}.csv`, csv, 'csv');
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not export.');
    } finally {
      setExporting(false);
    }
  };

  const showPerson = (id: string, name: string | null) => {
    setPerson({ id, name });
    setTab('students');
  };

  if (allowed === false)
    return (
      <View style={cs.center}>
        <Stack.Screen options={{ title: 'Admission Contribution' }} />
        <Text style={cs.muted}>Only the people Settings → AI allows can see admission contribution.</Text>
      </View>
    );

  const maxCredit = Math.max(1, ...(sum?.people ?? []).map((p) => p.credit));
  const t = sum?.totals;

  return (
    <ScrollView
      style={cs.screen}
      contentContainerStyle={[cs.content, cs.wide]}
      keyboardShouldPersistTaps="handled"
      refreshControl={<RefreshControl refreshing={refreshing} onRefresh={refresh} />}
    >
      <Stack.Screen options={{ title: 'Admission Contribution' }} />
      <ContribFilterBar
        value={f}
        period={period}
        onChange={(next, p) => {
          setF(next);
          setPeriod(p);
        }}
      />

      {error && <Text style={[cs.text, cs.bad]}>{error}</Text>}
      {!sum ? (
        <ActivityIndicator color={colors.primary} style={{ marginTop: spacing.xl }} />
      ) : (
        <>
          <View style={cs.card}>
            <View style={cs.stats}>
              <Stat n={t!.admissions} label="Admissions" />
              <Stat n={t!.done} label="Worked out" tone={colors.success} />
              <Stat n={t!.waiting + t!.not_started} label="Waiting" />
              {t!.manual > 0 && <Stat n={t!.manual} label="By hand" />}
              {t!.failed > 0 && <Stat n={t!.failed} label="Failed" tone={colors.danger} />}
            </View>
            {t!.waiting + t!.not_started > 0 && (
              <Text style={cs.small}>
                Not worked out yet: they count for whoever pressed Admitted until the AI is done (Settings → AI).
              </Text>
            )}
          </View>

          <View style={styles.tabs}>
            {(
              [
                ['people', '👥 People'],
                ['students', '🎓 Students'],
                ['groups', '📊 Sources · Courses'],
              ] as [Tab, string][]
            ).map(([k, label]) => (
              <Pressable
                key={k}
                onPress={() => setTab(k)}
                style={[styles.tab, tab === k && styles.tabOn]}
                accessibilityRole="tab"
                accessibilityState={{ selected: tab === k }}
              >
                <Text style={[styles.tabText, tab === k && styles.tabTextOn]}>{label}</Text>
              </Pressable>
            ))}
          </View>

          {/* 👥 each person */}
          {tab === 'people' &&
            (sum.people.length === 0 ? (
              <Text style={cs.muted}>No worked-out admissions in this period.</Text>
            ) : (
              <View style={cs.card}>
                {sum.people.map((p, i) => (
                  <Pressable
                    key={p.user_id}
                    onPress={() =>
                      router.push({
                        pathname: '/contribution/person/[id]',
                        params: { id: p.user_id, from: f.from, to: f.to },
                      } as unknown as Href)
                    }
                    style={({ pressed }) => [styles.person, i > 0 && styles.sep, pressed && cs.pressed]}
                    accessibilityRole="button"
                  >
                    <Text style={styles.rank}>{i + 1}</Text>
                    <View style={{ flex: 1, gap: 4 }}>
                      <View style={cs.row}>
                        <Dot userId={p.user_id} />
                        <Text style={styles.personName} numberOfLines={1}>
                          {p.name ?? 'No name'}
                        </Text>
                        <Text style={styles.credit}>{credits(p.credit)}</Text>
                      </View>
                      <View style={styles.track}>
                        <View
                          style={[
                            styles.fill,
                            { width: `${(p.credit / maxCredit) * 100}%`, backgroundColor: personColor(p.user_id) },
                          ]}
                        />
                      </View>
                      <Text style={cs.small}>
                        In {p.admissions} admissions · average {Math.round(p.avg_share)}% · biggest share in{' '}
                        {p.top_count}
                      </Text>
                    </View>
                    <Pressable onPress={() => showPerson(p.user_id, p.name)} hitSlop={8} accessibilityRole="button">
                      <Text style={cs.link}>🎓</Text>
                    </Pressable>
                  </Pressable>
                ))}
                <Text style={cs.small}>
                  The number = admissions’ worth (each admission shared out: 55% = 0.55). 🎓 = their students.
                </Text>
              </View>
            ))}

          {/* 🎓 every student */}
          {tab === 'students' && (
            <>
              <TextInput
                value={search}
                onChangeText={setSearch}
                placeholder="Search name or College ID"
                placeholderTextColor={colors.textMuted}
                style={styles.search}
              />
              <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={cs.row}>
                {person && <Chip label={`👤 ${person.name ?? 'Someone'} ✕`} on onPress={() => setPerson(null)} />}
                {STATUSES.map((s) => (
                  <Chip key={s.key} label={s.label} on={status === s.key} onPress={() => setStatus(s.key)} />
                ))}
              </ScrollView>
              <View style={[cs.row, { justifyContent: 'space-between' }]}>
                <Text style={cs.small}>{total} students</Text>
                <Pressable onPress={exportCsv} disabled={exporting} accessibilityRole="button" hitSlop={8}>
                  <Text style={cs.link}>{exporting ? 'Exporting…' : '⬇️ Export (Excel)'}</Text>
                </Pressable>
              </View>
              {rows.map((s) => (
                <Pressable
                  key={s.lead_id}
                  onPress={() => router.push(`/contribution/${s.lead_id}` as Href)}
                  style={({ pressed }) => [cs.card, pressed && cs.pressed]}
                  accessibilityRole="button"
                >
                  <View style={cs.row}>
                    <Text style={[cs.title, { flex: 1 }]} numberOfLines={1}>
                      {s.name}
                    </Text>
                    <Text style={cs.small}>{s.admitted_at.slice(0, 10)}</Text>
                  </View>
                  <Text style={cs.small} numberOfLines={1}>
                    {[s.student_ref, s.course, s.batch].filter(Boolean).join(' · ')}
                  </Text>
                  <ShareBar shares={s.shares} />
                  {s.shares.length > 0 ? (
                    <ShareLegend shares={s.shares} />
                  ) : (
                    <Text style={cs.small}>
                      {s.status === 'failed' ? '⚠️ Could not be worked out' : '⏳ Not worked out yet'}
                    </Text>
                  )}
                  {s.manual && <Text style={cs.small}>✍️ Set by hand</Text>}
                </Pressable>
              ))}
              {loadingRows ? (
                <ActivityIndicator color={colors.primary} />
              ) : rows.length < total ? (
                <Pressable onPress={() => loadRows(page + 1)} style={styles.more} accessibilityRole="button">
                  <Text style={cs.link}>Show more ({total - rows.length})</Text>
                </Pressable>
              ) : rows.length === 0 ? (
                <Text style={cs.muted}>No students here.</Text>
              ) : null}
            </>
          )}

          {/* 📊 who leads in each source / course */}
          {tab === 'groups' &&
            (['source', 'course'] as const).map((g) => {
              const list = sum.groups.filter((x) => x.group === g);
              if (list.length === 0) return null;
              return (
                <View key={g} style={{ gap: spacing.sm }}>
                  <Text style={cs.label}>{g === 'source' ? 'BY SOURCE' : 'BY COURSE'}</Text>
                  {list.map((x) => (
                    <View key={x.key} style={cs.card}>
                      <View style={cs.row}>
                        <Text style={[cs.title, { flex: 1 }]} numberOfLines={1}>
                          {x.key}
                        </Text>
                        <Text style={cs.small}>{x.admissions} admissions</Text>
                      </View>
                      <ShareBar
                        shares={x.people.map((p) => ({
                          user_id: p.user_id,
                          name: p.name,
                          share: (p.credit / Math.max(1, x.admissions)) * 100,
                          reason: null,
                        }))}
                      />
                      <Text style={cs.small} numberOfLines={2}>
                        {x.people
                          .slice(0, 4)
                          .map((p) => `${(p.name ?? 'Someone').split(' ')[0]} ${credits(p.credit)}`)
                          .join(' · ')}
                      </Text>
                    </View>
                  ))}
                </View>
              );
            })}
        </>
      )}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  tabs: {
    flexDirection: 'row',
    gap: 4,
    padding: 4,
    borderRadius: radius.pill,
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.border,
  },
  tab: { flex: 1, alignItems: 'center', paddingVertical: spacing.sm, borderRadius: radius.pill },
  tabOn: { backgroundColor: colors.primary },
  tabText: { fontSize: fontSize.small, fontWeight: fontWeight.semibold, color: colors.text },
  tabTextOn: { color: colors.textOnPrimary },
  person: { flexDirection: 'row', alignItems: 'center', gap: spacing.md, paddingVertical: spacing.sm },
  sep: { borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: colors.border },
  rank: {
    width: 22,
    textAlign: 'center',
    fontSize: fontSize.small,
    fontWeight: fontWeight.bold,
    color: colors.textMuted,
  },
  personName: { flex: 1, fontSize: fontSize.body, fontWeight: fontWeight.semibold, color: colors.text },
  credit: { fontSize: fontSize.body, fontWeight: fontWeight.bold, color: colors.primary },
  track: { height: 6, borderRadius: 3, backgroundColor: colors.background, overflow: 'hidden' },
  fill: { height: 6, borderRadius: 3 },
  search: {
    minHeight: 44,
    paddingHorizontal: spacing.md,
    borderRadius: radius.pill,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.surface,
    color: colors.text,
    fontSize: fontSize.body,
  },
  more: { alignItems: 'center', paddingVertical: spacing.md },
});
