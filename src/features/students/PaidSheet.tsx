import { useState } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';

import type { PaidRange } from '@/features/leads/api';
import { colors, fontSize, fontWeight, radius, spacing } from '@/shared/theme';
import { Button } from '@/shared/ui/Button';
import { Modal } from '@/shared/ui/Modal';

// =====================================================================
// 💵 Students tab: who paid how much. One small sheet:
//   quick picks (৳0 · under ৳1,000 · ৳1,000+ · ৳10,000+), your own
//   min – max, and "paid this week / month". The sort is on the list
//   (Paid most · Paid least · Last paid).
// =====================================================================

const PICKS: { label: string; range: PaidRange }[] = [
  { label: '৳0 (nothing yet)', range: { max: 0 } },
  { label: '৳1 – ৳999', range: { min: 1, max: 999 } },
  { label: '৳1,000+', range: { min: 1000 } },
  { label: '৳5,000+', range: { min: 5000 } },
  { label: '৳10,000+', range: { min: 10000 } },
];

type Since = 'any' | 'week' | 'month';

function sinceIso(s: Since): string | null {
  if (s === 'any') return null;
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  if (s === 'week') d.setDate(d.getDate() - 6);
  else d.setDate(1);
  return d.toISOString();
}

const taka = (n: number) => `৳${Math.round(n).toLocaleString('en-IN')}`;

/** "৳1,000+", "৳1 – ৳999", "৳0", plus "this month" */
export function paidRangeLabel(r: PaidRange | null): string | null {
  if (!r) return null;
  const parts: string[] = [];
  if (r.min != null && r.max != null) parts.push(r.max === 0 ? '৳0' : `${taka(r.min)} – ${taka(r.max)}`);
  else if (r.min != null) parts.push(`${taka(r.min)}+`);
  else if (r.max != null) parts.push(r.max === 0 ? '৳0' : `up to ${taka(r.max)}`);
  if (r.from) parts.push(r.since === 'month' ? 'paid this month' : 'paid in the last 7 days');
  return parts.length ? parts.join(' · ') : null;
}

export function PaidSheet({
  value,
  onApply,
  onClose,
}: {
  value: PaidRange | null;
  onApply: (r: PaidRange | null) => void;
  onClose: () => void;
}) {
  const [min, setMin] = useState(value?.min != null ? String(value.min) : '');
  const [max, setMax] = useState(value?.max != null ? String(value.max) : '');
  const [since, setSince] = useState<Since>(value?.since ?? 'any');
  const [error, setError] = useState<string | null>(null);

  const pickOn = (r: PaidRange) => String(r.min ?? '') === min && String(r.max ?? '') === max;

  const apply = () => {
    const lo = min.trim() === '' ? null : Number(min);
    const hi = max.trim() === '' ? null : Number(max);
    if (lo != null && hi != null && lo > hi) return setError('The "from" amount is more than the "to" amount.');
    const from = sinceIso(since);
    if (lo == null && hi == null && !from) return onApply(null);
    onApply({ min: lo, max: hi, from, since: since === 'any' ? null : since });
  };

  return (
    <Modal visible transparent animationType="slide" onRequestClose={onClose}>
      <View style={styles.backdrop}>
        <Pressable style={styles.flex} onPress={onClose} accessibilityLabel="Close" />
        <View style={styles.sheet}>
          <ScrollView contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
            <Text style={styles.title}>💵 Paid</Text>
            <Text style={styles.small}>What each student paid so far (refunds taken off).</Text>

            <Text style={styles.label}>QUICK</Text>
            <View style={styles.chips}>
              {PICKS.map((p) => {
                const on = pickOn(p.range);
                return (
                  <Pressable
                    key={p.label}
                    onPress={() => {
                      setError(null);
                      setMin(p.range.min != null ? String(p.range.min) : '');
                      setMax(p.range.max != null ? String(p.range.max) : '');
                    }}
                    style={[styles.chip, on && styles.chipOn]}
                    accessibilityRole="radio"
                    accessibilityState={{ checked: on }}
                  >
                    <Text style={[styles.chipText, on && styles.chipTextOn]}>{p.label}</Text>
                  </Pressable>
                );
              })}
            </View>

            <Text style={styles.label}>YOUR OWN</Text>
            <View style={styles.row}>
              <Money value={min} onChange={setMin} placeholder="From ৳" label="Paid from" />
              <Text style={styles.dash}>–</Text>
              <Money value={max} onChange={setMax} placeholder="To ৳" label="Paid up to" />
            </View>

            <Text style={styles.label}>PAID WHEN</Text>
            <View style={styles.chips}>
              {(
                [
                  ['any', 'Any time'],
                  ['week', 'Last 7 days'],
                  ['month', 'This month'],
                ] as const
              ).map(([k, label]) => (
                <Pressable
                  key={k}
                  onPress={() => setSince(k)}
                  style={[styles.chip, since === k && styles.chipOn]}
                  accessibilityRole="radio"
                  accessibilityState={{ checked: since === k }}
                >
                  <Text style={[styles.chipText, since === k && styles.chipTextOn]}>{label}</Text>
                </Pressable>
              ))}
            </View>

            {error && <Text style={styles.error}>{error}</Text>}
            <Button title="Show" onPress={apply} fullWidth />
            {value && <Button title="Clear" variant="ghost" onPress={() => onApply(null)} fullWidth />}
          </ScrollView>
        </View>
      </View>
    </Modal>
  );
}

function Money({
  value,
  onChange,
  placeholder,
  label,
}: {
  value: string;
  onChange: (v: string) => void;
  placeholder: string;
  label: string;
}) {
  return (
    <TextInput
      value={value}
      onChangeText={(t) => onChange(t.replace(/[^\d]/g, ''))}
      placeholder={placeholder}
      placeholderTextColor={colors.textMuted}
      keyboardType="number-pad"
      style={styles.input}
      accessibilityLabel={label}
    />
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1 },
  backdrop: { flex: 1, backgroundColor: 'rgba(0,0,0,0.4)' },
  sheet: {
    maxHeight: '88%',
    borderTopLeftRadius: radius.xl,
    borderTopRightRadius: radius.xl,
    backgroundColor: colors.surface,
  },
  content: { padding: spacing.lg, gap: spacing.sm, paddingBottom: spacing.xl },
  title: { fontSize: fontSize.title, fontWeight: fontWeight.bold, color: colors.text },
  small: { fontSize: fontSize.caption, color: colors.textMuted },
  label: {
    fontSize: fontSize.caption,
    fontWeight: fontWeight.bold,
    color: colors.textMuted,
    letterSpacing: 0.8,
    marginTop: spacing.sm,
  },
  chips: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.sm },
  chip: {
    paddingVertical: 7,
    paddingHorizontal: spacing.md,
    borderRadius: radius.pill,
    borderWidth: 1,
    borderColor: colors.border,
  },
  chipOn: { backgroundColor: colors.primary, borderColor: colors.primary },
  chipText: { fontSize: fontSize.small, fontWeight: fontWeight.semibold, color: colors.text },
  chipTextOn: { color: colors.textOnPrimary },
  row: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm },
  dash: { fontSize: fontSize.body, color: colors.textMuted },
  input: {
    flex: 1,
    height: 44,
    paddingHorizontal: spacing.md,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.border,
    color: colors.text,
    backgroundColor: colors.background,
    fontSize: fontSize.body,
  },
  error: { fontSize: fontSize.small, color: colors.danger },
});
