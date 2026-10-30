import { useCallback, useEffect, useMemo, useState } from 'react';
import { ActivityIndicator, Alert, Modal, Pressable, ScrollView, Share, StyleSheet, Text, TextInput, View } from 'react-native';
import { KeyboardAvoidingView } from 'react-native-keyboard-controller';

import { useAuth } from '@/features/auth/AuthProvider';
import {
  canTakePayments,
  canVoidPayments,
  installmentStates,
  listPayments,
  loadReceiptData,
  money,
  paidTotal,
  receiptText,
  recordPayment,
  recordRefund,
  setInstallments,
  voidPayment,
  type FeeSettings,
  type Installment,
  type Payment,
} from '@/features/fees/api';
import { colors, fontSize, fontWeight, radius, spacing } from '@/shared/theme';
import { Button } from '@/shared/ui/Button';
import { DateTimePickerButton } from '@/shared/ui/DateTimePickerButton';
import { ShowMoreButton, useShowMore } from '@/shared/ui/ShowMore';

// =====================================================================
// 💵 Payments on the Fee card (admitted students)
//   Paid / due, take a payment (receipt number given by the database),
//   share the receipt, void a wrong one, an optional installment plan.
//   After a cancelled admission: only a warning about money already paid.
// =====================================================================

type Props = {
  leadId: string;
  stageKind: string;
  /** the locked fee for the admitted course */
  finalFee: number;
  settings: FeeSettings;
  nameOf: (userId: string | null | undefined) => string | null;
  onChanged: (message?: string) => void;
};

const dayText = (iso: string) =>
  new Date(iso.length === 10 ? `${iso}T00:00:00` : iso).toLocaleDateString('en-GB', {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
  });

const isoDay = (d: Date) =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

const INST_STATE = {
  paid: { label: '✓ Paid', color: colors.success },
  part: { label: 'Part paid', color: colors.warning },
  due: { label: 'Due', color: colors.textMuted },
  late: { label: '⚠ Late', color: colors.danger },
};

