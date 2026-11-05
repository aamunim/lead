import { useEffect, useState } from 'react';
import { ActivityIndicator, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';

import { supabase } from '@/shared/lib/supabase';
import { colors, fontSize, fontWeight, radius, spacing } from '@/shared/theme';
import { Button } from '@/shared/ui/Button';
import { Modal } from '@/shared/ui/Modal';

// =====================================================================
// 📚 Leads → mark → Course (admins): give a course to many leads at once.
//   Only leads without any course get it; a lead that has a course is
//   left as it is (it is not changed).
// =====================================================================

type Preview = { ready: number; done: number; has_course: number; skipped: number; course: string };

export function BulkCourseSheet({
  ids,
  onClose,
  onDone,
}: {
  ids: string[];
  onClose: () => void;
  onDone: (message: string) => void;
}) {
  const [courses, setCourses] = useState<{ id: string; name: string }[] | null>(null);
  const [course, setCourse] = useState<string | null>(null);
  const [preview, setPreview] = useState<Preview | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    supabase
      .from('courses')
      .select('id, name')
      .eq('is_active', true)
      .order('sort_order')
      .order('name')
      .then(({ data }) => setCourses(data ?? []));
  }, []);

  useEffect(() => {
    setPreview(null);
    if (!course) return;
    let live = true;
    supabase
      .rpc('bulk_add_lead_course', { p_leads: ids, p_course: course, p_dry: true })
      .then(({ data, error: e }) => {
        if (!live) return;
        if (e) setError(e.message);
        else setPreview(data as unknown as Preview);
      });
    return () => {
      live = false;
    };
  }, [course, ids]);

  const run = async () => {
    if (!course) return;
    setSaving(true);
    setError(null);
    const { data, error: e } = await supabase.rpc('bulk_add_lead_course', { p_leads: ids, p_course: course, p_dry: false });
    setSaving(false);
    if (e) return setError(e.message);
    const r = data as unknown as Preview;
    onDone(`📚 ${r.done} ${r.done === 1 ? 'lead' : 'leads'} got ${r.course}.`);
  };

  return (
    <Modal visible transparent animationType="slide" onRequestClose={onClose}>
      <View style={styles.backdrop}>
        <Pressable style={styles.flex} onPress={saving ? undefined : onClose} accessibilityLabel="Close" />
        <View style={styles.sheet}>
          <ScrollView contentContainerStyle={styles.content}>
            <Text style={styles.title}>
              📚 Course for {ids.length} {ids.length === 1 ? 'lead' : 'leads'}
            </Text>
            <Text style={styles.small}>Only leads without a course get it. Leads that have one stay as they are.</Text>
            {courses === null ? (
              <ActivityIndicator color={colors.primary} />
            ) : (
              <View style={styles.chips}>
                {courses.map((c) => (
                  <Pressable
                    key={c.id}
                    onPress={() => setCourse(c.id)}
                    style={[styles.chip, course === c.id && styles.chipOn]}
                    accessibilityRole="radio"
                    accessibilityState={{ checked: course === c.id }}
                  >
                    <Text style={[styles.chipText, course === c.id && styles.chipTextOn]}>{c.name}</Text>
                  </Pressable>
                ))}
              </View>
            )}
            {preview && (
              <View style={styles.box}>
                <Text style={styles.line}>
                  {preview.ready > 0 ? `✅ ${preview.ready} will get ${preview.course}` : 'Nobody here is without a course.'}
                </Text>
                {preview.has_course > 0 && (
                  <Text style={styles.line}>⏭ {preview.has_course} have a course already (left as they are)</Text>
                )}
                {preview.skipped > 0 && <Text style={styles.line}>⏭ {preview.skipped} not found or deleted</Text>}
              </View>
            )}
            {error && <Text style={styles.error}>{error}</Text>}
            <Button
              title={preview && preview.ready > 0 ? `📚 Give it to ${preview.ready}` : 'Give the course'}
              onPress={run}
              loading={saving}
              disabled={!preview || preview.ready === 0}
              fullWidth
            />
            <Button title="Cancel" variant="ghost" onPress={onClose} fullWidth />
          </ScrollView>
        </View>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1 },
  backdrop: { flex: 1, backgroundColor: 'rgba(0,0,0,0.4)' },
  sheet: {
    maxHeight: '88%',
    width: '100%',
    maxWidth: 620,
    alignSelf: 'center',
    borderTopLeftRadius: radius.xl,
    borderTopRightRadius: radius.xl,
    backgroundColor: colors.surface,
  },
  content: { padding: spacing.lg, gap: spacing.sm, paddingBottom: spacing.xl },
  title: { fontSize: fontSize.title, fontWeight: fontWeight.bold, color: colors.text },
  small: { fontSize: fontSize.caption, color: colors.textMuted },
  chips: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.sm },
  chip: {
    paddingVertical: 7,
    paddingHorizontal: spacing.md,
    borderRadius: radius.pill,
    borderWidth: 1,
    borderColor: colors.border,
  },
  chipOn: { backgroundColor: colors.primary, borderColor: colors.primary },
  chipText: { fontSize: fontSize.small, fontWeight: fontWeight.semibold, color: colors.text },
  chipTextOn: { color: colors.textOnPrimary },
  box: {
    gap: 4,
    padding: spacing.md,
    borderRadius: radius.md,
    backgroundColor: colors.background,
    borderWidth: 1,
    borderColor: colors.border,
  },
  line: { fontSize: fontSize.small, color: colors.text, lineHeight: 20 },
  error: { fontSize: fontSize.small, color: colors.danger },
});
