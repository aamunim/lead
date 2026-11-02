import { router, useFocusEffect, type Href } from 'expo-router';
import { useCallback, useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';

import { useAuth } from '@/features/auth/AuthProvider';
import { listDueFollowUps, startOfDay } from '@/features/follow-ups/api';
import { MIcon, Tap, md, type MIconName } from '@/features/home/md';
import { listTodayVisits } from '@/features/visits/api';
import { supabase } from '@/shared/lib/supabase';
import { colors, fontSize, fontWeight } from '@/shared/theme';

// =====================================================================
// 📊 Home: today at a glance (2 × 2): calls due today · overdue ·
//   campus visits · money taken today. Tap a tile to open its list.
// =====================================================================

type Stats = { today: number; overdue: number; visits: number; taken: number | null };

const taka = (n: number) =>
  n >= 100000 ? `৳${(n / 100000).toFixed(1)}L` : n >= 1000 ? `৳${Math.round(n / 1000)}k` : `৳${Math.round(n)}`;

/** Money taken today that I can see (payments minus refunds; null = not allowed / not set up) */
async function takenToday(): Promise<number | null> {
  const start = startOfDay(new Date());
  const { data, error } = await supabase
    .from('fee_payments')
    .select('amount, kind')
    .is('voided_at', null)
    .gte('paid_at', start.toISOString());
  if (error) return null;
  return ((data ?? []) as { amount: number; kind?: string | null }[]).reduce(
    (n, p) => n + (p.kind === 'refund' ? -Number(p.amount) : Number(p.amount)),
    0,
  );
}

export function TodayStats({ onOpenCalls }: { onOpenCalls?: () => void }) {
  const { profile, assignmentOn } = useAuth();
  const [s, setS] = useState<Stats | null>(null);

  useFocusEffect(
    useCallback(() => {
      const mine = assignmentOn ? { userId: profile?.id } : { createdBy: profile?.id };
      Promise.all([listDueFollowUps(mine).catch(() => []), listTodayVisits().catch(() => []), takenToday()]).then(
        ([due, visits, taken]) => {
          const t0 = startOfDay(new Date()).getTime();
          const overdue = due.filter((f) => new Date(f.due_at).getTime() < t0).length;
          setS({ today: due.length - overdue, overdue, visits: visits.length, taken });
        },
      );
    }, [profile?.id, assignmentOn]),
  );

  const tiles: { icon: MIconName; bg: string; fg: string; value: string; label: string; onPress?: () => void }[] = [
    {
      icon: 'call',
      bg: md.primaryC,
      fg: md.onPrimaryC,
      value: s ? String(s.today) : '–',
      label: 'Calls today',
      onPress: onOpenCalls,
    },
    {
      icon: 'schedule',
      bg: md.errorC,
      fg: md.onErrorC,
      value: s ? String(s.overdue) : '–',
      label: 'Overdue',
      onPress: onOpenCalls,
    },
    {
      icon: 'apartment',
      bg: md.warnC,
      fg: md.onWarnC,
      value: s ? String(s.visits) : '–',
      label: 'Visits today',
      onPress: onOpenCalls,
    },
    {
      icon: 'payments',
      bg: md.okC,
      fg: md.onOkC,
      value: s?.taken != null ? taka(s.taken) : '–',
      label: 'Taken today',
      onPress: () => router.push({ pathname: '/students', params: { quick: 'paid' } } as unknown as Href),
    },
  ];
  // No money tile when payments can't be seen
  const shown = s && s.taken == null ? tiles.slice(0, 3) : tiles;

  return (
    <View style={styles.grid}>
      {shown.map((t) => (
        <Tap key={t.label} onPress={t.onPress} style={styles.tile} label={`${t.label}: ${t.value}`}>
          <View style={[styles.icon, { backgroundColor: t.bg }]}>
            <MIcon name={t.icon} size={20} color={t.fg} />
          </View>
          <Text style={styles.value} numberOfLines={1}>
            {t.value}
          </Text>
          <Text style={styles.label} numberOfLines={1}>
            {t.label}
          </Text>
        </Tap>
      ))}
    </View>
  );
}

const styles = StyleSheet.create({
  grid: { flexDirection: 'row', flexWrap: 'wrap', gap: 10, marginTop: 18 },
  tile: {
    flexBasis: '47%',
    flexGrow: 1,
    padding: 14,
    paddingBottom: 12,
    gap: 6,
    borderRadius: 16,
    backgroundColor: md.surface1,
    overflow: 'hidden',
  },
  icon: { width: 36, height: 36, borderRadius: 12, alignItems: 'center', justifyContent: 'center' },
  value: { fontSize: 26, lineHeight: 30, fontWeight: fontWeight.semibold, color: colors.text },
  label: { fontSize: fontSize.caption, color: colors.textMuted, letterSpacing: 0.2 },
});
