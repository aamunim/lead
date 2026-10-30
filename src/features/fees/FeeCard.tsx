import { router, type Href } from 'expo-router';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { ActivityIndicator, Alert, Modal, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';
import { KeyboardAvoidingView } from 'react-native-keyboard-controller';

import { useAuth } from '@/features/auth/AuthProvider';
import {
  EVENT_LABELS,
  addNegotiationEvent,
  canUseFees,
  cancelDiscount,
  getFeeSettings,
  getMyDiscountLimit,
  isActive,
  listNegotiations,
  money,
  requestDiscount,
  startNegotiation,
  totals,
  type Discount,
  type FeeSettings,
  type Negotiation,
  type NegotiationEvent,
} from '@/features/fees/api';
import { PaymentsSection } from '@/features/fees/PaymentsSection';
import { listCourses } from '@/features/settings/api';
import { colors, fontSize, fontWeight, radius, spacing } from '@/shared/theme';
import { Button } from '@/shared/ui/Button';
import { ShowMoreButton, useShowMore } from '@/shared/ui/ShowMore';

// =====================================================================
// 💰 Fee & discount card on the lead page
//   Before admission: start a negotiation for a course (New / Contacted →
//   Interested), note what was said ("Lead asked ৳30,000"), ask for a
//   discount. After admission the final fee is locked.
// =====================================================================

type Props = {
  leadId: string;
  /** open / won / lost / cancelled */
  stageKind: string;
  /** the lead's courses, shown first when starting */
  leadCourseIds: string[];
  /** changes when the lead changes: the card reloads */
  stateKey: string;
  nameOf: (userId: string | null | undefined) => string | null;
  onChanged: (message?: string) => void;
  /** In a sheet: say why there is nothing, instead of showing nothing */
  showEmpty?: boolean;
};

type CourseOption = { id: string; name: string; total: number };

const shortDate = (iso: string) => new Date(iso).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' });

export function FeeCard({ leadId, stageKind, leadCourseIds, stateKey, nameOf, onChanged, showEmpty }: Props) {
  const { profile, hasPermission } = useAuth();
  const isAdmin = hasPermission('settings.manage') || hasPermission('discounts.approve');
  const [settings, setSettings] = useState<FeeSettings | null>(null);
  const [items, setItems] = useState<Negotiation[]>([]);
  const [courses, setCourses] = useState<CourseOption[]>([]);
  const [limit, setLimit] = useState(0);
  const [tab, setTab] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [starting, setStarting] = useState<string | null>(null);
  const [picking, setPicking] = useState(false);
  const [sheet, setSheet] = useState<'event' | 'discount' | null>(null);

  const load = useCallback(async () => {
    try {
      setError(null);
      const [s, n] = await Promise.all([getFeeSettings(), listNegotiations(leadId)]);
      setSettings(s);
      setItems(n);
      setTab((t) => (t && n.some((x) => x.id === t) ? t : n[n.length - 1]?.id ?? null));
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not load the fee.');
    } finally {
      setLoading(false);
    }
  }, [leadId]);

  useEffect(() => {
    load();
  }, [load, stateKey]);

  useEffect(() => {
    getMyDiscountLimit()
      .then(setLimit)
      .catch(() => setLimit(0));
  }, []);

  const isOpen = stageKind === 'open';
  const allowed = !!settings && canUseFees(settings, profile, isAdmin);
  const current = items.find((n) => n.id === tab) ?? null;

  if (loading) {
    return (
      <View style={styles.card}>
        <Text style={styles.title}>💰 Fee & discount</Text>
        <ActivityIndicator color={colors.primary} />
      </View>
    );
  }
  // Off for this person, or a closed lead that never talked about the fee
  if ((!allowed || !isOpen) && items.length === 0) {
    if (!showEmpty) return null;
    return (
      <View style={styles.card}>
        <Text style={styles.title}>💰 Fee & discount</Text>
        <Text style={styles.hint}>
          {!allowed
            ? 'Fee negotiation is turned off for you. Ask an admin.'
            : 'This lead is closed. Reopen it to talk about the fee.'}
        </Text>
      </View>
    );
  }

  const openPicker = async () => {
    setPicking(true);
    if (courses.length > 0) return;
    try {
      const all = await listCourses();
      const withFees = all
        .filter((c) => c.course_fees.length > 0)
        .map((c) => ({ id: c.id, name: c.name, total: c.course_fees.reduce((t, f) => t + Number(f.amount), 0) }));
      // The lead's own courses first
      withFees.sort((a, b) => Number(leadCourseIds.includes(b.id)) - Number(leadCourseIds.includes(a.id)));
      setCourses(withFees);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not load the courses.');
    }
  };

  const start = async (courseId: string) => {
    setStarting(courseId);
    try {
      const id = await startNegotiation(leadId, courseId);
      setPicking(false);
      setTab(id);
      await load();
      onChanged('💰 Fee negotiation started.');
    } catch (e) {
      Alert.alert('Could not start', e instanceof Error ? e.message : '');
    } finally {
      setStarting(null);
    }
  };

  const after = async (message: string) => {
    setSheet(null);
    await load();
    onChanged(message);
  };

  const confirmCancel = (d: Discount) =>
    Alert.alert('Take back this discount?', `${money(d.amount)} off ${d.fee_name ?? 'the fee'} will be dropped.`, [
      { text: 'Keep it', style: 'cancel' },
      {
        text: 'Take back',
        style: 'destructive',
        onPress: async () => {
          try {
            await cancelDiscount(d.id);
            await after('Discount taken back.');
          } catch (e) {
            Alert.alert('Could not take it back', e instanceof Error ? e.message : '');
          }
        },
      },
    ]);

  const usedIds = items.map((n) => n.course_id);
  const canWork = allowed && isOpen && current?.status === 'open';

  return (
    <View style={[styles.card, current?.status === 'locked' && styles.cardLocked]}>
      <View style={styles.header}>
        <Text style={styles.title}>💰 Fee & discount</Text>
        {current && (
          <Text style={[styles.status, current.status === 'locked' && styles.statusLocked]}>
            {current.status === 'locked' ? '🔒 Final' : 'Negotiating'}
          </Text>
        )}
      </View>

      {/* Course tabs (when there is more than one) */}
      {items.length > 1 && (
        <View style={styles.chips}>
          {items.map((n) => (
            <Pressable
              key={n.id}
              onPress={() => setTab(n.id)}
              style={[styles.chip, n.id === tab && styles.chipOn]}
              accessibilityRole="tab"
              accessibilityState={{ selected: n.id === tab }}
            >
              <Text style={[styles.chipText, n.id === tab && styles.textOn]}>{n.course?.name ?? 'Course'}</Text>
            </Pressable>
          ))}
        </View>
      )}

      {current ? (
        <NegotiationView
          n={current}
          canWork={!!canWork}
          myId={profile?.id ?? null}
          limit={limit}
          nameOf={nameOf}
          onCancel={confirmCancel}
        />
      ) : (
        <Text style={styles.hint}>
          Talking about the fee or a discount? Start here. The lead moves to Interested (if it is New or Contacted).
        </Text>
      )}

      {/* 💵 Payments: admitted students (or money paid before a cancelled admission) */}
      {current && settings && (current.status === 'locked' || stageKind === 'cancelled') && (
        <PaymentsSection
          key={stateKey}
          leadId={leadId}
          stageKind={stageKind}
          finalFee={Number(current.final_total ?? totals(current).final)}
          settings={settings}
          nameOf={nameOf}
          onChanged={onChanged}
        />
      )}

      {canWork && (
        <View style={styles.row}>
          <View style={styles.flex}>
            <Button title="💬 What was said" variant="secondary" onPress={() => setSheet('event')} fullWidth />
          </View>
          <View style={styles.flex}>
            <Button title="％ Discount" onPress={() => setSheet('discount')} fullWidth />
          </View>
        </View>
      )}

      {allowed && isOpen && (
        <Pressable onPress={openPicker} hitSlop={8} accessibilityRole="button">
          <Text style={styles.link}>{items.length === 0 ? '＋ Start fee negotiation' : '＋ Another course'}</Text>
        </Pressable>
      )}

      {picking && (
        <View style={styles.picker}>
          {courses.length === 0 ? (
            <Text style={styles.hint}>Loading courses… (only courses with a fee list are shown)</Text>
          ) : (
            courses
              .filter((c) => !usedIds.includes(c.id))
              .map((c) => (
                <Pressable
                  key={c.id}
                  onPress={() => start(c.id)}
                  disabled={!!starting}
                  style={({ pressed }) => [styles.pickRow, pressed && styles.pressed]}
                  accessibilityRole="button"
                >
                  <Text style={styles.pickName} numberOfLines={1}>
                    {leadCourseIds.includes(c.id) ? '★ ' : ''}
                    {c.name}
                  </Text>
                  {starting === c.id ? (
                    <ActivityIndicator color={colors.primary} />
                  ) : (
                    <Text style={styles.pickTotal}>{money(c.total)}</Text>
                  )}
                </Pressable>
              ))
          )}
          <Pressable onPress={() => setPicking(false)} hitSlop={8}>
            <Text style={styles.cancelLink}>Close</Text>
          </Pressable>
        </View>
      )}

      {error && <Text style={styles.errorText}>{error}</Text>}

      {current && settings && (
        <>
          <EventSheet
            visible={sheet === 'event'}
            onClose={() => setSheet(null)}
            onSave={async (kind, amount, note) => {
              await addNegotiationEvent(current.id, kind, amount, note);
              await after('Saved.');
            }}
          />
          <DiscountSheet
            visible={sheet === 'discount'}
            n={current}
            settings={settings}
            limit={limit}
            onClose={() => setSheet(null)}
            onSaved={after}
          />
        </>
      )}
    </View>
  );
}

// =====================================================================
// One course: fee list, discounts, what was said
// =====================================================================
const STATUS: Record<Discount['status'] | 'expired', { label: string; color: string }> = {
  approved: { label: '✓ Approved', color: colors.success },
  pending: { label: '⏳ Waiting', color: colors.warning },
  rejected: { label: '✕ Not approved', color: colors.danger },
  cancelled: { label: 'Taken back', color: colors.textMuted },
  expired: { label: '⌛ Ran out', color: colors.textMuted },
};

function NegotiationView({
  n,
  canWork,
  myId,
  limit,
  nameOf,
  onCancel,
}: {
  n: Negotiation;
  canWork: boolean;
  myId: string | null;
  limit: number;
  nameOf: (userId: string | null | undefined) => string | null;
  onCancel: (d: Discount) => void;
}) {
  const t = totals(n);
  const fees = n.course?.course_fees ?? [];
  const discounts = [...n.fee_discounts].reverse();
  const events = [...n.negotiation_events].reverse();
  const discMore = useShowMore(discounts, 3);
  const evMore = useShowMore(events, 3);

  const offFor = (feeId: string) =>
    n.fee_discounts.filter((d) => d.fee_id === feeId && isActive(d, n)).reduce((s, d) => s + Number(d.amount), 0);

  return (
    <>
      {/* Fee list */}
      <View style={styles.fees}>
        {fees.map((f) => {
          const off = offFor(f.id);
          return (
            <View key={f.id} style={styles.feeRow}>
              <Text style={styles.feeName} numberOfLines={1}>
                {f.name}
              </Text>
              {off > 0 && <Text style={styles.feeOff}>−{money(off)}</Text>}
              <Text style={[styles.feeAmount, off > 0 && styles.struck]}>{money(Number(f.amount))}</Text>
            </View>
          );
        })}
        <View style={styles.divider} />
        <View style={styles.feeRow}>
          <Text style={styles.feeName}>Full fee</Text>
          <Text style={styles.feeAmount}>{money(t.list)}</Text>
        </View>
        {t.discount > 0 && (
          <View style={styles.feeRow}>
            <Text style={styles.feeName}>Discount ({Math.round((t.discount / Math.max(t.list, 1)) * 1000) / 10}%)</Text>
            <Text style={[styles.feeAmount, styles.good]}>−{money(t.discount)}</Text>
          </View>
        )}
        <View style={styles.feeRow}>
          <Text style={styles.finalLabel}>{n.status === 'locked' ? '🔒 Final fee (admitted)' : 'To pay'}</Text>
          <Text style={styles.finalAmount}>{money(t.final)}</Text>
        </View>
        {t.pending > 0 && <Text style={styles.hint}>⏳ {money(t.pending)} more discount waiting for approval</Text>}
      </View>

      {/* Discounts */}
      {discounts.length > 0 && (
        <View style={styles.section}>
          <Text style={styles.sectionLabel}>DISCOUNTS</Text>
          {discMore.visible.map((d) => {
            const expired = d.status === 'approved' && !isActive(d, n);
            const s = STATUS[expired ? 'expired' : d.status];
            const mayCancel =
              canWork && (d.status === 'pending' || (d.status === 'approved' && !expired)) && (d.requested_by === myId || limit > 0);
            return (
              <Pressable
                key={d.id}
                onLongPress={mayCancel ? () => onCancel(d) : undefined}
                style={styles.discRow}
                accessibilityHint={mayCancel ? 'Long press to take it back' : undefined}
              >
                <View style={styles.flex}>
                  <Text style={styles.discTitle}>
                    {money(d.amount)} off {d.fee_name ?? 'the fee'}
                    {d.kind === 'percent' ? ` (${d.value}%)` : ''}
                  </Text>
                  <Text style={styles.meta}>
                    {[d.reason, nameOf(d.requested_by), shortDate(d.requested_at)].filter(Boolean).join(' · ')}
                  </Text>
                  {d.note && <Text style={styles.note}>“{d.note}”</Text>}
                  {d.status !== 'pending' && d.decided_by && d.decided_by !== d.requested_by && (
                    <Text style={styles.meta}>
                      {d.status === 'approved' ? 'Approved' : d.status === 'rejected' ? 'Answered' : 'Taken back'} by{' '}
                      {nameOf(d.decided_by) ?? 'someone'}
                      {d.decision_note ? `: “${d.decision_note}”` : ''}
                    </Text>
                  )}
                  {d.status === 'approved' && !expired && d.expires_at && n.status === 'open' && (
                    <Text style={styles.meta}>Valid till {shortDate(d.expires_at)}</Text>
                  )}
                </View>
                <View style={styles.discSide}>
                  <Text style={[styles.discStatus, { color: s.color }]}>{s.label}</Text>
                  {mayCancel && (
                    <Pressable onPress={() => onCancel(d)} hitSlop={8} accessibilityRole="button">
                      <Text style={styles.takeBack}>Take back</Text>
                    </Pressable>
                  )}
                </View>
              </Pressable>
            );
          })}
          <ShowMoreButton {...discMore} />
          {discounts.some((d) => d.status === 'pending') && (
            <Pressable onPress={() => router.push('/discounts' as Href)} hitSlop={8}>
              <Text style={styles.link}>See all discount requests ›</Text>
            </Pressable>
          )}
        </View>
      )}

      {/* What was said */}
      {events.length > 0 && (
        <View style={styles.section}>
          <Text style={styles.sectionLabel}>WHAT WAS SAID</Text>
          {evMore.visible.map((e) => (
            <View key={e.id} style={styles.evRow}>
              <Text style={styles.evDot}>{e.kind === 'lead_asked' ? '🙋' : e.kind === 'note' ? '📝' : '🏷'}</Text>
              <View style={styles.flex}>
                <Text style={styles.evText}>
                  {e.kind === 'note' ? e.note : `${EVENT_LABELS[e.kind]} ${money(Number(e.amount ?? 0))}`}
                </Text>
                {e.kind !== 'note' && e.note && <Text style={styles.note}>“{e.note}”</Text>}
                <Text style={styles.meta}>{[nameOf(e.created_by), shortDate(e.created_at)].filter(Boolean).join(' · ')}</Text>
              </View>
            </View>
          ))}
          <ShowMoreButton {...evMore} />
        </View>
      )}
    </>
  );
}

// =====================================================================
// "What was said": we told the fee / lead asked / we offered / note
// =====================================================================
function EventSheet({
  visible,
  onClose,
  onSave,
}: {
  visible: boolean;
  onClose: () => void;
  onSave: (kind: NegotiationEvent['kind'], amount: number | null, note: string) => Promise<void>;
}) {
  const [kind, setKind] = useState<NegotiationEvent['kind']>('lead_asked');
  const [amount, setAmount] = useState('');
  const [note, setNote] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!visible) return;
    setKind('lead_asked');
    setAmount('');
    setNote('');
    setError(null);
  }, [visible]);

  const save = async () => {
    const value = Number(amount.replace(/[^0-9.]/g, ''));
    if (kind !== 'note' && !(value > 0)) return setError('Please type the amount.');
    if (kind === 'note' && !note.trim()) return setError('Please write the note.');
    setSaving(true);
    setError(null);
    try {
      await onSave(kind, kind === 'note' ? null : value, note);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not save.');
    } finally {
      setSaving(false);
    }
  };

  return (
    <SmallSheet visible={visible} onClose={saving ? undefined : onClose}>
      <Text style={styles.sheetTitle}>What was said about the fee?</Text>
      <View style={styles.chips}>
        {(['lead_asked', 'offer', 'quoted', 'note'] as const).map((k) => (
          <Pressable
            key={k}
            onPress={() => setKind(k)}
            style={[styles.chip, kind === k && styles.chipOn]}
            accessibilityRole="radio"
            accessibilityState={{ checked: kind === k }}
          >
            <Text style={[styles.chipText, kind === k && styles.textOn]}>{EVENT_LABELS[k]}</Text>
          </Pressable>
        ))}
      </View>
      {kind !== 'note' && (
        <TextInput
          value={amount}
          onChangeText={setAmount}
          placeholder="Amount (৳)"
          placeholderTextColor={colors.textMuted}
          keyboardType="numeric"
          style={styles.input}
        />
      )}
      <TextInput
        value={note}
        onChangeText={setNote}
        placeholder={kind === 'note' ? 'Note' : 'Note (optional), e.g. can pay in 2 parts'}
        placeholderTextColor={colors.textMuted}
        multiline
        style={[styles.input, styles.inputMulti]}
      />
      {error && <Text style={styles.errorText}>{error}</Text>}
      <Button title="Save" onPress={save} loading={saving} fullWidth />
    </SmallSheet>
  );
}

