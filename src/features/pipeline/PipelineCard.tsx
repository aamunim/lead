import { useEffect, useMemo, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  Modal,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { KeyboardAvoidingView } from 'react-native-keyboard-controller';

import { formatDue } from '@/features/follow-ups/api';
import { type LeadDetail } from '@/features/leads/api';
import { AdmitSheet } from '@/features/pipeline/AdmitSheet';
import { LostSheet } from '@/features/pipeline/LostSheet';
import { MoveStageSheet } from '@/features/pipeline/MoveStageSheet';
import {
  canCancelAdmission,
  CANCEL_REASONS,
  cancelAdmission,
  canMarkAdmitted,
  listPipelineStages,
  moveLeadStage,
  openStages,
  reopenLead,
  type PipelineStage,
} from '@/features/pipeline/api';
import { supabase } from '@/shared/lib/supabase';
import { colors, fontSize, fontWeight, radius, spacing } from '@/shared/theme';
import { Button } from '@/shared/ui/Button';
import { TextField } from '@/shared/ui/TextField';
import { VoiceNoteButton } from '@/features/voice/VoiceNote';

// =====================================================================
// The pipeline part of the lead page:
//   open lead   → step bar + "Mark admitted" / "Mark lost"
//   closed lead → status card + Reopen / Cancel admission
// =====================================================================

type Props = {
  lead: LeadDetail;
  /** A pending "♻️ Revive" follow-up date, if any */
  reviveAt?: string | null;
  /** id → person name (with "(inactive)") */
  nameOf: (userId: string | null | undefined) => string | null;
  /** Something changed: reload the lead */
  onChanged: (message?: string) => void;
};

type SheetName = 'admit' | 'lost' | 'reopen' | 'cancel' | 'move';

function formatDay(iso: string | null | undefined): string {
  if (!iso) return '—';
  return new Date(iso).toLocaleDateString([], { day: 'numeric', month: 'short', year: 'numeric' });
}

/** A stage that needs something before the move: a note and/or a date */
const needsSheet = (s: PipelineStage) => s.noteRequired || s.askDate;

export function PipelineCard({ lead, reviveAt, nameOf, onChanged }: Props) {
  const [stages, setStages] = useState<PipelineStage[]>([]);
  const [mayAdmit, setMayAdmit] = useState(false);
  const [mayCancel, setMayCancel] = useState(false);
  const [moving, setMoving] = useState<string | null>(null);

  // Names for the closed card
  const [courseName, setCourseName] = useState<string | null>(null);
  const [batchName, setBatchName] = useState<string | null>(null);

  const [sheet, setSheet] = useState<SheetName | null>(null);
  /** The stage waiting for a note and/or a date */
  const [moveStage, setMoveStage] = useState<PipelineStage | null>(null);

  const kind = lead.stage?.kind ?? 'open';
  const open = useMemo(() => openStages(stages), [stages]);
  const current = stages.find((s) => s.id === lead.stage_id) ?? null;

  useEffect(() => {
    listPipelineStages()
      .then(setStages)
      .catch(() => setStages([]));
    canMarkAdmitted().then(setMayAdmit);
    canCancelAdmission().then(setMayCancel);
  }, []);

  // Course and batch names of the admission
  useEffect(() => {
    setCourseName(null);
    setBatchName(null);
    if (lead.admitted_course_id) {
      supabase
        .from('courses')
        .select('name')
        .eq('id', lead.admitted_course_id)
        .maybeSingle()
        .then(({ data }) => setCourseName(data?.name ?? null));
    }
    if (lead.admitted_batch_id) {
      supabase
        .from('batches')
        .select('name')
        .eq('id', lead.admitted_batch_id)
        .maybeSingle()
        .then(({ data }) => setBatchName(data?.name ?? null));
    }
  }, [lead.admitted_course_id, lead.admitted_batch_id]);

  // --- move between open stages ---------------------------------------------
  /** Does the move; throws on error (the sheet shows it) */
  const doMove = async (stage: PipelineStage, note?: string, dueAt?: Date | null) => {
    const r = await moveLeadStage(lead.id, stage.id, note, dueAt);
    const same = stage.id === lead.stage_id;
    const head = same ? `${stage.name} updated.` : `Moved to ${stage.name}.`;
    onChanged(
      r.followUpAt
        ? `${head} ${stage.askDate ? `📌 ${formatDue(r.followUpAt)}` : `Next call: ${formatDue(r.followUpAt)}`}.`
        : head,
    );
  };

  const moveTo = async (stage: PipelineStage) => {
    if (moving) return;

    // Tapping the current stage: only stages with a date can be changed (e.g. move the visit)
    if (stage.id === lead.stage_id) {
      if (stage.askDate) {
        setMoveStage(stage);
        setSheet('move');
      }
      return;
    }

    // This stage asks for a note and/or a date first
    if (needsSheet(stage)) {
      setMoveStage(stage);
      setSheet('move');
      return;
    }

    setMoving(stage.id);
    try {
      await doMove(stage);
    } catch (e) {
      Alert.alert('Could not move', e instanceof Error ? e.message : '');
    } finally {
      setMoving(null);
    }
  };

  const currentIndex = open.findIndex((s) => s.id === lead.stage_id);

  // --- render -----------------------------------------------------------------
  return (
    <View style={styles.card}>
      {kind === 'open' ? (
        <>
          <View style={styles.header}>
            <Text style={styles.title}>Pipeline</Text>
            {current && <Text style={[styles.currentText, { color: current.color }]}>{current.name}</Text>}
          </View>

          {/* Step bar */}
          <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.steps}>
            {open.map((s, i) => {
              const isCurrent = s.id === lead.stage_id;
              const isPast = currentIndex >= 0 && i < currentIndex;
              const marks = `${s.askDate ? ' 📅' : ''}${s.noteRequired && !isCurrent ? ' ✎' : ''}`;
              return (
                <View key={s.id} style={styles.stepWrap}>
                  {i > 0 && <View style={[styles.line, (isPast || isCurrent) && { backgroundColor: s.color }]} />}
                  <Pressable
                    onPress={() => moveTo(s)}
                    disabled={!!moving}
                    style={({ pressed }) => [
                      styles.step,
                      isPast && { backgroundColor: s.color + '22', borderColor: s.color },
                      isCurrent && { backgroundColor: s.color, borderColor: s.color },
                      pressed && styles.pressed,
                    ]}
                    accessibilityRole="button"
                    accessibilityState={{ selected: isCurrent }}
                    accessibilityLabel={`${isCurrent ? 'Current stage' : 'Move to'} ${s.name}${
                      s.askDate ? ', asks for a date' : ''
                    }${s.noteRequired ? ', needs a note' : ''}`}
                  >
                    {moving === s.id ? (
                      <ActivityIndicator size="small" color={isCurrent ? colors.textOnPrimary : s.color} />
                    ) : (
                      <Text
                        style={[
                          styles.stepText,
                          isPast && { color: s.color },
                          isCurrent && styles.stepTextOn,
                        ]}
                        numberOfLines={1}
                      >
                        {isPast ? '✓ ' : ''}
                        {s.name}
                        {marks}
                      </Text>
                    )}
                  </Pressable>
                </View>
              );
            })}
          </ScrollView>
          <Text style={styles.hint}>
            Tap a step to move the lead there. 📅 = asks for a date · ✎ = needs a note.
            {current?.askDate ? ` Tap “${current.name}” again to change its date.` : ''}
          </Text>

          {/* Outcome buttons */}
          <View style={styles.row}>
            {mayAdmit && (
              <View style={styles.flex}>
                <Button title="🎓 Mark admitted" onPress={() => setSheet('admit')} fullWidth />
              </View>
            )}
            <View style={styles.flex}>
              <Button title="✕ Mark lost" variant="secondary" onPress={() => setSheet('lost')} fullWidth />
            </View>
          </View>
        </>
      ) : kind === 'won' ? (
        /* ---------- Admitted ---------- */
        <View style={[styles.status, styles.statusWon]}>
          <Text style={[styles.statusTitle, { color: colors.success }]}>🎓 Admitted</Text>
          <Text style={styles.statusText}>
            {formatDay(lead.admitted_at)}
            {courseName ? ` · ${courseName}` : ''}
            {batchName ? ` · ${batchName}` : ''}
          </Text>
          {lead.student_ref && (
            <View style={styles.refBadge}>
              <Text style={styles.refBadgeText}>Student ID: {lead.student_ref}</Text>
            </View>
          )}
          {nameOf(lead.admitted_by) && <Text style={styles.meta}>By {nameOf(lead.admitted_by)}</Text>}
          {lead.admission_note && <Text style={styles.note}>{lead.admission_note}</Text>}
          {mayCancel && (
            <Button title="Cancel admission" variant="ghost" onPress={() => setSheet('cancel')} fullWidth />
          )}
        </View>
      ) : kind === 'lost' ? (
        /* ---------- Lost ---------- */
        <View style={[styles.status, styles.statusLost]}>
          <Text style={[styles.statusTitle, { color: colors.danger }]}>✕ Lost</Text>
          <Text style={styles.statusText}>
            {formatDay(lead.lost_at)}
            {lead.lost_reason?.name ? ` · ${lead.lost_reason.name}` : ''}
          </Text>
          {nameOf(lead.lost_by) && <Text style={styles.meta}>By {nameOf(lead.lost_by)}</Text>}
          {lead.lost_note && <Text style={styles.note}>{lead.lost_note}</Text>}
          {reviveAt && <Text style={styles.revive}>♻️ Try again on {formatDay(reviveAt)}</Text>}
          <View style={styles.row}>
            <View style={styles.flex}>
              <Button title="↺ Reopen" variant="secondary" onPress={() => setSheet('reopen')} fullWidth />
            </View>
            {mayAdmit && (
              <View style={styles.flex}>
                <Button title="🎓 Admitted" onPress={() => setSheet('admit')} fullWidth />
              </View>
            )}
          </View>
        </View>
      ) : (
        /* ---------- Admission cancelled ---------- */
        <View style={[styles.status, styles.statusCancelled]}>
          <Text style={[styles.statusTitle, { color: colors.textMuted }]}>↩ Admission cancelled</Text>
          <Text style={styles.statusText}>
            {formatDay(lead.cancelled_at)}
            {lead.cancel_reason ? ` · ${lead.cancel_reason}` : ''}
          </Text>
          {courseName && (
            <Text style={styles.meta}>
              Was admitted to {courseName}
              {batchName ? ` (${batchName})` : ''} on {formatDay(lead.admitted_at)}
              {lead.student_ref ? ` · ${lead.student_ref}` : ''}
            </Text>
          )}
          {nameOf(lead.cancelled_by) && <Text style={styles.meta}>Cancelled by {nameOf(lead.cancelled_by)}</Text>}
          <Button title="↺ Reopen" variant="secondary" onPress={() => setSheet('reopen')} fullWidth />
        </View>
      )}

      {/* Sheets */}
      <AdmitSheet
        visible={sheet === 'admit'}
        lead={{
          id: lead.id,
          name: lead.name,
          courseIds: lead.lead_courses.map((c) => c.course?.id).filter(Boolean) as string[],
          studentRef: lead.student_ref,
        }}
        onClose={() => setSheet(null)}
        onSaved={() => {
          setSheet(null);
          onChanged('🎉 Admitted!');
        }}
      />

      <LostSheet
        visible={sheet === 'lost'}
        leads={[{ id: lead.id, name: lead.name }]}
        onClose={() => setSheet(null)}
        onSaved={(message) => {
          setSheet(null);
          onChanged(message);
        }}
      />

      <MoveStageSheet
        visible={sheet === 'move'}
        stage={moveStage}
        isCurrent={!!moveStage && moveStage.id === lead.stage_id}
        leadId={lead.id}
        onClose={() => {
          setSheet(null);
          setMoveStage(null);
        }}
        onSave={async (note, dueAt) => {
          if (!moveStage) return;
          await doMove(moveStage, note, dueAt);
          setSheet(null);
          setMoveStage(null);
        }}
      />

      <ReopenSheet
        visible={sheet === 'reopen'}
        leadId={lead.id}
        stages={open}
        onClose={() => setSheet(null)}
        onSave={async (stageId, note) => {
          await reopenLead(lead.id, stageId, note);
          setSheet(null);
          onChanged('Lead reopened.');
        }}
      />

      <CancelAdmissionSheet
        visible={sheet === 'cancel'}
        leadId={lead.id}
        leadName={lead.name}
        onClose={() => setSheet(null)}
        onSave={async (reason, note) => {
          await cancelAdmission(lead.id, reason, note);
          setSheet(null);
          onChanged('Admission cancelled. The seat is free again.');
        }}
      />
    </View>
  );
}

