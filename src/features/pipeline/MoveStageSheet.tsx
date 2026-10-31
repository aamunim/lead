import { useEffect, useMemo, useState } from 'react';
import { Modal, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { KeyboardAvoidingView } from 'react-native-keyboard-controller';

import { formatDue } from '@/features/follow-ups/api';
import type { PipelineStage } from '@/features/pipeline/api';
import { colors, fontSize, fontWeight, radius, spacing } from '@/shared/theme';
import { Button } from '@/shared/ui/Button';
import { DateTimePickerButton } from '@/shared/ui/DateTimePickerButton';
import { TextField } from '@/shared/ui/TextField';
import { VoiceNoteButton } from '@/features/voice/VoiceNote';

// =====================================================================
// Moving to a stage that needs a note and/or a date
//   Used by the lead page (pipeline), the board and the list's quick menu.
// =====================================================================

function quickDates(): { key: string; label: string; date: Date }[] {
  const at11 = (daysAhead: number) => {
    const d = new Date();
    d.setDate(d.getDate() + daysAhead);
    d.setHours(11, 0, 0, 0);
    return d;
  };
  return [
    { key: 'tomorrow', label: 'Tomorrow 11 am', date: at11(1) },
    { key: '2d', label: 'In 2 days 11 am', date: at11(2) },
    { key: '1w', label: 'Next week 11 am', date: at11(7) },
  ];
}

export function MoveStageSheet({
  visible,
  stage,
  isCurrent,
  subtitle,
  leadId,
  onClose,
  onSave,
}: {
  visible: boolean;
  /** One lead: 🎙 voice notes can be added */
  leadId?: string | null;
  stage: PipelineStage | null;
  /** e.g. the lead's name, or "5 leads" */
  subtitle?: string;
  /** Changing the date of the stage the lead is already in */
  isCurrent: boolean;
  onClose: () => void;
  onSave: (note: string, dueAt: Date | null) => Promise<void>;
}) {
  const [note, setNote] = useState('');
  const [dueAt, setDueAt] = useState<Date | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const quick = useMemo(() => (visible ? quickDates() : []), [visible]);
  const dateLabel = stage?.dateLabel?.trim() || 'Date & time';

  useEffect(() => {
    if (!visible) return;
    setNote('');
    setDueAt(null);
    setError(null);
  }, [visible]);

  const save = async () => {
    if (!stage) return;
    if (stage.askDate) {
      if (!dueAt) {
        setError(`Please pick the ${dateLabel.toLowerCase()}.`);
        return;
      }
      if (dueAt.getTime() < Date.now() - 5 * 60 * 1000) {
        setError('The date & time must be in the future.');
        return;
      }
    }
    if (stage.noteRequired && !isCurrent && !note.trim()) {
      setError('Please add a note.');
      return;
    }
    setSaving(true);
    setError(null);
    try {
      await onSave(note, stage.askDate ? dueAt : null);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not move the lead.');
    } finally {
      setSaving(false);
    }
  };

  return (
    <SmallSheet visible={visible} onClose={saving ? undefined : onClose}>
      <Text style={styles.sheetTitle}>
        {isCurrent ? 'Change ' : 'Move to '}
        <Text style={{ color: stage?.color ?? colors.primary }}>{stage?.name}</Text>
      </Text>
      {subtitle && <Text style={styles.hint}>{subtitle}</Text>}

      {/* Date & time (e.g. the visit) */}
      {stage?.askDate && (
        <View style={styles.field}>
          <Text style={styles.label}>📅 {dateLabel} *</Text>
          <View style={styles.chips}>
            {quick.map((q) => {
              const on = !!dueAt && dueAt.getTime() === q.date.getTime();
              return (
                <Pressable
                  key={q.key}
                  onPress={() => {
                    setDueAt(q.date);
                    setError(null);
                  }}
                  style={[styles.chip, on && { backgroundColor: stage.color, borderColor: stage.color }]}
                  accessibilityRole="radio"
                  accessibilityState={{ checked: on }}
                >
                  <Text style={[styles.chipText, on && styles.textOn]}>{q.label}</Text>
                </Pressable>
              );
            })}
          </View>
          <DateTimePickerButton
            title={dueAt ? '📅 Change date & time' : '📅 Pick date & time'}
            initial={dueAt ?? undefined}
            onPick={(d) => {
              setDueAt(d);
              setError(null);
            }}
          />
          <Text style={[styles.hint, dueAt && styles.hintStrong]}>
            {dueAt
              ? `📌 ${formatDue(dueAt)} · a reminder is set for this time`
              : 'A reminder will be set for this time and show in Today’s calls.'}
          </Text>
        </View>
      )}

      {/* Note */}
      <TextField
        label={stage?.noteRequired && !isCurrent ? 'Note *' : 'Note (optional)'}
        value={note}
        onChangeText={setNote}
        multiline
        placeholder={stage?.askDate ? 'e.g. Coming with father, wants to see the lab' : 'What happened?'}
      />
      <VoiceNoteButton leadId={leadId} context="stage" />

      {!stage?.askDate && stage?.followUpDays != null && (
        <Text style={styles.hint}>
          A next call will be set{' '}
          {stage.followUpDays === 0
            ? 'for today'
            : `${stage.followUpDays} ${stage.followUpDays === 1 ? 'day' : 'days'} from now`}
          .
        </Text>
      )}

      {error && <ErrorBox text={error} />}
      <Button title={isCurrent ? 'Save' : 'Move'} onPress={save} loading={saving} fullWidth />
      <Button title="Cancel" variant="ghost" onPress={onClose} disabled={saving} fullWidth />
    </SmallSheet>
  );
}

function SmallSheet({
  visible,
  onClose,
  children,
}: {
  visible: boolean;
  onClose?: () => void;
  children: React.ReactNode;
}) {
  return (
    <Modal visible={visible} transparent animationType="slide" onRequestClose={onClose}>
      <KeyboardAvoidingView style={styles.backdrop} behavior="padding">
        <Pressable style={styles.flex} onPress={onClose} accessibilityLabel="Close" />
        <View style={styles.sheet}>
          <View style={styles.handle} />
          <ScrollView contentContainerStyle={styles.sheetContent} keyboardShouldPersistTaps="handled">
            {children}
          </ScrollView>
        </View>
      </KeyboardAvoidingView>
    </Modal>
  );
}

function ErrorBox({ text }: { text: string }) {
  return (
    <View style={styles.errorBox}>
      <Text style={styles.errorText}>{text}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1 },
  hint: { fontSize: fontSize.caption, color: colors.textMuted },
  hintStrong: { color: colors.primary, fontWeight: fontWeight.bold },
  field: { gap: spacing.sm },
  label: { fontSize: fontSize.small, fontWeight: fontWeight.semibold, color: colors.text },
  backdrop: { flex: 1, backgroundColor: 'rgba(0,0,0,0.4)' },
  sheet: {
    maxHeight: '88%',
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
  sheetContent: { padding: spacing.lg, gap: spacing.md, paddingBottom: spacing.xxl },
  sheetTitle: { fontSize: fontSize.title, fontWeight: fontWeight.bold, color: colors.text },
  chips: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.sm },
  chip: {
    paddingVertical: spacing.sm,
    paddingHorizontal: spacing.lg,
    borderRadius: radius.pill,
    borderWidth: 1.5,
    borderColor: colors.border,
  },
  chipText: { fontSize: fontSize.small, fontWeight: fontWeight.semibold, color: colors.text },
  textOn: { color: colors.textOnPrimary },
  errorBox: { padding: spacing.md, borderRadius: radius.md, backgroundColor: colors.dangerSoft },
  errorText: { fontSize: fontSize.small, color: colors.danger },
});
