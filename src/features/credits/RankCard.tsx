import { router, useFocusEffect, type Href } from 'expo-router';
import { useCallback, useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';

import { useAuth } from '@/features/auth/AuthProvider';
import { boardRange, getLeaderboard } from '@/features/credits/api';
import { MIcon, Tap, md } from '@/features/home/md';
import { colors, fontWeight } from '@/shared/theme';

// 🏆 Home: "This week you are #3 · 420 credits ▲2" (tap = the leaderboard)
export function RankCard() {
  const { profile } = useAuth();
  const [line, setLine] = useState<{ rank: number | null; total: number; move: number | null; of: number } | null>(
    null,
  );

  useFocusEffect(
    useCallback(() => {
      if (!profile?.id) return;
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

  if (!line) return null;
  return (
    <Tap onPress={() => router.push('/leaderboard' as Href)} style={styles.card} label="Leaderboard">
      <Text style={styles.cup}>🏆</Text>
      <View style={styles.flex}>
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
        <Text style={styles.sub}>{line.rank === 1 ? 'You are at the top! 🥇' : 'Tap to see the leaderboard'}</Text>
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
    backgroundColor: '#FFF4D6',
    overflow: 'hidden',
  },
  cup: { fontSize: 24 },
  flex: { flex: 1 },
  title: { fontSize: 14, fontWeight: fontWeight.semibold, color: colors.text },
  sub: { fontSize: 12, color: colors.textMuted, marginTop: 1 },
});
