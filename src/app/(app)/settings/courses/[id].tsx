import { router, Stack, useLocalSearchParams, type Href } from 'expo-router';
import { useCallback, useEffect, useState } from 'react';
import {
    ActivityIndicator,
    Modal,
    Pressable,
    ScrollView,
    StyleSheet,
    Switch,
    Text,
    TextInput,
    View,
} from 'react-native';
import { KeyboardAvoidingView, KeyboardAwareScrollView } from 'react-native-keyboard-controller';
import { SafeAreaView } from 'react-native-safe-area-context';

import {
    getCourse,
    saveBatch,
    saveCourse,
    saveCourseFees,
    type Batch,
} from '@/features/settings/api';
import { colors, fontSize, fontWeight, radius, spacing } from '@/shared/theme';
import { Button } from '@/shared/ui/Button';
import { TextField } from '@/shared/ui/TextField';
import { SectionsEditor } from '@/features/approval/SectionsEditor';

type FeeRow = { key: string; id?: string; name: string; amount: string };

type CourseForm = {
  name: string;
  category: string;
  duration: string;
  description: string;
  isActive: boolean;
};

const EMPTY_COURSE: CourseForm = {
  name: '',
  category: '',
  duration: '',
  description: '',
  isActive: true,
};

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
let rowCounter = 0;
const newRowKey = () => `row-${++rowCounter}`;

function formatTaka(amount: number): string {
  return `BDT ${Math.round(amount).toLocaleString('en-US')}`;
}

