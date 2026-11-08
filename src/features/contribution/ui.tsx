import { useEffect, useState } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';

import {
  PERIODS,
  periodRange,
  personColor,
  type ContribFilters,
  type ContribShare,
  type Period,
} from '@/features/contribution/api';
import { listCourses, type CourseWithDetails } from '@/features/settings/api';
import { colors, fontSize, fontWeight, radius, spacing } from '@/shared/theme';

// =====================================================================
// 🤝 Admission Contribution: shared bits (the stacked bar, the filters)
// =====================================================================

/** One bar per admission: each person's colour, as wide as their share */
export function ShareBar({ shares, height = 10 }: { shares: ContribShare[]; height?: number }) {
  if (shares.length === 0) return <View style={[styles.bar, { height }, styles.barEmpty]} />;
  return (
    <View style={[styles.bar, { height }]}>
      {shares.map((s) => (
        <View
          key={s.user_id}
          style={{ width: `${Math.max(1, Math.min(100, s.share))}%`, backgroundColor: personColor(s.user_id) }}
        />
      ))}
    </View>
  );
}

/** "● Karim 55% · ● Rahim 35%" */
export function ShareLegend({ shares, max = 4 }: { shares: ContribShare[]; max?: number }) {
  return (
    <View style={styles.legend}>
      {shares.slice(0, max).map((s) => (
        <View key={s.user_id} style={styles.legendItem}>
          <View style={[styles.dot, { backgroundColor: personColor(s.user_id) }]} />
          <Text style={styles.legendText} numberOfLines={1}>
            {(s.name ?? 'Someone').split(' ')[0]} {Math.round(s.share)}%
          </Text>
        </View>
      ))}
      {shares.length > max && <Text style={styles.legendText}>+{shares.length - max}</Text>}
    </View>
  );
}

export function Dot({ userId, size = 10 }: { userId: string; size?: number }) {
  return <View style={{ width: size, height: size, borderRadius: size / 2, backgroundColor: personColor(userId) }} />;
}

/** The period chips + course / batch chips; tells the page the new filters */
export function ContribFilterBar({
  value,
  period,
  onChange,
}: {
  value: ContribFilters;
  period: Period;
  onChange: (f: ContribFilters, p: Period) => void;
}) {
  const [courses, setCourses] = useState<CourseWithDetails[]>([]);
  useEffect(() => {
    listCourses(true)
      .then(setCourses)
      .catch(() => undefined);
  }, []);
  const course = courses.find((c) => c.id === value.courseId) ?? null;

  return (
    <View style={styles.filters}>
      <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.row}>
        {PERIODS.map((p) => (
          <Chip
            key={p.key}
            label={p.label}
            on={period === p.key}
            onPress={() => onChange({ ...value, ...periodRange(p.key) }, p.key)}
          />
        ))}
      </ScrollView>
      {courses.length > 0 && (
        <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.row}>
          <Chip
            label="All courses"
            on={!value.courseId}
            onPress={() => onChange({ ...value, courseId: null, batchId: null }, period)}
          />
          {courses.map((c) => (
            <Chip
              key={c.id}
              label={c.name}
              on={value.courseId === c.id}
              onPress={() => onChange({ ...value, courseId: c.id, batchId: null }, period)}
            />
          ))}
        </ScrollView>
      )}
      {!!course && course.batches.length > 0 && (
        <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.row}>
          <Chip label="All batches" on={!value.batchId} onPress={() => onChange({ ...value, batchId: null }, period)} />
          {course.batches.map((b) => (
            <Chip
              key={b.id}
              label={b.name}
              on={value.batchId === b.id}
              onPress={() => onChange({ ...value, batchId: b.id }, period)}
            />
          ))}
        </ScrollView>
      )}
      <Text style={styles.range}>{value.from === '2000-01-01' ? 'All time' : `${value.from} → ${value.to}`}</Text>
    </View>
  );
}

export function Chip({ label, on, onPress }: { label: string; on: boolean; onPress: () => void }) {
  return (
    <Pressable
      onPress={onPress}
      style={[styles.chip, on && styles.chipOn]}
      accessibilityRole="radio"
      accessibilityState={{ checked: on }}
    >
      <Text style={[styles.chipText, on && styles.chipTextOn]} numberOfLines={1}>
        {label}
      </Text>
    </Pressable>
  );
}

export function Stat({ n, label, tone }: { n: string | number; label: string; tone?: string }) {
  return (
    <View style={styles.stat}>
      <Text style={[styles.statN, tone ? { color: tone } : null]}>{n}</Text>
      <Text style={styles.statLabel}>{label}</Text>
    </View>
  );
}

export const cs = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.background },
  content: { padding: spacing.lg, gap: spacing.md, paddingBottom: spacing.xxl },
  wide: { width: '100%', maxWidth: 1100, alignSelf: 'center' },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: spacing.xl },
  card: {
    gap: spacing.sm,
    padding: spacing.md,
    borderRadius: radius.lg,
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.border,
  },
  label: {
    fontSize: fontSize.caption,
    fontWeight: fontWeight.bold,
    letterSpacing: 1.2,
    color: colors.textMuted,
    marginTop: spacing.sm,
    marginLeft: spacing.xs,
  },
  title: { fontSize: fontSize.body, fontWeight: fontWeight.bold, color: colors.text },
  text: { fontSize: fontSize.small, lineHeight: 20, color: colors.text },
  muted: { fontSize: fontSize.small, color: colors.textMuted },
  small: { fontSize: fontSize.caption, color: colors.textMuted },
  stats: { flexDirection: 'row', flexWrap: 'wrap', justifyContent: 'space-between', rowGap: spacing.sm },
  link: { fontSize: fontSize.small, fontWeight: fontWeight.bold, color: colors.primary },
  row: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm },
  pressed: { opacity: 0.7 },
  bad: { color: colors.danger },
});

const styles = StyleSheet.create({
  bar: { flexDirection: 'row', width: '100%', borderRadius: 5, overflow: 'hidden', backgroundColor: colors.background },
  barEmpty: { borderWidth: 1, borderColor: colors.border, borderStyle: 'dashed' },
  legend: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.sm, alignItems: 'center' },
  legendItem: { flexDirection: 'row', alignItems: 'center', gap: 4, maxWidth: 160 },
  legendText: { fontSize: fontSize.caption, color: colors.textMuted },
  dot: { width: 8, height: 8, borderRadius: 4 },
  filters: { gap: spacing.xs },
  row: { gap: spacing.sm, paddingVertical: 2 },
  range: { fontSize: fontSize.caption, color: colors.textMuted, marginLeft: spacing.xs },
  chip: {
    minHeight: 34,
    justifyContent: 'center',
    paddingHorizontal: spacing.md,
    borderRadius: radius.pill,
    borderWidth: 1.5,
    borderColor: colors.border,
    backgroundColor: colors.surface,
  },
  chipOn: { backgroundColor: colors.primary, borderColor: colors.primary },
  chipText: { fontSize: fontSize.small, fontWeight: fontWeight.semibold, color: colors.text },
  chipTextOn: { color: colors.textOnPrimary },
  stat: { minWidth: 72, alignItems: 'center', flexGrow: 1 },
  statN: { fontSize: fontSize.title, fontWeight: fontWeight.bold, color: colors.text },
  statLabel: { fontSize: fontSize.caption, color: colors.textMuted },
});
