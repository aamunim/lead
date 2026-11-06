import { DarkTheme, DefaultTheme, Stack, ThemeProvider, usePathname, type ErrorBoundaryProps } from 'expo-router';
import * as SplashScreen from 'expo-splash-screen';
import { StatusBar } from 'expo-status-bar';
import { useEffect } from 'react';
import { Platform, StyleSheet, View } from 'react-native';
import { KeyboardProvider } from 'react-native-keyboard-controller';

import { AuthProvider, useAuth } from '@/features/auth/AuthProvider';
import { CrashScreen } from '@/features/feedback/CrashScreen';
import { flushCrashes, installCrashHandler, setCrashScreen } from '@/features/feedback/crash';
import { onThreeFingers } from '@/features/feedback/screenShot';
import { clearNativeCallLock } from '@/features/calls/callLock';
import { colors, isDark } from '@/shared/theme';
import { ThemeFollower } from '@/features/settings/appearance';
import { UpdateBanner } from '@/features/updates/UpdateBanner';
import { OfflineBanner } from '@/shared/ui/OfflineBanner';
import { WebAlertHost, installWebAlert } from '@/shared/web/WebAlert';
// 🌐 Read the address before the router changes it (reload keeps the page)
import '@/shared/web/bootUrl';

SplashScreen.preventAutoHideAsync();

// 🌐 Website: Alert.alert shows our own dialog (a browser shows nothing)
if (Platform.OS === 'web') installWebAlert();

// 💥 Errors go to the developer by themselves (Contact developer → inbox → Crashes)
if (Platform.OS !== 'web') installCrashHandler();

/** 💥 A screen broke: shown in its place (the error is sent by itself) */
export function ErrorBoundary({ error, retry }: ErrorBoundaryProps) {
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

export default function RootLayout() {
  return (
    // 🌙 Screens, headers and the tab bar take the app's light / dark colours
    <ThemeProvider value={NAV_THEME}>
      {/* Keeps the field you type in above the keyboard (all screens and sheets) */}
      <KeyboardProvider>
        <AuthProvider>
          <RootNavigator />
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
      </Stack>
      {/* 📵 No internet: shown over every screen */}
      <OfflineBanner />
      {/* 🔄 A new version downloaded (EAS Update) */}
      <UpdateBanner />
      {Platform.OS === 'web' && <WebAlertHost />}
    </View>
  );
}

const styles = StyleSheet.create({ root: { flex: 1 } });