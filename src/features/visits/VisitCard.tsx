import { useCallback, useEffect, useMemo, useState } from 'react';
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
import {
  cancelVisit,
  finishVisit,
  formatVisitTime,
  getCampusVisitSettings,
  listLeadVisits,
  planVisit,
  type Visit,
} from '@/features/visits/api';
import { colors, fontSize, fontWeight, radius, spacing } from '@/shared/theme';
import { Button } from '@/shared/ui/Button';
import { DateTimePickerButton } from '@/shared/ui/DateTimePickerButton';
import { ShowMoreButton, useShowMore } from '@/shared/ui/ShowMore';
import { TextField } from '@/shared/ui/TextField';

// =====================================================================
// 🏫 Campus visit card on the lead page (under the pipeline)
//   Not part of the pipeline: a lead can be in any stage and visit or not.
// =====================================================================

type Props = {
  leadId: string;
  /** open / won / lost / cancelled: new visits only for open leads */
  stageKind: string;
  /** leads.visit_status + visit_at: the card reloads when they change */
  stateKey: string;
  /** Something changed: reload the lead page (and show a short message) */
  onChanged: (message?: string) => void;
};

type SheetName = 'plan' | 'visited' | 'missed';

const STATUS_TEXT: Record<string, { label: string; color: string }> = {
  visited: { label: '✓ Visited', color: colors.success },
  missed: { label: '✕ Didn’t come', color: colors.danger },
  cancelled: { label: 'Cancelled', color: colors.textMuted },
};

export function VisitCard({ leadId, stageKind, stateKey, onChanged }: Props) {
  const [visits, setVisits] = useState<Visit[]>([]);
  const [enabled, setEnabled] = useState(true);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [sheet, setSheet] = useState<SheetName | null>(null);

  const load = useCallback(async () => {
    try {
      setError(null);
      const [v, s] = await Promise.all([listLeadVisits(leadId), getCampusVisitSettings()]);
      setVisits(v);
      setEnabled(s.enabled);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not load the visits.');
    } finally {
      setLoading(false);
    }
  }, [leadId]);

  useEffect(() => {
    load();
  }, [load, stateKey]);

  const planned = visits.find((v) => v.status === 'planned') ?? null;
  const past = useMemo(() => visits.filter((v) => v.status !== 'planned'), [visits]);
  const pastMore = useShowMore(past, 2);
  const isOpen = stageKind === 'open';

  // Switched off and nothing to show
  if (!loading && !enabled && visits.length === 0) return null;
  // A closed lead that never had a visit: nothing to do here
  if (!loading && !isOpen && visits.length === 0) return null;

  const after = async (message: string) => {
    setSheet(null);
    await load();
    onChanged(message);
  };

  const confirmCancel = () =>
    Alert.alert('Cancel the visit?', 'The planned visit will be dropped.', [
      { text: 'Keep it', style: 'cancel' },
      {
        text: 'Cancel visit',
        style: 'destructive',
        onPress: async () => {
          try {
            await cancelVisit(leadId);
            await after('Visit cancelled.');
          } catch (e) {
            Alert.alert('Could not cancel', e instanceof Error ? e.message : '');
          }
        },
      },
    ]);

  const overdue = !!planned?.planned_at && new Date(planned.planned_at).getTime() < Date.now();

  return (
    <View style={[styles.card, planned && styles.cardPlanned]}>
      <View style={styles.header}>
        <Text style={styles.title}>🏫 Campus visit</Text>
        {!loading && (
          <Text style={[styles.status, { color: planned ? colors.primary : colors.textMuted }]}>
            {planned ? 'Planned' : past[0] ? STATUS_TEXT[past[0].status]?.label : 'Not planned'}
          </Text>
        )}
      </View>

      {loading ? (
        <ActivityIndicator color={colors.primary} />
      ) : (
        <>
          {planned ? (
            <>
              <Text style={[styles.when, overdue && styles.whenOverdue]}>
                📅 {planned.planned_at ? formatVisitTime(planned.planned_at) : 'Date not set'}
                {overdue ? ' · Overdue' : ''}
              </Text>
              {planned.note && <Text style={styles.note}>{planned.note}</Text>}
              <View style={styles.row}>
                <View style={styles.flex}>
                  <Button title="✓ Visited" onPress={() => setSheet('visited')} fullWidth />
                </View>
                <View style={styles.flex}>
                  <Button title="✕ Didn’t come" variant="secondary" onPress={() => setSheet('missed')} fullWidth />
                </View>
              </View>
              <View style={styles.row}>
                {isOpen && (
                  <View style={styles.flex}>
                    <Button
                      title={planned.planned_at ? 'Change date' : 'Set date'}
                      variant="ghost"
                      onPress={() => setSheet('plan')}
                      fullWidth
                    />
                  </View>
                )}
                <View style={styles.flex}>
                  <Button title="Cancel visit" variant="ghost" onPress={confirmCancel} fullWidth />
                </View>
              </View>
            </>
          ) : (
            isOpen &&
            enabled && (
              <View style={styles.row}>
                <View style={styles.flex}>
                  <Button title="📅 Plan a visit" variant="secondary" onPress={() => setSheet('plan')} fullWidth />
                </View>
                <View style={styles.flex}>
                  <Button title="✓ Came today" variant="ghost" onPress={() => setSheet('visited')} fullWidth />
                </View>
              </View>
            )
          )}

          {/* Earlier visits */}
          {past.length > 0 && (
            <View style={styles.history}>
              {pastMore.visible.map((v) => {
                const s = STATUS_TEXT[v.status];
                const at = v.status === 'visited' ? v.visited_at : v.planned_at;
                const who = v.updater?.full_name ?? v.creator?.full_name;
                return (
                  <View key={v.id} style={styles.pastRow}>
                    <Text style={[styles.pastStatus, { color: s?.color }]}>{s?.label}</Text>
                    <View style={styles.flex}>
                      <Text style={styles.meta}>
                        {at ? formatVisitTime(at) : v.status === 'cancelled' ? 'No date' : '—'}
                        {who ? ` · ${who}` : ''}
                      </Text>
                      {v.note && (
                        <Text style={styles.pastNote} numberOfLines={2}>
                          {v.note}
                        </Text>
                      )}
                    </View>
                  </View>
                );
              })}
              <ShowMoreButton {...pastMore} />
            </View>
          )}
        </>
      )}

      {error && <Text style={styles.errorText}>{error}</Text>}

      <PlanSheet
        visible={sheet === 'plan'}
        initial={planned?.planned_at ? new Date(planned.planned_at) : null}
        onClose={() => setSheet(null)}
        onSave={async (at, note) => {
          await planVisit(leadId, at, note);
          await after(`🏫 Visit ${planned ? 'moved to' : 'planned for'} ${formatDue(at)}.`);
        }}
      />

      <FinishSheet
        visible={sheet === 'visited' || sheet === 'missed'}
        status={sheet === 'missed' ? 'missed' : 'visited'}
        walkIn={!planned}
        onClose={() => setSheet(null)}
        onSave={async (note) => {
          const status = sheet === 'missed' ? 'missed' : 'visited';
          const r = await finishVisit(leadId, status, note);
          const parts = [status === 'visited' ? '🏫 Visit saved.' : '🏫 Marked as didn’t come.'];
          if (r.movedTo) parts.push(`Moved to ${r.movedTo}.`);
          if (r.followUpAt) parts.push(`Next call: ${formatDue(r.followUpAt)}.`);
          await after(parts.join(' '));
        }}
      />
    </View>
  );
}

