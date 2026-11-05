import { router, type Href } from 'expo-router';
import { useSavedState } from '@/shared/lib/saved';
import { useFocusRefresh } from '@/shared/lib/useFocusRefresh';
import { useCallback, useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';

import { useAuth } from '@/features/auth/AuthProvider';
import { boardRange, getLeaderboard, getMe, levelProgress, type Level } from '@/features/credits/api';
import { MIcon, Tap, md } from '@/features/home/md';
import { colors, fontWeight } from '@/shared/theme';

// 🏆 Home: "This week you are #3 · 420 credits ▲2" (tap = the leaderboard)
export function RankCard() {
  const { profile } = useAuth();
  // ⚡ last time's line at once, then the fresh one
  const [line, setLine] = useSavedState<{ rank: number | null; total: number; move: number | null; of: number } | null>(
    'home:rank',
    null,
  );
  const [level, setLevel] = useSavedState<Level | null>('home:level', null);

  useFocusRefresh(
    useCallback(() => {
      if (!profile?.id) return;
      getMe()
        .then((m) => setLevel(m?.enabled ? (m.level ?? null) : null))
        .catch(() => setLevel(null));
      const r = boardRange('week');
      Promise.all([getLeaderboard(r.from, r.to), r.prev ? getLeaderboard(r.prev.from, r.prev.to) : Promise.resolve([])])
        .then(([now, before]) => {
          const me = now.find((x) => x.user_id === profile.id);
          if (!me) return setLine(null);
          const was = before.find((x) => x.user_id === profile.id)?.rank ?? null;
          setLine({
            rank: me.rank,
            total: me.total,
            move: me.rank != null && was != null ? was - me.rank : null,
            of: now.filter((x) => x.rank != null).length,
          });
        })
        .catch(() => setLine(null));
    }, [profile?.id]),
  );

  if (!line && !level) return null;
  const n = (x: number) => Math.round(x).toLocaleString('en-IN');
  return (
    <Tap onPress={() => router.push('/leaderboard' as Href)} style={styles.card} label="Leaderboard">
      <Text style={styles.cup}>{level?.icon ?? '🏆'}</Text>
      <View style={styles.flex}>
        {line ? (
          <Text style={styles.title}>
            {line.rank ? `#${line.rank} of ${line.of} this week` : 'This week'} ·{' '}
            {Math.round(line.total).toLocaleString('en-IN')} credits
            {line.move ? (
              <Text style={{ color: line.move > 0 ? md.onOkC : md.onErrorC }}>
                {'  '}
                {line.move > 0 ? '▲' : '▼'}
                {Math.abs(line.move)}
              </Text>
            ) : null}
          </Text>
        ) : null}
        {level ? (
          <>
            <Text style={line ? styles.sub : styles.title} numberOfLines={1}>
              {level.name ? `${level.icon} ${level.name}` : 'No level yet'} · {n(level.lifetime)}
              {level.next_at != null
                ? ` / ${n(level.next_at)} → ${level.next_icon ?? ''} ${level.next_name ?? ''}`
                : ' credits · top level!'}
            </Text>
            <View style={styles.track}>
              <View style={[styles.fill, { width: `${Math.round(levelProgress(level) * 100)}%` }]} />
            </View>
          </>
        ) : (
          <Text style={styles.sub}>{line?.rank === 1 ? 'You are at the top! 🥇' : 'Tap to see the leaderboard'}</Text>
        )}
      </View>
      <MIcon name="chevron-right" size={22} color={colors.textMuted} />
    </Tap>
  );
}

const styles = StyleSheet.create({
  card: {
    marginTop: 10,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    paddingVertical: 10,
    paddingHorizontal: 14,
    borderRadius: 16,
    backgroundColor: md.goldC,
    overflow: 'hidden',
  },
  cup: { fontSize: 24 },
  flex: { flex: 1 },
  title: { fontSize: 14, fontWeight: fontWeight.semibold, color: colors.text },
  sub: { fontSize: 12, color: colors.textMuted, marginTop: 1 },
  track: { height: 6, borderRadius: 3, backgroundColor: 'rgba(122,75,0,0.15)', marginTop: 6, overflow: 'hidden' },
  fill: { height: 6, borderRadius: 3, backgroundColor: md.gold },
});
