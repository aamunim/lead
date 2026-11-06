import { useEffect, useRef, useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';

import type { QuickFilter } from '@/features/leads/api';
import { getStudentsSummary, shortMoney, type StudentsSummaryData } from '@/features/students/api';
import { colors, fontSize, fontWeight, isDark, radius, spacing } from '@/shared/theme';

// =====================================================================
// 🌐🎓 The cards on top of the website's Students page: students, new
//   this month, due, late, collected this month, papers missing.
//   A click shows those students (a second click: all again).
// =====================================================================

type Tile = {
  key: QuickFilter;
  icon: string;
  label: string;
  value: string;
  sub?: string;
  tone: string;
};

export function StudentKpis({
  quick,
  onPick,
  reloadKey,
}: {
  quick: QuickFilter;
  onPick: (q: QuickFilter) => void;
  /** a change asks for fresh numbers (after a payment, …) */
  reloadKey: number;
}) {
  const [s, setS] = useState<StudentsSummaryData | null>(null);
  const first = useRef(true);
  useEffect(() => {
    // the first time at once; later ones a moment after the change
    const t = setTimeout(() => getStudentsSummary().then((d) => d && setS(d)), first.current ? 0 : 800);
    first.current = false;
    return () => clearTimeout(t);
  }, [reloadKey]);

  const tiles: Tile[] = s
    ? [
        { key: 'all', icon: '🎓', label: 'Students', value: s.students.toLocaleString('en-IN'), tone: '#3557D4' },
        {
          key: 'new_students',
          icon: '✨',
          label: 'New this month',
          value: s.new_this_month.toLocaleString('en-IN'),
          tone: '#7C3AED',
        },
        {
          key: 'due',
          icon: '⏳',
          label: 'Fee due',
          value: shortMoney(s.due),
          sub: `${s.with_due} students`,
          tone: '#B45309',
        },
        {
          key: 'overdue',
          icon: '⚠️',
          label: 'Late',
          value: shortMoney(s.overdue_amount),
          sub: `${s.overdue} students`,
          tone: '#DC2626',
        },
        {
          key: 'paid',
          icon: '💵',
          label: 'Collected',
          sub: 'this month',
          value: shortMoney(s.collected_month),
          tone: '#15803D',
        },
        {
          key: 'papers',
          icon: '📄',
          label: 'Papers missing',
          value: s.papers_missing.toLocaleString('en-IN'),
          sub: 'students',
          tone: '#0369A1',
        },
      ]
    : [];

  if (!s) {
    return (
      <View style={styles.row}>
        {Array.from({ length: 6 }, (_, i) => (
          <View key={i} style={[styles.tile, styles.skeleton]} />
        ))}
      </View>
    );
  }

  return (
    <View style={styles.row}>
      {tiles.map((t) => {
        const on = quick === t.key && t.key !== 'all';
        return (
          <Pressable
            key={t.key}
            onPress={() => onPick(on ? 'all' : t.key)}
            style={(st) => [
              styles.tile,
              (st as { hovered?: boolean }).hovered && styles.tileHover,
              on && { borderColor: t.tone, backgroundColor: `${t.tone}14` },
            ]}
            accessibilityRole="button"
            accessibilityState={{ selected: on }}
            accessibilityLabel={`${t.label}: ${t.value}`}
          >
            <View style={[styles.icon, { backgroundColor: `${t.tone}1F` }]}>
              <Text style={styles.iconText}>{t.icon}</Text>
            </View>
            <View style={styles.flex}>
              <Text style={styles.label} numberOfLines={1}>
                {t.label}
              </Text>
              <Text style={[styles.value, { color: t.tone }]} numberOfLines={1}>
                {t.value}
              </Text>
              {!!t.sub && (
                <Text style={styles.sub} numberOfLines={1}>
                  {t.sub}
                </Text>
              )}
            </View>
          </Pressable>
        );
      })}
    </View>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1, minWidth: 0 },
  row: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.md },
  tile: {
    flexGrow: 1,
    flexBasis: 170,
    minHeight: 78,
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
    paddingVertical: spacing.md,
    paddingHorizontal: spacing.lg,
    borderRadius: 14,
    borderWidth: 1.5,
    borderColor: colors.border,
    backgroundColor: colors.surface,
    shadowColor: '#0B1A44',
    shadowOpacity: isDark ? 0 : 0.05,
    shadowRadius: 10,
    shadowOffset: { width: 0, height: 3 },
  },
  tileHover: { borderColor: isDark ? '#3A4767' : '#C9D3EC' },
  skeleton: { backgroundColor: isDark ? '#141C2E' : '#F1F4FA', borderColor: 'transparent' },
  icon: { width: 42, height: 42, borderRadius: 12, alignItems: 'center', justifyContent: 'center' },
  iconText: { fontSize: 20 },
  label: { fontSize: fontSize.caption, fontWeight: fontWeight.semibold, color: colors.textMuted },
  value: { fontSize: 22, fontWeight: fontWeight.bold, marginTop: 1 },
  sub: { fontSize: 11, color: colors.textMuted, borderRadius: radius.sm },
});
