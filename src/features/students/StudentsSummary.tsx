import { useFocusEffect } from 'expo-router';
import { useCallback, useState } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';

import type { QuickFilter } from '@/features/leads/api';
import { getStudentsSummary, shortMoney, type StudentsSummaryData } from '@/features/students/api';
import { colors, fontSize, fontWeight, radius, spacing } from '@/shared/theme';

// =====================================================================
// 🎓 Totals on top of the Students list: tap one to show those students
// =====================================================================

type Props = { onPick: (quick: QuickFilter) => void };

export function StudentsSummary({ onPick }: Props) {
  const [s, setS] = useState<StudentsSummaryData | null>(null);

  useFocusEffect(
    useCallback(() => {
      getStudentsSummary().then((d) => d && setS(d));
    }, []),
  );

  if (!s) return null;

  const tiles: { key: QuickFilter; label: string; value: string; tone?: 'good' | 'warn' | 'bad' }[] = [
    { key: 'all', label: 'Students', value: String(s.students) },
    { key: 'new_students', label: 'New this month', value: String(s.new_this_month) },
    { key: 'due', label: `Due · ${s.with_due}`, value: shortMoney(s.due), tone: s.due > 0 ? 'warn' : undefined },
    {
      key: 'overdue',
      label: `Late · ${s.overdue}`,
      value: shortMoney(s.overdue_amount),
      tone: s.overdue > 0 ? 'bad' : undefined,
    },
    { key: 'paid', label: 'Collected this month', value: shortMoney(s.collected_month), tone: 'good' },
    { key: 'papers', label: 'Papers missing', value: String(s.papers_missing), tone: s.papers_missing > 0 ? 'warn' : undefined },
  ];

  return (
    <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.row} style={styles.scroll}>
      {tiles.map((t) => (
        <Pressable
          key={t.label}
          onPress={() => onPick(t.key)}
          style={({ pressed }) => [styles.tile, pressed && styles.pressed]}
          accessibilityRole="button"
          accessibilityLabel={`${t.label}: ${t.value}`}
        >
          <Text
            style={[
              styles.value,
              t.tone === 'good' && styles.good,
              t.tone === 'warn' && styles.warn,
              t.tone === 'bad' && styles.bad,
            ]}
          >
            {t.value}
          </Text>
          <Text style={styles.label} numberOfLines={1}>
            {t.label}
          </Text>
        </Pressable>
      ))}
      <View style={styles.end} />
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  scroll: { flexGrow: 0, flexShrink: 0 },
  row: { gap: spacing.sm, paddingLeft: spacing.lg, paddingTop: spacing.md },
  tile: {
    minWidth: 96,
    paddingVertical: spacing.sm,
    paddingHorizontal: spacing.md,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.surface,
  },
  pressed: { opacity: 0.7 },
  value: { fontSize: fontSize.title, fontWeight: fontWeight.bold, color: colors.text },
  label: { fontSize: fontSize.caption, color: colors.textMuted },
  good: { color: colors.success },
  warn: { color: colors.warning },
  bad: { color: colors.danger },
  end: { width: spacing.lg },
});
