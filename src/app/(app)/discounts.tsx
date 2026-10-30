import { Stack, router, useFocusEffect, type Href } from 'expo-router';
import { useCallback, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  Pressable,
  RefreshControl,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';

import { useAuth } from '@/features/auth/AuthProvider';
import { decideDiscount, discountQueue, getMyDiscountLimit, money, type QueueItem } from '@/features/fees/api';
import { colors, fontSize, fontWeight, radius, spacing } from '@/shared/theme';
import { Button } from '@/shared/ui/Button';

// =====================================================================
// 💰 Discount requests waiting for approval
//   Everyone sees the ones on leads they can see; Approve / Not now only
//   when the request fits their limit.
// =====================================================================

const when = (iso: string) => {
  const d = new Date(iso);
  return `${d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })}, ${d.toLocaleTimeString([], {
    hour: 'numeric',
    minute: '2-digit',
  })}`;
};

export default function DiscountsScreen() {
  const { profile } = useAuth();
  const [items, setItems] = useState<QueueItem[]>([]);
  const [limit, setLimit] = useState(0);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notes, setNotes] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setError(null);
      const [q, l] = await Promise.all([discountQueue(), getMyDiscountLimit().catch(() => 0)]);
      setItems(q);
      setLimit(l);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not load the requests.');
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, []);

  useFocusEffect(
    useCallback(() => {
      load();
    }, [load]),
  );

  const decide = async (item: QueueItem, approve: boolean) => {
    setBusy(item.id);
    try {
      await decideDiscount(item.id, approve, notes[item.id] ?? '');
      setItems((now) => now.filter((x) => x.id !== item.id));
    } catch (e) {
      Alert.alert('Could not save', e instanceof Error ? e.message : '');
      load();
    } finally {
      setBusy(null);
    }
  };

  const toApprove = items.filter((i) => i.can_approve && i.requested_by !== profile?.id);
  const others = items.filter((i) => !toApprove.includes(i));

  return (
    <ScrollView
      style={styles.screen}
      contentContainerStyle={styles.content}
      keyboardShouldPersistTaps="handled"
      refreshControl={
        <RefreshControl
          refreshing={refreshing}
          onRefresh={() => {
            setRefreshing(true);
            load();
          }}
        />
      }
    >
      <Stack.Screen options={{ title: 'Discount requests' }} />
      <Text style={styles.hint}>
        {limit >= 100
          ? 'You may approve any discount.'
          : limit > 0
            ? `You may give or approve discounts up to ${limit}% of a course fee.`
            : 'You can ask for discounts; a Team Lead or admin approves them.'}
      </Text>

      {loading ? (
        <ActivityIndicator color={colors.primary} style={styles.loader} />
      ) : error ? (
        <Text style={styles.error}>{error}</Text>
      ) : items.length === 0 ? (
        <Text style={styles.empty}>No discount requests waiting. 🎉</Text>
      ) : (
        <>
          {toApprove.length > 0 && <Text style={styles.sectionLabel}>FOR YOU TO ANSWER ({toApprove.length})</Text>}
          {toApprove.map((i) => (
            <Request
              key={i.id}
              item={i}
              note={notes[i.id] ?? ''}
              onNote={(v) => setNotes((n) => ({ ...n, [i.id]: v }))}
              busy={busy === i.id}
              onDecide={(ok) => decide(i, ok)}
            />
          ))}
          {others.length > 0 && <Text style={styles.sectionLabel}>WAITING FOR SOMEONE ELSE ({others.length})</Text>}
          {others.map((i) => (
            <Request key={i.id} item={i} />
          ))}
        </>
      )}
    </ScrollView>
  );
}

function Request({
  item: i,
  note,
  onNote,
  busy,
  onDecide,
}: {
  item: QueueItem;
  note?: string;
  onNote?: (v: string) => void;
  busy?: boolean;
  onDecide?: (approve: boolean) => void;
}) {
  return (
    <View style={styles.card}>
      <Pressable onPress={() => router.push(`/leads/${i.lead_id}` as Href)} accessibilityRole="link">
        <Text style={styles.lead}>{i.lead_name} ›</Text>
      </Pressable>
      <Text style={styles.amount}>
        {money(i.amount)} off {i.fee_name}
        {i.kind === 'percent' ? ` (${i.value}%)` : ''}
      </Text>
      <Text style={styles.meta}>
        {i.course_name} · full fee {money(i.list_total)} · all discounts {i.percent_after}% · to pay{' '}
        {money(Math.max(i.list_total - (i.list_total * i.percent_after) / 100, 0))}
      </Text>
      <Text style={styles.meta}>
        {[i.reason, i.requester ? `by ${i.requester}` : null, when(i.requested_at)].filter(Boolean).join(' · ')}
      </Text>
      {i.note && <Text style={styles.note}>“{i.note}”</Text>}

      {onDecide ? (
        <>
          <TextInput
            value={note}
            onChangeText={onNote}
            placeholder="Note to them (optional)"
            placeholderTextColor={colors.textMuted}
            style={styles.input}
          />
          <View style={styles.row}>
            <View style={styles.flex}>
              <Button title="✕ Not now" variant="secondary" onPress={() => onDecide(false)} disabled={busy} fullWidth />
            </View>
            <View style={styles.flex}>
              <Button title="✓ Approve" onPress={() => onDecide(true)} loading={busy} fullWidth />
            </View>
          </View>
        </>
      ) : (
        <Text style={styles.waiting}>⏳ Waiting for approval</Text>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1 },
  screen: { flex: 1, backgroundColor: colors.background },
  content: { padding: spacing.lg, gap: spacing.md, paddingBottom: spacing.xxl },
  hint: { fontSize: fontSize.caption, color: colors.textMuted },
  loader: { paddingVertical: spacing.xxl },
  error: { fontSize: fontSize.small, color: colors.danger, textAlign: 'center' },
  empty: { fontSize: fontSize.small, color: colors.textMuted, textAlign: 'center', paddingVertical: spacing.xl },
  sectionLabel: { fontSize: fontSize.caption, fontWeight: fontWeight.bold, letterSpacing: 1, color: colors.textMuted },
  card: {
    gap: 4,
    padding: spacing.lg,
    borderRadius: radius.lg,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.surface,
  },
  lead: { fontSize: fontSize.body, fontWeight: fontWeight.bold, color: colors.primary },
  amount: { fontSize: fontSize.title, fontWeight: fontWeight.bold, color: colors.text },
  meta: { fontSize: fontSize.caption, color: colors.textMuted },
  note: { fontSize: fontSize.small, color: colors.text },
  waiting: { fontSize: fontSize.small, fontWeight: fontWeight.semibold, color: colors.warning, marginTop: spacing.xs },
  input: {
    minHeight: 42,
    marginTop: spacing.sm,
    paddingHorizontal: spacing.md,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.border,
    fontSize: fontSize.small,
    color: colors.text,
    backgroundColor: colors.background,
  },
  row: { flexDirection: 'row', gap: spacing.sm, marginTop: spacing.sm },
});
