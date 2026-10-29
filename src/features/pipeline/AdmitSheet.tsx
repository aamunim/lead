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

import { listMissingPapers } from '@/features/papers/api';
import {
  DEFAULT_ADMISSION,
  batchLabel,
  getAdmissionSettings,
  listActiveCourses,
  listAdmissionBatches,
  markAdmitted,
  previewStudentRef,
  type AdmissionBatch,
  type AdmissionSettings,
  type AdmitResult,
  type Named,
} from '@/features/pipeline/api';
import { colors, fontSize, fontWeight, radius, spacing } from '@/shared/theme';
import { Button } from '@/shared/ui/Button';
import { DateTimePickerButton } from '@/shared/ui/DateTimePickerButton';
import { TextField } from '@/shared/ui/TextField';

type Props = {
  visible: boolean;
  lead: {
    id: string;
    name: string;
    /** Courses the lead is interested in: shown first */
    courseIds: string[];
    /** Kept from an earlier (cancelled) admission */
    studentRef?: string | null;
  };
  onClose: () => void;
  onSaved: (result: AdmitResult) => void;
};

function formatDay(d: Date): string {
  return d.toLocaleDateString([], { day: 'numeric', month: 'short', year: 'numeric' });
}

export function AdmitSheet({ visible, lead, onClose, onSaved }: Props) {
  const [settings, setSettings] = useState<AdmissionSettings>(DEFAULT_ADMISSION);
  const [courses, setCourses] = useState<Named[]>([]);
  const [loading, setLoading] = useState(true);

  const [courseId, setCourseId] = useState<string | null>(null);
  const [batches, setBatches] = useState<AdmissionBatch[]>([]);
  const [batchesLoading, setBatchesLoading] = useState(false);
  const [batchId, setBatchId] = useState<string | null>(null);

  // Required papers not received yet, for the chosen course (null = not checked)
  const [missing, setMissing] = useState<string[] | null>(null);
  const [missingLoading, setMissingLoading] = useState(false);

  const [admittedAt, setAdmittedAt] = useState<Date>(new Date());
  const [refPreview, setRefPreview] = useState<string | null>(null);
  const [ownRef, setOwnRef] = useState(false); // auto mode: type my own instead
  const [studentRef, setStudentRef] = useState('');
  const [note, setNote] = useState('');

  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<AdmitResult | null>(null);
  const [doneMissing, setDoneMissing] = useState(0); // papers still to collect after admitting

  const idMode = settings.student_id.mode;
  const paperRule = settings.papers_on_admit;
  const missingCount = missing?.length ?? 0;
  const blockedByPapers = paperRule === 'block' && missingCount > 0;

  // --- open: start fresh and load what the sheet needs ---------------------
  useEffect(() => {
    if (!visible) return;
    setLoading(true);
    setError(null);
    setDone(null);
    setDoneMissing(0);
    setBatchId(null);
    setBatches([]);
    setMissing(null);
    setAdmittedAt(new Date());
    setOwnRef(false);
    setStudentRef(lead.studentRef ?? '');
    setNote('');

    Promise.all([getAdmissionSettings(), listActiveCourses(), previewStudentRef()])
      .then(([s, c, preview]) => {
        setSettings(s);
        setCourses(c);
        setRefPreview(preview);
        // Only one interested course: pick it
        const interested = c.filter((x) => lead.courseIds.includes(x.id));
        setCourseId(interested.length === 1 ? interested[0].id : null);
      })
      .catch((e) => setError(e instanceof Error ? e.message : 'Could not load courses.'))
      .finally(() => setLoading(false));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visible, lead.id]);

  // --- batches of the chosen course ------------------------------------------
  useEffect(() => {
    setBatchId(null);
    setBatches([]);
    if (!courseId) return;
    setBatchesLoading(true);
    listAdmissionBatches(courseId)
      .then((list) => {
        setBatches(list);
        // Only one batch that still has room: pick it
        const usable = list.filter((b) => !b.isFull && b.status === 'open');
        if (usable.length === 1) setBatchId(usable[0].id);
      })
      .catch(() => setBatches([]))
      .finally(() => setBatchesLoading(false));
  }, [courseId]);

  // --- papers missing for the chosen course ----------------------------------
  useEffect(() => {
    setMissing(null);
    if (!visible || loading || !courseId || paperRule === 'allow') return;
    let alive = true;
    setMissingLoading(true);
    listMissingPapers(lead.id, courseId)
      .then((names) => alive && setMissing(names))
      .catch(() => alive && setMissing(null)) // the database still checks on save
      .finally(() => alive && setMissingLoading(false));
    return () => {
      alive = false;
    };
  }, [visible, loading, courseId, paperRule, lead.id]);

  // Interested courses first
  const sortedCourses = useMemo(() => {
    const first = courses.filter((c) => lead.courseIds.includes(c.id));
    const rest = courses.filter((c) => !lead.courseIds.includes(c.id));
    return [...first, ...rest];
  }, [courses, lead.courseIds]);

  const canPickBatch = (b: AdmissionBatch) => b.status === 'open' && (!b.isFull || settings.allow_overbooking);

  // --- save -----------------------------------------------------------------
  const save = async (papersConfirmed = false) => {
    setError(null);
    if (!courseId) {
      setError('Please choose a course.');
      return;
    }
    if (settings.batch_required && !batchId) {
      setError('Please choose a batch.');
      return;
    }
    if (idMode === 'manual' && !studentRef.trim()) {
      setError('Please type the student ID.');
      return;
    }

    // Papers
    if (blockedByPapers) {
      setError(`Required papers are missing: ${missing!.join(', ')}. Tick them on the Papers card first.`);
      return;
    }
    if (paperRule === 'warn' && missingCount > 0 && !papersConfirmed) {
      Alert.alert(
        `${missingCount} paper${missingCount > 1 ? 's' : ''} not received`,
        `Still missing:\n• ${missing!.join('\n• ')}\n\nAdmit anyway?`,
        [
          { text: 'Go back', style: 'cancel' },
          { text: 'Admit anyway', onPress: () => save(true) },
        ],
      );
      return;
    }

    setSaving(true);
    try {
      const result = await markAdmitted({
        leadId: lead.id,
        courseId,
        batchId,
        admittedAt,
        studentRef: idMode === 'manual' || (idMode === 'auto' && ownRef) ? studentRef : null,
        note,
      });
      setDoneMissing(missingCount);
      setDone(result);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not save the admission.');
    } finally {
      setSaving(false);
    }
  };

  const courseName = courses.find((c) => c.id === courseId)?.name;
  const batchName = batches.find((b) => b.id === batchId)?.name;

  // --- render ---------------------------------------------------------------
  return (
    <Modal visible={visible} transparent animationType="slide" onRequestClose={done ? () => onSaved(done) : onClose}>
      <KeyboardAvoidingView style={styles.backdrop} behavior="padding">
        <Pressable
          style={styles.flex}
          onPress={saving ? undefined : done ? () => onSaved(done) : onClose}
          accessibilityLabel="Close"
        />

        <View style={styles.sheet}>
          <View style={styles.handle} />
          <ScrollView contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
            {done ? (
              /* ---------- 🎉 Done ---------- */
              <View style={styles.doneBox}>
                <Text style={styles.party}>🎉</Text>
                <Text style={styles.title}>{lead.name} is admitted!</Text>
                <Text style={styles.doneText}>
                  {courseName}
                  {batchName ? ` · ${batchName}` : ''}
                </Text>
                {done.studentRef && (
                  <View style={styles.refBadge}>
                    <Text style={styles.refBadgeText}>Student ID: {done.studentRef}</Text>
                  </View>
                )}
                {done.seatsLeft != null && (
                  <Text style={styles.hint}>
                    {done.seatsLeft === 0 ? 'This batch is now full.' : `${done.seatsLeft} seats left in this batch.`}
                  </Text>
                )}
                {doneMissing > 0 && (
                  <Text style={styles.warn}>
                    📄 {doneMissing} paper{doneMissing > 1 ? 's' : ''} still to collect. See the Papers card.
                  </Text>
                )}
                <Button title="Done" onPress={() => onSaved(done)} fullWidth />
              </View>
            ) : (
              <>
                <View>
                  <Text style={styles.title}>🎓 Mark admitted</Text>
                  <Text style={styles.subtitle}>{lead.name}</Text>
                </View>

                {loading ? (
                  <ActivityIndicator color={colors.primary} style={styles.loader} />
                ) : (
                  <>
                    {/* Course */}
                    <View style={styles.field}>
                      <Text style={styles.label}>Course *</Text>
                      {sortedCourses.length === 0 ? (
                        <Text style={styles.warn}>No courses yet. Add one in Settings → Courses & batches.</Text>
                      ) : (
                        <View style={styles.chips}>
                          {sortedCourses.map((c) => {
                            const on = courseId === c.id;
                            const interested = lead.courseIds.includes(c.id);
                            return (
                              <Pressable
                                key={c.id}
                                onPress={() => setCourseId(c.id)}
                                style={[styles.chip, on && styles.chipOn]}
                                accessibilityRole="radio"
                                accessibilityState={{ checked: on }}
                              >
                                <Text style={[styles.chipText, on && styles.textOn]}>
                                  {interested ? '★ ' : ''}
                                  {c.name}
                                </Text>
                              </Pressable>
                            );
                          })}
                        </View>
                      )}
                      {lead.courseIds.length > 0 && <Text style={styles.hint}>★ = the lead is interested in it</Text>}
                    </View>

                    {/* Papers for this course */}
                    {courseId && paperRule !== 'allow' && (
                      <PapersStatus
                        loading={missingLoading}
                        missing={missing}
                        rule={paperRule}
                      />
                    )}

                    {/* Batch */}
                    {courseId && (
                      <View style={styles.field}>
                        <Text style={styles.label}>Batch{settings.batch_required ? ' *' : ' (optional)'}</Text>
                        {batchesLoading ? (
                          <ActivityIndicator color={colors.primary} />
                        ) : batches.length === 0 ? (
                          <Text style={styles.hint}>No batches for this course.</Text>
                        ) : (
                          <View style={styles.batchList}>
                            {!settings.batch_required && (
                              <BatchRow
                                label="No batch yet"
                                selected={batchId === null}
                                onPress={() => setBatchId(null)}
                              />
                            )}
                            {batches.map((b) => (
                              <BatchRow
                                key={b.id}
                                label={batchLabel(b)}
                                sub={[b.startDate && `Starts ${b.startDate}`, b.classTime, b.status !== 'open' && b.status]
                                  .filter(Boolean)
                                  .join(' · ')}
                                selected={batchId === b.id}
                                disabled={!canPickBatch(b)}
                                warn={b.isFull && settings.allow_overbooking}
                                onPress={() => setBatchId(b.id)}
                              />
                            ))}
                          </View>
                        )}
                        {batches.some((b) => b.isFull) && (
                          <Text style={styles.hint}>
                            {settings.allow_overbooking
                              ? 'Full batches can still be chosen (overbooking is on).'
                              : 'Full batches are greyed out.'}
                          </Text>
                        )}
                      </View>
                    )}

                    {/* Date */}
                    <View style={styles.field}>
                      <Text style={styles.label}>Admission date</Text>
                      <DateTimePickerButton
                        title={`📅 ${formatDay(admittedAt)}`}
                        initial={admittedAt}
                        onPick={setAdmittedAt}
                      />
                    </View>

                    {/* Student ID */}
                    {idMode !== 'off' && (
                      <View style={styles.field}>
                        <Text style={styles.label}>Student ID{idMode === 'manual' ? ' *' : ''}</Text>

                        {idMode === 'auto' && !ownRef ? (
                          <>
                            <View style={styles.refPreview}>
                              <Text style={styles.refPreviewText}>
                                {lead.studentRef ?? refPreview ?? 'Given automatically'}
                              </Text>
                              <Text style={styles.hint}>{lead.studentRef ? 'Kept from before' : 'Given automatically'}</Text>
                            </View>
                            <Pressable onPress={() => setOwnRef(true)} hitSlop={8} accessibilityRole="button">
                              <Text style={styles.link}>Type a different ID</Text>
                            </Pressable>
                          </>
                        ) : (
                          <TextField
                            label=""
                            value={studentRef}
                            onChangeText={setStudentRef}
                            placeholder="e.g. ADM-2026-0042"
                            autoCapitalize="characters"
                          />
                        )}
                      </View>
                    )}

                    {/* Note */}
                    <TextField
                      label="Note (optional)"
                      value={note}
                      onChangeText={setNote}
                      multiline
                      placeholder="e.g. Paid admission fee"
                    />
                  </>
                )}

                {error && (
                  <View style={styles.errorBox}>
                    <Text style={styles.errorText}>{error}</Text>
                  </View>
                )}

                <Button
                  title="🎓 Mark admitted"
                  onPress={() => save()}
                  loading={saving}
                  disabled={loading || !courseId || blockedByPapers || missingLoading}
                  fullWidth
                />
                <Button title="Cancel" variant="ghost" onPress={onClose} disabled={saving} fullWidth />
              </>
            )}
          </ScrollView>
        </View>
      </KeyboardAvoidingView>
    </Modal>
  );
}

