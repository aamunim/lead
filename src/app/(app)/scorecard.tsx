import { Stack, useLocalSearchParams } from 'expo-router';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { ActivityIndicator, Pressable, RefreshControl, ScrollView, StyleSheet, Text, View } from 'react-native';

import { useAuth } from '@/features/auth/AuthProvider';
import { writeAndShareSpreadsheet } from '@/features/import-export/excel';
import {
  delta,
  getScorecard,
  highlights,
  lastWeekStart,
  minutes,
  taka,
  totals,
  weekLabel,
  type ScoreRow,
  type Scorecard,
  type WeekNumbers,
} from '@/features/scorecard/api';
import { isWeb } from '@/features/web/api';
import { colors, fontSize, fontWeight, radius, spacing } from '@/shared/theme';

// =====================================================================
// 🏁 Weekly scorecard: last week (Sat–Fri) per person, next to the week
//   before. ◀ ▶ moves a week. Phone: a card per person. Website: a
//   table (tap a heading to sort) and an Excel download.
// =====================================================================

type Col = {
  key: keyof WeekNumbers;
  label: string;
  short: string;
  fmt: (v: WeekNumbers) => string;
  lowerIsBetter?: boolean;
};

const COLS: Col[] = [
  { key: 'leads', label: 'Leads received', short: 'Leads', fmt: (v) => String(v.leads) },
  { key: 'calls', label: 'Calls', short: 'Calls', fmt: (v) => String(v.calls) },
  { key: 'connected', label: 'Connected', short: 'Conn.', fmt: (v) => String(v.connected) },
  { key: 'admitted', label: 'Admissions', short: 'Adm.', fmt: (v) => String(v.admitted) },
  { key: 'money', label: 'Money taken', short: 'Taken', fmt: (v) => taka(Number(v.money)) },
  {
    key: 'response_min',
    label: 'First call after',
    short: 'Resp.',
    fmt: (v) => minutes(v.response_min),
    lowerIsBetter: true,
  },
  {
    key: 'missed',
    label: 'Follow-ups missed',
    short: 'Missed',
    fmt: (v) => `${v.missed}/${v.follow_ups}`,
    lowerIsBetter: true,
  },
];

const MEDALS = ['🥇', '🥈', '🥉'];