// =====================================================================
// Plan (or move) the visit
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

function PlanSheet({
  visible,
  initial,
  onClose,
  onSave,
}: {
  visible: boolean;
  initial: Date | null;
  onClose: () => void;
  onSave: (at: Date, note: string) => Promise<void>;
}) {
  const [at, setAt] = useState<Date | null>(null);
  const [note, setNote] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const quick = useMemo(() => (visible ? quickDates() : []), [visible]);

  useEffect(() => {
    if (!visible) return;
    setAt(null);
    setNote('');
    setError(null);
  }, [visible]);

  const save = async () => {
    if (!at) {
      setError('Please pick the visit date & time.');
      return;
    }
    if (at.getTime() < Date.now() - 5 * 60 * 1000) {
      setError('The visit date & time must be in the future.');
      return;
    }
    setSaving(true);
    setError(null);
    try {
      await onSave(at, note);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not save the visit.');
    } finally {
      setSaving(false);
    }
  };

  return (
    <SmallSheet visible={visible} onClose={saving ? undefined : onClose}>
      <Text style={styles.sheetTitle}>{initial ? 'Change the visit date' : 'Plan a campus visit'}</Text>
      {initial && <Text style={styles.hint}>Now: {formatDue(initial)}</Text>}

      <View style={styles.field}>
        <Text style={styles.label}>📅 Visit date & time *</Text>
        <View style={styles.chips}>
          {quick.map((q) => {
            const on = !!at && at.getTime() === q.date.getTime();
            return (
              <Pressable
                key={q.key}
                onPress={() => {
                  setAt(q.date);
                  setError(null);
                }}
                style={[styles.chip, on && styles.chipOn]}
                accessibilityRole="radio"
                accessibilityState={{ checked: on }}
              >
                <Text style={[styles.chipText, on && styles.textOn]}>{q.label}</Text>
              </Pressable>
            );
          })}
        </View>
        <DateTimePickerButton
          title={at ? '📅 Change date & time' : '📅 Pick date & time'}
          initial={at ?? initial ?? undefined}
          onPick={(d) => {
            setAt(d);
            setError(null);
          }}
        />
        <Text style={[styles.hint, at && styles.hintStrong]}>
          {at ? `🏫 ${formatDue(at)} · shows in Today on that day` : 'The visit shows in Today on that day.'}
        </Text>
      </View>

      <TextField
        label="Note (optional)"
        value={note}
        onChangeText={setNote}
        multiline
        placeholder="e.g. Coming with father, wants to see the lab"
      />

      {error && <ErrorBox text={error} />}
      <Button title="Save" onPress={save} loading={saving} fullWidth />
      <Button title="Cancel" variant="ghost" onPress={onClose} disabled={saving} fullWidth />
    </SmallSheet>
  );
}

