import { useEffect, useState } from 'react';
import { ActivityIndicator, StyleSheet, Text, View } from 'react-native';

import { MIcon, md, Tap } from '@/features/home/md';
import { listAlumniCourses, type CourseWithDetails } from '@/features/settings/api';
import { colors, fontSize, radius, spacing } from '@/shared/theme';
import { Button } from '@/shared/ui/Button';

import { Sheet } from './sheets';
import { Chip, s as ui } from './ui';

// =====================================================================
// 🎓 Choose an alumni course (and a batch if you want): every new alumnus
//   needs one. Only alumni courses show (Settings → Alumni → Alumni courses).
// =====================================================================

export function AlumniCoursePicker({
  title,
  saveLabel = 'Save',
  courses: given,
  onPick,
  onClose,
}: {
  title: string;
  saveLabel?: string;
  /** already loaded (else they are loaded here) */
  courses?: CourseWithDetails[];
  onPick: (courseId: string, batchId: string | null) => void | Promise<void>;
  onClose: () => void;
}) {
  const [courses, setCourses] = useState<CourseWithDetails[] | null>(given ?? null);
  const [course, setCourse] = useState<string | null>(null);
  const [batch, setBatch] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (given) return;
    listAlumniCourses()
      .then(setCourses)
      .catch((e) => {
        setCourses([]);
        setError(e instanceof Error ? e.message : 'Could not load the courses.');
      });
  }, [given]);

  const batches = courses?.find((c) => c.id === course)?.batches ?? [];
  const save = async () => {
    if (!course) return;
    setBusy(true);
    setError(null);
    try {
      await onPick(course, batch);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not save.');
      setBusy(false);
    }
  };

  return (
    <Sheet title={title} onClose={onClose}>
      {courses === null ? (
        <ActivityIndicator color={colors.primary} />
      ) : courses.length === 0 ? (
        <Text style={ui.muted}>
          No alumni course yet. An admin can add one in Settings → Alumni → Alumni courses (or make a lead course an
          alumni course in Settings → Courses).
        </Text>
      ) : (
        courses.map((c) => {
          const on = course === c.id;
          return (
            <Tap
              key={c.id}
              onPress={() => {
                setCourse(c.id);
                setBatch(null);
              }}
              style={[styles.option, on && styles.optionOn]}
              label={c.name}
            >
              <MIcon
                name={on ? 'radio-button-checked' : 'radio-button-unchecked'}
                color={on ? colors.primary : colors.textMuted}
              />
              <Text style={styles.optionText}>{c.name}</Text>
            </Tap>
          );
        })
      )}
      {batches.length > 0 && (
        <>
          <Text style={ui.label}>BATCH (IF YOU WANT)</Text>
          <View style={ui.chips}>
            <Chip text="No batch" on={!batch} onPress={() => setBatch(null)} />
            {batches.map((b) => (
              <Chip key={b.id} text={b.name} on={batch === b.id} onPress={() => setBatch(b.id)} />
            ))}
          </View>
        </>
      )}
      {error && <Text style={ui.error}>{error}</Text>}
      <View style={styles.buttons}>
        <View style={styles.flex}>
          <Button title="Cancel" variant="ghost" onPress={onClose} fullWidth />
        </View>
        <View style={styles.flex}>
          <Button title={saveLabel} onPress={save} loading={busy} disabled={!course} fullWidth />
        </View>
      </View>
    </Sheet>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1 },
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
  buttons: { flexDirection: 'row', gap: spacing.sm, paddingTop: spacing.sm },
});
