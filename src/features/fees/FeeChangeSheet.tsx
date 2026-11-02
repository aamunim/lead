import { useEffect, useState } from 'react';
import { ActivityIndicator, Modal, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';

import { getStudentFee, money, setFinalFee } from '@/features/fees/api';
import { colors, fontSize, fontWeight, radius, spacing } from '@/shared/theme';
import { Button } from '@/shared/ui/Button';
import { TextField } from '@/shared/ui/TextField';

// =====================================================================
// 💰 Change an admitted student's fee (Admission Officer / admin)
//   Type the total discount or the final fee: the other follows
//   (final = full − discount). A reason is needed. Not below what is
//   paid, not above the full fee (the database checks it too).
// =====================================================================

const toNumber = (t: string) => Number(t.replace(/[^\d.]/g, '')) || 0;
const plain = (n: number) => String(Math.round(n * 100) / 100);

export function FeeChangeSheet({
  leadId,
  name,
  onClose,
  onDone,
}: {
  leadId: string;
  name?: string;
  onClose: () => void;
  onDone: (message: string) => void;
}) {
  const [fee, setFee] = useState<{ full: number; final: number; paid: number } | null>(null);
  const [discount, setDiscount] = useState('');
  const [final, setFinal] = useState('');
  const [reason, setReason] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    getStudentFee(leadId)
      .then((f) => {
        setFee(f);
        setFinal(plain(f.final));
        setDiscount(plain(Math.max(f.full - f.final, 0)));
      })
      .catch((e) => setError(e instanceof Error ? e.message : 'Could not load the fee.'));
  }, [leadId]);

  const finalNo = toNumber(final);
  const due = fee ? Math.max(finalNo - fee.paid, 0) : 0;

  const save = async () => {
    if (!fee) return;
    setError(null);
    if (!reason.trim()) return setError('Please write why the fee changes.');
    if (finalNo > fee.full) return setError(`The final fee can't be more than the full fee (${money(fee.full)}).`);
    if (finalNo < fee.paid) return setError(`The final fee can't be less than what is paid (${money(fee.paid)}). Refund first.`);
    setSaving(true);
    try {
      const r = await setFinalFee(leadId, finalNo, reason);
      onDone(
        !r.changed
          ? 'The fee is the same.'
          : r.installmentsOff
            ? '💰 Fee changed. Installments no longer add up: please re-check them.'
            : '💰 Fee changed.',
      );
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not save.');
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal visible transparent animationType="slide" onRequestClose={onClose}>
      <View style={styles.backdrop}>
        <Pressable style={styles.flex} onPress={saving ? undefined : onClose} accessibilityLabel="Close" />
        <View style={styles.sheet}>
          <View style={styles.handle} />
          <ScrollView contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
            <Text style={styles.title}>💰 Change fee</Text>
            {!!name && <Text style={styles.sub}>{name}</Text>}

            {!fee ? (
              error ? (
                <Text style={styles.error}>{error}</Text>
              ) : (
                <ActivityIndicator color={colors.primary} />
              )
            ) : (
              <>
                <View style={styles.row}>
                  <Text style={styles.label}>Full fee</Text>
                  <Text style={styles.value}>{money(fee.full)}</Text>
                </View>
                <View style={styles.two}>
                  <View style={styles.flex}>
                    <TextField
                      label="Total discount (৳)"
                      value={discount}
                      keyboardType="numeric"
                      onChangeText={(t) => {
                        setDiscount(t);
                        setFinal(plain(Math.max(fee.full - toNumber(t), 0)));
                      }}
                    />
                  </View>
                  <View style={styles.flex}>
                    <TextField
                      label="Final fee (৳)"
                      value={final}
                      keyboardType="numeric"
                      onChangeText={(t) => {
                        setFinal(t);
                        setDiscount(plain(Math.max(fee.full - toNumber(t), 0)));
                      }}
                    />
                  </View>
                </View>
                <View style={styles.summary}>
                  <View style={styles.row}>
                    <Text style={styles.label}>Now</Text>
                    <Text style={styles.value}>{money(fee.final)}</Text>
                  </View>
                  <View style={styles.row}>
                    <Text style={styles.label}>Paid</Text>
                    <Text style={styles.value}>{money(fee.paid)}</Text>
                  </View>
                  <View style={styles.row}>
                    <Text style={styles.label}>Due after this</Text>
                    <Text style={[styles.value, due > 0 ? styles.bad : styles.good]}>{due > 0 ? money(due) : '✓ Paid'}</Text>
                  </View>
                </View>
                <TextField
                  label="Why? *"
                  value={reason}
                  onChangeText={setReason}
                  multiline
                  placeholder="e.g. Merit scholarship, approved by the Principal"
                />
                {error && <Text style={styles.error}>{error}</Text>}
                <Button title="Save" onPress={save} loading={saving} fullWidth />
              </>
            )}
          </ScrollView>
        </View>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1 },
  backdrop: { flex: 1, backgroundColor: 'rgba(0,0,0,0.4)' },
  sheet: { maxHeight: '90%', backgroundColor: colors.surface, borderTopLeftRadius: radius.lg, borderTopRightRadius: radius.lg },
  handle: { alignSelf: 'center', width: 40, height: 4, borderRadius: radius.pill, backgroundColor: colors.border, marginTop: spacing.sm },
  content: { padding: spacing.lg, gap: spacing.md, paddingBottom: spacing.xxl },
  title: { fontSize: fontSize.title, fontWeight: fontWeight.bold, color: colors.text },
  sub: { fontSize: fontSize.small, color: colors.textMuted, marginTop: -spacing.sm },
  two: { flexDirection: 'row', gap: spacing.md },
  row: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
  label: { fontSize: fontSize.small, color: colors.textMuted },
  value: { fontSize: fontSize.body, fontWeight: fontWeight.bold, color: colors.text },
  summary: { gap: spacing.xs, padding: spacing.md, borderRadius: radius.md, backgroundColor: colors.background },
  good: { color: colors.success },
  bad: { color: colors.danger },
  error: { fontSize: fontSize.small, color: colors.danger },
});
