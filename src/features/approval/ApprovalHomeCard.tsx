import { router, useFocusEffect, type Href } from 'expo-router';
import { useCallback, useState } from 'react';
import { StyleSheet, Text } from 'react-native';

import { canApprove, countWaitingApproval, getApprovalSettings } from '@/features/approval/api';
import { useAuth } from '@/features/auth/AuthProvider';
import { MIcon, Tap, md } from '@/features/home/md';
import { fontSize, fontWeight } from '@/shared/theme';

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
    <Tap
      onPress={() => router.push({ pathname: '/students', params: { quick: 'approval_waiting' } } as unknown as Href)}
      style={styles.line}
      label={`${waiting} waiting for approval. Review`}
    >
      <MIcon name="pending-actions" size={20} color={md.onWarnC} />
      <Text style={styles.text} numberOfLines={1}>
        {waiting} {waiting === 1 ? 'student' : 'students'} waiting for approval
      </Text>
      <Text style={styles.action}>Review</Text>
    </Tap>
  );
}

const styles = StyleSheet.create({
  line: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    height: 42,
    marginTop: 10,
    paddingLeft: 12,
    paddingRight: 14,
    borderRadius: 12,
    backgroundColor: md.warnC,
    overflow: 'hidden',
  },
  text: { flex: 1, fontSize: 13.5, fontWeight: fontWeight.medium, color: '#2C1600' },
  action: { fontSize: fontSize.caption, fontWeight: fontWeight.bold, color: md.onWarnC },
});