export function PaymentsSection({ leadId, stageKind, finalFee, settings, nameOf, onChanged }: Props) {
  const { profile, hasPermission } = useAuth();
  const isAdmin = hasPermission('settings.manage') || hasPermission('payments.manage');
  const [payments, setPayments] = useState<Payment[]>([]);
  const [installments, setInst] = useState<Installment[]>([]);
  const [loading, setLoading] = useState(true);
  const [sheet, setSheet] = useState<'pay' | 'plan' | null>(null);
  const [voiding, setVoiding] = useState<Payment | null>(null);
  const [refunding, setRefunding] = useState(false);

  const load = useCallback(async () => {
    try {
      const r = await listPayments(leadId);
      setPayments(r.payments);
      setInst(r.installments);
    } catch {
      // the card still shows the fee
    } finally {
      setLoading(false);
    }
  }, [leadId]);

  useEffect(() => {
    load();
  }, [load]);

  const admitted = stageKind === 'won';
  const canTake = admitted && canTakePayments(settings, profile, isAdmin);
  const canVoid = canVoidPayments(settings, profile, isAdmin);
  const paid = paidTotal(payments);
  const due = Math.max(finalFee - paid, 0);
  const plan = useMemo(() => installmentStates(installments, paid), [installments, paid]);
  const next = plan.find((i) => i.state !== 'paid');
  const more = useShowMore(payments, 3);

  const after = async (message: string) => {
    setSheet(null);
    setVoiding(null);
    await load();
    onChanged(message);
  };

  const share = async (p: Payment) => {
    try {
      // "Paid so far" as of this receipt: this payment and the ones before it
      const upto = payments
        .filter((x) => !x.voided_at && (x.paid_at < p.paid_at || (x.paid_at === p.paid_at && x.receipt_no <= p.receipt_no)))
        .reduce((t, x) => t + Number(x.amount), 0);
      const data = await loadReceiptData(p, finalFee, p.voided_at ? paid : upto, nameOf(p.received_by));
      await Share.share({ message: receiptText(data, settings.payments) });
    } catch (e) {
      Alert.alert('Could not share', e instanceof Error ? e.message : '');
    }
  };

  if (loading) return <ActivityIndicator color={colors.primary} />;

  // Receipts (payments and refunds), newest first
  const receiptRows = more.visible.map((p) => (
        <View key={p.id} style={[styles.payRow, p.voided_at && styles.voided]}>
          <View style={styles.flex}>
            <Text style={[styles.payAmount, p.voided_at && styles.struck, p.kind === 'refund' && styles.refund]}>
              {p.kind === 'refund' ? '↩ Refund ' : ''}
              {money(Number(p.amount))} · {p.method}
            </Text>
            <Text style={styles.meta}>
              {p.kind === 'refund' ? '↩' : '🧾'} {p.receipt_no} · {dayText(p.paid_at)}
              {nameOf(p.received_by) ? ` · ${nameOf(p.received_by)}` : ''}
            </Text>
            {p.txn_id && <Text style={styles.meta}>Txn: {p.txn_id}</Text>}
            {p.note && <Text style={styles.note}>“{p.note}”</Text>}
            {p.voided_at && (
              <Text style={styles.badText}>
                ✕ Void{p.void_reason ? `: ${p.void_reason}` : ''}
                {nameOf(p.voided_by) ? ` · ${nameOf(p.voided_by)}` : ''}
              </Text>
            )}
          </View>
          <View style={styles.payActions}>
            <Pressable onPress={() => share(p)} hitSlop={8} accessibilityRole="button" accessibilityLabel="Share receipt">
              <Text style={styles.link}>Share</Text>
            </Pressable>
            {canVoid && !p.voided_at && (
              <Pressable onPress={() => setVoiding(p)} hitSlop={8} accessibilityRole="button">
                <Text style={styles.voidLink}>Void</Text>
              </Pressable>
            )}
          </View>
        </View>
      ));

  // A cancelled admission: what was paid, and give it back (refund)
  if (!admitted) {
    if (payments.length === 0) return null;
    return (
      <View style={styles.section}>
        <Text style={styles.sectionLabel}>PAYMENTS</Text>
        {paid > 0 ? (
          <View style={styles.warnBox}>
            <Text style={styles.warnText}>
              ⚠ Admission cancelled, but {money(paid)} is still with us. Return it with Refund if needed.
            </Text>
          </View>
        ) : (
          <Text style={styles.meta}>Nothing left to return.</Text>
        )}
        {canVoid && paid > 0 && (
          <Button title="↩ Refund" variant="secondary" onPress={() => setRefunding(true)} fullWidth />
        )}
        {receiptRows}
        <ShowMoreButton {...more} />
        <RefundSheet
          visible={refunding}
          paid={paid}
          settings={settings}
          onClose={() => setRefunding(false)}
          onSave={async (input) => {
            const r = await recordRefund({ leadId, ...input });
            setRefunding(false);
            await after(`↩ ${money(input.amount)} returned · ${r.receipt_no}`);
          }}
        />
        <VoidSheet
          payment={voiding}
          onClose={() => setVoiding(null)}
          onSave={async (reason) => {
            if (!voiding) return;
            await voidPayment(voiding.id, reason);
            await after(`✕ ${voiding.receipt_no} is void.`);
          }}
        />
      </View>
    );
  }
  if (!settings.payments.enabled && payments.length === 0) return null;

  return (
    <View style={styles.section}>
      <Text style={styles.sectionLabel}>PAYMENTS</Text>

      {/* Paid / due */}
      <View style={styles.sumRow}>
        <View style={styles.sumBox}>
          <Text style={styles.sumLabel}>Paid</Text>
          <Text style={[styles.sumValue, styles.good]}>{money(paid)}</Text>
        </View>
        <View style={styles.sumBox}>
          <Text style={styles.sumLabel}>Due</Text>
          <Text style={[styles.sumValue, due > 0 && styles.bad]}>{due > 0 ? money(due) : '✓ Paid in full'}</Text>
        </View>
      </View>
      <View style={styles.track}>
        <View style={[styles.bar, { width: `${finalFee > 0 ? Math.min((paid / finalFee) * 100, 100) : 0}%` }]} />
      </View>
      {next && (
        <Text style={[styles.meta, next.state === 'late' && styles.badText]}>
          {next.state === 'late' ? '⚠ Late: ' : '📅 Next: '}installment {next.seq} · {money(Number(next.amount) - next.covered)} by{' '}
          {dayText(next.due_date)}
        </Text>
      )}

      {canTake && (
        <View style={styles.row}>
          {due > 0 && (
            <View style={styles.flex}>
              <Button title="＋ Take payment" onPress={() => setSheet('pay')} fullWidth />
            </View>
          )}
          <View style={styles.flex}>
            <Button
              title={installments.length > 0 ? '📅 Change plan' : '📅 Installments'}
              variant="secondary"
              onPress={() => setSheet('plan')}
              fullWidth
            />
          </View>
        </View>
      )}

      {/* Installment plan */}
      {plan.length > 0 && (
        <View style={styles.list}>
          {plan.map((i) => (
            <View key={i.id} style={styles.instRow}>
              <Text style={styles.instSeq}>{i.seq}</Text>
              <Text style={styles.instDate}>{dayText(i.due_date)}</Text>
              <Text style={styles.instAmount}>{money(Number(i.amount))}</Text>
              <Text style={[styles.instState, { color: INST_STATE[i.state].color }]}>{INST_STATE[i.state].label}</Text>
            </View>
          ))}
        </View>
      )}

      {/* Receipts */}
      {receiptRows}
      <ShowMoreButton {...more} />

      <PaySheet
        visible={sheet === 'pay'}
        due={due}
        next={next ? Number(next.amount) - next.covered : null}
        settings={settings}
        isAdmin={hasPermission('settings.manage')}
        onClose={() => setSheet(null)}
        onSave={async (input) => {
          const r = await recordPayment({ leadId, ...input });
          await after(`💵 ${money(input.amount)} received · ${r.receipt_no}`);
          // Offer the receipt straight away
          const fresh = await listPayments(leadId).catch(() => null);
          const p = fresh?.payments.find((x) => x.id === r.id);
          if (p) {
            Alert.alert('Payment saved', `${r.receipt_no} · ${money(input.amount)}`, [
              { text: 'Done', style: 'cancel' },
              { text: 'Share receipt', onPress: () => share(p) },
            ]);
          }
        }}
      />

      <PlanSheet
        visible={sheet === 'plan'}
        fee={finalFee}
        current={installments}
        onClose={() => setSheet(null)}
        onSave={async (items) => {
          await setInstallments(leadId, items);
          await after(items.length > 0 ? `📅 ${items.length} installments set.` : 'Installment plan removed.');
        }}
      />

      <VoidSheet
        payment={voiding}
        onClose={() => setVoiding(null)}
        onSave={async (reason) => {
          if (!voiding) return;
          await voidPayment(voiding.id, reason);
          await after(`✕ ${voiding.receipt_no} is void.`);
        }}
      />
    </View>
  );
}

