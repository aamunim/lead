import { useState } from 'react';
import { Linking, Platform, Pressable, StyleSheet, Text, View } from 'react-native';

import { colors, fontSize, fontWeight, radius, spacing } from '@/shared/theme';

// =====================================================================
// 📲 "Update from the Play Store": an app installed before 2.8.4 has no
//   Google (Firebase) part, so it can never get push notifications. An
//   App update (OTA) can't add it: only a new install from the Play Store.
//   The version here is the one on the phone (the native app), not the
//   JavaScript one (an App update changes that).
// =====================================================================

/** The first app version that has the Firebase part (push) */
export const MIN_NATIVE_FOR_PUSH = '2.8.4';
const PACKAGE = 'com.abamunim.leads';

// expo-application comes with expo-notifications (in every build)
let nativeVersion: string | null = null;
try {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  nativeVersion = require('expo-application').nativeApplicationVersion ?? null;
} catch {
  nativeVersion = null;
}

/** "2.8.1" (the installed app), or null when unknown / website */
export function installedAppVersion(): string | null {
  return Platform.OS === 'web' ? null : nativeVersion;
}

/** -1 / 0 / 1, like 2.8.1 vs 2.8.4 */
export function compareVersions(a: string, b: string): number {
  const pa = a.split('.').map((n) => parseInt(n, 10) || 0);
  const pb = b.split('.').map((n) => parseInt(n, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d !== 0) return d < 0 ? -1 : 1;
  }
  return 0;
}

/** This phone's app is too old for push (Android only) */
export function needsStoreUpdate(): boolean {
  if (Platform.OS !== 'android') return false;
  const v = installedAppVersion();
  return !!v && compareVersions(v, MIN_NATIVE_FOR_PUSH) < 0;
}

/** Firebase error text → the app is too old */
export function isMissingFirebase(error: string | null | undefined): boolean {
  return !!error && /FirebaseApp|Firebase Messaging|googleServicesFile/i.test(error);
}

export async function openPlayStore(): Promise<void> {
  try {
    await Linking.openURL(`market://details?id=${PACKAGE}`);
  } catch {
    await Linking.openURL(`https://play.google.com/store/apps/details?id=${PACKAGE}`).catch(() => undefined);
  }
}

/** The card (Home and Notification check). `always`: not hideable */
export function StoreUpdateCard({ always = false }: { always?: boolean }) {
  const [hidden, setHidden] = useState(false);
  if (!needsStoreUpdate() || (hidden && !always)) return null;
  return (
    <View style={styles.card} accessibilityRole="alert">
      <Text style={styles.title}>📲 Update the app from the Play Store</Text>
      <Text style={styles.text}>
        Your app ({installedAppVersion()}) is missing the part notifications need, so you get no notifications. Install
        version {MIN_NATIVE_FOR_PUSH} or newer from the Play Store. Your leads and calls stay as they are.
      </Text>
      <View style={styles.row}>
        <Pressable onPress={openPlayStore} style={styles.btn} accessibilityRole="button">
          <Text style={styles.btnText}>Open Play Store</Text>
        </Pressable>
        {!always && (
          <Pressable onPress={() => setHidden(true)} hitSlop={8} accessibilityRole="button">
            <Text style={styles.later}>Later</Text>
          </Pressable>
        )}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  card: {
    gap: spacing.xs,
    padding: spacing.md,
    borderRadius: radius.lg,
    borderWidth: 1,
    borderColor: colors.warning,
    backgroundColor: colors.surface,
  },
  title: { fontSize: fontSize.body, fontWeight: fontWeight.bold, color: colors.text },
  text: { fontSize: fontSize.small, color: colors.text, lineHeight: 20 },
  row: { flexDirection: 'row', alignItems: 'center', gap: spacing.lg, marginTop: spacing.xs },
  btn: {
    paddingVertical: spacing.sm,
    paddingHorizontal: spacing.lg,
    borderRadius: radius.md,
    backgroundColor: colors.primary,
  },
  btnText: { color: colors.textOnPrimary, fontWeight: fontWeight.bold, fontSize: fontSize.small },
  later: { color: colors.textMuted, fontWeight: fontWeight.bold, fontSize: fontSize.small },
});