// =====================================================================
// Reopen: pick the stage to go back to
// =====================================================================
function ReopenSheet({
  visible,
  leadId,
  stages,
  onClose,
  onSave,
}: {
  visible: boolean;
  leadId: string;
  stages: PipelineStage[];
  onClose: () => void;
  onSave: (stageId: string, note: string) => Promise<void>;
}) {
  const [stageId, setStageId] = useState<string | null>(null);
  const [note, setNote] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!visible) return;
    setStageId(stages.find((s) => s.key === 'interested')?.id ?? stages[0]?.id ?? null);
    setNote('');
    setError(null);
  }, [visible, stages]);

  const save = async () => {
    if (!stageId) return;
    setSaving(true);
    setError(null);
    try {
      await onSave(stageId, note);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not reopen.');
    } finally {
      setSaving(false);
    }
  };

  return (
    <SmallSheet visible={visible} onClose={saving ? undefined : onClose}>
      <Text style={styles.sheetTitle}>↺ Reopen lead</Text>
      <Text style={styles.hint}>Move it back to:</Text>
      <View style={styles.chips}>
        {stages.map((s) => {
          const on = stageId === s.id;
          return (
            <Pressable
              key={s.id}
              onPress={() => setStageId(s.id)}
              style={[styles.chip, on && { backgroundColor: s.color, borderColor: s.color }]}
              accessibilityRole="radio"
              accessibilityState={{ checked: on }}
            >
              <Text style={[styles.chipText, on && styles.textOn]}>{s.name}</Text>
            </Pressable>
          );
        })}
      </View>
      <TextField label="Note (optional)" value={note} onChangeText={setNote} multiline placeholder="Why reopen?" />
      <VoiceNoteButton leadId={leadId} context="reopen" />
      <Text style={styles.hint}>The lost / cancelled details stay in the lead’s history.</Text>
      {error && <ErrorBox text={error} />}
      <Button title="Reopen" onPress={save} loading={saving} disabled={!stageId} fullWidth />
      <Button title="Cancel" variant="ghost" onPress={onClose} disabled={saving} fullWidth />
    </SmallSheet>
  );
}

