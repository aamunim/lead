import { useEffect, useState } from 'react';
import { ActivityIndicator, Modal, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';

import {
  DEFAULT_APPROVAL_SETTINGS,
  approveAdmission,
  approveRegistration,
  canApprove,
  getApprovalSettings,
  getPlacementOptions,
  resubmitAdmission,
  resubmitRegistration,
  returnAdmission,
  returnRegistration,
  setNuAdmissionId,
  setPlacement,
  setStudentRef,
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
// 🎓 Admission & registration approval (admitted students only)
//   1. Admission: ⏳ waiting → ✅ approved (৳ needed + the section chosen)
//      or ↩ sent back
//   2. Registration (after the admission is approved): ⏳ → ✅ (৳ needed
//      in total) or ↩ sent back
//   The Admission Officer can change the course / batch / section, the
//   College ID and the NU Admission ID. Hidden once cancelled.
// =====================================================================

export type ApprovalLead = {
  id: string;
  student_ref: string | null;
  approval_status: string | null;
  approval_by: string | null;
  approval_at: string | null;
  approval_note: string | null;
  nu_admission_id: string | null;
  papers_required: number | null;
  papers_missing: number | null;
  fee_due: number | null;
  fee_paid: number | null;
  admitted_course_id: string | null;
  admitted_batch_id: string | null;
  admitted_section_id: string | null;
  registration_status: string | null;
  registration_by: string | null;
  registration_at: string | null;
  registration_note: string | null;
};

type Sheet =
  | 'approve'
  | 'return'
  | 'resubmit'
  | 'nu'
  | 'ref'
  | 'place'
  | 'reg_approve'
  | 'reg_return'
  | 'reg_resubmit'
  | null;
export type ApprovalSheetKind = Exclude<Sheet, null>;

const day = (iso: string) =>
  new Date(iso).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });

