import Ionicons from '@expo/vector-icons/Ionicons';
import { Stack } from 'expo-router';
import { useCallback, useEffect, useState } from 'react';
import {
    ActivityIndicator,
    Alert,
    KeyboardAvoidingView,
    Modal,
    Platform,
    Pressable,
    ScrollView,
    StyleSheet,
    Switch,
    Text,
    TextInput,
    View,
} from 'react-native';

import { useAuth } from '@/features/auth/AuthProvider';
import {
    createPaper,
    deletePaper,
    listAdmissionPapers,
    reorderPapers,
    updatePaper,
    type AdmissionPaper,
    type PaperInput,
} from '@/features/papers/api';
import { listActiveCourses, type Named } from '@/features/pipeline/api';
import { colors, fontSize, fontWeight, radius, spacing } from '@/shared/theme';
import { Button } from '@/shared/ui/Button';

export default function PapersSettingsScreen() {
  const { hasPermission } = useAuth();
  const canManage = hasPermission('settings.manage');

  const [papers, setPapers] = useState<AdmissionPaper[]>([]);
  const [courses, setCourses] = useState<Named[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [orderChanged, setOrderChanged] = useState(false);
  const [savingOrder, setSavingOrder] = useState(false);
  const [editing, setEditing] = useState<AdmissionPaper | 'new' | null>(null);

  const load = useCallback(async () => {
    try {
      setError(null);
      const [p, c] = await Promise.all([listAdmissionPapers(true), listActiveCourses()]);
      setPapers(p);
      setCourses(c);
      setOrderChanged(false);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not load the papers.');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const courseNames = (ids: string[]) =>
    ids.length === 0
      ? 'All courses'
      : ids.map((id) => courses.find((c) => c.id === id)?.name ?? 'Removed course').join(', ');

  const move = (index: number, by: -1 | 1) => {
    const to = index + by;
    if (to < 0 || to >= papers.length) return;
    setPapers((list) => {
      const next = [...list];
      [next[index], next[to]] = [next[to], next[index]];
      return next;
    });
    setOrderChanged(true);
  };

  const saveOrder = async () => {
    setSavingOrder(true);
    setError(null);
    try {
      await reorderPapers(papers.map((p) => p.id));
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not save the order.');
    } finally {
      setSavingOrder(false);
    }
  };

  // --- states -------------------------------------------------------------
  if (!canManage) {
    return (
      <View style={styles.center}>
        <Stack.Screen options={{ title: 'Required papers' }} />
        <Text style={styles.muted}>Only admins can change this list.</Text>
      </View>
    );
  }

  if (loading) {
    return (
      <View style={styles.center}>
        <Stack.Screen options={{ title: 'Required papers' }} />
        <ActivityIndicator size="large" color={colors.primary} />
      </View>
    );
  }

  return (
    <View style={styles.flex}>
      <ScrollView style={styles.screen} contentContainerStyle={styles.content}>
        <Stack.Screen options={{ title: 'Required papers' }} />

        <Text style={styles.intro}>
          Papers a student brings for admission. Each lead shows the papers for its course, with a tick for each one
          received.
        </Text>

        <View style={styles.card}>
          {papers.length === 0 && <Text style={styles.hint}>No papers yet. Add the first one below.</Text>}

          {papers.map((p, index) => (
            <View key={p.id}>
              {index > 0 && <View style={styles.divider} />}
              <View style={[styles.row, !p.isActive && styles.off]}>
                <Pressable
                  onPress={() => setEditing(p)}
                  style={({ pressed }) => [styles.rowMain, pressed && styles.pressed]}
                  accessibilityRole="button"
                  accessibilityLabel={`Edit ${p.name}`}
                >
                  <Text style={styles.icon}>📄</Text>
                  <View style={styles.flex}>
                    <Text style={styles.rowTitle}>
                      {p.name}
                      {!p.isActive ? '  (off)' : ''}
                    </Text>
                    <Text style={styles.rowText}>
                      <Text style={p.isRequired ? styles.required : styles.optional}>
                        {p.isRequired ? 'Required' : 'Optional'}
                      </Text>
                      {' · '}
                      {courseNames(p.courseIds)}
                    </Text>
                  </View>
                </Pressable>
                <View style={styles.arrows}>
                  <ArrowButton icon="chevron-up" disabled={index === 0} onPress={() => move(index, -1)} />
                  <ArrowButton
                    icon="chevron-down"
                    disabled={index === papers.length - 1}
                    onPress={() => move(index, 1)}
                  />
                </View>
              </View>
            </View>
          ))}

          <Pressable
            onPress={() => setEditing('new')}
            style={({ pressed }) => [styles.addRow, pressed && styles.pressed]}
            accessibilityRole="button"
          >
            <Ionicons name="add-circle" size={22} color={colors.primary} />
            <Text style={styles.addText}>Add paper</Text>
          </Pressable>
        </View>

        {orderChanged && <Button title="Save order" onPress={saveOrder} loading={savingOrder} fullWidth />}

        <Text style={styles.hint}>
          Admitting with required papers missing (block / warn / allow) is set in Settings → Admission rules.
        </Text>

        {error && (
          <View style={styles.errorBox}>
            <Text style={styles.errorText}>{error}</Text>
          </View>
        )}
      </ScrollView>

      {editing && (
        <PaperSheet
          paper={editing === 'new' ? null : editing}
          courses={courses}
          nextOrder={papers.length + 1}
          onClose={() => setEditing(null)}
          onSaved={() => {
            setEditing(null);
            load();
          }}
        />
      )}
    </View>
  );
}

function ArrowButton({
  icon,
  disabled,
  onPress,
}: {
  icon: 'chevron-up' | 'chevron-down';
  disabled: boolean;
  onPress: () => void;
}) {
  return (
    <Pressable
      onPress={onPress}
      disabled={disabled}
      hitSlop={6}
      style={({ pressed }) => [styles.arrow, pressed && styles.pressed]}
      accessibilityRole="button"
      accessibilityLabel={icon === 'chevron-up' ? 'Move up' : 'Move down'}
    >
      <Ionicons name={icon} size={20} color={disabled ? colors.border : colors.text} />
    </Pressable>
  );
}

// =====================================================================
// Add / edit a paper
// =====================================================================
function PaperSheet({
  paper,
  courses,
  nextOrder,
  onClose,
  onSaved,
}: {
  paper: AdmissionPaper | null;
  courses: Named[];
  nextOrder: number;
  onClose: () => void;
  onSaved: () => void;
}) {
  const isNew = !paper;
  const [form, setForm] = useState<PaperInput>({
    name: paper?.name ?? '',
    description: paper?.description ?? '',
    isRequired: paper?.isRequired ?? true,
    courseIds: paper?.courseIds ?? [],
    isActive: paper?.isActive ?? true,
  });
  const [someCourses, setSomeCourses] = useState((paper?.courseIds.length ?? 0) > 0);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const set = <K extends keyof PaperInput>(key: K, value: PaperInput[K]) => {
    setForm((f) => ({ ...f, [key]: value }));
    setError(null);
  };

  const toggleCourse = (id: string) =>
    set('courseIds', form.courseIds.includes(id) ? form.courseIds.filter((c) => c !== id) : [...form.courseIds, id]);

  const save = async () => {
    if (!form.name.trim()) {
      setError('Please give the paper a name.');
      return;
    }
    if (someCourses && form.courseIds.length === 0) {
      setError('Choose at least one course, or pick “All courses”.');
      return;
    }
    const input: PaperInput = { ...form, courseIds: someCourses ? form.courseIds : [] };

    setSaving(true);
    setError(null);
    try {
      if (isNew) await createPaper(input, nextOrder);
      else await updatePaper(paper.id, input);
      onSaved();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not save the paper.');
    } finally {
      setSaving(false);
    }
  };

  const remove = () => {
    if (!paper) return;
    Alert.alert('Remove this paper?', `"${paper.name}" will be removed from the list.`, [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Remove',
        style: 'destructive',
        onPress: async () => {
          try {
            await deletePaper(paper.id);
            onSaved();
          } catch (e) {
            setError(e instanceof Error ? e.message : 'Could not remove the paper.');
          }
        },
      },
    ]);
  };

  return (
    <Modal visible transparent animationType="slide" onRequestClose={onClose}>
      <KeyboardAvoidingView style={styles.backdrop} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
        <Pressable style={styles.flex} onPress={saving ? undefined : onClose} accessibilityLabel="Close" />
        <View style={styles.sheet}>
          <View style={styles.handle} />
          <ScrollView contentContainerStyle={styles.sheetContent} keyboardShouldPersistTaps="handled">
            <Text style={styles.sheetTitle}>{isNew ? 'Add paper' : 'Edit paper'}</Text>

            <View style={styles.field}>
              <Text style={styles.label}>Name *</Text>
              <TextInput
                value={form.name}
                onChangeText={(t) => set('name', t)}
                placeholder="e.g. SSC certificate"
                placeholderTextColor={colors.textMuted}
                maxLength={60}
                style={styles.input}
              />
            </View>

            <View style={styles.field}>
              <Text style={styles.label}>Note for staff (optional)</Text>
              <TextInput
                value={form.description ?? ''}
                onChangeText={(t) => set('description', t)}
                placeholder="e.g. Original + 2 photocopies"
                placeholderTextColor={colors.textMuted}
                maxLength={120}
                style={styles.input}
              />
            </View>

            <View style={styles.row}>
              <View style={styles.flex}>
                <Text style={styles.rowTitleSmall}>Required</Text>
                <Text style={styles.rowText}>
                  {form.isRequired ? 'Counted in “3 of 5 required”.' : 'Optional: shown, but not counted.'}
                </Text>
              </View>
              <Switch value={form.isRequired} onValueChange={(v) => set('isRequired', v)} />
            </View>

            {/* Courses */}
            <View style={styles.field}>
              <Text style={styles.label}>For which courses</Text>
              <View style={styles.chips}>
                <Pressable
                  onPress={() => setSomeCourses(false)}
                  style={[styles.chip, !someCourses && styles.chipOn]}
                  accessibilityRole="radio"
                  accessibilityState={{ checked: !someCourses }}
                >
                  <Text style={[styles.chipText, !someCourses && styles.chipTextOn]}>All courses</Text>
                </Pressable>
                <Pressable
                  onPress={() => setSomeCourses(true)}
                  style={[styles.chip, someCourses && styles.chipOn]}
                  accessibilityRole="radio"
                  accessibilityState={{ checked: someCourses }}
                >
                  <Text style={[styles.chipText, someCourses && styles.chipTextOn]}>Only some courses</Text>
                </Pressable>
              </View>

              {someCourses &&
                (courses.length === 0 ? (
                  <Text style={styles.hint}>No courses yet.</Text>
                ) : (
                  <View style={styles.courseList}>
                    {courses.map((c) => {
                      const on = form.courseIds.includes(c.id);
                      return (
                        <Pressable
                          key={c.id}
                          onPress={() => toggleCourse(c.id)}
                          style={({ pressed }) => [styles.row, pressed && styles.pressed]}
                          accessibilityRole="checkbox"
                          accessibilityState={{ checked: on }}
                        >
                          <View style={[styles.check, on && styles.checkOn]}>
                            {on && <Ionicons name="checkmark" size={16} color={colors.textOnPrimary} />}
                          </View>
                          <Text style={styles.rowTitleSmall}>{c.name}</Text>
                        </Pressable>
                      );
                    })}
                  </View>
                ))}
              <Text style={styles.hint}>
                A lead sees the papers of its admitted course, or of the courses it is interested in.
              </Text>
            </View>

            {!isNew && (
              <View style={styles.row}>
                <View style={styles.flex}>
                  <Text style={styles.rowTitleSmall}>Paper is on</Text>
                  <Text style={styles.rowText}>Switched off: hidden on new leads; ticks already given stay.</Text>
                </View>
                <Switch value={form.isActive ?? true} onValueChange={(v) => set('isActive', v)} />
              </View>
            )}

            {error && (
              <View style={styles.errorBox}>
                <Text style={styles.errorText}>{error}</Text>
              </View>
            )}

            <Button title={isNew ? 'Add paper' : 'Save'} onPress={save} loading={saving} fullWidth />
            {!isNew && <Button title="Remove paper" variant="ghost" onPress={remove} disabled={saving} fullWidth />}
            <Button title="Cancel" variant="ghost" onPress={onClose} disabled={saving} fullWidth />
          </ScrollView>
        </View>
      </KeyboardAvoidingView>
    </Modal>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1 },
  screen: { flex: 1, backgroundColor: colors.background },
  content: { padding: spacing.lg, gap: spacing.md, paddingBottom: spacing.xxl },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: spacing.xl, backgroundColor: colors.background },
  pressed: { opacity: 0.7 },
  off: { opacity: 0.5 },
  intro: { fontSize: fontSize.small, lineHeight: 20, color: colors.textMuted },
  card: {
    gap: spacing.sm,
    padding: spacing.lg,
    borderRadius: radius.lg,
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.border,
  },
  divider: { height: 1, backgroundColor: colors.border, marginVertical: spacing.xs },
  row: { flexDirection: 'row', alignItems: 'center', gap: spacing.md, paddingVertical: spacing.xs },
  rowMain: { flex: 1, flexDirection: 'row', alignItems: 'center', gap: spacing.md },
  icon: { fontSize: 18 },
  rowTitle: { fontSize: fontSize.body, fontWeight: fontWeight.semibold, color: colors.text },
  rowTitleSmall: { fontSize: fontSize.small, fontWeight: fontWeight.semibold, color: colors.text },
  rowText: { fontSize: fontSize.caption, lineHeight: 18, color: colors.textMuted, marginTop: 2 },
  required: { color: colors.danger, fontWeight: fontWeight.bold },
  optional: { color: colors.textMuted, fontWeight: fontWeight.semibold },
  arrows: { flexDirection: 'row', gap: 2 },
  arrow: {
    width: 34,
    height: 34,
    borderRadius: radius.md,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: colors.background,
  },
  addRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm, paddingVertical: spacing.sm, marginTop: spacing.xs },
  addText: { fontSize: fontSize.body, fontWeight: fontWeight.bold, color: colors.primary },
  hint: { fontSize: fontSize.caption, lineHeight: 18, color: colors.textMuted },
  muted: { fontSize: fontSize.small, color: colors.textMuted },
  errorBox: { padding: spacing.md, borderRadius: radius.md, backgroundColor: colors.dangerSoft },
  errorText: { fontSize: fontSize.small, color: colors.danger },

  // Sheet
  backdrop: { flex: 1, backgroundColor: 'rgba(0,0,0,0.4)' },
  sheet: {
    maxHeight: '92%',
    backgroundColor: colors.surface,
    borderTopLeftRadius: radius.lg,
    borderTopRightRadius: radius.lg,
  },
  handle: {
    alignSelf: 'center',
    width: 40,
    height: 4,
    borderRadius: radius.pill,
    backgroundColor: colors.border,
    marginTop: spacing.sm,
  },
  sheetContent: { padding: spacing.lg, gap: spacing.lg, paddingBottom: spacing.xxl },
  sheetTitle: { fontSize: fontSize.title, fontWeight: fontWeight.bold, color: colors.text },
  field: { gap: spacing.sm },
  label: { fontSize: fontSize.small, fontWeight: fontWeight.semibold, color: colors.text },
  input: {
    minHeight: 44,
    paddingHorizontal: spacing.md,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.border,
    fontSize: fontSize.body,
    color: colors.text,
  },
  chips: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.sm },
  chip: {
    paddingVertical: 6,
    paddingHorizontal: spacing.md,
    borderRadius: radius.pill,
    borderWidth: 1.5,
    borderColor: colors.border,
  },
  chipOn: { backgroundColor: colors.primary, borderColor: colors.primary },
  chipText: { fontSize: fontSize.small, fontWeight: fontWeight.semibold, color: colors.text },
  chipTextOn: { color: colors.textOnPrimary },
  courseList: { gap: spacing.xs, paddingLeft: spacing.xs },
  check: {
    width: 24,
    height: 24,
    borderRadius: radius.sm,
    borderWidth: 2,
    borderColor: colors.border,
    alignItems: 'center',
    justifyContent: 'center',
  },
  checkOn: { backgroundColor: colors.primary, borderColor: colors.primary },
});