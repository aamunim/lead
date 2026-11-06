import { useCallback, useEffect, useMemo, useState } from 'react';
import { ActivityIndicator, Modal, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';

import {
  installmentStates,
  listPayments,
  loadReceiptData,
  money,
  paidTotal,
  recordPayment,
  type FeeSettings,
  type Installment,
  type Payment,
} from '@/features/fees/api';
import { PaySheet } from '@/features/fees/PaymentsSection';
import { printReceipt } from '@/features/fees/receipt';
import type { LeadListItem } from '@/features/leads/api';
import { colors, fontSize, fontWeight, isDark, radius, spacing } from '@/shared/theme';

// =====================================================================
// 🌐💵 A student's fee from the Students table: what is paid and due,
//   the receipts (🖨 print any), the next installment, and
//   💵 Take payment right here (then 🖨 print the receipt).
// =====================================================================

const dayText = (iso: string) =>
  new Date(iso).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });

export function FeePopup({
  row: r,
  settings,
  canPay,
  canChangeFee,
  isAdmin,
  nameOf,
  onClose,
  onChanged,
  onChangeFee,
  onOpen,
}: {
  row: LeadListItem;
  settings: FeeSettings | null;
  canPay: boolean;
  canChangeFee: boolean;
  isAdmin: boolean;
  nameOf: (id: string | null) => string | null;
  onClose: () => void;
  /** a payment was saved: the table refreshes */
  onChanged: (message: string) => void;
  onChangeFee: () => void;
  onOpen: () => void;
}) {
  const [payments, setPayments] = useState<Payment[] | null>(null);
  const [installments, setInstallments] = useState<Installment[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [paying, setPaying] = useState(false);
  const [saved, setSaved] = useState<Payment | null>(null);
  const [printing, setPrinting] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const res = await listPayments(r.id);
      setPayments(res.payments);
      setInstallments(res.installments);
      return res.payments;
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not load the payments.');
      return null;
    }
  }, [r.id]);
  useEffect(() => {
    load();
  }, [load]);

  const finalFee = Number(r.fee_final ?? 0);
  const paid = payments ? paidTotal(payments) : Number(r.fee_paid ?? 0);
  const due = Math.max(finalFee - paid, 0);
  const part = finalFee > 0 ? Math.min(1, paid / finalFee) : 0;
  const plan = useMemo(() => installmentStates(installments, paid), [installments, paid]);
  const next = plan.find((i) => i.state !== 'paid');
  const admitted = r.stage?.kind === 'won';

  const print = async (p: Payment, list: Payment[] | null = payments) => {
    if (!settings) return;
    setPrinting(p.id);
    try {
      const upto = (list ?? [])
        .filter(
          (x) => !x.voided_at && (x.paid_at < p.paid_at || (x.paid_at === p.paid_at && x.receipt_no <= p.receipt_no)),
        )
        .reduce((t, x) => t + (x.kind === 'refund' ? -1 : 1) * Number(x.amount), 0);
      const data = await loadReceiptData(p, finalFee, upto, nameOf(p.received_by));
      await printReceipt(data, settings.payments);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not print.');
    } finally {
      setPrinting(null);
    }
  };

  return (
    <Modal visible transparent animationType="fade" onRequestClose={onClose}>
      <Pressable style={styles.back} onPress={onClose} accessibilityLabel="Close fee">
        <Pressable style={styles.box} onPress={() => undefined}>
          {/* Head */}
          <View style={styles.head}>
            <View style={styles.flex}>
              <Text style={styles.title}>💵 Fee & payments</Text>
              <Text style={styles.sub} numberOfLines={1}>
                {r.name}
                {r.student_ref ? ` · ${r.student_ref}` : ''}
                {r.admitted_course?.name ? ` · ${r.admitted_course.name}` : ''}
              </Text>
            </View>
            <Pressable onPress={onClose} hitSlop={8} accessibilityRole="button" accessibilityLabel="Close">
              <Text style={styles.x}>✕</Text>
            </Pressable>
          </View>

          {/* Numbers */}
          <View style={styles.stats}>
            <Stat label="Total fee" value={finalFee ? money(finalFee) : '—'} />
            <Stat label="Paid" value={money(paid)} tone="good" />
            <Stat label="Due" value={money(due)} tone={due > 0 ? 'warn' : 'good'} />
          </View>
          <View style={styles.bar}>
            <View style={[styles.barFill, { width: `${Math.round(part * 100)}%` }, due <= 0 && styles.barDone]} />
          </View>
          {next && (
            <Text style={[styles.next, next.state === 'late' && styles.late]}>
              {next.state === 'late' ? '⚠ Late: ' : '📅 Next installment: '}
              {money(Number(next.amount) - next.covered)} · {dayText(next.due_date)}
            </Text>
          )}

          {/* Just saved */}
          {saved && (
            <View style={styles.savedBox}>
              <Text style={styles.savedText}>
                ✅ {money(Number(saved.amount))} received · {saved.receipt_no}
                {saved.college_receipt_no ? ` · College ${saved.college_receipt_no}` : ''}
              </Text>
              <Pressable onPress={() => print(saved)} style={styles.btn} accessibilityRole="button">
                <Text style={styles.btnText}>{printing === saved.id ? 'Opening…' : '🖨 Print receipt'}</Text>
              </Pressable>
            </View>
          )}

          {/* Receipts */}
          <Text style={styles.label}>RECEIPTS</Text>
          {!payments ? (
            error ? (
              <Text style={styles.error}>{error}</Text>
            ) : (
              <ActivityIndicator color={colors.primary} style={styles.loader} />
            )
          ) : payments.length === 0 ? (
            <Text style={styles.muted}>No payment yet.</Text>
          ) : (
            <ScrollView style={styles.list}>
              {payments.map((p) => (
                <View key={p.id} style={[styles.payRow, p.voided_at && styles.voided]}>
                  <View style={styles.flex}>
                    <Text style={[styles.payAmount, p.voided_at && styles.struck]}>
                      {p.kind === 'refund' ? '↩ ' : ''}
                      {money(Number(p.amount))} <Text style={styles.method}>· {p.method}</Text>
                    </Text>
                    <Text style={styles.muted} numberOfLines={1}>
                      🧾 {p.receipt_no}
                      {p.college_receipt_no ? ` · College ${p.college_receipt_no}` : ''} · {dayText(p.paid_at)}
                      {nameOf(p.received_by) ? ` · ${nameOf(p.received_by)}` : ''}
                      {p.voided_at ? ' · ✕ void' : ''}
                    </Text>
                  </View>
                  <Pressable
                    onPress={() => print(p)}
                    style={(s) => [styles.iconBtn, (s as { hovered?: boolean }).hovered && styles.iconBtnHover]}
                    accessibilityRole="button"
                    accessibilityLabel={`Print ${p.receipt_no}`}
                  >
                    <Text style={styles.iconText}>{printing === p.id ? '…' : '🖨'}</Text>
                  </Pressable>
                </View>
              ))}
            </ScrollView>
          )}
          {error && payments && <Text style={styles.error}>{error}</Text>}

          {/* Buttons */}
          <View style={styles.buttons}>
            <Pressable onPress={onOpen} style={styles.ghost} accessibilityRole="button">
              <Text style={styles.ghostText}>Open student</Text>
            </Pressable>
            {canChangeFee && admitted && (
              <Pressable onPress={onChangeFee} style={styles.outline} accessibilityRole="button">
                <Text style={styles.outlineText}>✏️ Change fee</Text>
              </Pressable>
            )}
            {canPay && admitted && due > 0 && settings && (
              <Pressable onPress={() => setPaying(true)} style={styles.btn} accessibilityRole="button">
                <Text style={styles.btnText}>💵 Take payment</Text>
              </Pressable>
            )}
          </View>
        </Pressable>
      </Pressable>

      {paying && settings && (
        <PaySheet
          visible
          leadId={r.id}
          due={due}
          next={next ? Number(next.amount) - next.covered : null}
          settings={settings}
          isAdmin={isAdmin}
          onClose={() => setPaying(false)}
          onSave={async (input) => {
            const res = await recordPayment({ leadId: r.id, ...input });
            setPaying(false);
            const fresh = await load();
            const p = fresh?.find((x) => x.id === res.id) ?? null;
            setSaved(p);
            onChanged(`💵 ${money(input.amount)} received from ${r.name} · ${res.receipt_no}`);
          }}
        />
      )}
    </Modal>
  );
}

