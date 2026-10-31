import { useEffect, useRef, useState } from 'react';
import { Platform, Pressable, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { checkNow, isOnline, onNetworkChange } from '@/shared/lib/network';
import { colors, fontSize, fontWeight, spacing } from '@/shared/theme';

// =====================================================================
// 📵 "No internet" strip at the top (just below the screen title)
//   Stays while the server can't be reached; "✓ Back online" for a moment after.
// =====================================================================

const HEADER = 56; // height of the screen title bar
const BACK_ONLINE_MS = 2500;

export function OfflineBanner() {
  const insets = useSafeAreaInsets();
  const [online, setOnline] = useState(isOnline());
  const [backOnline, setBackOnline] = useState(false);
  const [checking, setChecking] = useState(false);
  const hideTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    const off = onNetworkChange((now) => {
      setOnline(now);
      if (hideTimer.current) clearTimeout(hideTimer.current);
      if (now) {
        setBackOnline(true);
        hideTimer.current = setTimeout(() => setBackOnline(false), BACK_ONLINE_MS);
      } else {
        setBackOnline(false);
      }
    });
    return () => {
      off();
      if (hideTimer.current) clearTimeout(hideTimer.current);
    };
  }, []);

  if (online && !backOnline) return null;

  const retry = async () => {
    setChecking(true);
    await checkNow();
    setChecking(false);
  };

  return (
    <View pointerEvents="box-none" style={[styles.wrap, { top: insets.top + HEADER }]}>
      {online ? (
        <View style={[styles.bar, styles.barOk]} accessibilityLiveRegion="polite">
          <Text style={styles.title}>✓ Back online</Text>
        </View>
      ) : (
        <View style={[styles.bar, styles.barOff]} accessibilityLiveRegion="assertive">
          <View style={styles.flex}>
            <Text style={styles.title}>📵 No internet: changes can’t be saved right now</Text>
            {Platform.OS !== 'web' && (
              <Text style={styles.text}>Calls stay on this phone and sync when the internet is back.</Text>
            )}
          </View>
          <Pressable onPress={retry} hitSlop={8} disabled={checking} accessibilityRole="button">
            <Text style={styles.retry}>{checking ? '…' : 'Retry'}</Text>
          </Pressable>
        </View>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1 },
  wrap: { position: 'absolute', left: 0, right: 0, zIndex: 1000, elevation: 1000 },
  bar: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
    paddingVertical: spacing.sm,
    paddingHorizontal: spacing.lg,
  },
  barOff: { backgroundColor: colors.danger },
  barOk: { backgroundColor: colors.success, justifyContent: 'center' },
  title: { fontSize: fontSize.small, fontWeight: fontWeight.bold, color: colors.textOnPrimary },
  text: { fontSize: fontSize.caption, color: colors.textOnPrimary, marginTop: 1 },
  retry: {
    fontSize: fontSize.small,
    fontWeight: fontWeight.bold,
    color: colors.textOnPrimary,
    textDecorationLine: 'underline',
  },
});