// =====================================================================
// Papers for the chosen course: all in / missing (warn or block)
// =====================================================================
function PapersStatus({
  loading,
  missing,
  rule,
}: {
  loading: boolean;
  missing: string[] | null;
  rule: 'block' | 'warn';
}) {
  if (loading) {
    return (
      <View style={[styles.paperBox, styles.paperBoxInfo]}>
        <ActivityIndicator size="small" color={colors.primary} />
        <Text style={styles.hint}>Checking papers…</Text>
      </View>
    );
  }
  if (missing === null) return null; // could not check: the database still checks on save

  if (missing.length === 0) {
    return (
      <View style={[styles.paperBox, styles.paperBoxOk]}>
        <Text style={styles.paperOkText}>✓ All required papers received</Text>
      </View>
    );
  }

  const block = rule === 'block';
  return (
    <View style={[styles.paperBox, block ? styles.paperBoxBlock : styles.paperBoxWarn]}>
      <View style={styles.flex}>
        <Text style={[styles.paperTitle, { color: block ? colors.danger : colors.warning }]}>
          {block ? '⛔' : '⚠️'} {missing.length} required paper{missing.length > 1 ? 's' : ''} not received
        </Text>
        {missing.map((name) => (
          <Text key={name} style={styles.paperItem}>
            • {name}
          </Text>
        ))}
        <Text style={styles.hint}>
          {block
            ? 'Admission needs all required papers. Tick them on the Papers card, or mark “not needed”.'
            : 'You can still admit. The papers stay on the to-collect list.'}
        </Text>
      </View>
    </View>
  );
}

