import { router, type Href } from 'expo-router';
import { memo, useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';

import { splitLostNote, type LostItem, type TeamLost } from '@/features/activity/api';
import { colors, fontSize, fontWeight, radius, spacing } from '@/shared/theme';

// =====================================================================
// ❌ Team activity → Marked Lost: each person, how many, and why
//   (tap a person to see the leads and notes; tap a lead to open it)
//   Phone and website use the same section.
// =====================================================================

const when = (iso: string) =>
  new Date(iso).toLocaleString('en-GB', { day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' });

export function LostSection({ lost, compact }: { lost: TeamLost | null; compact?: boolean }) {
  const [open, setOpen] = useState<string | null>(null);
  if (!lost) return null;
  return (
    <View style={styles.card}>
      <View style={styles.head}>
        <Text style={styles.title}>❌ Moved to Not Now</Text>
        <View style={styles.totalPill}>
          <Text style={styles.totalText}>{lost.total}</Text>
        </View>
      </View>
      {lost.people.length === 0 ? (
        <Text style={styles.muted}>Nobody moved a lead to Not Now in this period.</Text>
      ) : (
        lost.people.map((p) => {
          const isOpen = open === p.user_id;
          const items = isOpen ? lost.items.filter((i) => i.user_id === p.user_id) : [];
          const shown = lost.items.filter((i) => i.user_id === p.user_id).length;
          return (
            <View key={p.user_id} style={styles.person}>
              <Pressable
                onPress={() => setOpen(isOpen ? null : p.user_id)}
                style={({ pressed }) => [styles.personRow, pressed && styles.pressed]}
                accessibilityRole="button"
                accessibilityState={{ expanded: isOpen }}
                accessibilityLabel={`${p.name ?? 'No name'}: ${p.count} moved to Not Now`}
              >
                <Text style={styles.personName} numberOfLines={1}>
                  {p.name ?? 'No name'}
                </Text>
                <Text style={styles.count}>{p.count}</Text>
                <Text style={styles.chev}>{isOpen ? '▾' : '▸'}</Text>
              </Pressable>
              {isOpen && (
                <View style={[styles.items, compact && styles.itemsCompact]}>
                  {items.map((i) => (
                    <LostRow key={`${i.lead_id}-${i.at}`} item={i} />
                  ))}
                  {shown < p.count && (
                    <Text style={styles.muted}>
                      Showing the newest {shown} of {p.count}. Choose a shorter period to see the rest.
                    </Text>
                  )}
                </View>
              )}
            </View>
          );
        })
      )}
    </View>
  );
}

const LostRow = memo(function LostRow({ item }: { item: LostItem }) {
  const { reason, note } = splitLostNote(item.note);
  return (
    <Pressable
      onPress={() => router.push(`/leads/${item.lead_id}` as Href)}
      style={({ pressed }) => [styles.item, pressed && styles.pressed]}
      accessibilityRole="button"
      accessibilityLabel={`Open ${item.lead_name}`}
    >
      <View style={styles.itemTop}>
        <Text style={styles.lead} numberOfLines={1}>
          {item.lead_name}
        </Text>
        <Text style={styles.time}>{when(item.at)}</Text>
      </View>
      <View style={styles.tags}>
        {!!reason && (
          <View style={styles.reason}>
            <Text style={styles.reasonText}>{reason}</Text>
          </View>
        )}
        {!item.still_lost && (
          <View style={styles.reopened}>
            <Text style={styles.reopenedText}>Opened again</Text>
          </View>
        )}
      </View>
      {!!note && <Text style={styles.note}>“{note}”</Text>}
    </Pressable>
  );
});

const styles = StyleSheet.create({
  card: {
    gap: spacing.xs,
    padding: spacing.md,
    borderRadius: radius.lg,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.surface,
  },
  head: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: spacing.xs },
  title: { fontSize: fontSize.body, fontWeight: fontWeight.bold, color: colors.text },
  totalPill: { paddingHorizontal: 10, paddingVertical: 2, borderRadius: radius.pill, backgroundColor: colors.danger },
  totalText: { fontSize: fontSize.small, fontWeight: fontWeight.bold, color: colors.textOnPrimary },
  muted: { fontSize: fontSize.small, color: colors.textMuted },
  person: { borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: colors.border },
  personRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm, paddingVertical: spacing.sm },
  pressed: { opacity: 0.7 },
  personName: { flex: 1, fontSize: fontSize.small, fontWeight: fontWeight.semibold, color: colors.text },
  count: {
    fontSize: fontSize.body,
    fontWeight: fontWeight.bold,
    color: colors.danger,
    minWidth: 28,
    textAlign: 'right',
  },
  chev: { width: 16, fontSize: fontSize.small, color: colors.textMuted, textAlign: 'center' },
  items: { gap: spacing.xs, paddingBottom: spacing.sm, paddingLeft: spacing.sm },
  itemsCompact: { paddingLeft: 0 },
  item: {
    gap: 4,
    padding: spacing.sm,
    borderRadius: radius.md,
    backgroundColor: colors.background,
  },
  itemTop: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm },
  lead: { flex: 1, fontSize: fontSize.small, fontWeight: fontWeight.bold, color: colors.primary },
  time: { fontSize: fontSize.caption, color: colors.textMuted },
  tags: { flexDirection: 'row', flexWrap: 'wrap', gap: 6 },
  reason: { paddingHorizontal: 8, paddingVertical: 2, borderRadius: radius.sm, backgroundColor: colors.surface },
  reasonText: { fontSize: fontSize.caption, fontWeight: fontWeight.semibold, color: colors.danger },
  reopened: { paddingHorizontal: 8, paddingVertical: 2, borderRadius: radius.sm, backgroundColor: colors.surface },
  reopenedText: { fontSize: fontSize.caption, fontWeight: fontWeight.semibold, color: colors.success },
  note: { fontSize: fontSize.small, color: colors.text, fontStyle: 'italic' },
});