// =====================================================================
// Visited / didn't come
// =====================================================================
function FinishSheet({
  visible,
  status,
  walkIn,
  onClose,
  onSave,
}: {
  visible: boolean;
  status: 'visited' | 'missed';
  /** Visited without a plan */
  walkIn: boolean;
  onClose: () => void;
  onSave: (note: string) => Promise<void>;
}) {
  const [note, setNote] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!visible) return;
    setNote('');
    setError(null);
  }, [visible]);

  const save = async () => {
    setSaving(true);
    setError(null);
    try {
      await onSave(note);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not save.');
    } finally {
      setSaving(false);
    }
  };

  const visited = status === 'visited';
  return (
    <SmallSheet visible={visible} onClose={saving ? undefined : onClose}>
      <Text style={styles.sheetTitle}>
        {visited ? (walkIn ? '🏫 Came today' : '🏫 The student visited') : '🏫 The student didn’t come'}
      </Text>
      <Text style={styles.hint}>
        {visited
          ? 'Saved with today’s date and your name.'
          : 'You can plan a new visit afterwards. A next call may be set (Settings → Campus visit).'}
      </Text>
      <TextField
        label="Note (optional)"
        value={note}
        onChangeText={setNote}
        multiline
        placeholder={visited ? 'e.g. Saw the lab, liked the hostel' : 'e.g. Said he was sick, will come next week'}
      />
      {error && <ErrorBox text={error} />}
      <Button title={visited ? '✓ Save visit' : 'Save'} onPress={save} loading={saving} fullWidth />
      <Button title="Cancel" variant="ghost" onPress={onClose} disabled={saving} fullWidth />
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
  card: {
    gap: spacing.md,
    padding: spacing.lg,
    borderRadius: radius.lg,
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.border,
  },
  cardPlanned: { borderColor: colors.primary },
  header: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  title: { fontSize: fontSize.body, fontWeight: fontWeight.bold, color: colors.text },
  status: { fontSize: fontSize.small, fontWeight: fontWeight.bold },
  when: { fontSize: fontSize.body, fontWeight: fontWeight.semibold, color: colors.text },
  whenOverdue: { color: colors.danger },
  note: { fontSize: fontSize.small, color: colors.text },
  row: { flexDirection: 'row', gap: spacing.sm },
  history: { gap: spacing.sm, paddingTop: spacing.sm, borderTopWidth: 1, borderTopColor: colors.border },
  pastRow: { flexDirection: 'row', gap: spacing.md, alignItems: 'flex-start' },
  pastStatus: { width: 96, fontSize: fontSize.small, fontWeight: fontWeight.bold },
  pastNote: { fontSize: fontSize.small, color: colors.text, marginTop: 2 },
  meta: { fontSize: fontSize.caption, color: colors.textMuted },
  hint: { fontSize: fontSize.caption, color: colors.textMuted },
  hintStrong: { color: colors.primary, fontWeight: fontWeight.bold },
  field: { gap: spacing.sm },
  label: { fontSize: fontSize.small, fontWeight: fontWeight.semibold, color: colors.text },

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
  chipOn: { backgroundColor: colors.primary, borderColor: colors.primary },
  chipText: { fontSize: fontSize.small, fontWeight: fontWeight.semibold, color: colors.text },
  textOn: { color: colors.textOnPrimary },
  errorBox: { padding: spacing.md, borderRadius: radius.md, backgroundColor: colors.dangerSoft },
  errorText: { fontSize: fontSize.small, color: colors.danger },
});
