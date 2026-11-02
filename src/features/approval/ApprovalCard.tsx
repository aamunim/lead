import { useEffect, useState } from 'react';
import { Alert, Modal, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';

import {
  DEFAULT_APPROVAL_SETTINGS,
  approveAdmission,
  canApprove,
  getApprovalSettings,
  resubmitAdmission,
  returnAdmission,
  setNuAdmissionId,
  setStudentRef,
  type ApprovalSettings,
} from '@/features/approval/api';
import { useAuth } from '@/features/auth/AuthProvider';
import { money } from '@/features/fees/api';
import { colors, fontSize, fontWeight, radius, spacing } from '@/shared/theme';
import { Button } from '@/shared/ui/Button';
import { TextField } from '@/shared/ui/TextField';

// =====================================================================
// 🎓 Admission approval card (admitted students only)
//   ⏳ waiting → the officer checks the list and approves (NU Admission ID
//   now or later) or sends it back with a reason → ✅ approved / ↩ sent back
//   (fixed: "Send again"). Hidden for anyone not admitted or cancelled.
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
  admitted_batch_id: string | null;
};

export type ApprovalSheetKind = Exclude<Sheet, null>;
type Sheet = 'approve' | 'return' | 'resubmit' | 'nu' | 'ref' | null;

const day = (iso: string) =>
  new Date(iso).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });

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
  const [sheet, setSheet] = useState<Sheet>(null);

  useEffect(() => {
    getApprovalSettings().then(setSettings);
  }, []);

  const status = lead.approval_status;
  if (!settings.enabled || !status) return null;
  const officer = canApprove(settings, profile, isAdmin);

  // What the officer should look at before approving
  const checks: { ok: boolean; text: string }[] = [
    {
      ok: !!lead.student_ref,
      text: lead.student_ref ? `College ID: ${lead.student_ref}` : 'No College ID (Student ID) yet',
    },
    ...((lead.papers_required ?? 0) > 0
      ? [
          {
            ok: (lead.papers_missing ?? 0) === 0,
            text:
              (lead.papers_missing ?? 0) === 0
                ? `Papers: all ${lead.papers_required} in`
                : `Papers: ${lead.papers_missing} of ${lead.papers_required} missing`,
          },
        ]
      : []),
    {
      ok: Number(lead.fee_due ?? 0) <= 0,
      text: Number(lead.fee_due ?? 0) > 0 ? `Fee: ${money(Number(lead.fee_due))} due` : 'Fee: fully paid',
    },
    { ok: !!lead.admitted_batch_id, text: lead.admitted_batch_id ? 'Batch: set' : 'No batch yet' },
  ];
  const warnings = checks.filter((c) => !c.ok).length;

  const tone = status === 'approved' ? styles.good : status === 'returned' ? styles.bad : styles.wait;
  const title =
    status === 'approved'
      ? '✅ Admission approved'
      : status === 'returned'
        ? '↩ Sent back to fix'
        : '⏳ Waiting for approval';

  return (
    <View style={[styles.card, tone]}>
      <Text style={styles.header}>🎓 Admission approval</Text>
      <Text style={styles.title}>{title}</Text>
      {status !== 'waiting' && lead.approval_at && (
        <Text style={styles.meta}>{[nameOf(lead.approval_by), day(lead.approval_at)].filter(Boolean).join(' · ')}</Text>
      )}
      {!!lead.approval_note && <Text style={styles.note}>“{lead.approval_note}”</Text>}

      <View style={styles.ids}>
        <IdRow label="College ID" value={lead.student_ref} onEdit={officer ? () => setSheet('ref') : undefined} />
        <IdRow
          label="NU Admission ID"
          value={lead.nu_admission_id}
          onEdit={officer ? () => setSheet('nu') : undefined}
        />
      </View>

      {status === 'waiting' && officer && (
        <>
          <Text style={styles.label}>CHECK BEFORE APPROVING</Text>
          {checks.map((c) => (
            <Text key={c.text} style={[styles.check, !c.ok && styles.checkWarn]}>
              {c.ok ? '✅' : '⚠️'} {c.text}
            </Text>
          ))}
          <View style={styles.row}>
            <View style={styles.flex}>
              <Button title="↩ Send back" variant="secondary" onPress={() => setSheet('return')} fullWidth />
            </View>
            <View style={styles.flex}>
              <Button title="✅ Approve" onPress={() => setSheet('approve')} fullWidth />
            </View>
          </View>
        </>
      )}
      {status === 'waiting' && !officer && <Text style={styles.meta}>The Admission Officer will check it.</Text>}

      {status === 'returned' && <Button title="Fixed: send again" onPress={() => setSheet('resubmit')} fullWidth />}

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

function IdRow({ label, value, onEdit }: { label: string; value: string | null; onEdit?: () => void }) {
  return (
    <View style={styles.idRow}>
      <Text style={styles.idLabel}>{label}</Text>
      <Text style={[styles.idValue, !value && styles.idEmpty]} selectable>
        {value ?? '—'}
      </Text>
      {onEdit && (
        <Pressable onPress={onEdit} hitSlop={8} accessibilityRole="button" accessibilityLabel={`Change ${label}`}>
          <Text style={styles.edit}>{value ? 'Change' : '＋ Add'}</Text>
        </Pressable>
      )}
    </View>
  );
}

// One small sheet for approve / send back / send again / NU ID
/** The approve / send back / send again / ID dialog (also from the website's table) */
export function ApprovalActionSheet({
  kind,
  lead,
  warnings,
  checks,
  onClose,
  onDone,
}: {
  kind: Exclude<Sheet, null>;
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
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const save = async () => {
    setError(null);
    if (kind === 'return' && !text.trim()) return setError('Please write what needs to be fixed.');
    if (kind === 'ref' && !ref.trim()) return setError('Please type the College ID.');
    if (kind === 'approve' && warnings > 0 && !text.trim()) {
      return setError('Some checks are not done. Please write why you approve anyway.');
    }
    setSaving(true);
    try {
      if (kind === 'approve') {
        await approveAdmission(lead.id, nu, text);
        onDone('✅ Admission approved.');
      } else if (kind === 'return') {
        await returnAdmission(lead.id, text);
        onDone('↩ Sent back to fix.');
      } else if (kind === 'resubmit') {
        await resubmitAdmission(lead.id, text);
        onDone('Sent for approval again.');
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

  const titles: Record<typeof kind, string> = {
    approve: '✅ Approve admission',
    return: '↩ Send back to fix',
    resubmit: 'Send for approval again',
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
            {kind !== 'nu' && kind !== 'ref' && (
              <TextField
                label={
                  kind === 'return'
                    ? 'What needs to be fixed? *'
                    : kind === 'approve'
                      ? warnings > 0
                        ? `Note * (${warnings} check${warnings > 1 ? 's' : ''} not done)`
                        : 'Note (optional)'
                      : 'Note (optional)'
                }
                value={text}
                onChangeText={setText}
                multiline
                placeholder={
                  kind === 'return'
                    ? 'e.g. NID copy missing'
                    : kind === 'approve'
                      ? 'e.g. Fee in 2 installments'
                      : 'e.g. NID copy given'
                }
              />
            )}
            {error && <Text style={styles.error}>{error}</Text>}
            <Button
              title={kind === 'return' ? 'Send back' : kind === 'approve' ? 'Approve' : 'Save'}
              variant={kind === 'return' ? 'danger' : 'primary'}
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
  title: { fontSize: fontSize.body, fontWeight: fontWeight.bold, color: colors.text },
  meta: { fontSize: fontSize.caption, color: colors.textMuted },
  note: { fontSize: fontSize.small, color: colors.text, fontStyle: 'italic' },
  ids: { gap: spacing.xs, paddingVertical: spacing.xs },
  idRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm },
  idLabel: { width: 130, fontSize: fontSize.small, color: colors.textMuted },
  idValue: { flex: 1, fontSize: fontSize.body, fontWeight: fontWeight.bold, color: colors.text },
  idEmpty: { fontWeight: fontWeight.regular, color: colors.textMuted },
  edit: { fontSize: fontSize.small, fontWeight: fontWeight.bold, color: colors.primary },
  label: { fontSize: fontSize.caption, fontWeight: fontWeight.bold, color: colors.textMuted, marginTop: spacing.xs },
  check: { fontSize: fontSize.small, color: colors.text },
  checkWarn: { color: colors.warning, fontWeight: fontWeight.semibold },
  row: { flexDirection: 'row', gap: spacing.md, marginTop: spacing.sm },
  backdrop: { flex: 1, backgroundColor: 'rgba(0,0,0,0.4)' },
  sheet: {
    maxHeight: '85%',
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
