import { useEffect, useState } from 'react';
import { ActivityIndicator, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { Modal } from '@/shared/ui/Modal';

import {
  DEFAULT_APPROVAL_SETTINGS,
  canApprove,
  getApprovalSettings,
  getPlacementOptions,
  markReceived,
  setNuAdmissionId,
  setPlacement,
  setStudentRef,
  submitOnline,
  undoIttcStep,
  type ApprovalSettings,
  type Placement,
  type PlacementOptions,
} from '@/features/approval/api';
import { useAuth } from '@/features/auth/AuthProvider';
import { money } from '@/features/fees/api';
import { colors, fontSize, fontWeight, radius, spacing } from '@/shared/theme';
import { Button } from '@/shared/ui/Button';
import { TextField } from '@/shared/ui/TextField';

// =====================================================================
// 🏛 The admission flow (admitted students only)
//   1. 📤 Submitted Online: the NU Admission ID, no money
//   2. 🏛 Received by ITTC: after Submitted, once the course's admission
//      fee is paid
//   The Admission Officer / admins do both (and undo, with a reason), and
//   can change the course / batch / section, the College ID and the NU ID.
//   Hidden once cancelled.
// =====================================================================

export type ApprovalLead = {
  id: string;
  student_ref: string | null;
  nu_admission_id: string | null;
  papers_required: number | null;
  papers_missing: number | null;
  fee_due: number | null;
  fee_paid: number | null;
  admitted_course_id: string | null;
  admitted_batch_id: string | null;
  admitted_section_id: string | null;
  submitted_at: string | null;
  submitted_by?: string | null;
  received_at: string | null;
  received_by?: string | null;
  /** ৳ the course's admission fee (kept on the lead) */
  admission_fee_need: number | null;
};

type Sheet = 'submit' | 'receive' | 'undo_submit' | 'undo_receive' | 'nu' | 'ref' | 'place' | null;
export type ApprovalSheetKind = Exclude<Sheet, null>;

const day = (iso: string) =>
  new Date(iso).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });

/** What to look at for a student (the website's popups) */
export function admissionChecks(
  lead: Pick<ApprovalLead, 'student_ref' | 'papers_required' | 'papers_missing' | 'fee_due'>,
): { ok: boolean; text: string }[] {
  const req = lead.papers_required ?? 0;
  const miss = lead.papers_missing ?? 0;
  const due = Number(lead.fee_due ?? 0);
  return [
    { ok: !!lead.student_ref, text: lead.student_ref ? `College ID: ${lead.student_ref}` : 'No College ID yet' },
    ...(req > 0
      ? [{ ok: miss === 0, text: miss === 0 ? `Papers: all ${req} in` : `Papers: ${miss} of ${req} missing` }]
      : []),
    { ok: due <= 0, text: due > 0 ? `Fee: ${money(due)} due` : 'Fee: fully paid' },
  ];
}

