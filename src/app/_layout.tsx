import { Stack } from 'expo-router';
import * as SplashScreen from 'expo-splash-screen';
import { StatusBar } from 'expo-status-bar';
import { useEffect } from 'react';
import { Platform } from 'react-native';
import { KeyboardProvider } from 'react-native-keyboard-controller';

import { AuthProvider, useAuth } from '@/features/auth/AuthProvider';
import { colors } from '@/shared/theme';
import { UpdateBanner } from '@/features/updates/UpdateBanner';
import { OfflineBanner } from '@/shared/ui/OfflineBanner';
import { WebAlertHost, installWebAlert } from '@/shared/web/WebAlert';
// 🌐 Read the address before the router changes it (reload keeps the page)
import '@/shared/web/bootUrl';

SplashScreen.preventAutoHideAsync();

// 🌐 Website: Alert.alert shows our own dialog (a browser shows nothing)
if (Platform.OS === 'web') installWebAlert();

export default function RootLayout() {
  return (
    // Keeps the field you type in above the keyboard (all screens and sheets)
    <KeyboardProvider>
      <AuthProvider>
        <RootNavigator />
      </AuthProvider>
    </KeyboardProvider>
  );
}

function RootNavigator() {
  const { status } = useAuth();

  useEffect(() => {
    if (status !== 'loading') SplashScreen.hideAsync();
  }, [status]);

  useEffect(() => {
    const timer = setTimeout(() => SplashScreen.hideAsync(), 5000);
    return () => clearTimeout(timer);
  }, []);

  return (
    <>
      <StatusBar style="dark" />
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
      </Stack>
      {/* 📵 No internet: shown over every screen */}
      <OfflineBanner />
      {/* 🔄 A new version downloaded (EAS Update) */}
      <UpdateBanner />
      {Platform.OS === 'web' && <WebAlertHost />}
    </>
  );
}