// =====================================================================
// Take a payment
// =====================================================================
function PaySheet({
  visible,
  due,
  next,
  settings,
  isAdmin,
  onClose,
  onSave,
}: {
  visible: boolean;
  due: number;
  next: number | null;
  settings: FeeSettings;
  isAdmin: boolean;
  onClose: () => void;
  onSave: (input: { amount: number; method: string; txnId: string; paidAt: Date | null; note: string }) => Promise<void>;
}) {
  const methods = settings.payments.methods;
  const [amount, setAmount] = useState('');
  const [method, setMethod] = useState<string | null>(null);
  const [txn, setTxn] = useState('');
  const [paidAt, setPaidAt] = useState<Date | null>(null);
  const [note, setNote] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!visible) return;
    setAmount(String(Math.round(next && next < due ? next : due)));
    setMethod(methods[0]?.name ?? null);
    setTxn('');
    setPaidAt(null);
    setNote('');
    setError(null);
  }, [visible, due, next, methods]);

  const m = methods.find((x) => x.name === method);
  const earliest = useMemo(() => {
    const d = new Date();
    d.setHours(0, 0, 0, 0);
    d.setDate(d.getDate() - (isAdmin ? 3650 : settings.payments.backdate_days));
    return d;
  }, [isAdmin, settings.payments.backdate_days]);

  const save = async () => {
    const v = Number(amount.replace(/[^0-9.]/g, ''));
    if (!(v > 0)) return setError('Please type the amount.');
    if (v > due) return setError(`That is more than the amount due (${money(due)}).`);
    if (!method) return setError('Please choose how it was paid.');
    if (m?.txn && !txn.trim()) return setError(`Please type the transaction ID for ${method}.`);
    setSaving(true);
    setError(null);
    try {
      await onSave({ amount: v, method, txnId: txn, paidAt, note });
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not save.');
    } finally {
      setSaving(false);
    }
  };

  return (
    <SmallSheet visible={visible} onClose={saving ? undefined : onClose}>
      <Text style={styles.sheetTitle}>💵 Take payment</Text>
      <Text style={styles.meta}>Due {money(due)}</Text>
      <TextInput
        value={amount}
        onChangeText={setAmount}
        keyboardType="numeric"
        placeholder="Amount (৳)"
        placeholderTextColor={colors.textMuted}
        style={[styles.input, styles.bigInput]}
      />
      <View style={styles.chips}>
        {next != null && next < due && (
          <Chip text={`Installment ${money(next)}`} on={amount === String(Math.round(next))} onPress={() => setAmount(String(Math.round(next)))} />
        )}
        <Chip text={`All due ${money(due)}`} on={amount === String(Math.round(due))} onPress={() => setAmount(String(Math.round(due)))} />
      </View>

      <Text style={styles.label}>Paid by</Text>
      <View style={styles.chips}>
        {methods.map((x) => (
          <Chip key={x.name} text={x.name} on={method === x.name} onPress={() => setMethod(x.name)} />
        ))}
      </View>
      {(m?.txn || txn) && (
        <TextInput
          value={txn}
          onChangeText={setTxn}
          placeholder={`Transaction ID${m?.txn ? ' *' : ''}`}
          placeholderTextColor={colors.textMuted}
          autoCapitalize="characters"
          style={styles.input}
        />
      )}

      <Text style={styles.label}>Date</Text>
      <DateTimePickerButton
        title={paidAt ? `📅 ${dayText(paidAt.toISOString())}` : '📅 Today (change if paid earlier)'}
        initial={paidAt ?? new Date()}
        minimumDate={earliest}
        onPick={setPaidAt}
      />
      {!isAdmin && (
        <Text style={styles.meta}>Up to {settings.payments.backdate_days} days back. Older payments: ask an admin.</Text>
      )}

      <TextInput
        value={note}
        onChangeText={setNote}
        placeholder="Note (optional)"
        placeholderTextColor={colors.textMuted}
        style={styles.input}
      />
      {error && <Text style={styles.errorText}>{error}</Text>}
      <Button title="Save payment" onPress={save} loading={saving} fullWidth />
    </SmallSheet>
  );
}