export function ApprovalCard({
  lead,
  nameOf,
  onChanged,
}: {
  lead: ApprovalLead;
  nameOf: (id: string | null | undefined) => string | null;
  onChanged: (message: string) => void;
}) {
  const { profile, hasPermission } = useAuth();
  const isAdmin = hasPermission('settings.manage');
  const [settings, setSettings] = useState<ApprovalSettings>(DEFAULT_APPROVAL_SETTINGS);
  const [options, setOptions] = useState<PlacementOptions | null>(null);
  const [sheet, setSheet] = useState<Sheet>(null);

  useEffect(() => {
    getApprovalSettings().then(setSettings);
    getPlacementOptions()
      .then(setOptions)
      .catch(() => setOptions(null));
  }, []);

  const officer = canApprove(settings, profile, isAdmin);
  const paid = Number(lead.fee_paid ?? 0);
  const need = Number(lead.admission_fee_need ?? settings.admission_min_paid);
  const feeOk = paid >= need;
  const submitted = !!lead.submitted_at;
  const received = !!lead.received_at;

  const placement = placementText(options, lead.admitted_course_id, lead.admitted_batch_id, lead.admitted_section_id);
  const tone = received ? styles.good : styles.wait;

  return (
    <View style={[styles.card, tone]}>
      <Text style={styles.header}>🏛 Submitted Online → Received by ITTC</Text>

      <Step
        n={1}
        title="📤 Submitted Online"
        done={submitted}
        doneText="Submitted"
        waitText="Not yet"
        by={nameOf(lead.submitted_by)}
        at={lead.submitted_at}
        undo={officer && submitted && !received ? () => setSheet('undo_submit') : undefined}
      />
      <Step
        n={2}
        title="🏛 Received by ITTC"
        done={received}
        doneText="Received"
        waitText={!submitted ? 'After Submitted' : feeOk ? 'Ready' : `${money(need - paid)} more`}
        ready={submitted && feeOk}
        by={nameOf(lead.received_by)}
        at={lead.received_at}
        undo={officer && received ? () => setSheet('undo_receive') : undefined}
      />

      {/* Paid and the admission fee */}
      <View style={styles.money}>
        <Text style={styles.moneyPaid}>💵 Paid {money(paid)}</Text>
        <Text style={[styles.moneyNeed, feeOk ? styles.okText : styles.warnText]}>
          {feeOk ? '✓' : '✗'} Admission fee {money(need)}
          {feeOk ? ' paid' : ` (${money(need - paid)} more)`}
        </Text>
      </View>

      <View style={styles.ids}>
        <IdRow label="College ID" value={lead.student_ref} onEdit={officer ? () => setSheet('ref') : undefined} />
        <IdRow
          label="NU Admission ID"
          value={lead.nu_admission_id}
          onEdit={officer ? () => setSheet('nu') : undefined}
        />
        <IdRow
          label="Course · batch · section"
          value={placement || null}
          missing={!lead.admitted_section_id ? 'No section yet' : undefined}
          onEdit={officer ? () => setSheet('place') : undefined}
        />
      </View>

      {officer && !submitted && (
        <Button title="📤 Submitted Online (NU Admission ID)" onPress={() => setSheet('submit')} fullWidth />
      )}
      {officer && submitted && !received && (
        <>
          {!feeOk && (
            <Text style={styles.blocked}>
              🔒 Opens when the admission fee {money(need)} is paid (paid {money(paid)}).
            </Text>
          )}
          <Button title="🏛 Received by ITTC" onPress={() => setSheet('receive')} disabled={!feeOk} fullWidth />
        </>
      )}
      {!officer && !received && <Text style={styles.meta}>The Admission Officer does these steps.</Text>}

      {sheet && (
        <ApprovalActionSheet
          kind={sheet}
          lead={{ ...lead, admission_fee_need: need }}
          onClose={() => setSheet(null)}
          onDone={(message) => {
            setSheet(null);
            onChanged(message);
          }}
        />
      )}
    </View>
  );
}

function Step({
  n,
  title,
  done,
  doneText,
  waitText,
  ready,
  by,
  at,
  undo,
}: {
  n: number;
  title: string;
  done: boolean;
  doneText: string;
  waitText: string;
  ready?: boolean;
  by: string | null;
  at: string | null;
  undo?: () => void;
}) {
  const pill = done ? styles.pillGood : ready ? styles.pillWait : styles.pillOff;
  return (
    <View style={styles.step}>
      <View style={[styles.stepNo, done && styles.stepNoDone]}>
        <Text style={[styles.stepNoText, done && styles.stepNoTextDone]}>{done ? '✓' : n}</Text>
      </View>
      <View style={styles.flex}>
        <View style={styles.stepHead}>
          <Text style={styles.stepTitle}>{title}</Text>
          <View style={[styles.pill, pill]}>
            <Text style={[styles.pillText, pill]}>{done ? `✅ ${doneText}` : waitText}</Text>
          </View>
        </View>
        {done && at && <Text style={styles.meta}>{[by, day(at)].filter(Boolean).join(' · ')}</Text>}
      </View>
      {undo && (
        <Pressable onPress={undo} hitSlop={8} accessibilityRole="button" accessibilityLabel={`Undo ${title}`}>
          <Text style={styles.undo}>Undo</Text>
        </Pressable>
      )}
    </View>
  );
}