function Stat({ label, value, tone }: { label: string; value: string; tone?: 'good' | 'warn' }) {
  return (
    <View style={styles.stat}>
      <Text style={styles.statLabel}>{label}</Text>
      <Text style={[styles.statValue, tone === 'good' && styles.good, tone === 'warn' && styles.warn]}>{value}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1 },
  back: {
    flex: 1,
    backgroundColor: 'rgba(16,26,51,0.45)',
    alignItems: 'center',
    justifyContent: 'center',
    padding: spacing.lg,
  },
  box: {
    width: '100%',
    maxWidth: 560,
    maxHeight: '90%',
    gap: spacing.sm,
    padding: spacing.xl,
    borderRadius: 16,
    backgroundColor: colors.surface,
    shadowColor: '#000',
    shadowOpacity: 0.18,
    shadowRadius: 24,
    shadowOffset: { width: 0, height: 10 },
  },
  head: { flexDirection: 'row', alignItems: 'flex-start', gap: spacing.md },
  title: { fontSize: fontSize.title, fontWeight: fontWeight.bold, color: colors.text },
  sub: { fontSize: fontSize.small, color: colors.textMuted, marginTop: 2 },
  x: { fontSize: 18, color: colors.textMuted, padding: 4 },
  stats: { flexDirection: 'row', gap: spacing.sm, marginTop: spacing.sm },
  stat: {
    flex: 1,
    padding: spacing.md,
    borderRadius: radius.md,
    backgroundColor: isDark ? '#141C2E' : '#F5F7FC',
    borderWidth: 1,
    borderColor: colors.border,
  },
  statLabel: { fontSize: fontSize.caption, color: colors.textMuted, fontWeight: fontWeight.semibold },
  statValue: { fontSize: fontSize.title, fontWeight: fontWeight.bold, color: colors.text, marginTop: 2 },
  good: { color: colors.success },
  warn: { color: colors.warning },
  bar: { height: 8, borderRadius: 4, backgroundColor: isDark ? '#28324B' : '#E8ECF4', overflow: 'hidden' },
  barFill: { height: '100%', backgroundColor: colors.warning, borderRadius: 4 },
  barDone: { backgroundColor: colors.success },
  next: { fontSize: fontSize.small, color: colors.text, fontWeight: fontWeight.semibold },
  late: { color: colors.danger },
  savedBox: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
    padding: spacing.md,
    borderRadius: radius.md,
    backgroundColor: colors.successSoft,
  },
  savedText: { flex: 1, fontSize: fontSize.small, fontWeight: fontWeight.semibold, color: colors.success },
  label: {
    fontSize: fontSize.caption,
    fontWeight: fontWeight.bold,
    color: colors.textMuted,
    letterSpacing: 0.6,
    marginTop: spacing.sm,
  },
  loader: { marginVertical: spacing.lg },
  muted: { fontSize: fontSize.caption, color: colors.textMuted },
  list: { maxHeight: 280 },
  payRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    paddingVertical: 8,
    borderBottomWidth: 1,
    borderBottomColor: colors.border,
  },
  voided: { opacity: 0.55 },
  struck: { textDecorationLine: 'line-through' },
  payAmount: { fontSize: fontSize.body, fontWeight: fontWeight.bold, color: colors.text },
  method: { fontSize: fontSize.small, fontWeight: fontWeight.regular, color: colors.textMuted },
  iconBtn: { width: 36, height: 36, borderRadius: radius.pill, alignItems: 'center', justifyContent: 'center' },
  iconBtnHover: { backgroundColor: colors.primarySoft },
  iconText: { fontSize: 16 },
  error: { fontSize: fontSize.small, color: colors.danger },
  buttons: { flexDirection: 'row', justifyContent: 'flex-end', gap: spacing.sm, marginTop: spacing.md },
  btn: {
    paddingVertical: spacing.sm + 2,
    paddingHorizontal: spacing.lg,
    borderRadius: radius.md,
    backgroundColor: colors.primary,
  },
  btnText: { fontSize: fontSize.small, fontWeight: fontWeight.bold, color: colors.textOnPrimary },
  outline: {
    paddingVertical: spacing.sm + 2,
    paddingHorizontal: spacing.lg,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.border,
  },
  outlineText: { fontSize: fontSize.small, fontWeight: fontWeight.bold, color: colors.text },
  ghost: { paddingVertical: spacing.sm + 2, paddingHorizontal: spacing.md, marginRight: 'auto' },
  ghostText: { fontSize: fontSize.small, fontWeight: fontWeight.bold, color: colors.textMuted },
});