// =====================================================================
// Installment plan: how many, from when, how far apart; each row can be changed
// =====================================================================
function PlanSheet({
  visible,
  fee,
  current,
  onClose,
  onSave,
}: {
  visible: boolean;
  fee: number;
  current: Installment[];
  onClose: () => void;
  onSave: (items: { due_date: string; amount: number }[]) => Promise<void>;
}) {
  const [rows, setRows] = useState<{ date: Date; amount: string }[]>([]);
  const [count, setCount] = useState(3);
  const [gap, setGap] = useState(30);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const build = useCallback(
    (n: number, days: number, first: Date) => {
      const each = Math.floor(fee / n);
      return Array.from({ length: n }, (_, i) => {
        const d = new Date(first);
        d.setDate(d.getDate() + i * days);
        // The last one takes what is left over
        return { date: d, amount: String(i === n - 1 ? Math.round(fee - each * (n - 1)) : each) };
      });
    },
    [fee],
  );

  useEffect(() => {
    if (!visible) return;
    setError(null);
    if (current.length > 0) {
      setCount(current.length);
      setRows(current.map((i) => ({ date: new Date(`${i.due_date}T00:00:00`), amount: String(Math.round(Number(i.amount))) })));
    } else {
      setCount(3);
      setGap(30);
      setRows(build(3, 30, new Date()));
    }
  }, [visible, current, build]);

  const total = rows.reduce((t, r) => t + (Number(r.amount.replace(/[^0-9.]/g, '')) || 0), 0);
  const remake = (n: number, days: number) => {
    setCount(n);
    setGap(days);
    setRows(build(n, days, rows[0]?.date ?? new Date()));
  };

  const save = async (items: { due_date: string; amount: number }[]) => {
    setSaving(true);
    setError(null);
    try {
      await onSave(items);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not save.');
    } finally {
      setSaving(false);
    }
  };

  return (
    <SmallSheet visible={visible} onClose={saving ? undefined : onClose}>
      <Text style={styles.sheetTitle}>📅 Installments · {money(fee)}</Text>
      <Text style={styles.label}>How many</Text>
      <View style={styles.chips}>
        {[2, 3, 4, 6, 12].map((n) => (
          <Chip key={n} text={String(n)} on={count === n} onPress={() => remake(n, gap)} />
        ))}
      </View>
      <Text style={styles.label}>Every</Text>
      <View style={styles.chips}>
        {[15, 30, 60, 90].map((d) => (
          <Chip key={d} text={`${d} days`} on={gap === d} onPress={() => remake(count, d)} />
        ))}
      </View>

      {rows.map((r, i) => (
        <View key={i} style={styles.planRow}>
          <Text style={styles.instSeq}>{i + 1}</Text>
          <View style={styles.flex}>
            <DateTimePickerButton
              title={dayText(r.date.toISOString())}
              initial={r.date}
              minimumDate={new Date(2000, 0, 1)}
              onPick={(d) => setRows((now) => now.map((x, j) => (j === i ? { ...x, date: d } : x)))}
            />
          </View>
          <TextInput
            value={r.amount}
            onChangeText={(v) => setRows((now) => now.map((x, j) => (j === i ? { ...x, amount: v } : x)))}
            keyboardType="numeric"
            style={[styles.input, styles.planAmount]}
          />
        </View>
      ))}
      <Text style={[styles.meta, Math.abs(total - fee) > 0.5 && styles.badText]}>
        Total {money(total)} of {money(fee)}
        {Math.abs(total - fee) > 0.5 ? ` · ${total > fee ? 'too much' : `${money(fee - total)} short`}` : ' ✓'}
      </Text>
      <Text style={styles.meta}>Payments count toward the earliest installment first.</Text>
      {error && <Text style={styles.errorText}>{error}</Text>}
      <Button
        title="Save plan"
        onPress={() =>
          save(rows.map((r) => ({ due_date: isoDay(r.date), amount: Number(r.amount.replace(/[^0-9.]/g, '')) || 0 })))
        }
        loading={saving}
        disabled={Math.abs(total - fee) > 0.5}
        fullWidth
      />
      {current.length > 0 && (
        <Button title="Remove the plan" variant="ghost" onPress={() => save([])} disabled={saving} fullWidth />
      )}
    </SmallSheet>
  );
}

