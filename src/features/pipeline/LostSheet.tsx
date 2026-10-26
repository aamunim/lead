import { useEffect, useMemo, useState } from 'react';
import {
    ActivityIndicator,
    KeyboardAvoidingView,
    Modal,
    Platform,
    Pressable,
    ScrollView,
    StyleSheet,
    Text,
    View,
} from 'react-native';

import {
    bulkMarkLost,
    listLostReasons,
    markLost,
    reviveChoices,
    type Named,
} from '@/features/pipeline/api';
import { colors, fontSize, fontWeight, radius, spacing } from '@/shared/theme';
import { Button } from '@/shared/ui/Button';
import { DateTimePickerButton } from '@/shared/ui/DateTimePickerButton';
import { TextField } from '@/shared/ui/TextField';

const NO_REVIVE = 'none';
const CUSTOM = 'custom';

type Props = {
  visible: boolean;
  /** One lead (lead page) or many (marked in the list) */
  leads: { id: string; name: string }[];
  onClose: () => void;
  /** Short message for a toast, e.g. "Marked lost." */
  onSaved: (message: string) => void;
};

function formatDay(d: Date): string {
  return d.toLocaleDateString([], { day: 'numeric', month: 'short', year: 'numeric' });
}

export function LostSheet({ visible, leads, onClose, onSaved }: Props) {
  const bulk = leads.length > 1;

  const [reasons, setReasons] = useState<Named[]>([]);
  const [loading, setLoading] = useState(true);
  const [reasonId, setReasonId] = useState<string | null>(null);
  const [note, setNote] = useState('');
  const [reviveKey, setReviveKey] = useState<string>(NO_REVIVE);
  const [customDate, setCustomDate] = useState<Date | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const choices = useMemo(() => (visible ? reviveChoices() : []), [visible]);

  useEffect(() => {
    if (!visible) return;
    setReasonId(null);
    setNote('');
    setReviveKey(NO_REVIVE);
    setCustomDate(null);
    setError(null);
    setLoading(true);
    listLostReasons()
      .then(setReasons)
      .catch((e) => setError(e instanceof Error ? e.message : 'Could not load lost reasons.'))
      .finally(() => setLoading(false));
  }, [visible]);

  const reason = reasons.find((r) => r.id === reasonId) ?? null;
  const noteNeeded = !!reason && /^other/i.test(reason.name);

  const reviveAt: Date | null =
    reviveKey === CUSTOM ? customDate : choices.find((c) => c.key === reviveKey)?.date ?? null;

  const save = async () => {
    setError(null);
    if (!reasonId) {
      setError('Please choose why the lead was lost.');
      return;
    }
    if (noteNeeded && !note.trim()) {
      setError(`Please add a note for "${reason?.name}".`);
      return;
    }
    if (reviveKey === CUSTOM && (!customDate || customDate.getTime() <= Date.now())) {
      setError('Please pick a date in the future for “Try again”.');
      return;
    }

    setSaving(true);
    try {
      if (bulk) {
        const r = await bulkMarkLost(
          leads.map((l) => l.id),
          reasonId,
          note,
        );
        onSaved(
          r.skipped > 0
            ? `${r.done} marked lost · ${r.skipped} skipped (admitted, already lost or not yours)`
            : `${r.done} ${r.done === 1 ? 'lead' : 'leads'} marked lost.`,
        );
      } else {
        await markLost({ leadId: leads[0].id, reasonId, note, reviveAt });
        onSaved(reviveAt ? `Marked lost. ♻️ Back in your calls on ${formatDay(reviveAt)}.` : 'Marked lost.');
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not save.');
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal visible={visible} transparent animationType="slide" onRequestClose={onClose}>
      <KeyboardAvoidingView style={styles.backdrop} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
        <Pressable style={styles.flex} onPress={saving ? undefined : onClose} accessibilityLabel="Close" />

        <View style={styles.sheet}>
          <View style={styles.handle} />
          <ScrollView contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
            <View>
              <Text style={styles.title}>✕ Mark lost</Text>
              <Text style={styles.subtitle} numberOfLines={2}>
                {bulk ? `${leads.length} leads` : leads[0]?.name}
              </Text>
            </View>

            {loading ? (
              <ActivityIndicator color={colors.primary} style={styles.loader} />
            ) : (
              <>
                {/* Reason */}
                <View style={styles.field}>
                  <Text style={styles.label}>Why? *</Text>
                  {reasons.length === 0 ? (
                    <Text style={styles.warn}>No lost reasons yet. Add them in Settings → Lost reasons.</Text>
                  ) : (
                    <View style={styles.chips}>
                      {reasons.map((r) => {
                        const on = reasonId === r.id;
                        return (
                          <Pressable
                            key={r.id}
                            onPress={() => setReasonId(r.id)}
                            style={[styles.chip, on && styles.chipOn]}
                            accessibilityRole="radio"
                            accessibilityState={{ checked: on }}
                          >
                            <Text style={[styles.chipText, on && styles.textOn]}>{r.name}</Text>
                          </Pressable>
                        );
                      })}
                    </View>
                  )}
                </View>

                {/* Note */}
                <TextField
                  label={noteNeeded ? 'Note *' : 'Note (optional)'}
                  value={note}
                  onChangeText={setNote}
                  multiline
                  placeholder="e.g. Took admission at another institute"
                />

                {/* Try again later (one lead only) */}
                {!bulk && (
                  <View style={styles.field}>
                    <Text style={styles.label}>Try again later?</Text>
                    <View style={styles.chips}>
                      <Pressable
                        onPress={() => setReviveKey(NO_REVIVE)}
                        style={[styles.chip, reviveKey === NO_REVIVE && styles.chipMuted]}
                        accessibilityRole="radio"
                        accessibilityState={{ checked: reviveKey === NO_REVIVE }}
                      >
                        <Text style={[styles.chipText, reviveKey === NO_REVIVE && styles.textOn]}>No</Text>
                      </Pressable>
                      {choices.map((c) => {
                        const on = reviveKey === c.key;
                        return (
                          <Pressable
                            key={c.key}
                            onPress={() => setReviveKey(c.key)}
                            style={[styles.chip, on && styles.chipRevive]}
                            accessibilityRole="radio"
                            accessibilityState={{ checked: on }}
                          >
                            <Text style={[styles.chipText, on && styles.textOn]}>{c.label}</Text>
                          </Pressable>
                        );
                      })}
                    </View>

                    <DateTimePickerButton
                      title={reviveKey === CUSTOM && customDate ? '📅 Change date' : '📅 Pick a date'}
                      initial={customDate ?? undefined}
                      onPick={(d) => {
                        setCustomDate(d);
                        setReviveKey(CUSTOM);
                      }}
                    />

                    <Text style={[styles.hint, reviveAt && styles.hintStrong]}>
                      {reviveAt
                        ? `♻️ This lead comes back in your calls on ${formatDay(reviveAt)}.`
                        : 'The lead leaves your call list.'}
                    </Text>
                  </View>
                )}

                {bulk && (
                  <Text style={styles.hint}>
                    Admitted leads, leads already lost, and leads you can’t edit are skipped.
                  </Text>
                )}
              </>
            )}

            {error && (
              <View style={styles.errorBox}>
                <Text style={styles.errorText}>{error}</Text>
              </View>
            )}

            <Button
              title={bulk ? `✕ Mark ${leads.length} leads lost` : '✕ Mark lost'}
              variant="danger"
              onPress={save}
              loading={saving}
              disabled={loading || !reasonId}
              fullWidth
            />
            <Button title="Cancel" variant="ghost" onPress={onClose} disabled={saving} fullWidth />
          </ScrollView>
        </View>
      </KeyboardAvoidingView>
    </Modal>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1 },
  backdrop: { flex: 1, backgroundColor: 'rgba(0,0,0,0.4)' },
  sheet: {
    maxHeight: '90%',
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

  title: { fontSize: fontSize.title, fontWeight: fontWeight.bold, color: colors.danger },
  subtitle: { fontSize: fontSize.small, color: colors.textMuted, marginTop: 2 },
  field: { gap: spacing.sm },
  label: { fontSize: fontSize.small, fontWeight: fontWeight.semibold, color: colors.text },
  hint: { fontSize: fontSize.caption, color: colors.textMuted },
  hintStrong: { color: colors.success, fontWeight: fontWeight.bold },
  warn: { fontSize: fontSize.small, color: colors.warning },

  chips: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.sm },
  chip: {
    paddingVertical: spacing.sm,
    paddingHorizontal: spacing.lg,
    borderRadius: radius.pill,
    borderWidth: 1.5,
    borderColor: colors.border,
  },
  chipOn: { backgroundColor: colors.danger, borderColor: colors.danger },
  chipRevive: { backgroundColor: colors.success, borderColor: colors.success },
  chipMuted: { backgroundColor: colors.textMuted, borderColor: colors.textMuted },
  chipText: { fontSize: fontSize.small, fontWeight: fontWeight.semibold, color: colors.text },
  textOn: { color: colors.textOnPrimary },

  errorBox: { padding: spacing.md, borderRadius: radius.md, backgroundColor: colors.dangerSoft },
  errorText: { fontSize: fontSize.small, color: colors.danger },
});