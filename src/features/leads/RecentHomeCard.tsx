import { router, type Href } from 'expo-router';
import { useCallback } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';

import { Fold, md } from '@/features/home/md';
import { listLeadsByIds } from '@/features/leads/api';
import { listRecent, recentWhat, recentWhen } from '@/features/leads/find';
import { useSavedState } from '@/shared/lib/saved';
import { useFocusRefresh } from '@/shared/lib/useFocusRefresh';
import { colors, fontSize, fontWeight, spacing } from '@/shared/theme';

// =====================================================================
// 🕘 Home: the leads I worked on today (calls, notes, changes, opened),
//   newest first; tap one to open it, "See all" = Leads → 🕘 Recent
// =====================================================================

type Row = { id: string; name: string; what: string; at: string };

export function RecentHomeCard() {
  const [rows, setRows] = useSavedState<Row[]>('home:recent', []);

  useFocusRefresh(
    useCallback(() => {
      listRecent({ day: 'today' }, 8)
        .then(async (recent) => {
          const leads = await listLeadsByIds(recent.map((r) => r.leadId));
          const byId = new Map(leads.map((l) => [l.id, l]));
          setRows(
            recent
              .filter((r) => byId.has(r.leadId))
              .slice(0, 5)
              .map((r) => ({
                id: r.leadId,
                name: byId.get(r.leadId)!.name,
                what: recentWhat(r),
                at: r.at.toISOString(),
              })),
          );
        })
        .catch(() => undefined);
    }, [setRows]),
  );

  if (rows.length === 0) return null;
  return (
    <Fold
      id="recent"
      icon="history"
      tint={{ bg: md.skyC, fg: md.onPrimaryC }}
      title="Called today"
      summary={`${rows.length}${rows.length >= 5 ? '+' : ''} · last: ${rows[0].name}`}
      defaultOpen
    >
      {rows.map((r) => (
        <Pressable
          key={r.id}
          onPress={() => router.push(`/leads/${r.id}` as Href)}
          style={({ pressed }) => [styles.row, pressed && styles.pressed]}
          accessibilityRole="button"
        >
          <Text style={styles.name} numberOfLines={1}>
            {r.name}
          </Text>
          <Text style={styles.what} numberOfLines={1}>
            {r.what} · {recentWhen(new Date(r.at))}
          </Text>
        </Pressable>
      ))}
      <View style={styles.footer}>
        <Pressable
          onPress={() => router.push({ pathname: '/leads', params: { quick: 'recent' } } as unknown as Href)}
          hitSlop={8}
          accessibilityRole="button"
        >
          <Text style={styles.all}>See all ›</Text>
        </Pressable>
      </View>
    </Fold>
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm, paddingVertical: 8 },
  pressed: { opacity: 0.7 },
  name: { flex: 1, fontSize: fontSize.body, fontWeight: fontWeight.semibold, color: colors.text },
  what: { fontSize: fontSize.caption, color: colors.textMuted },
  footer: { alignItems: 'flex-end', paddingTop: 2 },
  all: { fontSize: fontSize.small, fontWeight: fontWeight.bold, color: colors.primary },
});
