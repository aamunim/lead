import { DarkTheme, DefaultTheme, Stack, ThemeProvider, usePathname, type ErrorBoundaryProps } from 'expo-router';
import * as SplashScreen from 'expo-splash-screen';
import { StatusBar } from 'expo-status-bar';
import { useEffect } from 'react';
import { Platform, StyleSheet, Text, View } from 'react-native';
import { KeyboardProvider } from 'react-native-keyboard-controller';

import { AuthProvider, useAuth } from '@/features/auth/AuthProvider';
import { CrashScreen } from '@/features/feedback/CrashScreen';
import { flushCrashes, installCrashHandler, setCrashScreen } from '@/features/feedback/crash';
import { onThreeFingers } from '@/features/feedback/screenShot';
import { clearNativeCallLock } from '@/features/calls/callLock';
import { colors, isDark } from '@/shared/theme';
import { DisclosureHost } from '@/shared/ui/Disclosure';
import { ThemeFollower } from '@/features/settings/appearance';
import { UpdateBanner } from '@/features/updates/UpdateBanner';
import { OfflineBanner } from '@/shared/ui/OfflineBanner';
import { WebAlertHost, installWebAlert } from '@/shared/web/WebAlert';
import { installStaleBuildReload, reloadForNewVersion } from '@/shared/web/staleBuild';
// 🌐 Read the address before the router changes it (reload keeps the page)
import '@/shared/web/bootUrl';

SplashScreen.preventAutoHideAsync();

// 🌐 Website: Alert.alert shows our own dialog (a browser shows nothing)
if (Platform.OS === 'web') installWebAlert();

// 💥 Errors go to the developer by themselves (Contact developer → inbox → Crashes)
if (Platform.OS !== 'web') installCrashHandler();

/** 💥 A screen broke: shown in its place (the error is sent by itself) */
// 🌐 A newer website version while this tab was open: load the page again
installStaleBuildReload();

export function ErrorBoundary({ error, retry }: ErrorBoundaryProps) {
  if (reloadForNewVersion(error)) {
    return (
      <View style={[styles.root, styles.updating]}>
        <Text style={styles.updatingText}>Updating to the new version…</Text>
      </View>
    );
  }
  return <CrashScreen error={error} retry={retry} />;
}

const NAV_THEME = {
  ...(isDark ? DarkTheme : DefaultTheme),
  dark: isDark,
  colors: {
    ...(isDark ? DarkTheme : DefaultTheme).colors,
    primary: colors.primary,
    background: colors.background,
    card: colors.surface,
    text: colors.text,
    border: colors.border,
  },
};

// The visitor opened lead.ittc.edu.bd/apply, /refer/<code> or /update/<token> (website only)
const OPENED_PUBLIC_FORM =
  Platform.OS === 'web' && typeof window !== 'undefined' && /^\/(apply|refer\/|update\/)/.test(window.location.pathname);

export default function RootLayout() {
  return (
    // 🌙 Screens, headers and the tab bar take the app's light / dark colours
    <ThemeProvider value={NAV_THEME}>
      {/* Keeps the field you type in above the keyboard (all screens and sheets) */}
      <KeyboardProvider>
        <AuthProvider>
          <RootNavigator />
          <DisclosureHost />
        </AuthProvider>
      </KeyboardProvider>
    </ThemeProvider>
  );
}

function RootNavigator() {
  const { status } = useAuth();

  // 💥 Which screen is open goes with a crash report; waiting reports are sent once signed in
  const pathname = usePathname();
  useEffect(() => {
    setCrashScreen(pathname);
  }, [pathname]);
  useEffect(() => {
    if (status === 'active' && Platform.OS !== 'web') flushCrashes().catch(() => undefined);
    // 📵 Signed out: this phone stops marking calls for the old user
    if (status === 'signed_out') clearNativeCallLock();
  }, [status]);

  useEffect(() => {
    if (status !== 'loading') SplashScreen.hideAsync();
  }, [status]);

  useEffect(() => {
    const timer = setTimeout(() => SplashScreen.hideAsync(), 5000);
    return () => clearTimeout(timer);
  }, []);

  return (
    // 📸 Three fingers anywhere (signed in): send this screen to the developer
    <View style={styles.root} onTouchStart={status === 'active' && Platform.OS !== 'web' ? onThreeFingers : undefined}>
      <StatusBar style={isDark ? 'light' : 'dark'} />
      {/* 🌙 "System" colours: follow the phone when it switches light / dark */}
      <ThemeFollower />
      <Stack screenOptions={{ headerShown: false, contentStyle: { backgroundColor: colors.background } }}>
        <Stack.Protected guard={status === 'loading'}>
          <Stack.Screen name="loading" />
        </Stack.Protected>
        <Stack.Protected guard={status === 'error'}>
          <Stack.Screen name="error" />
        </Stack.Protected>
        <Stack.Protected guard={status === 'needs_setup'}>
          <Stack.Screen name="setup" />
        </Stack.Protected>
        <Stack.Protected guard={status === 'signed_out'}>
          <Stack.Screen name="login" />
          <Stack.Screen name="sign-up" options={{ animation: 'slide_from_right' }} />
        </Stack.Protected>
        <Stack.Protected guard={status === 'pending_approval'}>
          <Stack.Screen name="pending" />
        </Stack.Protected>
        <Stack.Protected guard={status === 'must_change_password'}>
          <Stack.Screen name="change-password" />
        </Stack.Protected>
        <Stack.Protected guard={status === 'active'}>
          <Stack.Screen name="(app)" />
        </Stack.Protected>
        {/* 🗑 Delete my account: open to everyone (Google Play asks for a web link too) */}
        <Stack.Screen name="delete-account" />
        <Stack.Screen name="privacy" />
        {/* 🔗 Public forms (website only): an alumnus's link, and the interested-person form.
            ⚠️ Open ONLY when the visitor came with such a link. expo-router falls back to
            the first open route in A–Z order ("apply" comes right after "(app)"), so an
            always-open form caught everyone on start (app and website, 7 Nov). */}
        <Stack.Protected guard={OPENED_PUBLIC_FORM}>
          <Stack.Screen name="refer/[code]" />
          <Stack.Screen name="apply" />
          <Stack.Screen name="update/[token]" />
        </Stack.Protected>
      </Stack>
      {/* 📵 No internet: shown over every screen */}
      <OfflineBanner />
      {/* 🔄 A new version downloaded (EAS Update) */}
      <UpdateBanner />
      {Platform.OS === 'web' && <WebAlertHost />}
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  updating: { alignItems: 'center', justifyContent: 'center', backgroundColor: colors.background },
  updatingText: { fontSize: 16, color: colors.textMuted },
});
