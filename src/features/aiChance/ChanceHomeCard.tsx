import { router, type Href } from 'expo-router';
import { useCallback } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';

import { getChanceToday, type ChanceToday } from '@/features/aiChance/api';
import { ChanceChip } from '@/features/aiChance/ChanceChip';
import { Fold, md } from '@/features/home/md';
import { useSavedState } from '@/shared/lib/saved';
import { useFocusRefresh } from '@/shared/lib/useFocusRefresh';
import { colors, fontSize, fontWeight, spacing } from '@/shared/theme';

// =====================================================================
// 🔮 Home: my leads to call first today, by the AI's chance — a good
//   chance, not talked to today, no next call later than today. One small
//   request, kept for 3 minutes (and on the phone for an instant open).
// =====================================================================

export function ChanceHomeCard() {
  const [rows, setRows] = useSavedState<ChanceToday[]>('home:aichance', []);

  useFocusRefresh(
    useCallback(() => {
      getChanceToday()
        .then(setRows)
        .catch(() => undefined);
    }, [setRows]),
  );

  if (rows.length === 0) return null;
  return (
    <Fold
      id="aichance"
      icon="auto-awesome"
      tint={{ bg: md.purpleC, fg: md.onPurpleC }}
      title="Call these first"
      summary={`🔮 ${rows.length} · ${rows[0].name} ${rows[0].chance}%`}
      defaultOpen
    >
      {rows.map((r) => (
        <Pressable
          key={r.lead_id}
          onPress={() => router.push(`/leads/${r.lead_id}` as Href)}
          style={({ pressed }) => [styles.row, pressed && styles.pressed]}
          accessibilityRole="button"
        >
          <View style={styles.flex}>
            <View style={styles.top}>
              <Text style={styles.name} numberOfLines={1}>
                {r.name}
              </Text>
              <ChanceChip chance={r.chance} level={r.level} />
            </View>
            {!!r.action && (
              <Text style={styles.action} numberOfLines={2}>
                👉 {r.action}
              </Text>
            )}
            <Text style={styles.meta} numberOfLines={1}>
              {r.days_since == null
                ? 'Never talked to'
                : r.days_since === 0
                  ? 'Talked today'
                  : `Last talk ${r.days_since}d ago`}
              {r.best_time ? ` · ⏰ ${r.best_time}` : ''}
            </Text>
          </View>
        </Pressable>
      ))}
      <View style={styles.footer}>
        <Pressable
          onPress={() =>
            router.push({ pathname: '/leads', params: { quick: 'mine', sort: 'ai_chance' } } as unknown as Href)
          }
          hitSlop={8}
          accessibilityRole="button"
        >
          <Text style={styles.all}>All by AI chance ›</Text>
        </Pressable>
      </View>
    </Fold>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1 },
  row: { paddingVertical: 8 },
  pressed: { opacity: 0.7 },
  top: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm },
  name: { flex: 1, fontSize: fontSize.body, fontWeight: fontWeight.semibold, color: colors.text },
  action: { fontSize: fontSize.small, lineHeight: 19, color: colors.text, marginTop: 2 },
  meta: { fontSize: fontSize.caption, color: colors.textMuted, marginTop: 2 },
  footer: { alignItems: 'flex-end', paddingTop: 2 },
  all: { fontSize: fontSize.small, fontWeight: fontWeight.bold, color: colors.primary },
});
