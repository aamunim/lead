import Ionicons from '@expo/vector-icons/Ionicons';
import { Stack } from 'expo-router';
import { useCallback, useEffect, useState } from 'react';
import {
    ActivityIndicator,
    Alert,
    Modal,
    Pressable,
    ScrollView,
    StyleSheet,
    Switch,
    Text,
    TextInput,
    View,
} from 'react-native';
import { KeyboardAvoidingView } from 'react-native-keyboard-controller';

import { useAuth } from '@/features/auth/AuthProvider';
import {
    KIND_INFO,
    STAGE_COLORS,
    createStage,
    deleteStage,
    listPipelineStages,
    reorderOpenStages,
    stageLeadCounts,
    updateStage,
    type PipelineStage,
    type StageInput,
} from '@/features/pipeline/api';
import { colors, fontSize, fontWeight, radius, spacing } from '@/shared/theme';
import { Button } from '@/shared/ui/Button';

/** Next call after moving to a stage (null = none) */
const FOLLOW_UP_DAYS: (number | null)[] = [null, 0, 1, 2, 3, 7, 14];

const daysLabel = (d: number | null) =>
  d == null ? 'None' : d === 0 ? 'Same day' : `${d} ${d === 1 ? 'day' : 'days'}`;

export default function StagesScreen() {
  const { hasPermission } = useAuth();
  const canManage = hasPermission('settings.manage');

  const [open, setOpen] = useState<PipelineStage[]>([]);
  const [final, setFinal] = useState<PipelineStage[]>([]);
  const [counts, setCounts] = useState<Map<string, number>>(new Map());
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [orderChanged, setOrderChanged] = useState(false);
  const [savingOrder, setSavingOrder] = useState(false);

  // Edit sheet: a stage, or "new"
  const [editing, setEditing] = useState<PipelineStage | 'new' | null>(null);

  const load = useCallback(async () => {
    try {
      setError(null);
      const [stages, c] = await Promise.all([listPipelineStages(true), stageLeadCounts()]);
      setOpen(stages.filter((s) => s.kind === 'open'));
      setFinal(stages.filter((s) => s.kind !== 'open'));
      setCounts(c);
      setOrderChanged(false);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not load the stages.');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const move = (index: number, by: -1 | 1) => {
    const to = index + by;
    if (to < 0 || to >= open.length) return;
    setOpen((list) => {
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
      await reorderOpenStages(open.filter((s) => s.isActive).map((s) => s.id));
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
        <Stack.Screen options={{ title: 'Pipeline stages' }} />
        <Text style={styles.muted}>Only admins can change stages.</Text>
      </View>
    );
  }

  if (loading) {
    return (
      <View style={styles.center}>
        <Stack.Screen options={{ title: 'Pipeline stages' }} />
        <ActivityIndicator size="large" color={colors.primary} />
      </View>
    );
  }

  return (
    <View style={styles.flex}>
      <ScrollView style={styles.screen} contentContainerStyle={styles.content}>
        <Stack.Screen options={{ title: 'Pipeline stages' }} />

        <Text style={styles.intro}>
          The steps a lead goes through. Tap a stage to change it, use ▲▼ to change the order.
        </Text>

        {/* Open stages */}
        <Text style={styles.sectionLabel}>STAGES</Text>
        <View style={styles.card}>
          {open.map((s, index) => (
            <View key={s.id}>
              {index > 0 && <View style={styles.divider} />}
              <View style={[styles.row, !s.isActive && styles.off]}>
                <Pressable
                  onPress={() => setEditing(s)}
                  style={({ pressed }) => [styles.rowMain, pressed && styles.pressed]}
                  accessibilityRole="button"
                  accessibilityLabel={`Edit ${s.name}`}
                >
                  <View style={[styles.dot, { backgroundColor: s.color }]} />
                  <View style={styles.flex}>
                    <Text style={styles.rowTitle}>
                      {s.name}
                      {!s.isActive ? '  (off)' : ''}
                    </Text>
                    <StageBadges stage={s} count={counts.get(s.id) ?? 0} />
                  </View>
                </Pressable>
                <View style={styles.arrows}>
                  <ArrowButton icon="chevron-up" disabled={index === 0} onPress={() => move(index, -1)} />
                  <ArrowButton icon="chevron-down" disabled={index === open.length - 1} onPress={() => move(index, 1)} />
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
            <Text style={styles.addText}>Add stage</Text>
          </Pressable>
        </View>

        {orderChanged && (
          <Button title="Save order" onPress={saveOrder} loading={savingOrder} fullWidth />
        )}

        {/* Final stages */}
        <Text style={styles.sectionLabel}>FINAL STAGES</Text>
        <View style={styles.card}>
          {final.map((s, index) => (
            <View key={s.id}>
              {index > 0 && <View style={styles.divider} />}
              <Pressable
                onPress={() => setEditing(s)}
                style={({ pressed }) => [styles.row, pressed && styles.pressed]}
                accessibilityRole="button"
                accessibilityLabel={`Edit ${s.name}`}
              >
                <Text style={styles.finalIcon}>{KIND_INFO[s.kind].icon}</Text>
                <View style={styles.flex}>
                  <Text style={styles.rowTitle}>{s.name}</Text>
                  <Text style={styles.rowText}>
                    {counts.get(s.id) ?? 0} leads · set with “Mark admitted” / “Mark lost”
                  </Text>
                </View>
                <Ionicons name="lock-closed" size={16} color={colors.textMuted} />
              </Pressable>
            </View>
          ))}
          <Text style={styles.hint}>
            These always come last and can’t be removed. You can change their name and colour.
          </Text>
        </View>

        {error && (
          <View style={styles.errorBox}>
            <Text style={styles.errorText}>{error}</Text>
          </View>
        )}
      </ScrollView>

      {editing && (
        <StageSheet
          stage={editing === 'new' ? null : editing}
          leadCount={editing === 'new' ? 0 : counts.get(editing.id) ?? 0}
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

// =====================================================================
// Small badges under a stage name
// =====================================================================
function StageBadges({ stage, count }: { stage: PipelineStage; count: number }) {
  const parts: string[] = [`${count} ${count === 1 ? 'lead' : 'leads'}`];
  if (stage.askDate) parts.push(`📅 asks ${stage.dateLabel?.toLowerCase() || 'date & time'}`);
  else if (stage.followUpDays != null) parts.push(`⏰ next call ${daysLabel(stage.followUpDays).toLowerCase()}`);
  if (stage.noteRequired) parts.push('✎ note');
  return <Text style={styles.rowText}>{parts.join(' · ')}</Text>;
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
// Add / edit a stage
// =====================================================================
function StageSheet({
  stage,
  leadCount,
  onClose,
  onSaved,
}: {
  stage: PipelineStage | null;
  leadCount: number;
  onClose: () => void;
  onSaved: () => void;
}) {
  const isNew = !stage;
  const isFinal = !!stage && stage.kind !== 'open';

  const [form, setForm] = useState<StageInput>({
    name: stage?.name ?? '',
    color: stage?.color ?? STAGE_COLORS[0],
    followUpDays: stage?.followUpDays ?? null,
    noteRequired: stage?.noteRequired ?? false,
    askDate: stage?.askDate ?? false,
    dateLabel: stage?.dateLabel ?? '',
  });
  const [active, setActive] = useState(stage?.isActive ?? true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const set = <K extends keyof StageInput>(key: K, value: StageInput[K]) => {
    setForm((f) => ({ ...f, [key]: value }));
    setError(null);
  };

  const save = async () => {
    if (!form.name.trim()) {
      setError('Please give the stage a name.');
      return;
    }
    if (!active && leadCount > 0) {
      setError(`${leadCount} leads are in this stage. Move them first before switching it off.`);
      return;
    }
    setSaving(true);
    setError(null);
    try {
      if (isNew) {
        await createStage(form);
      } else if (isFinal) {
        await updateStage(stage.id, { name: form.name, color: form.color });
      } else {
        await updateStage(stage.id, { ...form, isActive: active });
      }
      onSaved();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not save the stage.');
    } finally {
      setSaving(false);
    }
  };

  const remove = () => {
    if (!stage) return;
    if (leadCount > 0) {
      Alert.alert('Can’t remove', `${leadCount} leads are in "${stage.name}". Move them to another stage first.`);
      return;
    }
    Alert.alert('Remove this stage?', `"${stage.name}" will be removed.`, [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Remove',
        style: 'destructive',
        onPress: async () => {
          try {
            await deleteStage(stage.id);
            onSaved();
          } catch (e) {
            setError(e instanceof Error ? e.message : 'Could not remove the stage.');
          }
        },
      },
    ]);
  };

  return (
    <Modal visible transparent animationType="slide" onRequestClose={onClose}>
      <KeyboardAvoidingView style={styles.backdrop} behavior="padding">
        <Pressable style={styles.flex} onPress={saving ? undefined : onClose} accessibilityLabel="Close" />
        <View style={styles.sheet}>
          <View style={styles.handle} />
          <ScrollView contentContainerStyle={styles.sheetContent} keyboardShouldPersistTaps="handled">
            <Text style={styles.sheetTitle}>{isNew ? 'Add stage' : isFinal ? 'Final stage' : 'Edit stage'}</Text>

            {/* Name */}
            <View style={styles.field}>
              <Text style={styles.label}>Name *</Text>
              <TextInput
                value={form.name}
                onChangeText={(t) => set('name', t)}
                placeholder="e.g. Interview"
                placeholderTextColor={colors.textMuted}
                maxLength={40}
                style={styles.input}
              />
            </View>

            {/* Colour */}
            <View style={styles.field}>
              <Text style={styles.label}>Colour</Text>
              <View style={styles.colors}>
                {STAGE_COLORS.map((c) => {
                  const on = form.color.toLowerCase() === c.toLowerCase();
                  return (
                    <Pressable
                      key={c}
                      onPress={() => set('color', c)}
                      style={[styles.colorDot, { backgroundColor: c }, on && styles.colorDotOn]}
                      accessibilityRole="radio"
                      accessibilityState={{ checked: on }}
                      accessibilityLabel={c}
                    >
                      {on && <Ionicons name="checkmark" size={16} color="#fff" />}
                    </Pressable>
                  );
                })}
              </View>
            </View>

            {isFinal ? (
              <Text style={styles.hint}>
                This stage is used by “Mark admitted” / “Mark lost”. Only its name and colour can change.
              </Text>
            ) : (
              <>
                {/* Ask for a date */}
                <View style={styles.ruleBox}>
                  <View style={styles.row}>
                    <View style={styles.flex}>
                      <Text style={styles.rowTitleSmall}>📅 Ask for a date & time</Text>
                      <Text style={styles.rowText}>
                        When a lead is moved here, pick when (e.g. the visit). A reminder is set for that time.
                      </Text>
                    </View>
                    <Switch value={form.askDate} onValueChange={(v) => set('askDate', v)} />
                  </View>
                  {form.askDate && (
                    <TextInput
                      value={form.dateLabel ?? ''}
                      onChangeText={(t) => set('dateLabel', t)}
                      placeholder="What is it called? e.g. Visit date & time"
                      placeholderTextColor={colors.textMuted}
                      maxLength={40}
                      style={styles.input}
                    />
                  )}
                </View>

                {/* Next call after N days (only without a picked date) */}
                {!form.askDate && (
                  <View style={styles.field}>
                    <Text style={styles.label}>⏰ Next call after moving here</Text>
                    <View style={styles.chips}>
                      {FOLLOW_UP_DAYS.map((d) => {
                        const on = form.followUpDays === d;
                        return (
                          <Pressable
                            key={String(d)}
                            onPress={() => set('followUpDays', d)}
                            style={[styles.chip, on && styles.chipOn]}
                            accessibilityRole="radio"
                            accessibilityState={{ checked: on }}
                          >
                            <Text style={[styles.chipText, on && styles.chipTextOn]}>{daysLabel(d)}</Text>
                          </Pressable>
                        );
                      })}
                    </View>
                  </View>
                )}

                {/* Note required */}
                <View style={styles.row}>
                  <View style={styles.flex}>
                    <Text style={styles.rowTitleSmall}>✎ Note required</Text>
                    <Text style={styles.rowText}>Ask why when a lead is moved here.</Text>
                  </View>
                  <Switch value={form.noteRequired} onValueChange={(v) => set('noteRequired', v)} />
                </View>

                {/* On / off */}
                {!isNew && (
                  <View style={styles.row}>
                    <View style={styles.flex}>
                      <Text style={styles.rowTitleSmall}>Stage is on</Text>
                      <Text style={styles.rowText}>
                        {leadCount > 0
                          ? `${leadCount} leads are here, so it can’t be switched off.`
                          : 'Switched-off stages are hidden from the step bar.'}
                      </Text>
                    </View>
                    <Switch value={active} onValueChange={setActive} disabled={leadCount > 0 && active} />
                  </View>
                )}

                <Text style={styles.hint}>
                  These rules apply when a lead is moved on its lead page. Moving many leads at once from the list
                  skips them.
                </Text>
              </>
            )}

            {error && (
              <View style={styles.errorBox}>
                <Text style={styles.errorText}>{error}</Text>
              </View>
            )}

            <Button title={isNew ? 'Add stage' : 'Save'} onPress={save} loading={saving} fullWidth />
            {!isNew && !isFinal && (
              <Button title="Remove stage" variant="ghost" onPress={remove} disabled={saving} fullWidth />
            )}
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
  sectionLabel: {
    fontSize: fontSize.caption,
    fontWeight: fontWeight.bold,
    letterSpacing: 1.2,
    color: colors.textMuted,
    marginTop: spacing.md,
    marginLeft: spacing.xs,
  },
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
  rowTitle: { fontSize: fontSize.body, fontWeight: fontWeight.semibold, color: colors.text },
  rowTitleSmall: { fontSize: fontSize.small, fontWeight: fontWeight.semibold, color: colors.text },
  rowText: { fontSize: fontSize.caption, lineHeight: 18, color: colors.textMuted, marginTop: 2 },
  dot: { width: 14, height: 14, borderRadius: radius.pill },
  finalIcon: { fontSize: 18, width: 22, textAlign: 'center' },
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
  colors: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.sm },
  colorDot: {
    width: 34,
    height: 34,
    borderRadius: radius.pill,
    alignItems: 'center',
    justifyContent: 'center',
  },
  colorDotOn: { borderWidth: 3, borderColor: colors.text },
  ruleBox: {
    gap: spacing.sm,
    padding: spacing.md,
    borderRadius: radius.md,
    backgroundColor: colors.background,
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
});