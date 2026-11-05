import { router, type Href } from 'expo-router';
import { useFocusRefresh } from '@/shared/lib/useFocusRefresh';
import { useCallback, useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';

import { useAuth } from '@/features/auth/AuthProvider';
import { listDueFollowUps, startOfDay } from '@/features/follow-ups/api';
import { MIcon, Tap, md, type MIconName } from '@/features/home/md';
import { listTodayVisits } from '@/features/visits/api';
import { supabase } from '@/shared/lib/supabase';
import { colors, fontWeight } from '@/shared/theme';

// =====================================================================
// 📊 Home: today at a glance (3 × 2)
//   calls due · call time · new leads · admitted · visits · money taken
//   Admins (and everyone in shared mode) see the whole team's day,
//   everyone else their own. Tap a tile to open its list.
// =====================================================================

type Stats = {
  calls: number;
  talkMin: number | null;
  leads: number | null;
  admitted: number | null;
  visits: number;
  taken: number | null;
};

const taka = (n: number) =>
  n >= 100000 ? `৳${(n / 100000).toFixed(1)}L` : n >= 1000 ? `৳${Math.round(n / 1000)}k` : `৳${Math.round(n)}`;

const minutes = (m: number) => (m >= 60 ? `${Math.floor(m / 60)}h ${m % 60}m` : `${m}m`);

/** Money taken today that I can see (payments minus refunds; null = not allowed) */
async function takenToday(start: string): Promise<number | null> {
  const { data, error } = await supabase
    .from('fee_payments')
    .select('amount, kind')
    .is('voided_at', null)
    .gte('paid_at', start);
  if (error) return null;
  return ((data ?? []) as { amount: number; kind?: string | null }[]).reduce(
    (n, p) => n + (p.kind === 'refund' ? -Number(p.amount) : Number(p.amount)),
    0,
  );
}

/** New leads added today (by me, or by everyone) */
async function leadsToday(start: string, me: string | null): Promise<number | null> {
  let q = supabase
    .from('leads')
    .select('id', { count: 'exact', head: true })
    .is('deleted_at', null)
    .gte('created_at', start);
  if (me) q = q.eq('created_by', me);
  const { count, error } = await q;
  return error ? null : (count ?? 0);
}

/** Admitted today (by me, or by everyone) */
async function admittedToday(start: string, me: string | null): Promise<number | null> {
  let q = supabase
    .from('leads')
    .select('id', { count: 'exact', head: true })
    .is('deleted_at', null)
    .gte('admitted_at', start);
  if (me) q = q.eq('admitted_by', me);
  const { count, error } = await q;
  return error ? null : (count ?? 0);
}

/** Talk time today on connected calls, in minutes (mine, or everyone's) */
async function talkToday(start: string, me: string | null): Promise<number | null> {
  let q = supabase
    .from('call_logs')
    .select('duration_sec')
    .eq('outcome', 'connected')
    .gte('called_at', start)
    .limit(5000);
  if (me) q = q.eq('user_id', me);
  const { data, error } = await q;
  if (error) return null;
  const sec = ((data ?? []) as { duration_sec: number | null }[]).reduce((n, c) => n + (c.duration_sec ?? 0), 0);
  return Math.round(sec / 60);
}

export function TodayStats({ onOpenCalls }: { onOpenCalls?: () => void }) {
  const { profile, assignmentOn, hasPermission, sharedMode } = useAuth();
  const team = sharedMode || hasPermission('leads.view_all');
  const [s, setS] = useState<Stats | null>(null);

  useFocusRefresh(
    useCallback(() => {
      const start = startOfDay(new Date()).toISOString();
      const me = team ? null : (profile?.id ?? null);
      const mine = assignmentOn ? { userId: profile?.id } : { createdBy: profile?.id };
      Promise.all([
        listDueFollowUps(mine).catch(() => []),
        talkToday(start, me),
        leadsToday(start, me),
        admittedToday(start, me),
        listTodayVisits().catch(() => []),
        takenToday(start),
      ]).then(([due, talkMin, leads, admitted, visits, taken]) => {
        const t0 = new Date(start).getTime();
        const calls = due.filter((f) => new Date(f.due_at).getTime() >= t0).length;
        setS({ calls, talkMin, leads, admitted, visits: visits.length, taken });
      });
    }, [profile?.id, assignmentOn, team]),
  );

  const v = (n: number | null | undefined, f: (x: number) => string = String) => (n == null ? '–' : f(n));
  const tiles: { icon: MIconName; fg: string; value: string; label: string; onPress?: () => void; hide?: boolean }[] = [
    { icon: 'call', fg: md.onPrimaryC, value: v(s?.calls), label: 'Calls due', onPress: onOpenCalls },
    {
      icon: 'timer',
      fg: md.onPurpleC,
      value: v(s?.talkMin, minutes),
      label: 'Call time',
      // Team activity is for the people who may see the team
      onPress: team ? () => router.push('/activity' as Href) : undefined,
    },
    {
      icon: 'person-add-alt',
      fg: md.onPrimaryC,
      value: v(s?.leads),
      label: 'New leads',
      onPress: () =>
        router.push({
          pathname: '/leads',
          params: team ? { addedDay: 'today' } : { addedBy: profile?.id ?? '', addedDay: 'today' },
        } as unknown as Href),
    },
    {
      icon: 'how-to-reg',
      fg: md.onOkC,
      value: v(s?.admitted),
      label: 'Admitted',
      onPress: () => router.push({ pathname: '/students', params: { quick: 'new_students' } } as unknown as Href),
    },
    { icon: 'apartment', fg: md.onWarnC, value: v(s?.visits), label: 'Visits', onPress: onOpenCalls },
    {
      icon: 'payments',
      fg: md.onOkC,
      value: v(s?.taken, taka),
      label: 'Taken',
      onPress: () => router.push({ pathname: '/students', params: { quick: 'paid' } } as unknown as Href),
      // No money tile when payments can't be seen
      hide: !!s && s.taken == null,
    },
  ];

  return (
    <View style={styles.card}>
      <Text style={styles.caption}>{team ? 'TODAY · WHOLE TEAM' : 'TODAY · YOU'}</Text>
      <View style={styles.grid}>
        {tiles
          .filter((t) => !t.hide)
          .map((t) => (
            <Tap key={t.label} onPress={t.onPress} style={styles.tile} label={`${t.label}: ${t.value}`}>
              <View style={styles.top}>
                <MIcon name={t.icon} size={16} color={t.fg} />
                <Text style={styles.label} numberOfLines={1}>
                  {t.label}
                </Text>
              </View>
              <Text style={styles.value} numberOfLines={1}>
                {t.value}
              </Text>
            </Tap>
          ))}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  card: { marginTop: 12, padding: 10, paddingTop: 8, borderRadius: 18, backgroundColor: md.surface1 },
  caption: { fontSize: 10.5, fontWeight: fontWeight.semibold, color: colors.textMuted, letterSpacing: 0.8, margin: 4 },
  grid: { flexDirection: 'row', flexWrap: 'wrap', gap: 6 },
  tile: {
    width: '31.8%',
    flexGrow: 1,
    gap: 4,
    paddingVertical: 9,
    paddingHorizontal: 10,
    borderRadius: 12,
    backgroundColor: colors.surface,
    overflow: 'hidden',
  },
  top: { flexDirection: 'row', alignItems: 'center', gap: 5 },
  value: { fontSize: 18, lineHeight: 22, fontWeight: fontWeight.semibold, color: colors.text },
  label: { flex: 1, fontSize: 11, color: colors.textMuted },
});
