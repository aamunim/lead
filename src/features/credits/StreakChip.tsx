import { router, useFocusEffect, type Href } from 'expo-router';
import { useCallback, useState } from 'react';
import { StyleSheet, Text } from 'react-native';

import { useAuth } from '@/features/auth/AuthProvider';
import { getMe, type Me } from '@/features/credits/api';
import { Tap, md } from '@/features/home/md';
import { fontWeight } from '@/shared/theme';

// 🔥 Home top bar: your streak and your level icon (also when the Super
// Admin left you out of the leaderboard). Tap = the leaderboard.
export function StreakChip() {
  const { profile } = useAuth();
  const [me, setMe] = useState<Me | null>(null);

  useFocusEffect(
    useCallback(() => {
      if (!profile?.id) return;
      getMe()
        .then(setMe)
        .catch(() => setMe(null));
    }, [profile?.id]),
  );

  if (!me || !me.enabled) return null;
  const icon = me.level?.icon;
  const label = `${me.streak} day streak${me.level?.name ? `, level ${me.level.name}` : ''}`;
  return (
    <Tap onPress={() => router.push('/leaderboard' as Href)} style={styles.chip} label={label}>
      <Text style={styles.text}>
        🔥 {me.streak}
        {icon ? `  ${icon}` : ''}
      </Text>
    </Tap>
  );
}

const styles = StyleSheet.create({
  chip: {
    height: 32,
    paddingHorizontal: 10,
    borderRadius: 16,
    backgroundColor: md.goldC,
    alignItems: 'center',
    justifyContent: 'center',
    overflow: 'hidden',
  },
  text: { fontSize: 14, fontWeight: fontWeight.semibold, color: md.onGoldC },
});