// =====================================================================
// Give money back (after a cancelled admission)
// =====================================================================
function RefundSheet({
  visible,
  paid,
  settings,
  onClose,
  onSave,
}: {
  visible: boolean;
  paid: number;
  settings: FeeSettings;
  onClose: () => void;
  onSave: (input: { amount: number; method: string; reason: string; txnId: string }) => Promise<void>;
}) {
  const methods = settings.payments.methods;
  const [amount, setAmount] = useState('');
  const [method, setMethod] = useState<string | null>(null);
  const [txn, setTxn] = useState('');
  const [reason, setReason] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!visible) return;
    setAmount(String(Math.round(paid)));
    setMethod(methods[0]?.name ?? null);
    setTxn('');
    setReason('');
    setError(null);
  }, [visible, paid, methods]);

  const save = async () => {
    const v = Number(amount.replace(/[^0-9.]/g, ''));
    if (!(v > 0)) return setError('Please type the amount.');
    if (v > paid) return setError(`That is more than what was paid (${money(paid)}).`);
    if (!method) return setError('Please choose how it was returned.');
    if (!reason.trim()) return setError('Please write why the money is returned.');
    setSaving(true);
    setError(null);
    try {
      await onSave({ amount: v, method, reason, txnId: txn });
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not save.');
    } finally {
      setSaving(false);
    }
  };

  return (
    <SmallSheet visible={visible} onClose={saving ? undefined : onClose}>
      <Text style={styles.sheetTitle}>↩ Refund</Text>
      <Text style={styles.meta}>Paid and not returned yet: {money(paid)}</Text>
      <TextInput
        value={amount}
        onChangeText={setAmount}
        keyboardType="numeric"
        placeholder="Amount (৳)"
        placeholderTextColor={colors.textMuted}
        style={[styles.input, styles.bigInput]}
      />
      <Text style={styles.label}>Returned by</Text>
      <View style={styles.chips}>
        {methods.map((x) => (
          <Chip key={x.name} text={x.name} on={method === x.name} onPress={() => setMethod(x.name)} />
        ))}
      </View>
      <TextInput
        value={txn}
        onChangeText={setTxn}
        placeholder="Transaction ID (optional)"
        placeholderTextColor={colors.textMuted}
        autoCapitalize="characters"
        style={styles.input}
      />
      <TextInput
        value={reason}
        onChangeText={setReason}
        placeholder="Why? e.g. left the course *"
        placeholderTextColor={colors.textMuted}
        style={styles.input}
      />
      {error && <Text style={styles.errorText}>{error}</Text>}
      <Button title="Save refund" onPress={save} loading={saving} fullWidth />
    </SmallSheet>
  );
}