function IdRow({
  label,
  value,
  missing,
  onEdit,
}: {
  label: string;
  value: string | null;
  missing?: string;
  onEdit?: () => void;
}) {
  return (
    <View style={styles.idRow}>
      <Text style={styles.idLabel}>{label}</Text>
      <View style={styles.flex}>
        <Text style={[styles.idValue, !value && styles.idEmpty]} selectable>
          {value ?? '—'}
        </Text>
        {!!missing && <Text style={styles.missing}>⚠ {missing}</Text>}
      </View>
      {onEdit && (
        <Pressable onPress={onEdit} hitSlop={8} accessibilityRole="button" accessibilityLabel={`Change ${label}`}>
          <Text style={styles.edit}>{value ? 'Change' : '＋ Add'}</Text>
        </Pressable>
      )}
    </View>
  );
}

/** "B.Ed · Jan 2027 · Section A" */
export function placementText(
  o: PlacementOptions | null,
  courseId: string | null,
  batchId: string | null,
  sectionId: string | null,
): string {
  if (!o) return '';
  const section = o.sections.find((s) => s.id === sectionId)?.name;
  return [
    o.courses.find((c) => c.id === courseId)?.name,
    o.batches.find((b) => b.id === batchId)?.name,
    section ? `Section ${section}` : null,
  ]
    .filter(Boolean)
    .join(' · ');
}

// ---------------------------------------------------------------------
// Course → batch → section (chips; the section is a must)
// ---------------------------------------------------------------------
export function PlacementPicker({ value, onChange }: { value: Placement; onChange: (p: Placement) => void }) {
  const [o, setO] = useState<PlacementOptions | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    getPlacementOptions()
      .then(setO)
      .catch((e) => setError(e instanceof Error ? e.message : 'Could not load the courses.'));
  }, []);

  if (!o) return error ? <Text style={styles.error}>{error}</Text> : <ActivityIndicator color={colors.primary} />;
  const batches = o.batches.filter((b) => b.course_id === value.courseId);
  const sections = o.sections.filter((s) => s.batch_id === value.batchId);

  return (
    <View style={styles.picker}>
      <Text style={styles.pickLabel}>Course</Text>
      <Chips
        items={o.courses}
        on={value.courseId}
        pick={(id) => onChange({ courseId: id, batchId: null, sectionId: null })}
      />
      {!!value.courseId && (
        <>
          <Text style={styles.pickLabel}>Batch</Text>
          {batches.length ? (
            <Chips
              items={batches}
              on={value.batchId}
              pick={(id) => onChange({ ...value, batchId: id, sectionId: null })}
            />
          ) : (
            <Text style={styles.hint}>This course has no open batch. Add one in Settings → Courses.</Text>
          )}
        </>
      )}
      {!!value.batchId && (
        <>
          <Text style={styles.pickLabel}>Section *</Text>
          {sections.length ? (
            <Chips
              items={sections.map((s) => ({ ...s, name: `Section ${s.name}` }))}
              on={value.sectionId}
              pick={(id) => onChange({ ...value, sectionId: id })}
            />
          ) : (
            <Text style={styles.hint}>This batch has no sections yet. Add them in Settings → Courses → the batch.</Text>
          )}
        </>
      )}
    </View>
  );
}

function Chips({
  items,
  on,
  pick,
}: {
  items: { id: string; name: string }[];
  on: string | null;
  pick: (id: string) => void;
}) {
  return (
    <View style={styles.chips}>
      {items.map((it) => (
        <Pressable
          key={it.id}
          onPress={() => pick(it.id)}
          style={[styles.chip, it.id === on && styles.chipOn]}
          accessibilityRole="radio"
          accessibilityState={{ selected: it.id === on }}
        >
          <Text style={[styles.chipText, it.id === on && styles.chipTextOn]}>{it.name}</Text>
        </Pressable>
      ))}
    </View>
  );
}