export default function ScorecardScreen() {
  const { profile } = useAuth();
  const params = useLocalSearchParams<{ week?: string }>();
  const [week, setWeek] = useState<Date>(() => (params.week ? new Date(params.week) : lastWeekStart()));
  const [card, setCard] = useState<Scorecard | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [sort, setSort] = useState<keyof WeekNumbers>('admitted');

  const load = useCallback(async () => {
    try {
      setError(null);
      setCard(await getScorecard(week));
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not load.');
    } finally {
      setLoading(false);
    }
  }, [week]);

  useEffect(() => {
    setLoading(true);
    load();
  }, [load]);

  const move = (days: number) => {
    const d = new Date(week);
    d.setDate(d.getDate() + days);
    setWeek(d);
  };
  const isLast = card ? card.weekStart.getTime() >= lastWeekStart().getTime() : true;

  const rows = useMemo(() => {
    if (!card) return [];
    const col = COLS.find((c) => c.key === sort)!;
    return [...card.rows].sort((a, b) => {
      const av = Number(a.now[sort] ?? (col.lowerIsBetter ? Infinity : -Infinity));
      const bv = Number(b.now[sort] ?? (col.lowerIsBetter ? Infinity : -Infinity));
      return col.lowerIsBetter ? av - bv : bv - av;
    });
  }, [card, sort]);
  const team = useMemo(() => (card ? totals(card.rows) : null), [card]);
  const notes = useMemo(() => (card && card.rows.length > 1 ? highlights(card.rows) : []), [card]);
  const many = (card?.rows.length ?? 0) > 1;

  const excel = async () => {
    if (!card) return;
    await writeAndShareSpreadsheet(
      `scorecard-${card.weekStart.toISOString().slice(0, 10)}.xlsx`,
      ['Name', 'Role', ...COLS.flatMap((c) => [c.label, `${c.label} (week before)`])],
      rows.map((r) => [r.name, r.role, ...COLS.flatMap((c) => [plain(r.now, c.key), plain(r.before, c.key)])]),
      'Scorecard',
    );
  };

  return (
    <ScrollView
      style={styles.screen}
      contentContainerStyle={[styles.content, isWeb && styles.contentWeb]}
      refreshControl={<RefreshControl refreshing={false} onRefresh={load} />}
    >
      <Stack.Screen options={{ title: 'Weekly scorecard', headerShown: !isWeb }} />

      {/* Week */}
      <View style={styles.weekRow}>
        <Pressable
          onPress={() => move(-7)}
          style={styles.arrow}
          accessibilityRole="button"
          accessibilityLabel="Week before"
        >
          <Text style={styles.arrowText}>◀</Text>
        </Pressable>
        <View style={styles.weekMid}>
          <Text style={styles.weekText}>{card ? weekLabel(card) : '…'}</Text>
          <Text style={styles.small}>{isLast ? 'Last week' : 'Sat – Fri'} · compared with the week before</Text>
        </View>
        <Pressable
          onPress={() => !isLast && move(7)}
          style={[styles.arrow, isLast && styles.off]}
          accessibilityRole="button"
          accessibilityLabel="Week after"
          disabled={isLast}
        >
          <Text style={styles.arrowText}>▶</Text>
        </Pressable>
        {isWeb && card && (
          <Pressable onPress={excel} style={styles.excel} accessibilityRole="button">
            <Text style={styles.excelText}>⬇ Excel</Text>
          </Pressable>
        )}
      </View>

      {error && <Text style={styles.error}>{error}</Text>}
      {loading && <ActivityIndicator color={colors.primary} style={{ marginTop: spacing.xl }} />}

      {card && !loading && (
        <>
          {/* Team totals */}
          {team && many && (
            <View style={styles.card}>
              <Text style={styles.h2}>Whole team</Text>
              <View style={styles.tiles}>
                {COLS.map((c) => (
                  <Tile key={c.key} col={c} now={team.now} before={team.before} />
                ))}
              </View>
              {notes.length > 0 && (
                <View style={styles.notes}>
                  {notes.map((n, i) => (
                    <Text key={i} style={styles.note}>
                      {n}
                    </Text>
                  ))}
                </View>
              )}
            </View>
          )}

          {card.rows.length === 0 && <Text style={styles.muted}>Nothing happened in this week.</Text>}

          {isWeb && many ? (
            <WebTable rows={rows} sort={sort} onSort={setSort} me={profile?.id ?? null} />
          ) : (
            rows.map((r, i) => (
              <View key={r.user_id} style={[styles.card, r.user_id === profile?.id && styles.mine]}>
                <View style={styles.nameRow}>
                  <Text style={styles.name} numberOfLines={1}>
                    {many && i < 3 && r.now.admitted > 0 ? `${MEDALS[i]} ` : ''}
                    {r.name}
                  </Text>
                  {!!r.role && <Text style={styles.small}>{r.role}</Text>}
                </View>
                <View style={styles.tiles}>
                  {COLS.map((c) => (
                    <Tile key={c.key} col={c} now={r.now} before={r.before} />
                  ))}
                </View>
              </View>
            ))
          )}
          <Text style={styles.small}>
            Money is counted for the lead’s counselor. “First call after” is the average time from a new lead to its
            first call. A follow-up is missed when it was done after its day, or not at all.
          </Text>
        </>
      )}
    </ScrollView>
  );
}

function plain(v: WeekNumbers, k: keyof WeekNumbers): string | number | null {
  const x = v[k];
  return x == null ? null : Number(x);
}

function Tile({ col, now, before }: { col: Col; now: WeekNumbers; before: WeekNumbers }) {
  const a = Number(now[col.key] ?? NaN);
  const b = Number(before[col.key] ?? NaN);
  const d = Number.isFinite(a) && Number.isFinite(b) ? a - b : 0;
  const good = col.lowerIsBetter ? d < 0 : d > 0;
  const text =
    col.key === 'money'
      ? d
        ? `${d > 0 ? '+' : '−'}${taka(Math.abs(d))}`
        : ''
      : col.key === 'response_min'
        ? ''
        : delta(a, b);
  return (
    <View style={styles.tile} accessible accessibilityLabel={`${col.label}: ${col.fmt(now)}`}>
      <Text style={styles.tileValue} numberOfLines={1}>
        {col.fmt(now)}
      </Text>
      <Text style={styles.tileLabel} numberOfLines={1}>
        {col.short}
      </Text>
      <Text style={[styles.tileDelta, text ? (good ? styles.good : styles.bad) : null]} numberOfLines={1}>
        {text || `was ${col.fmt(before)}`}
      </Text>
    </View>
  );
}

