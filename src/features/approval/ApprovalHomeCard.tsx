import { router, type Href } from 'expo-router';
import { getHomeSummary } from '@/features/home/summary';
import { startOfDay } from '@/features/follow-ups/api';
import { useSavedState } from '@/shared/lib/saved';
import { useFocusRefresh } from '@/shared/lib/useFocusRefresh';
import { useCallback, useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';

import { canApprove, countIttcWork, getApprovalSettings } from '@/features/approval/api';
import { useAuth } from '@/features/auth/AuthProvider';
import { MIcon, Tap, md, type MIconName } from '@/features/home/md';
import { fontSize, fontWeight } from '@/shared/theme';

// 🏛 Home: the Admission Officer's work (only when there is some)
//   📤 not submitted yet · 🏛 admission fee paid, ready for ITTC
export function ApprovalHomeCard() {
  const { profile, hasPermission } = useAuth();
  const isAdmin = hasPermission('settings.manage');
  const { sharedMode } = useAuth();
  // ⚡ last time's numbers at once, then the fresh ones
  const [work, setWork] = useSavedState('home:ittc', { notSubmitted: 0, ready: 0 });

  useFocusRefresh(
    useCallback(() => {
      let live = true;
      getApprovalSettings()
        .then(async (s) => {
          if (!canApprove(s, profile, isAdmin)) return { notSubmitted: 0, ready: 0 };
          // ⚡ from Home's numbers (one request for all the cards); else as before
          const team = sharedMode || hasPermission('leads.view_all');
          const sum = await getHomeSummary(team ? null : (profile?.id ?? null), startOfDay(new Date()).toISOString());
          return sum ? { notSubmitted: sum.ittc_not_submitted, ready: sum.ittc_ready } : countIttcWork();
        })
        .then((n) => live && setWork(n))
        .catch(() => undefined);
      return () => {
        live = false;
      };
    }, [profile, isAdmin, sharedMode, hasPermission, setWork]),
  );

  if (work.notSubmitted === 0 && work.ready === 0) return null;
  const open = (quick: string) => router.push({ pathname: '/students', params: { quick } } as unknown as Href);
  return (
    <View>
      {work.ready > 0 && (
        <Line
          icon="account-balance"
          text={`${work.ready} ready for ITTC (admission fee paid)`}
          onPress={() => open('ittc_ready')}
        />
      )}
      {work.notSubmitted > 0 && (
        <Line
          icon="upload"
          text={`${work.notSubmitted} not submitted online yet`}
          onPress={() => open('not_submitted')}
        />
      )}
    </View>
  );
}

function Line({ icon, text, onPress }: { icon: MIconName; text: string; onPress: () => void }) {
  return (
    <Tap onPress={onPress} style={styles.line} label={`${text}. Review`}>
      <MIcon name={icon} size={20} color={md.onWarnC} />
      <Text style={styles.text} numberOfLines={1}>
        {text}
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
  text: { flex: 1, fontSize: 13.5, fontWeight: fontWeight.medium, color: md.warnText },
  action: { fontSize: fontSize.caption, fontWeight: fontWeight.bold, color: md.onWarnC },
});