/** What the officer should look at before approving the admission */
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

  const status = lead.approval_status;
  if (!settings.enabled || !status) return null;
  const officer = canApprove(settings, profile, isAdmin);
  const reg = status === 'approved' ? (lead.registration_status ?? 'waiting') : null;

  const paid = Number(lead.fee_paid ?? 0);
  const admissionReady = paid >= settings.admission_min_paid;
  const registrationReady = paid >= settings.registration_min_paid;
  const checks = admissionChecks(lead);
  const warnings = checks.filter((c) => !c.ok).length;

  const placement = placementText(options, lead.admitted_course_id, lead.admitted_batch_id, lead.admitted_section_id);
  const done = reg === 'approved';
  const tone = done ? styles.good : status === 'returned' || reg === 'returned' ? styles.bad : styles.wait;

  return (
    <View style={[styles.card, tone]}>
      <Text style={styles.header}>🎓 Admission & registration</Text>

      {/* The two steps */}
      <Step
        n={1}
        title="Admission"
        status={status}
        by={nameOf(lead.approval_by)}
        at={lead.approval_at}
        note={lead.approval_note}
      />
      <Step
        n={2}
        title="Registration"
        status={reg}
        by={nameOf(lead.registration_by)}
        at={lead.registration_at}
        note={lead.registration_note}
      />

      {/* Paid and what each step needs */}
      <View style={styles.money}>
        <Text style={styles.moneyPaid}>Paid {money(paid)}</Text>
        <Text style={[styles.moneyNeed, admissionReady ? styles.okText : styles.warnText]}>
          {admissionReady ? '✓' : '✗'} Admission needs {money(settings.admission_min_paid)}
        </Text>
        <Text style={[styles.moneyNeed, registrationReady ? styles.okText : styles.warnText]}>
          {registrationReady ? '✓' : '✗'} Registration needs {money(settings.registration_min_paid)} in total
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
          onEdit={officer && status === 'approved' ? () => setSheet('place') : undefined}
        />
      </View>

      {/* ── Step 1: the admission ── */}
      {status === 'waiting' && officer && (
        <>
          <Text style={styles.label}>CHECK BEFORE APPROVING</Text>
          {checks.map((c) => (
            <Text key={c.text} style={[styles.check, !c.ok && styles.checkWarn]}>
              {c.ok ? '✅' : '⚠️'} {c.text}
            </Text>
          ))}
          {!admissionReady && (
            <Text style={styles.blocked}>
              🔒 Approve opens when {money(settings.admission_min_paid)} is paid (paid {money(paid)}).
            </Text>
          )}
          <View style={styles.row}>
            <View style={styles.flex}>
              <Button title="↩ Send back" variant="secondary" onPress={() => setSheet('return')} fullWidth />
            </View>
            <View style={styles.flex}>
              <Button
                title="✅ Approve admission"
                onPress={() => setSheet('approve')}
                disabled={!admissionReady}
                fullWidth
              />
            </View>
          </View>
        </>
      )}
      {status === 'waiting' && !officer && <Text style={styles.meta}>The Admission Officer will check it.</Text>}
      {status === 'returned' && (
        <Button title="Fixed: send the admission again" onPress={() => setSheet('resubmit')} fullWidth />
      )}

      {/* ── Step 2: the registration ── */}
      {reg === 'waiting' && officer && (
        <>
          {!registrationReady && (
            <Text style={styles.blocked}>
              🔒 Registration opens when {money(settings.registration_min_paid)} is paid in total (paid {money(paid)}).
            </Text>
          )}
          <View style={styles.row}>
            <View style={styles.flex}>
              <Button title="↩ Send back" variant="secondary" onPress={() => setSheet('reg_return')} fullWidth />
            </View>
            <View style={styles.flex}>
              <Button
                title="📝 Approve registration"
                onPress={() => setSheet('reg_approve')}
                disabled={!registrationReady}
                fullWidth
              />
            </View>
          </View>
        </>
      )}
      {reg === 'waiting' && !officer && (
        <Text style={styles.meta}>The Admission Officer will check the registration.</Text>
      )}
      {reg === 'returned' && (
        <Button title="Fixed: send the registration again" onPress={() => setSheet('reg_resubmit')} fullWidth />
      )}

      {sheet && (
        <ApprovalActionSheet
          kind={sheet}
          lead={lead}
          warnings={warnings}
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
  status,
  by,
  at,
  note,
}: {
  n: number;
  title: string;
  status: string | null;
  by: string | null;
  at: string | null;
  note: string | null;
}) {
  const label =
    status === 'approved'
      ? '✅ Approved'
      : status === 'returned'
        ? '↩ Sent back'
        : status === 'waiting'
          ? '⏳ Waiting'
          : 'After the admission';
  const pill =
    status === 'approved'
      ? styles.pillGood
      : status === 'returned'
        ? styles.pillBad
        : status
          ? styles.pillWait
          : styles.pillOff;
  return (
    <View style={styles.step}>
      <View style={[styles.stepNo, status === 'approved' && styles.stepNoDone]}>
        <Text style={[styles.stepNoText, status === 'approved' && styles.stepNoTextDone]}>{n}</Text>
      </View>
      <View style={styles.flex}>
        <View style={styles.stepHead}>
          <Text style={styles.stepTitle}>{title}</Text>
          <View style={[styles.pill, pill]}>
            <Text style={[styles.pillText, pill]}>{label}</Text>
          </View>
        </View>
        {status && status !== 'waiting' && at && (
          <Text style={styles.meta}>{[by, day(at)].filter(Boolean).join(' · ')}</Text>
        )}
        {!!note && <Text style={styles.note}>“{note}”</Text>}
      </View>
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
  warnings,
  checks,
  onClose,
  onDone,
}: {
  kind: ApprovalSheetKind;
  lead: ApprovalLead;
  warnings: number;
  /** 🌐 shown in the dialog when opened from the table (the card shows them itself) */
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

  const needsReason = kind === 'return' || kind === 'reg_return';
  const withPlacement = kind === 'approve' || kind === 'place';

  const save = async () => {
    setError(null);
    if (needsReason && !text.trim()) return setError('Please write what needs to be fixed.');
    if (kind === 'ref' && !ref.trim()) return setError('Please type the College ID.');
    if (withPlacement && (!place.courseId || !place.batchId || !place.sectionId)) {
      return setError('Please choose the course, batch and section.');
    }
    if (kind === 'approve' && warnings > 0 && !text.trim()) {
      return setError('Some checks are not done. Please write why you approve anyway.');
    }
    setSaving(true);
    try {
      if (kind === 'approve') {
        await approveAdmission(lead.id, nu, text, place);
        onDone('✅ Admission approved. Registration is next.');
      } else if (kind === 'return') {
        await returnAdmission(lead.id, text);
        onDone('↩ Admission sent back to fix.');
      } else if (kind === 'resubmit') {
        await resubmitAdmission(lead.id, text);
        onDone('Sent for admission approval again.');
      } else if (kind === 'reg_approve') {
        await approveRegistration(lead.id, text);
        onDone('📝 Registration approved.');
      } else if (kind === 'reg_return') {
        await returnRegistration(lead.id, text);
        onDone('↩ Registration sent back to fix.');
      } else if (kind === 'reg_resubmit') {
        await resubmitRegistration(lead.id, text);
        onDone('Sent for registration approval again.');
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
    approve: '✅ Approve admission',
    return: '↩ Send the admission back',
    resubmit: 'Send for admission approval again',
    reg_approve: '📝 Approve registration',
    reg_return: '↩ Send the registration back',
    reg_resubmit: 'Send for registration approval again',
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
            {kind === 'approve' &&
              checks?.map((c) => (
                <Text key={c.text} style={[styles.check, !c.ok && styles.checkWarn]}>
                  {c.ok ? '✅' : '⚠️'} {c.text}
                </Text>
              ))}
            {withPlacement && <PlacementPicker value={place} onChange={setPlace} />}
            {kind === 'place' && (
              <Text style={styles.hint}>
                A new course changes the fee to that course's fee (its fee talk, or the full fee).
              </Text>
            )}
            {(kind === 'approve' || kind === 'nu') && (
              <TextField
                label={kind === 'approve' ? 'NU Admission ID (now or later)' : 'NU Admission ID'}
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
            {kind !== 'nu' && kind !== 'ref' && kind !== 'place' && (
              <TextField
                label={
                  needsReason
                    ? 'What needs to be fixed? *'
                    : kind === 'approve' && warnings > 0
                      ? `Note * (${warnings} check${warnings > 1 ? 's' : ''} not done)`
                      : 'Note (optional)'
                }
                value={text}
                onChangeText={setText}
                multiline
                placeholder={needsReason ? 'e.g. NID copy missing' : 'e.g. Fee in 2 installments'}
              />
            )}
            {error && <Text style={styles.error}>{error}</Text>}
            <Button
              title={needsReason ? 'Send back' : kind === 'approve' || kind === 'reg_approve' ? 'Approve' : 'Save'}
              variant={needsReason ? 'danger' : 'primary'}
              onPress={save}
              loading={saving}
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