// =====================================================================
// Void a wrong payment (with a reason)
// =====================================================================
function VoidSheet({
  payment,
  onClose,
  onSave,
}: {
  payment: Payment | null;
  onClose: () => void;
  onSave: (reason: string) => Promise<void>;
}) {
  const [reason, setReason] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setReason('');
    setError(null);
  }, [payment]);

  const save = async () => {
    if (!reason.trim()) return setError('Please write why it is void.');
    setSaving(true);
    setError(null);
    try {
      await onSave(reason);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not save.');
    } finally {
      setSaving(false);
    }
  };

  return (
    <SmallSheet visible={!!payment} onClose={saving ? undefined : onClose}>
      <Text style={styles.sheetTitle}>Void {payment?.receipt_no}?</Text>
      <Text style={styles.meta}>
        {payment ? `${money(Number(payment.amount))} · ${payment.method}` : ''}. It stays in the list, marked void, and is
        no longer counted as paid.
      </Text>
      <TextInput
        value={reason}
        onChangeText={setReason}
        placeholder="Why? e.g. typed twice, wrong student"
        placeholderTextColor={colors.textMuted}
        style={styles.input}
      />
      {error && <Text style={styles.errorText}>{error}</Text>}
      <Button title="Void payment" variant="danger" onPress={save} loading={saving} fullWidth />
    </SmallSheet>
  );
}

function Chip({ text, on, onPress }: { text: string; on: boolean; onPress: () => void }) {
  return (
    <Pressable
      onPress={onPress}
      style={[styles.chip, on && styles.chipOn]}
      accessibilityRole="radio"
      accessibilityState={{ checked: on }}
    >
      <Text style={[styles.chipText, on && styles.textOn]}>{text}</Text>
    </Pressable>
  );
}