// =====================================================================
// One batch choice
// =====================================================================
function BatchRow({
  label,
  sub,
  selected,
  disabled,
  warn,
  onPress,
}: {
  label: string;
  sub?: string;
  selected: boolean;
  disabled?: boolean;
  warn?: boolean;
  onPress: () => void;
}) {
  return (
    <Pressable
      onPress={onPress}
      disabled={disabled}
      style={({ pressed }) => [
        styles.batchRow,
        selected && styles.batchRowOn,
        disabled && styles.batchRowOff,
        pressed && styles.pressed,
      ]}
      accessibilityRole="radio"
      accessibilityState={{ checked: selected, disabled }}
    >
      <View style={[styles.radio, selected && styles.radioOn]}>{selected && <View style={styles.radioDot} />}</View>
      <View style={styles.flex}>
        <Text style={[styles.batchText, disabled && styles.mutedText, warn && styles.warnText]}>{label}</Text>
        {sub ? <Text style={styles.hint}>{sub}</Text> : null}
      </View>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1 },
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
  content: { padding: spacing.lg, gap: spacing.lg, paddingBottom: spacing.xxl },
  loader: { paddingVertical: spacing.xl },
  pressed: { opacity: 0.8 },

  title: { fontSize: fontSize.title, fontWeight: fontWeight.bold, color: colors.text },
  subtitle: { fontSize: fontSize.small, color: colors.textMuted, marginTop: 2 },
  field: { gap: spacing.sm },
  label: { fontSize: fontSize.small, fontWeight: fontWeight.semibold, color: colors.text },
  hint: { fontSize: fontSize.caption, color: colors.textMuted },
  warn: { fontSize: fontSize.small, color: colors.warning, textAlign: 'center' },
  link: { fontSize: fontSize.small, fontWeight: fontWeight.bold, color: colors.primary },

  chips: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.sm },
  chip: {
    paddingVertical: spacing.sm,
    paddingHorizontal: spacing.lg,
    borderRadius: radius.pill,
    borderWidth: 1.5,
    borderColor: colors.border,
  },
  chipOn: { backgroundColor: colors.success, borderColor: colors.success },
  chipText: { fontSize: fontSize.small, fontWeight: fontWeight.semibold, color: colors.text },
  textOn: { color: colors.textOnPrimary },

  paperBox: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    padding: spacing.md,
    borderRadius: radius.md,
    borderWidth: 1,
  },
  paperBoxInfo: { borderColor: colors.border, backgroundColor: colors.background },
  paperBoxOk: { borderColor: colors.success, backgroundColor: colors.successSoft },
  paperBoxWarn: { borderColor: colors.warning, backgroundColor: colors.background },
  paperBoxBlock: { borderColor: colors.danger, backgroundColor: colors.dangerSoft },
  paperOkText: { fontSize: fontSize.small, fontWeight: fontWeight.bold, color: colors.success },
  paperTitle: { fontSize: fontSize.small, fontWeight: fontWeight.bold, marginBottom: 4 },
  paperItem: { fontSize: fontSize.small, color: colors.text, marginBottom: 2 },

  batchList: { gap: spacing.sm },
  batchRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
    padding: spacing.md,
    borderRadius: radius.md,
    borderWidth: 1.5,
    borderColor: colors.border,
  },
  batchRowOn: { borderColor: colors.success, backgroundColor: colors.successSoft },
  batchRowOff: { opacity: 0.5 },
  batchText: { fontSize: fontSize.small, fontWeight: fontWeight.semibold, color: colors.text },
  mutedText: { color: colors.textMuted },
  warnText: { color: colors.warning },
  radio: {
    width: 20,
    height: 20,
    borderRadius: radius.pill,
    borderWidth: 2,
    borderColor: colors.border,
    alignItems: 'center',
    justifyContent: 'center',
  },
  radioOn: { borderColor: colors.success },
  radioDot: { width: 10, height: 10, borderRadius: radius.pill, backgroundColor: colors.success },

  refPreview: { padding: spacing.md, borderRadius: radius.md, backgroundColor: colors.background, gap: 2 },
  refPreviewText: { fontSize: fontSize.body, fontWeight: fontWeight.bold, color: colors.text, letterSpacing: 0.5 },

  doneBox: { alignItems: 'center', gap: spacing.md, paddingVertical: spacing.lg },
  party: { fontSize: 56 },
  doneText: { fontSize: fontSize.body, fontWeight: fontWeight.semibold, color: colors.success, textAlign: 'center' },
  refBadge: {
    paddingVertical: spacing.sm,
    paddingHorizontal: spacing.lg,
    borderRadius: radius.pill,
    backgroundColor: colors.successSoft,
  },
  refBadgeText: { fontSize: fontSize.small, fontWeight: fontWeight.bold, color: colors.success },

  errorBox: { padding: spacing.md, borderRadius: radius.md, backgroundColor: colors.dangerSoft },
  errorText: { fontSize: fontSize.small, color: colors.danger },
});