function WebTable({
  rows,
  sort,
  onSort,
  me,
}: {
  rows: ScoreRow[];
  sort: keyof WeekNumbers;
  onSort: (k: keyof WeekNumbers) => void;
  me: string | null;
}) {
  return (
    <View style={styles.table}>
      <View style={[styles.tr, styles.th]}>
        <Text style={[styles.td, styles.tdName, styles.thText]}>Name</Text>
        {COLS.map((c) => (
          <Pressable key={c.key} onPress={() => onSort(c.key)} style={styles.td} accessibilityRole="button">
            <Text style={[styles.thText, sort === c.key && styles.thOn]}>
              {c.label}
              {sort === c.key ? ' ▾' : ''}
            </Text>
          </Pressable>
        ))}
      </View>
      {rows.map((r, i) => (
        <View key={r.user_id} style={[styles.tr, i % 2 === 1 && styles.trAlt, r.user_id === me && styles.mine]}>
          <View style={[styles.td, styles.tdName]}>
            <Text style={styles.name} numberOfLines={1}>
              {i < 3 && r.now.admitted > 0 ? `${MEDALS[i]} ` : ''}
              {r.name}
            </Text>
            {!!r.role && <Text style={styles.small}>{r.role}</Text>}
          </View>
          {COLS.map((c) => {
            const a = Number(r.now[c.key] ?? NaN);
            const b = Number(r.before[c.key] ?? NaN);
            const d = Number.isFinite(a) && Number.isFinite(b) ? a - b : 0;
            const good = c.lowerIsBetter ? d < 0 : d > 0;
            const dt =
              c.key === 'money'
                ? d
                  ? `${d > 0 ? '+' : '−'}${taka(Math.abs(d))}`
                  : ''
                : c.key === 'response_min'
                  ? ''
                  : delta(a, b);
            return (
              <View key={c.key} style={styles.td}>
                <Text style={styles.cell}>{c.fmt(r.now)}</Text>
                <Text style={[styles.small, dt ? (good ? styles.good : styles.bad) : null]}>
                  {dt || `was ${c.fmt(r.before)}`}
                </Text>
              </View>
            );
          })}
        </View>
      ))}
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.background },
  content: { padding: spacing.lg, gap: spacing.md, paddingBottom: spacing.xxl },
  contentWeb: { maxWidth: 1180, width: '100%', alignSelf: 'center' },
  weekRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm },
  weekMid: { flex: 1, alignItems: 'center' },
  weekText: { fontSize: fontSize.title, fontWeight: fontWeight.bold, color: colors.text },
  arrow: {
    width: 40,
    height: 40,
    borderRadius: 20,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.border,
  },
  arrowText: { fontSize: fontSize.small, color: colors.text },
  off: { opacity: 0.35 },
  excel: {
    paddingVertical: 8,
    paddingHorizontal: spacing.md,
    borderRadius: radius.sm,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.surface,
  },
  excelText: { fontSize: fontSize.small, fontWeight: fontWeight.semibold, color: colors.text },
  error: { fontSize: fontSize.small, color: colors.danger },
  muted: { fontSize: fontSize.small, color: colors.textMuted },
  small: { fontSize: fontSize.caption, color: colors.textMuted },
  h2: { fontSize: fontSize.body, fontWeight: fontWeight.bold, color: colors.text },
  card: {
    padding: spacing.lg,
    gap: spacing.sm,
    borderRadius: radius.lg,
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.border,
  },
  mine: { borderColor: colors.primary },
  nameRow: { flexDirection: 'row', alignItems: 'baseline', justifyContent: 'space-between', gap: spacing.sm },
  name: { fontSize: fontSize.body, fontWeight: fontWeight.bold, color: colors.text, flexShrink: 1 },
  tiles: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.sm },
  tile: {
    minWidth: 92,
    flexGrow: 1,
    padding: spacing.sm,
    borderRadius: radius.md,
    backgroundColor: colors.background,
  },
  tileValue: { fontSize: fontSize.title, fontWeight: fontWeight.bold, color: colors.text },
  tileLabel: { fontSize: fontSize.caption, color: colors.textMuted },
  tileDelta: { fontSize: fontSize.caption, color: colors.textMuted, marginTop: 2 },
  good: { color: colors.success, fontWeight: fontWeight.bold },
  bad: { color: colors.danger, fontWeight: fontWeight.bold },
  notes: { gap: 2, marginTop: spacing.xs },
  note: { fontSize: fontSize.small, color: colors.text },
  // web table
  table: {
    borderRadius: radius.lg,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.surface,
    overflow: 'hidden',
  },
  tr: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: spacing.sm },
  trAlt: { backgroundColor: colors.background },
  th: { borderBottomWidth: 1, borderBottomColor: colors.border },
  thText: { fontSize: fontSize.caption, fontWeight: fontWeight.bold, color: colors.textMuted },
  thOn: { color: colors.primary },
  td: { flex: 1, paddingVertical: spacing.sm, paddingHorizontal: spacing.xs },
  tdName: { flex: 1.8 },
  cell: { fontSize: fontSize.small, fontWeight: fontWeight.semibold, color: colors.text },
});
