import { router, useFocusEffect, type Href } from 'expo-router';
import { useCallback, useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';

import { canApprove, countWaitingApproval, getApprovalSettings } from '@/features/approval/api';
import { useAuth } from '@/features/auth/AuthProvider';
import { colors, fontSize, fontWeight, radius, spacing } from '@/shared/theme';

// 🎓 Home: the Admission Officer's "waiting for approval" (only when some wait)
export function ApprovalHomeCard() {
  const { profile, hasPermission } = useAuth();
  const isAdmin = hasPermission('settings.manage');
  const [waiting, setWaiting] = useState(0);

  useFocusEffect(
    useCallback(() => {
      let live = true;
      getApprovalSettings()
        .then((s) => (s.enabled && canApprove(s, profile, isAdmin) ? countWaitingApproval() : 0))
        .then((n) => live && setWaiting(n))
        .catch(() => undefined);
      return () => {
        live = false;
      };
    }, [profile, isAdmin]),
  );

  if (waiting === 0) return null;
  return (
    <Pressable
      onPress={() => router.push({ pathname: '/students', params: { quick: 'approval_waiting' } } as unknown as Href)}
      style={({ pressed }) => [styles.card, pressed && styles.pressed]}
      accessibilityRole="button"
    >
      <Text style={styles.icon}>🎓</Text>
      <View style={styles.flex}>
        <Text style={styles.title}>
          {waiting} {waiting === 1 ? 'student' : 'students'} waiting for approval (admission / registration)
        </Text>
        <Text style={styles.text}>Check and approve, or send back to fix</Text>
      </View>
      <Text style={styles.chevron}>›</Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1 },
  card: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
    padding: spacing.lg,
    borderRadius: radius.lg,
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.warning,
  },
  pressed: { opacity: 0.8 },
  icon: { fontSize: 26 },
  title: { fontSize: fontSize.body, fontWeight: fontWeight.bold, color: colors.text },
  text: { fontSize: fontSize.caption, color: colors.textMuted },
  chevron: { fontSize: 22, color: colors.textMuted },
});