// =====================================================================
// Cancel an admission: reason required
// =====================================================================
function CancelAdmissionSheet({
  visible,
  leadId,
  leadName,
  onClose,
  onSave,
}: {
  visible: boolean;
  leadId: string;
  leadName: string;
  onClose: () => void;
  onSave: (reason: string, note: string) => Promise<void>;
}) {
  const [reason, setReason] = useState('');
  const [note, setNote] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!visible) return;
    setReason('');
    setNote('');
    setError(null);
  }, [visible]);

  const save = async () => {
    if (!reason.trim()) {
      setError('Please give a reason.');
      return;
    }
    setSaving(true);
    setError(null);
    try {
      await onSave(reason, note);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not cancel the admission.');
    } finally {
      setSaving(false);
    }
  };

  return (
    <SmallSheet visible={visible} onClose={saving ? undefined : onClose}>
      <Text style={[styles.sheetTitle, { color: colors.danger }]}>Cancel admission</Text>
      <Text style={styles.hint}>{leadName}’s seat will be freed. The student ID is kept.</Text>
      <View style={styles.chips}>
        {CANCEL_REASONS.map((r) => {
          const on = reason === r;
          return (
            <Pressable
              key={r}
              onPress={() => setReason(r)}
              style={[styles.chip, on && styles.chipDanger]}
              accessibilityRole="radio"
              accessibilityState={{ checked: on }}
            >
              <Text style={[styles.chipText, on && styles.textOn]}>{r}</Text>
            </Pressable>
          );
        })}
      </View>
      <TextField label="Reason *" value={reason} onChangeText={setReason} placeholder="Or type a reason" />
      <TextField label="Note (optional)" value={note} onChangeText={setNote} multiline placeholder="e.g. Refund given" />
      <VoiceNoteButton leadId={leadId} context="cancel" />
      {error && <ErrorBox text={error} />}
      <Button title="Cancel admission" variant="danger" onPress={save} loading={saving} fullWidth />
      <Button title="Keep admission" variant="ghost" onPress={onClose} disabled={saving} fullWidth />
    </SmallSheet>
  );
}