function SmallSheet({ visible, onClose, children }: { visible: boolean; onClose?: () => void; children: React.ReactNode }) {
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

const styles = StyleSheet.create({
  flex: { flex: 1 },
  section: { gap: spacing.sm, paddingTop: spacing.sm, borderTopWidth: 1, borderTopColor: colors.border },
  sectionLabel: { fontSize: fontSize.caption, fontWeight: fontWeight.bold, letterSpacing: 1, color: colors.textMuted },
  row: { flexDirection: 'row', gap: spacing.sm },
  meta: { fontSize: fontSize.caption, color: colors.textMuted },
  note: { fontSize: fontSize.small, color: colors.text },
  link: { fontSize: fontSize.small, fontWeight: fontWeight.bold, color: colors.primary },
  voidLink: { fontSize: fontSize.small, fontWeight: fontWeight.semibold, color: colors.danger },
  good: { color: colors.success },
  bad: { color: colors.danger },
  badText: { fontSize: fontSize.caption, color: colors.danger, fontWeight: fontWeight.semibold },
  errorText: { fontSize: fontSize.small, color: colors.danger },
  warnBox: { padding: spacing.md, borderRadius: radius.md, backgroundColor: colors.warningSoft },
  warnText: { fontSize: fontSize.small, color: colors.text },

  sumRow: { flexDirection: 'row', gap: spacing.sm },
  sumBox: { flex: 1, padding: spacing.md, borderRadius: radius.md, backgroundColor: colors.background, gap: 2 },
  sumLabel: { fontSize: fontSize.caption, color: colors.textMuted },
  sumValue: { fontSize: fontSize.title, fontWeight: fontWeight.bold, color: colors.text },
  track: { height: 8, borderRadius: radius.pill, backgroundColor: colors.border, overflow: 'hidden' },
  bar: { height: 8, borderRadius: radius.pill, backgroundColor: colors.success },

  list: { gap: 4 },
  instRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm },
  instSeq: {
    width: 22,
    height: 22,
    borderRadius: 11,
    textAlign: 'center',
    lineHeight: 22,
    fontSize: fontSize.caption,
    fontWeight: fontWeight.bold,
    color: colors.text,
    backgroundColor: colors.background,
  },
  instDate: { flex: 1, fontSize: fontSize.small, color: colors.text },
  instAmount: { fontSize: fontSize.small, fontWeight: fontWeight.semibold, color: colors.text },
  instState: { width: 76, textAlign: 'right', fontSize: fontSize.caption, fontWeight: fontWeight.bold },

  payRow: {
    flexDirection: 'row',
    gap: spacing.md,
    alignItems: 'flex-start',
    paddingTop: spacing.sm,
    borderTopWidth: 1,
    borderTopColor: colors.border,
  },
  voided: { opacity: 0.6 },
  payAmount: { fontSize: fontSize.small, fontWeight: fontWeight.bold, color: colors.text },
  struck: { textDecorationLine: 'line-through' },
  refund: { color: colors.danger },
  payActions: { alignItems: 'flex-end', gap: spacing.sm },

  // Sheets
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
  sheetContent: { padding: spacing.lg, gap: spacing.md, paddingBottom: spacing.xxl },
  sheetTitle: { fontSize: fontSize.title, fontWeight: fontWeight.bold, color: colors.text },
  label: { fontSize: fontSize.small, fontWeight: fontWeight.semibold, color: colors.text },
  chips: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.sm },
  chip: {
    paddingVertical: spacing.sm,
    paddingHorizontal: spacing.md,
    borderRadius: radius.pill,
    borderWidth: 1.5,
    borderColor: colors.border,
  },
  chipOn: { backgroundColor: colors.primary, borderColor: colors.primary },
  chipText: { fontSize: fontSize.small, fontWeight: fontWeight.semibold, color: colors.text },
  textOn: { color: colors.textOnPrimary },
  input: {
    minHeight: 44,
    paddingHorizontal: spacing.md,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.border,
    fontSize: fontSize.body,
    color: colors.text,
    backgroundColor: colors.background,
  },
  bigInput: { fontSize: fontSize.title, fontWeight: fontWeight.bold },
  planRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm },
  planAmount: { width: 100, textAlign: 'right' },
});