// ---------------------------------------------------------------------
// One dialog for every action (also from the website's table)
// ---------------------------------------------------------------------
export function ApprovalActionSheet({
  kind,
  lead,
  onClose,
  onDone,
}: {
  kind: ApprovalSheetKind;
  lead: ApprovalLead;
  /** (old, not used) */
  warnings?: number;
  checks?: { ok: boolean; text: string }[];
  onClose: () => void;
  onDone: (message: string) => void;
}) {
  const [nu, setNu] = useState(lead.nu_admission_id ?? '');
  const [ref, setRef] = useState(lead.student_ref ?? '');
  const [text, setText] = useState('');
  const [place, setPlace] = useState<Placement>({
    courseId: lead.admitted_course_id,
    batchId: lead.admitted_batch_id,
    sectionId: lead.admitted_section_id,
  });
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const isUndo = kind === 'undo_submit' || kind === 'undo_receive';
  const need = Number(lead.admission_fee_need ?? 0);
  const paid = Number(lead.fee_paid ?? 0);

  const save = async () => {
    setError(null);
    if (isUndo && !text.trim()) return setError('Please write why.');
    if (kind === 'ref' && !ref.trim()) return setError('Please type the College ID.');
    if (kind === 'submit' && !nu.trim()) return setError('Please type the NU Admission ID.');
    if (kind === 'place' && (!place.courseId || !place.batchId || !place.sectionId)) {
      return setError('Please choose the course, batch and section.');
    }
    setSaving(true);
    try {
      if (kind === 'submit') {
        await submitOnline(lead.id, nu, text);
        onDone('📤 Submitted Online. The NU Admission ID is saved.');
      } else if (kind === 'receive') {
        await markReceived(lead.id, text);
        onDone('🏛 Received by ITTC.');
      } else if (kind === 'undo_submit') {
        await undoIttcStep(lead.id, 'submitted', text);
        onDone('↩ Submitted Online undone.');
      } else if (kind === 'undo_receive') {
        await undoIttcStep(lead.id, 'received', text);
        onDone('↩ Received by ITTC undone.');
      } else if (kind === 'place') {
        await setPlacement(lead.id, place);
        onDone('🏫 Course, batch and section saved.');
      } else if (kind === 'ref') {
        await setStudentRef(lead.id, ref);
        onDone('🎓 College ID saved.');
      } else {
        await setNuAdmissionId(lead.id, nu);
        onDone(nu.trim() ? '🆔 NU Admission ID saved.' : 'NU Admission ID removed.');
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not save.');
    } finally {
      setSaving(false);
    }
  };

  const titles: Record<ApprovalSheetKind, string> = {
    submit: '📤 Submitted Online',
    receive: '🏛 Received by ITTC',
    undo_submit: '↩ Undo Submitted Online',
    undo_receive: '↩ Undo Received by ITTC',
    place: '🏫 Course, batch and section',
    nu: '🆔 NU Admission ID',
    ref: '✏️ College ID',
  };

  return (
    <Modal visible transparent animationType="slide" onRequestClose={onClose}>
      <View style={styles.backdrop}>
        <Pressable style={styles.flex} onPress={saving ? undefined : onClose} accessibilityLabel="Close" />
        <View style={styles.sheet}>
          <View style={styles.handle} />
          <ScrollView contentContainerStyle={styles.sheetContent} keyboardShouldPersistTaps="handled">
            <Text style={styles.sheetTitle}>{titles[kind]}</Text>
            {kind === 'submit' && (
              <Text style={styles.hint}>No money is needed for this step: only the NU Admission ID.</Text>
            )}
            {kind === 'receive' && (
              <Text style={[styles.check, paid >= need ? null : styles.checkWarn]}>
                {paid >= need ? '✅' : '⚠️'} Admission fee {money(need)} · paid {money(paid)}
              </Text>
            )}
            {kind === 'place' && <PlacementPicker value={place} onChange={setPlace} />}
            {kind === 'place' && (
              <Text style={styles.hint}>
                A new course changes the fee to that course's fee (its fee talk, or the full fee).
              </Text>
            )}
            {(kind === 'submit' || kind === 'nu') && (
              <TextField
                label={kind === 'submit' ? 'NU Admission ID *' : 'NU Admission ID'}
                value={nu}
                onChangeText={setNu}
                autoCapitalize="characters"
                autoCorrect={false}
                placeholder="Type it as it is"
              />
            )}
            {kind === 'ref' && (
              <TextField
                label="College ID"
                value={ref}
                onChangeText={setRef}
                autoCapitalize="characters"
                autoCorrect={false}
                placeholder="Type it as it is"
              />
            )}
            {(kind === 'submit' || kind === 'receive' || isUndo) && (
              <TextField
                label={isUndo ? 'Why? *' : 'Note (optional)'}
                value={text}
                onChangeText={setText}
                multiline
                placeholder={isUndo ? 'e.g. Marked by mistake' : 'e.g. Submitted from the NU site'}
              />
            )}
            {error && <Text style={styles.error}>{error}</Text>}
            <Button
              title={isUndo ? 'Undo' : kind === 'submit' ? '📤 Submitted' : kind === 'receive' ? '🏛 Received' : 'Save'}
              variant={isUndo ? 'danger' : 'primary'}
              onPress={save}
              loading={saving}
              disabled={kind === 'receive' && paid < need}
              fullWidth
            />
          </ScrollView>
        </View>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1 },
  card: { gap: spacing.sm, padding: spacing.lg, borderRadius: radius.lg, borderWidth: 1 },
  wait: { backgroundColor: colors.surface, borderColor: colors.warning },
  good: { backgroundColor: colors.successSoft, borderColor: colors.success },
  bad: { backgroundColor: colors.dangerSoft, borderColor: colors.danger },
  header: { fontSize: fontSize.caption, fontWeight: fontWeight.bold, color: colors.textMuted },
  meta: { fontSize: fontSize.caption, color: colors.textMuted },
  note: { fontSize: fontSize.small, color: colors.text, fontStyle: 'italic' },

  step: { flexDirection: 'row', gap: spacing.md, alignItems: 'flex-start' },
  stepNo: {
    width: 26,
    height: 26,
    borderRadius: 13,
    borderWidth: 1.5,
    borderColor: colors.border,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: colors.surface,
  },
  stepNoDone: { backgroundColor: colors.success, borderColor: colors.success },
  stepNoText: { fontSize: fontSize.caption, fontWeight: fontWeight.bold, color: colors.textMuted },
  stepNoTextDone: { color: '#fff' },
  stepHead: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm, flexWrap: 'wrap' },
  stepTitle: { fontSize: fontSize.body, fontWeight: fontWeight.bold, color: colors.text },
  pill: { paddingHorizontal: 8, paddingVertical: 2, borderRadius: radius.pill },
  pillText: { fontSize: fontSize.caption, fontWeight: fontWeight.bold, backgroundColor: 'transparent' },
  pillWait: { backgroundColor: colors.warningSoft, color: colors.warning },
  pillGood: { backgroundColor: colors.successSoft, color: colors.success },
  pillBad: { backgroundColor: colors.dangerSoft, color: colors.danger },
  pillOff: { backgroundColor: colors.background, color: colors.textMuted },

  money: { gap: 2, padding: spacing.sm, borderRadius: radius.md, backgroundColor: colors.background },
  moneyPaid: { fontSize: fontSize.small, fontWeight: fontWeight.bold, color: colors.text },
  moneyNeed: { fontSize: fontSize.caption, fontWeight: fontWeight.semibold },
  okText: { color: colors.success },
  warnText: { color: colors.warning },
  blocked: { fontSize: fontSize.small, fontWeight: fontWeight.semibold, color: colors.warning },

  ids: { gap: spacing.xs, paddingVertical: spacing.xs },
  idRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm },
  idLabel: { width: 130, fontSize: fontSize.small, color: colors.textMuted },
  idValue: { fontSize: fontSize.body, fontWeight: fontWeight.bold, color: colors.text },
  idEmpty: { fontWeight: fontWeight.regular, color: colors.textMuted },
  missing: { fontSize: fontSize.caption, fontWeight: fontWeight.semibold, color: colors.warning },
  edit: { fontSize: fontSize.small, fontWeight: fontWeight.bold, color: colors.primary },
  undo: { fontSize: fontSize.caption, fontWeight: fontWeight.bold, color: colors.danger, paddingTop: 4 },
  label: { fontSize: fontSize.caption, fontWeight: fontWeight.bold, color: colors.textMuted, marginTop: spacing.xs },
  check: { fontSize: fontSize.small, color: colors.text },
  checkWarn: { color: colors.warning, fontWeight: fontWeight.semibold },
  row: { flexDirection: 'row', gap: spacing.md, marginTop: spacing.sm },

  picker: { gap: spacing.xs },
  pickLabel: { fontSize: fontSize.small, fontWeight: fontWeight.semibold, color: colors.text, marginTop: spacing.xs },
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
  hint: { fontSize: fontSize.caption, color: colors.textMuted },

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
  error: { fontSize: fontSize.small, color: colors.danger },
});
