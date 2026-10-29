import { router, useFocusEffect, type Href } from 'expo-router';
import { useCallback, useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';

import { contactLabel } from '@/features/leads/contact';
import { formatVisitTime, listTodayVisits, type TodayVisit } from '@/features/visits/api';
import { colors, fontSize, fontWeight, radius, spacing } from '@/shared/theme';
import { ShowMoreButton, useShowMore } from '@/shared/ui/ShowMore';

// =====================================================================
// 🏫 Campus visits planned for today (and earlier ones not marked yet)
//   Shown on Home only when there is at least one.
// =====================================================================
export function TodayVisits() {
  const [items, setItems] = useState<TodayVisit[]>([]);
  const more = useShowMore(items, 5);

  // Reload every time Home comes back into view (e.g. after marking a visit)
  useFocusEffect(
    useCallback(() => {
      listTodayVisits()
        .then(setItems)
        .catch(() => setItems([]));
    }, []),
  );

  if (items.length === 0) return null;

  const startOfToday = new Date();
  startOfToday.setHours(0, 0, 0, 0);
  const late = items.filter((v) => new Date(v.plannedAt) < startOfToday).length;

  return (
    <View style={styles.card}>
      <View>
        <Text style={styles.title}>🏫 Campus visits</Text>
        <Text style={styles.subtitle}>
          {items.length - late} today
          {late > 0 && <Text style={styles.lateCount}> · {late} not marked yet</Text>}
        </Text>
      </View>

      {more.visible.map((v) => {
        const isLate = new Date(v.plannedAt) < startOfToday;
        return (
          <Pressable
            key={v.id}
            onPress={() => router.push(`/leads/${v.lead.id}` as Href)}
            style={({ pressed }) => [styles.row, pressed && styles.pressed]}
            accessibilityRole="button"
            accessibilityLabel={`${v.lead.name}, visit ${formatVisitTime(v.plannedAt)}`}
          >
            <View style={styles.flex}>
              <Text style={styles.name} numberOfLines={1}>
                {v.lead.name}
              </Text>
              <Text style={[styles.time, isLate && styles.timeLate]}>
                {isLate ? '⚠ ' : ''}
                {formatVisitTime(v.plannedAt)} · {contactLabel(v.lead)}
              </Text>
            </View>
            <Text style={styles.chevron}>›</Text>
          </Pressable>
        );
      })}
      <ShowMoreButton {...more} />
    </View>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1 },
  card: {
    gap: spacing.md,
    padding: spacing.lg,
    borderRadius: radius.lg,
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.primary,
  },
  title: { fontSize: fontSize.body, fontWeight: fontWeight.bold, color: colors.text },
  subtitle: { fontSize: fontSize.caption, color: colors.textMuted, marginTop: 2 },
  lateCount: { color: colors.danger, fontWeight: fontWeight.bold },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
    paddingVertical: spacing.sm,
    borderTopWidth: 1,
    borderTopColor: colors.border,
  },
  pressed: { opacity: 0.6 },
  name: { fontSize: fontSize.small, fontWeight: fontWeight.bold, color: colors.text },
  time: { fontSize: fontSize.caption, color: colors.textMuted, marginTop: 2 },
  timeLate: { color: colors.danger, fontWeight: fontWeight.semibold },
  chevron: { fontSize: 22, color: colors.textMuted },
});