export default function CourseEditScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const isNew = id === 'new';

  const [form, setForm] = useState<CourseForm>(EMPTY_COURSE);
  const [fees, setFees] = useState<FeeRow[]>([]);
  const [batches, setBatches] = useState<Batch[]>([]);
  const [loading, setLoading] = useState(!isNew);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [savedMessage, setSavedMessage] = useState<string | null>(null);
  const [batchDraft, setBatchDraft] = useState<Partial<Batch> | null>(null);

  // --- load an existing course ---------------------------------------
  const load = useCallback(async () => {
    if (isNew || !id) return;
    try {
      setError(null);
      const course = await getCourse(id);
      if (!course) {
        setError('Course not found.');
        return;
      }
      setForm({
        name: course.name,
        category: course.category ?? '',
        duration: course.duration ?? '',
        description: course.description ?? '',
        isActive: course.is_active,
      });
      setFees(
        course.course_fees.map((f) => ({
          key: newRowKey(),
          id: f.id,
          name: f.name,
          amount: String(f.amount),
        })),
      );
      setBatches(course.batches);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not load this course.');
    } finally {
      setLoading(false);
    }
  }, [id, isNew]);

  useEffect(() => {
    load();
  }, [load]);

  const setField = <K extends keyof CourseForm>(key: K, value: CourseForm[K]) => {
    setForm((f) => ({ ...f, [key]: value }));
    setSavedMessage(null);
  };

  // --- fee rows --------------------------------------------------------
  const addFee = () => setFees((list) => [...list, { key: newRowKey(), name: '', amount: '' }]);
  const updateFee = (key: string, patch: Partial<FeeRow>) => {
    setFees((list) => list.map((f) => (f.key === key ? { ...f, ...patch } : f)));
    setSavedMessage(null);
  };
  const removeFee = (key: string) => setFees((list) => list.filter((f) => f.key !== key));

  const totalFee = fees.reduce((sum, f) => sum + (Number(f.amount) || 0), 0);

  // --- save course + fees ----------------------------------------------
  const handleSave = async () => {
    if (!form.name.trim()) {
      setError('Please enter the course name.');
      return;
    }

    // Ignore completely empty fee rows; check the rest
    const filled = fees.filter((f) => f.name.trim() || f.amount.trim());
    for (const f of filled) {
      if (!f.name.trim()) {
        setError('Every fee needs a name.');
        return;
      }
      const amount = Number(f.amount);
      if (f.amount.trim() === '' || Number.isNaN(amount) || amount < 0) {
        setError(`“${f.name}” needs a valid amount.`);
        return;
      }
    }

    setSaving(true);
    setError(null);
    try {
      const saved = await saveCourse({
        ...(isNew ? {} : { id }),
        name: form.name.trim(),
        category: form.category.trim() || null,
        duration: form.duration.trim() || null,
        description: form.description.trim() || null,
        is_active: form.isActive,
      });

      await saveCourseFees(
        saved.id,
        filled.map((f) => ({ id: f.id, name: f.name, amount: Number(f.amount) })),
      );

      if (isNew) {
        // Open the saved course so batches can be added
        router.replace(`/settings/courses/${saved.id}` as Href);
      } else {
        setSavedMessage('Saved');
        await load();
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not save the course.');
    } finally {
      setSaving(false);
    }
  };

  if (loading) {
    return (
      <View style={styles.center}>
        <Stack.Screen options={{ title: 'Course' }} />
        <ActivityIndicator size="large" color={colors.primary} />
      </View>
    );
  }

  return (
    <View style={styles.screen}>
      <Stack.Screen options={{ title: isNew ? 'New course' : form.name || 'Course' }} />

      <KeyboardAwareScrollView
        bottomOffset={spacing.xl}
        contentContainerStyle={styles.content}
        keyboardShouldPersistTaps="handled"
      >
        {/* Details */}
        <View style={styles.card}>
          <Text style={styles.sectionTitle}>Course details</Text>
          <TextField
            label="Course name"
            required
            value={form.name}
            onChangeText={(v) => setField('name', v)}
            placeholder="e.g. BBA"
          />
          <TextField
            label="Category"
            value={form.category}
            onChangeText={(v) => setField('category', v)}
            placeholder="e.g. Honours"
          />
          <TextField
            label="Duration"
            value={form.duration}
            onChangeText={(v) => setField('duration', v)}
            placeholder="e.g. 4 years / 8 semesters"
          />
          <TextField
            label="Description"
            value={form.description}
            onChangeText={(v) => setField('description', v)}
            multiline
          />
          <View style={styles.switchRow}>
            <View style={styles.switchText}>
              <Text style={styles.switchLabel}>Active</Text>
              <Text style={styles.switchHint}>Switched-off courses are hidden from new leads.</Text>
            </View>
            <Switch
              value={form.isActive}
              onValueChange={(v) => setField('isActive', v)}
              trackColor={{ true: colors.primary, false: colors.border }}
            />
          </View>
        </View>

        {/* Fees */}
        <View style={styles.card}>
          <View style={styles.sectionHeader}>
            <Text style={styles.sectionTitle}>Fees</Text>
            <Text style={styles.total}>Total {formatTaka(totalFee)}</Text>
          </View>

          {fees.length === 0 && (
            <Text style={styles.muted}>No fees yet. Add admission fee, tuition and others.</Text>
          )}

          {fees.map((f) => (
            <View key={f.key} style={styles.feeRow}>
              <TextInput
                value={f.name}
                onChangeText={(v) => updateFee(f.key, { name: v })}
                placeholder="Fee name"
                placeholderTextColor={colors.textMuted}
                style={[styles.feeInput, styles.feeName]}
                accessibilityLabel="Fee name"
              />
              <TextInput
                value={f.amount}
                onChangeText={(v) => updateFee(f.key, { amount: v })}
                placeholder="Amount"
                placeholderTextColor={colors.textMuted}
                keyboardType="decimal-pad"
                style={[styles.feeInput, styles.feeAmount]}
                accessibilityLabel="Fee amount"
              />
              <Pressable
                onPress={() => removeFee(f.key)}
                hitSlop={8}
                accessibilityLabel={`Remove ${f.name || 'fee'}`}
              >
                <Text style={styles.remove}>✕</Text>
              </Pressable>
            </View>
          ))}

          <Button title="+ Add fee" variant="secondary" onPress={addFee} />
        </View>

        {error && (
          <View style={styles.errorBox}>
            <Text style={styles.errorText}>{error}</Text>
          </View>
        )}

        <Button
          title={savedMessage ? 'Saved ✓' : isNew ? 'Create course' : 'Save course'}
          onPress={handleSave}
          loading={saving}
          fullWidth
        />

        {/* Batches */}
        <View style={styles.card}>
          <View style={styles.sectionHeader}>
            <Text style={styles.sectionTitle}>Batches</Text>
          </View>

          {isNew ? (
            <Text style={styles.muted}>Create the course first, then add its batches.</Text>
          ) : (
            <>
              {batches.length === 0 && (
                <Text style={styles.muted}>No batches yet, for example “January 2027”.</Text>
              )}

              {batches.map((b) => (
                <Pressable
                  key={b.id}
                  onPress={() => setBatchDraft(b)}
                  style={({ pressed }) => [
                    styles.batchRow,
                    !b.is_active && styles.batchInactive,
                    pressed && styles.batchPressed,
                  ]}
                  accessibilityRole="button"
                >
                  <View style={styles.batchBody}>
                    <Text style={styles.batchTitle}>{b.name}</Text>
                    <Text style={styles.batchMeta}>
                      {[b.start_date && `Starts ${b.start_date}`, b.class_time, b.seat_capacity != null && `${b.seat_capacity} seats`]
                        .filter(Boolean)
                        .join(' · ') || 'No details'}
                    </Text>
                  </View>
                  <Text style={[styles.statusPill, STATUS_STYLE[b.status as keyof typeof STATUS_STYLE]]}>
                    {b.is_active ? b.status : 'off'}
                  </Text>
                </Pressable>
              ))}

              <Button
                title="+ Add batch"
                variant="secondary"
                onPress={() => setBatchDraft({ status: 'open', is_active: true })}
              />
            </>
          )}
        </View>
      </KeyboardAwareScrollView>

      {batchDraft && !isNew && id && (
        <BatchModal
          courseId={id}
          initial={batchDraft}
          onClose={() => setBatchDraft(null)}
          onSaved={() => {
            setBatchDraft(null);
            load();
          }}
        />
      )}
    </View>
  );
}

