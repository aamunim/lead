import { router, Stack, useFocusEffect, type Href } from 'expo-router';
import { useCallback, useMemo, useState } from 'react';
import {
    ActivityIndicator,
    Pressable,
    RefreshControl,
    ScrollView,
    StyleSheet,
    Text,
    View,
} from 'react-native';

import { listCourses, type CourseWithDetails } from '@/features/settings/api';
import { colors, fontSize, fontWeight, radius, spacing } from '@/shared/theme';
import { Button } from '@/shared/ui/Button';

function formatTaka(amount: number): string {
  return `BDT ${Math.round(amount).toLocaleString('en-US')}`;
}

export default function CoursesScreen() {
  const [courses, setCourses] = useState<CourseWithDetails[]>([]);
  const [showInactive, setShowInactive] = useState(false);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setError(null);
      setCourses(await listCourses(true));
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not load courses.');
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, []);

  // Reload whenever the screen comes into view (e.g. back from editing)
  useFocusEffect(
    useCallback(() => {
      load();
    }, [load]),
  );

  const visible = useMemo(
    () => (showInactive ? courses : courses.filter((c) => c.is_active)),
    [courses, showInactive],
  );
  const inactiveCount = courses.filter((c) => !c.is_active).length;

  return (
    <View style={styles.screen}>
      <Stack.Screen options={{ title: 'Courses & batches' }} />

      {loading ? (
        <View style={styles.center}>
          <ActivityIndicator size="large" color={colors.primary} />
        </View>
      ) : (
        <ScrollView
          contentContainerStyle={styles.content}
          refreshControl={
            <RefreshControl
              refreshing={refreshing}
              onRefresh={() => {
                setRefreshing(true);
                load();
              }}
            />
          }
        >
          {error && (
            <View style={styles.errorBox}>
              <Text style={styles.errorText}>{error}</Text>
            </View>
          )}

          <Button
            title="Add course"
            onPress={() => router.push('/settings/courses/new' as Href)}
            fullWidth
          />

          {visible.length === 0 ? (
            <View style={styles.empty}>
              <Text style={styles.emptyTitle}>No courses yet</Text>
              <Text style={styles.emptyText}>
                Add the courses your institution offers, with their fees and batches.
              </Text>
            </View>
          ) : (
            visible.map((course) => (
              <CourseCard
                key={course.id}
                course={course}
                onPress={() => router.push(`/settings/courses/${course.id}` as Href)}
              />
            ))
          )}

          {inactiveCount > 0 && (
            <Button
              title={showInactive ? 'Hide switched-off courses' : `Show switched-off courses (${inactiveCount})`}
              variant="ghost"
              onPress={() => setShowInactive((s) => !s)}
            />
          )}
        </ScrollView>
      )}
    </View>
  );
}

// ---------------------------------------------------------------------
// One course card
// ---------------------------------------------------------------------
function CourseCard({ course, onPress }: { course: CourseWithDetails; onPress: () => void }) {
  const totalFee = course.course_fees.reduce((sum, f) => sum + Number(f.amount), 0);
  const openBatches = course.batches.filter((b) => b.is_active && b.status === 'open').length;
  const details = [course.category, course.duration].filter(Boolean).join(' · ');

  return (
    <Pressable
      onPress={onPress}
      style={({ pressed }) => [
        styles.card,
        !course.is_active && styles.cardInactive,
        pressed && styles.cardPressed,
      ]}
      accessibilityRole="button"
      accessibilityLabel={course.name}
    >
      <View style={styles.cardTop}>
        <Text style={styles.cardTitle} numberOfLines={1}>
          {course.name}
        </Text>
        {!course.is_active && <Text style={styles.offBadge}>Off</Text>}
      </View>

      {details !== '' && <Text style={styles.cardMeta}>{details}</Text>}

      <View style={styles.stats}>
        <View style={styles.stat}>
          <Text style={styles.statValue}>{totalFee > 0 ? formatTaka(totalFee) : '—'}</Text>
          <Text style={styles.statLabel}>Total fee</Text>
        </View>
        <View style={styles.stat}>
          <Text style={styles.statValue}>{openBatches}</Text>
          <Text style={styles.statLabel}>{openBatches === 1 ? 'Open batch' : 'Open batches'}</Text>
        </View>
        <View style={styles.stat}>
          <Text style={styles.statValue}>{course.course_fees.length}</Text>
          <Text style={styles.statLabel}>Fee items</Text>
        </View>
      </View>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.background },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  content: { padding: spacing.lg, gap: spacing.md, paddingBottom: spacing.xxl },
  card: {
    gap: spacing.sm,
    padding: spacing.lg,
    borderRadius: radius.lg,
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.border,
  },
  cardInactive: { opacity: 0.55 },
  cardPressed: { opacity: 0.7 },
  cardTop: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm },
  cardTitle: {
    flex: 1,
    fontSize: fontSize.title,
    fontWeight: fontWeight.bold,
    color: colors.text,
  },
  cardMeta: { fontSize: fontSize.small, color: colors.textMuted },
  offBadge: {
    fontSize: 11,
    fontWeight: fontWeight.bold,
    color: colors.danger,
    backgroundColor: colors.dangerSoft,
    paddingVertical: 2,
    paddingHorizontal: spacing.sm,
    borderRadius: radius.pill,
    overflow: 'hidden',
  },
  stats: {
    flexDirection: 'row',
    marginTop: spacing.xs,
    paddingTop: spacing.md,
    borderTopWidth: 1,
    borderTopColor: colors.border,
  },
  stat: { flex: 1, gap: 2 },
  statValue: { fontSize: fontSize.body, fontWeight: fontWeight.bold, color: colors.text },
  statLabel: { fontSize: fontSize.caption, color: colors.textMuted },
  empty: { alignItems: 'center', paddingVertical: spacing.xxl, gap: spacing.xs },
  emptyTitle: { fontSize: fontSize.body, fontWeight: fontWeight.bold, color: colors.text },
  emptyText: { fontSize: fontSize.small, color: colors.textMuted, textAlign: 'center' },
  errorBox: { padding: spacing.md, borderRadius: radius.md, backgroundColor: colors.dangerSoft },
  errorText: { fontSize: fontSize.small, color: colors.danger },
});