import { useEffect, useState } from 'react';
import { AppState, Pressable, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { Updates, checkAndDownload, restartWithUpdate } from '@/features/updates/api';
import { colors, fontSize, fontWeight, radius, spacing } from '@/shared/theme';

// =====================================================================
// 🔄 "A new version is ready · Restart" at the bottom of the screen
//   Shown once an update is downloaded. "Later" hides it; the update then
//   starts by itself the next time the app is opened.
// =====================================================================

// Nothing at all in builds without expo-updates (older APKs / dev client)
export const UpdateBanner = Updates ? Banner : () => null;

function Banner() {
  const insets = useSafeAreaInsets();
  const { isUpdatePending } = Updates!.useUpdates();
  const [hidden, setHidden] = useState(false);
  const [restarting, setRestarting] = useState(false);

  // Back in the app after a while: look again
  useEffect(() => {
    const sub = AppState.addEventListener('change', (state) => {
      if (state === 'active') checkAndDownload();
    });
    return () => sub.remove();
  }, []);

  if (!isUpdatePending || hidden) return null;

  return (
    <View pointerEvents="box-none" style={[styles.wrap, { bottom: insets.bottom + 70 }]}>
      <View style={styles.bar} accessibilityLiveRegion="polite">
        <Text style={styles.icon}>🔄</Text>
        <Text style={styles.text}>A new version of the app is ready.</Text>
        <Pressable onPress={() => setHidden(true)} hitSlop={8} accessibilityRole="button">
          <Text style={styles.later}>Later</Text>
        </Pressable>
        <Pressable
          onPress={() => {
            setRestarting(true);
            restartWithUpdate().catch(() => setRestarting(false));
          }}
          disabled={restarting}
          style={styles.btn}
          accessibilityRole="button"
        >
          <Text style={styles.btnText}>{restarting ? '…' : 'Restart'}</Text>
        </Pressable>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { position: 'absolute', left: spacing.md, right: spacing.md },
  bar: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    padding: spacing.md,
    borderRadius: radius.lg,
    backgroundColor: colors.text,
    shadowColor: '#000',
    shadowOpacity: 0.2,
    shadowRadius: 8,
    shadowOffset: { width: 0, height: 3 },
    elevation: 6,
  },
  icon: { fontSize: fontSize.body },
  text: { flex: 1, fontSize: fontSize.small, fontWeight: fontWeight.semibold, color: colors.surface },
  later: { fontSize: fontSize.small, color: colors.surface, opacity: 0.8 },
  btn: { paddingVertical: 6, paddingHorizontal: spacing.md, borderRadius: radius.pill, backgroundColor: colors.primary },
  btnText: { fontSize: fontSize.small, fontWeight: fontWeight.bold, color: colors.textOnPrimary },
});