// =====================================================================
// Add / edit a batch
// =====================================================================
function BatchModal({
  courseId,
  initial,
  onClose,
  onSaved,
}: {
  courseId: string;
  initial: Partial<Batch>;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [name, setName] = useState(initial.name ?? '');
  const [startDate, setStartDate] = useState(initial.start_date ?? '');
  const [classTime, setClassTime] = useState(initial.class_time ?? '');
  const [seats, setSeats] = useState(initial.seat_capacity != null ? String(initial.seat_capacity) : '');
  const [status, setStatus] = useState(initial.status ?? 'open');
  const [isActive, setIsActive] = useState(initial.is_active ?? true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleSave = async () => {
    if (!name.trim()) {
      setError('Please enter the batch name.');
      return;
    }
    if (startDate.trim() && !DATE_RE.test(startDate.trim())) {
      setError('Start date must look like 2027-01-15.');
      return;
    }
    const seatNumber = seats.trim() === '' ? null : Number(seats);
    if (seatNumber !== null && (!Number.isInteger(seatNumber) || seatNumber < 0)) {
      setError('Seats must be a whole number.');
      return;
    }

    setSaving(true);
    setError(null);
    try {
      await saveBatch({
        ...(initial.id ? { id: initial.id } : {}),
        course_id: courseId,
        name: name.trim(),
        start_date: startDate.trim() || null,
        class_time: classTime.trim() || null,
        seat_capacity: seatNumber,
        status,
        is_active: isActive,
      });
      onSaved();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not save the batch.');
      setSaving(false);
    }
  };

  return (
    <Modal visible animationType="slide" transparent onRequestClose={onClose}>
      <View style={styles.backdrop}>
        <KeyboardAvoidingView
          behavior="padding"
          style={styles.sheetWrap}
        >
          <SafeAreaView edges={['bottom']} style={styles.sheet}>
            <View style={styles.sheetHeader}>
              <Text style={styles.sheetTitle}>{initial.id ? 'Edit batch' : 'New batch'}</Text>
              <Pressable onPress={onClose} hitSlop={10} accessibilityLabel="Close">
                <Text style={styles.close}>✕</Text>
              </Pressable>
            </View>

            <ScrollView contentContainerStyle={styles.sheetContent} keyboardShouldPersistTaps="handled">
              <TextField label="Batch name" required value={name} onChangeText={setName} placeholder="e.g. January 2027" />
              <TextField
                label="Start date"
                value={startDate}
                onChangeText={setStartDate}
                placeholder="YYYY-MM-DD"
                keyboardType="numbers-and-punctuation"
                maxLength={10}
              />
              <TextField label="Class time" value={classTime} onChangeText={setClassTime} placeholder="e.g. Morning shift" />
              <TextField
                label="Seats"
                value={seats}
                onChangeText={setSeats}
                placeholder="e.g. 60"
                keyboardType="number-pad"
                hint="Leave empty for no limit"
              />

              <View style={styles.fieldBlock}>
                <Text style={styles.fieldLabel}>Status</Text>
                <View style={styles.chips}>
                  {(['open', 'closed', 'full'] as const).map((s) => (
                    <Pressable
                      key={s}
                      onPress={() => setStatus(s)}
                      style={[styles.chip, status === s && styles.chipSelected]}
                      accessibilityRole="radio"
                      accessibilityState={{ selected: status === s }}
                    >
                      <Text style={[styles.chipText, status === s && styles.chipTextSelected]}>
                        {s.charAt(0).toUpperCase() + s.slice(1)}
                      </Text>
                    </Pressable>
                  ))}
                </View>
              </View>

              <View style={styles.switchRow}>
                <View style={styles.switchText}>
                  <Text style={styles.switchLabel}>Active</Text>
                  <Text style={styles.switchHint}>Switched-off batches are hidden from new admissions.</Text>
                </View>
                <Switch
                  value={isActive}
                  onValueChange={setIsActive}
                  trackColor={{ true: colors.primary, false: colors.border }}
                />
              </View>

              {error && (
                <View style={styles.errorBox}>
                  <Text style={styles.errorText}>{error}</Text>
                </View>
              )}

              <Button title="Save batch" onPress={handleSave} loading={saving} fullWidth />

              {/* 🏫 Sections (saved right away, separate from the batch's Save) */}
              {initial.id ? (
                <SectionsEditor batchId={initial.id} />
              ) : (
                <Text style={styles.switchHint}>Save the batch first, then add its sections.</Text>
              )}
            </ScrollView>
          </SafeAreaView>
        </KeyboardAvoidingView>
      </View>
    </Modal>
  );
}

const STATUS_STYLE = {
  open: { backgroundColor: colors.successSoft, color: colors.success },
  closed: { backgroundColor: colors.background, color: colors.textMuted },
  full: { backgroundColor: colors.warningSoft, color: colors.warning },
};

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.background },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center', backgroundColor: colors.background },
  content: { padding: spacing.lg, gap: spacing.lg, paddingBottom: spacing.xxl },
  card: {
    gap: spacing.md,
    padding: spacing.lg,
    borderRadius: radius.lg,
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.border,
  },
  sectionHeader: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  sectionTitle: { fontSize: fontSize.body, fontWeight: fontWeight.bold, color: colors.text },
  total: { fontSize: fontSize.small, fontWeight: fontWeight.bold, color: colors.primary },
  muted: { fontSize: fontSize.small, color: colors.textMuted },
  switchRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.md },
  switchText: { flex: 1, gap: 2 },
  switchLabel: { fontSize: fontSize.body, fontWeight: fontWeight.semibold, color: colors.text },
  switchHint: { fontSize: fontSize.caption, color: colors.textMuted },
  feeRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm },
  feeInput: {
    minHeight: 44,
    paddingHorizontal: spacing.md,
    borderWidth: 1.5,
    borderColor: colors.border,
    borderRadius: radius.md,
    fontSize: fontSize.body,
    color: colors.text,
    backgroundColor: colors.surface,
  },
  feeName: { flex: 2 },
  feeAmount: { flex: 1 },
  remove: { fontSize: fontSize.body, color: colors.danger, paddingHorizontal: spacing.xs },
  batchRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
    padding: spacing.md,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.border,
  },
  batchInactive: { opacity: 0.55 },
  batchPressed: { backgroundColor: colors.background },
  batchBody: { flex: 1, gap: 2 },
  batchTitle: { fontSize: fontSize.body, fontWeight: fontWeight.semibold, color: colors.text },
  batchMeta: { fontSize: fontSize.caption, color: colors.textMuted },
  statusPill: {
    fontSize: fontSize.caption,
    fontWeight: fontWeight.bold,
    textTransform: 'capitalize',
    paddingVertical: 3,
    paddingHorizontal: spacing.sm,
    borderRadius: radius.pill,
    overflow: 'hidden',
  },
  errorBox: { padding: spacing.md, borderRadius: radius.md, backgroundColor: colors.dangerSoft },
  errorText: { fontSize: fontSize.small, color: colors.danger },

  // sheet
  backdrop: { flex: 1, backgroundColor: 'rgba(11,19,40,0.45)', justifyContent: 'flex-end' },
  sheetWrap: { maxHeight: '90%' },
  sheet: {
    backgroundColor: colors.surface,
    borderTopLeftRadius: radius.xl,
    borderTopRightRadius: radius.xl,
  },
  sheetHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    padding: spacing.lg,
    borderBottomWidth: 1,
    borderBottomColor: colors.border,
  },
  sheetTitle: { fontSize: fontSize.title, fontWeight: fontWeight.bold, color: colors.text },
  close: { fontSize: fontSize.title, color: colors.textMuted },
  sheetContent: { padding: spacing.lg, gap: spacing.lg },
  fieldBlock: { gap: spacing.sm },
  fieldLabel: { fontSize: fontSize.small, fontWeight: fontWeight.semibold, color: colors.text },
  chips: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.sm },
  chip: {
    paddingVertical: spacing.sm,
    paddingHorizontal: spacing.md,
    borderRadius: radius.pill,
    borderWidth: 1.5,
    borderColor: colors.border,
    backgroundColor: colors.surface,
  },
  chipSelected: { backgroundColor: colors.primary, borderColor: colors.primary },
  chipText: { fontSize: fontSize.small, fontWeight: fontWeight.semibold, color: colors.text },
  chipTextSelected: { color: colors.textOnPrimary },
});