// =====================================================================
// Ask for a discount (approved at once when within my limit)
// =====================================================================
function DiscountSheet({
  visible,
  n,
  settings,
  limit,
  onClose,
  onSaved,
}: {
  visible: boolean;
  n: Negotiation;
  settings: FeeSettings;
  limit: number;
  onClose: () => void;
  onSaved: (message: string) => Promise<void>;
}) {
  const [feeId, setFeeId] = useState<string | null>(null);
  const [kind, setKind] = useState<'amount' | 'percent'>('amount');
  const [value, setValue] = useState('');
  const [reason, setReason] = useState<string | null>(null);
  const [note, setNote] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!visible) return;
    setFeeId(null);
    setKind('amount');
    setValue('');
    setReason(null);
    setNote('');
    setError(null);
  }, [visible]);

  const fees = n.course?.course_fees ?? [];
  const t = totals(n);
  const base = feeId ? Number(fees.find((f) => f.id === feeId)?.amount ?? 0) : t.list;
  const v = Number(value.replace(/[^0-9.]/g, '')) || 0;
  const amount = useMemo(() => Math.round((kind === 'percent' ? (base * v) / 100 : v) * 100) / 100, [kind, base, v]);
  const pctAfter = t.list > 0 ? Math.round(((t.discount + amount) * 10000) / t.list) / 100 : 0;
  const autoOk = amount > 0 && limit >= pctAfter;

  const save = async () => {
    if (!(amount > 0)) return setError('Please type the discount.');
    if (amount > base) return setError(`The discount is more than the fee (${money(base)}).`);
    if (settings.reason_required && !reason) return setError('Please choose a reason.');
    setSaving(true);
    setError(null);
    try {
      const r = await requestDiscount({ negotiationId: n.id, feeId, kind, value: v, reason, note });
      await onSaved(
        r.status === 'approved'
          ? `✓ ${money(r.amount)} discount approved.`
          : `⏳ ${money(r.amount)} discount sent for approval.`,
      );
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not save.');
    } finally {
      setSaving(false);
    }
  };

  return (
    <SmallSheet visible={visible} onClose={saving ? undefined : onClose}>
      <Text style={styles.sheetTitle}>Discount · {n.course?.name}</Text>

      <Text style={styles.label}>On</Text>
      <View style={styles.chips}>
        <Chip text={`Whole fee · ${money(t.list)}`} on={feeId === null} onPress={() => setFeeId(null)} />
        {fees.map((f) => (
          <Chip key={f.id} text={`${f.name} · ${money(Number(f.amount))}`} on={feeId === f.id} onPress={() => setFeeId(f.id)} />
        ))}
      </View>

      <View style={styles.amountRow}>
        <View style={styles.segment}>
          <Chip text="৳ Taka" on={kind === 'amount'} onPress={() => setKind('amount')} />
          <Chip text="% Percent" on={kind === 'percent'} onPress={() => setKind('percent')} />
        </View>
        <TextInput
          value={value}
          onChangeText={setValue}
          placeholder={kind === 'percent' ? '10' : '3000'}
          placeholderTextColor={colors.textMuted}
          keyboardType="numeric"
          style={[styles.input, styles.flex]}
        />
      </View>

      {amount > 0 && (
        <View style={[styles.preview, autoOk ? styles.previewOk : styles.previewWait]}>
          <Text style={styles.previewText}>
            {money(amount)} off · to pay {money(Math.max(t.list - t.discount - amount, 0))} · all discounts {pctAfter}% of the fee
          </Text>
          <Text style={styles.previewText}>
            {autoOk
              ? '✓ Within your limit: approved at once.'
              : `⏳ Needs approval (you may give up to ${limit}%).`}
          </Text>
        </View>
      )}

      <Text style={styles.label}>Reason{settings.reason_required ? ' *' : ''}</Text>
      <View style={styles.chips}>
        {settings.reasons.map((r) => (
          <Chip key={r} text={r} on={reason === r} onPress={() => setReason(reason === r ? null : r)} />
        ))}
      </View>
      <TextInput
        value={note}
        onChangeText={setNote}
        placeholder="Note (optional)"
        placeholderTextColor={colors.textMuted}
        multiline
        style={[styles.input, styles.inputMulti]}
      />
      {error && <Text style={styles.errorText}>{error}</Text>}
      <Button title={autoOk ? 'Give discount' : 'Ask for approval'} onPress={save} loading={saving} fullWidth />
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
  cardLocked: { borderColor: colors.success },
  header: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  title: { fontSize: fontSize.body, fontWeight: fontWeight.bold, color: colors.text },
  status: { fontSize: fontSize.small, fontWeight: fontWeight.bold, color: colors.primary },
  statusLocked: { color: colors.success },
  row: { flexDirection: 'row', gap: spacing.sm },
  hint: { fontSize: fontSize.caption, color: colors.textMuted },
  meta: { fontSize: fontSize.caption, color: colors.textMuted },
  note: { fontSize: fontSize.small, color: colors.text, marginTop: 2 },
  link: { fontSize: fontSize.small, fontWeight: fontWeight.bold, color: colors.primary },
  cancelLink: { fontSize: fontSize.small, color: colors.textMuted, textAlign: 'center', marginTop: spacing.xs },
  errorText: { fontSize: fontSize.small, color: colors.danger },
  pressed: { opacity: 0.7 },

  fees: { gap: 6 },
  feeRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm },
  feeName: { flex: 1, fontSize: fontSize.small, color: colors.text },
  feeOff: { fontSize: fontSize.caption, fontWeight: fontWeight.bold, color: colors.success },
  feeAmount: { fontSize: fontSize.small, fontWeight: fontWeight.semibold, color: colors.text },
  struck: { textDecorationLine: 'line-through', color: colors.textMuted },
  good: { color: colors.success },
  divider: { height: 1, backgroundColor: colors.border, marginVertical: 2 },
  finalLabel: { flex: 1, fontSize: fontSize.body, fontWeight: fontWeight.bold, color: colors.text },
  finalAmount: { fontSize: fontSize.title, fontWeight: fontWeight.bold, color: colors.text },

  section: { gap: spacing.sm, paddingTop: spacing.sm, borderTopWidth: 1, borderTopColor: colors.border },
  sectionLabel: { fontSize: fontSize.caption, fontWeight: fontWeight.bold, letterSpacing: 1, color: colors.textMuted },
  discRow: { flexDirection: 'row', gap: spacing.md, alignItems: 'flex-start' },
  discTitle: { fontSize: fontSize.small, fontWeight: fontWeight.bold, color: colors.text },
  discSide: { alignItems: 'flex-end', gap: 4 },
  discStatus: { fontSize: fontSize.caption, fontWeight: fontWeight.bold },
  takeBack: { fontSize: fontSize.caption, fontWeight: fontWeight.semibold, color: colors.danger },
  evRow: { flexDirection: 'row', gap: spacing.sm, alignItems: 'flex-start' },
  evDot: { fontSize: fontSize.small, width: 22 },
  evText: { fontSize: fontSize.small, fontWeight: fontWeight.semibold, color: colors.text },

  picker: { gap: spacing.xs },
  pickRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
    padding: spacing.md,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.border,
  },
  pickName: { flex: 1, fontSize: fontSize.small, fontWeight: fontWeight.semibold, color: colors.text },
  pickTotal: { fontSize: fontSize.small, color: colors.textMuted },

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
  amountRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm },
  segment: { flexDirection: 'row', gap: spacing.xs },
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
  inputMulti: { minHeight: 72, paddingTop: spacing.sm, textAlignVertical: 'top' },
  preview: { padding: spacing.md, borderRadius: radius.md, gap: 2 },
  previewOk: { backgroundColor: colors.successSoft },
  previewWait: { backgroundColor: colors.warningSoft },
  previewText: { fontSize: fontSize.small, color: colors.text },
});
