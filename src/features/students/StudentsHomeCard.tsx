import { router, useFocusEffect, type Href } from 'expo-router';
import { useCallback, useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';

import { useAuth } from '@/features/auth/AuthProvider';
import {
  canSeeStudents,
  getStudentsSettings,
  getStudentsSummary,
  shortMoney,
  type StudentsSummaryData,
} from '@/features/students/api';
import { colors, fontSize, fontWeight, radius, spacing } from '@/shared/theme';

// =====================================================================
// 🎓 Home: the students at a glance; tap to open the Students tab
// =====================================================================

export function StudentsHomeCard() {
  const { profile, hasPermission } = useAuth();
  const isAdmin = hasPermission('settings.manage');
  const [allowed, setAllowed] = useState(false);
  const [s, setS] = useState<StudentsSummaryData | null>(null);

  useFocusEffect(
    useCallback(() => {
      getStudentsSettings().then((st) => {
        const ok = canSeeStudents(st, profile, isAdmin);
        setAllowed(ok);
        if (ok) getStudentsSummary().then(setS);
      });
    }, [profile, isAdmin]),
  );

  if (!allowed || !s || s.students === 0) return null;

  return (
    <Pressable
      onPress={() => router.push('/students' as Href)}
      style={({ pressed }) => [styles.card, pressed && styles.pressed]}
      accessibilityRole="button"
      accessibilityLabel={`${s.students} students. Open Students`}
    >
      <View style={styles.top}>
        <Text style={styles.title}>🎓 Students</Text>
        <Text style={styles.link}>Open ›</Text>
      </View>
      <View style={styles.row}>
        <Stat value={String(s.students)} label="students" />
        <Stat value={shortMoney(s.due)} label={`due · ${s.with_due}`} tone={s.due > 0 ? 'warn' : undefined} />
        <Stat value={String(s.overdue)} label="late" tone={s.overdue > 0 ? 'bad' : undefined} />
        <Stat value={shortMoney(s.collected_month)} label="this month" tone="good" />
      </View>
    </Pressable>
  );
}

function Stat({ value, label, tone }: { value: string; label: string; tone?: 'good' | 'warn' | 'bad' }) {
  return (
    <View style={styles.stat}>
      <Text style={[styles.value, tone === 'good' && styles.good, tone === 'warn' && styles.warn, tone === 'bad' && styles.bad]}>
        {value}
      </Text>
      <Text style={styles.label} numberOfLines={1}>
        {label}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  card: {
    gap: spacing.sm,
    padding: spacing.lg,
    borderRadius: radius.lg,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.surface,
  },
  pressed: { opacity: 0.7 },
  top: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  title: { fontSize: fontSize.body, fontWeight: fontWeight.bold, color: colors.text },
  link: { fontSize: fontSize.small, fontWeight: fontWeight.bold, color: colors.primary },
  row: { flexDirection: 'row', gap: spacing.sm },
  stat: { flex: 1 },
  value: { fontSize: fontSize.title, fontWeight: fontWeight.bold, color: colors.text },
  label: { fontSize: fontSize.caption, color: colors.textMuted },
  good: { color: colors.success },
  warn: { color: colors.warning },
  bad: { color: colors.danger },
});