// =====================================================================
// Small pieces
// =====================================================================
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
  pressed: { opacity: 0.8 },
  card: {
    gap: spacing.md,
    padding: spacing.lg,
    borderRadius: radius.lg,
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.border,
  },
  header: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  title: { fontSize: fontSize.body, fontWeight: fontWeight.bold, color: colors.text },
  currentText: { fontSize: fontSize.small, fontWeight: fontWeight.bold },
  hint: { fontSize: fontSize.caption, color: colors.textMuted },
  hintStrong: { color: colors.primary, fontWeight: fontWeight.bold },
  row: { flexDirection: 'row', gap: spacing.sm },
  field: { gap: spacing.sm },
  label: { fontSize: fontSize.small, fontWeight: fontWeight.semibold, color: colors.text },

  // Step bar
  steps: { alignItems: 'center', paddingVertical: spacing.xs },
  stepWrap: { flexDirection: 'row', alignItems: 'center' },
  line: { width: 14, height: 2, backgroundColor: colors.border },
  step: {
    minWidth: 72,
    alignItems: 'center',
    paddingVertical: spacing.sm,
    paddingHorizontal: spacing.md,
    borderRadius: radius.pill,
    borderWidth: 1.5,
    borderColor: colors.border,
    backgroundColor: colors.surface,
  },
  stepText: { fontSize: fontSize.caption, fontWeight: fontWeight.semibold, color: colors.textMuted },
  stepTextOn: { color: colors.textOnPrimary, fontWeight: fontWeight.bold },

  // Closed status
  status: { gap: spacing.sm, padding: spacing.md, borderRadius: radius.md, borderWidth: 1.5 },
  statusWon: { borderColor: colors.success, backgroundColor: colors.successSoft },
  statusLost: { borderColor: colors.danger, backgroundColor: colors.dangerSoft },
  statusCancelled: { borderColor: colors.border, backgroundColor: colors.background },
  statusTitle: { fontSize: fontSize.title, fontWeight: fontWeight.bold },
  statusText: { fontSize: fontSize.small, fontWeight: fontWeight.semibold, color: colors.text },
  meta: { fontSize: fontSize.caption, color: colors.textMuted },
  note: { fontSize: fontSize.small, color: colors.text },
  revive: { fontSize: fontSize.small, fontWeight: fontWeight.bold, color: colors.success },
  refBadge: {
    alignSelf: 'flex-start',
    paddingVertical: 3,
    paddingHorizontal: spacing.md,
    borderRadius: radius.pill,
    backgroundColor: colors.surface,
  },
  refBadgeText: { fontSize: fontSize.caption, fontWeight: fontWeight.bold, color: colors.success },

  // Sheets
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
  chipDanger: { backgroundColor: colors.danger, borderColor: colors.danger },
  chipText: { fontSize: fontSize.small, fontWeight: fontWeight.semibold, color: colors.text },
  textOn: { color: colors.textOnPrimary },
  errorBox: { padding: spacing.md, borderRadius: radius.md, backgroundColor: colors.dangerSoft },
  errorText: { fontSize: fontSize.small, color: colors.danger },
});