import { useEffect, useState } from 'react';
import { ActivityIndicator, Pressable, StyleSheet, Text, View } from 'react-native';

import { setUserCourses } from '@/features/roles/api';
import type { RoleOption } from '@/features/users/api';
import { supabase } from '@/shared/lib/supabase';
import { colors, fontSize, fontWeight, radius, spacing } from '@/shared/theme';

// 🎓 Users → a person: the courses they see (like their role, or only some)
export function PersonCourses({
  userId,
  value,
  role,
  onSaved,
}: {
  userId: string;
  /** null = like the role */
  value: string[] | null;
  role: RoleOption | null;
  onSaved: () => void;
}) {
  const [courses, setCourses] = useState<{ id: string; name: string }[]>([]);
  const [own, setOwn] = useState<string[] | null>(value);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    supabase
      .from('courses')
      .select('id, name')
      .eq('is_alumni' as never, false as never)
      .order('sort_order')
      .order('name')
      .then(({ data }) => setCourses(data ?? []));
  }, []);
  useEffect(() => setOwn(value), [value]);

  const names = (ids: string[] | null | undefined) =>
    !ids
      ? 'every course'
      : ids
          .map((id) => courses.find((c) => c.id === id)?.name)
          .filter(Boolean)
          .join(', ') || 'no course';

  const save = async (next: string[] | null) => {
    setOwn(next);
    if (next && next.length === 0) return; // pick at least one first
    setBusy(true);
    setError(null);
    try {
      await setUserCourses(userId, next);
      onSaved();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not save.');
    } finally {
      setBusy(false);
    }
  };

  const toggle = (id: string) => {
    const now = own ?? [];
    save(now.includes(id) ? now.filter((x) => x !== id) : [...now, id]);
  };

  return (
    <View style={styles.card}>
      <Text style={styles.title}>🎓 Courses</Text>
      <View style={styles.chips}>
        <Chip text={`Like the role (${names(role?.course_ids)})`} on={own === null} onPress={() => save(null)} />
        <Chip text="Only these" on={own !== null} onPress={() => setOwn(own ?? [])} />
      </View>
      {own !== null && (
        <View style={styles.chips}>
          {courses.map((c) => (
            <Chip key={c.id} text={c.name} on={own.includes(c.id)} onPress={() => toggle(c.id)} />
          ))}
        </View>
      )}
      {busy && <ActivityIndicator color={colors.primary} />}
      {error && <Text style={styles.error}>{error}</Text>}
      <Text style={styles.hint}>
        Leads and students of other courses are hidden from them. Admins (Settings permission) always see every course.
      </Text>
    </View>
  );
}

function Chip({ text, on, onPress }: { text: string; on: boolean; onPress: () => void }) {
  return (
    <Pressable
      onPress={onPress}
      style={[styles.chip, on && styles.chipOn]}
      accessibilityRole="button"
      accessibilityState={{ selected: on }}
    >
      <Text style={[styles.chipText, on && styles.chipTextOn]}>{text}</Text>
    </Pressable>
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
  title: { fontSize: fontSize.body, fontWeight: fontWeight.bold, color: colors.text },
  chips: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.sm },
  chip: {
    paddingVertical: 6,
    paddingHorizontal: spacing.md,
    borderRadius: radius.pill,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.surface,
  },
  chipOn: { backgroundColor: colors.primary, borderColor: colors.primary },
  chipText: { fontSize: fontSize.small, fontWeight: fontWeight.semibold, color: colors.text },
  chipTextOn: { color: colors.textOnPrimary },
  error: { fontSize: fontSize.small, color: colors.danger },
  hint: { fontSize: fontSize.caption, color: colors.textMuted },
});
