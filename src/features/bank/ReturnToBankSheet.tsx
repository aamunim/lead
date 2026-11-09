import { useState } from 'react';
import { StyleSheet, Text, TextInput, View } from 'react-native';

import { Sheet } from '@/features/alumni/sheets';
import { Chip, s as ui } from '@/features/alumni/ui';
import { md } from '@/features/home/md';
import { colors, fontSize, radius, spacing } from '@/shared/theme';
import { Button } from '@/shared/ui/Button';

import { RETURN_REASONS, returnToBank } from './api';

// ---------------------------------------------------------------------
// ↩️ Leads back to the bank (lead page, lead list): a reason, rest days
// ---------------------------------------------------------------------
const REST = [0, 7, 30, 90];

export function ReturnToBankSheet({
  leadIds,
  onClose,
  onDone,
}: {
  leadIds: string[];
  onClose: () => void;
  onDone: (message: string) => void;
}) {
  const [reason, setReason] = useState<string | null>(RETURN_REASONS[0]);
  const [other, setOther] = useState('');
  const [rest, setRest] = useState(30);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const go = async () => {
    setBusy(true);
    setError(null);
    try {
      const why = reason === 'Other' ? other.trim() || 'Other' : reason;
      const r = await returnToBank(leadIds, why, rest);
      onDone(
        r.skipped
          ? `🏦 ${r.returned} sent to the Lead Bank · ${r.skipped} skipped (admitted, or no number)`
          : `🏦 ${r.returned} sent to the Lead Bank.`,
      );
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not send them.');
      setBusy(false);
    }
  };

  return (
    <Sheet
      title={`🏦 ${leadIds.length === 1 ? 'Back to the Lead Bank' : `${leadIds.length} back to the Lead Bank`}`}
      onClose={onClose}
    >
      <Text style={ui.muted}>
        They leave the lead list and wait in the bank (Returned). When put back, the same lead comes back with all its
        calls and notes. Admitted students stay.
      </Text>
      <Text style={ui.label}>WHY</Text>
      <View style={ui.chips}>
        {RETURN_REASONS.map((r) => (
          <Chip key={r} text={r} on={reason === r} onPress={() => setReason(r)} />
        ))}
      </View>
      {reason === 'Other' && (
        <TextInput
          value={other}
          onChangeText={setOther}
          placeholder="The reason"
          placeholderTextColor={colors.textMuted}
          style={styles.input}
          maxLength={200}
        />
      )}
      <Text style={ui.label}>REST BEFORE THEY CAN GO OUT AGAIN</Text>
      <View style={ui.chips}>
        {REST.map((d) => (
          <Chip key={d} text={d === 0 ? 'No rest' : `${d} days`} on={rest === d} onPress={() => setRest(d)} />
        ))}
      </View>
      {error && <Text style={ui.error}>{error}</Text>}
      <View style={styles.buttons}>
        <View style={styles.flex}>
          <Button title="Cancel" variant="ghost" onPress={onClose} fullWidth />
        </View>
        <View style={styles.flex}>
          <Button title="Send to the bank" onPress={go} loading={busy} fullWidth />
        </View>
      </View>
    </Sheet>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1 },
  buttons: { flexDirection: 'row', gap: spacing.sm, paddingTop: spacing.sm },
  input: {
    minHeight: 44,
    paddingHorizontal: spacing.md,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: md.outline,
    color: colors.text,
    fontSize: fontSize.body,
  },
});
