import { Stack, type ErrorBoundaryProps } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { ActivityTracker } from '@/features/activity/ActivityTracker';
import { CrashScreen } from '@/features/feedback/CrashScreen';
import { useAuth } from '@/features/auth/AuthProvider';
import { setupNativeCallLock } from '@/features/calls/callLock';
import { useEffect } from 'react';
import { PushSetup } from '@/features/notifications/PushSetup';
import { WhatsNewOnUpdate } from '@/features/updates/WhatsNewSheet';
import { colors, fontWeight } from '@/shared/theme';
import { isWeb } from '@/features/web/api';
import { WebShell } from '@/features/web/WebShell';

/** 💥 A page broke: shown in its place, the rest of the app keeps working */
export function ErrorBoundary({ error, retry }: ErrorBoundaryProps) {
  return <CrashScreen error={error} retry={retry} />;
}

export default function AppLayout() {
  // Pages outside the tabs end above the phone's ◁ ○ □ buttons (the tabs do this themselves)
  const insets = useSafeAreaInsets();
  const stack = (
    <Stack
      screenOptions={{
        // 🌐 Website: a light header under its own top bar
        headerStyle: { backgroundColor: isWeb ? colors.surface : colors.primary },
        headerTintColor: isWeb ? colors.primary : colors.textOnPrimary,
        headerTitleStyle: { fontWeight: fontWeight.bold },
        headerBackTitle: 'Back',
        contentStyle: { backgroundColor: colors.background, paddingBottom: isWeb ? 0 : insets.bottom },
        animation: 'slide_from_right',
      }}
    >
      {/* Tabs: Home and Leads */}
      <Stack.Screen
        name="(tabs)"
        options={{ headerShown: false, contentStyle: { backgroundColor: colors.background } }}
      />

      {/* Leads */}
      <Stack.Screen name="leads/[id]" options={{ title: 'Lead' }} />
      <Stack.Screen name="leads/edit/[id]" options={{ title: 'Lead' }} />

      {/* Users */}
      <Stack.Screen name="users/index" options={{ title: 'Users' }} />
      <Stack.Screen name="users/[id]" options={{ title: 'User' }} />

      {/* Settings */}
      <Stack.Screen name="settings/index" options={{ title: 'Settings' }} />
      <Stack.Screen name="settings/list/[table]" options={{ title: 'Settings' }} />
      <Stack.Screen name="settings/courses/index" options={{ title: 'Courses & batches' }} />
      <Stack.Screen name="settings/courses/[id]" options={{ title: 'Course' }} />
      <Stack.Screen name="settings/calendar" options={{ title: 'Working days & holidays' }} />
    </Stack>
  );

  // 🌐 Website: a menu on the left, no phone push
  if (isWeb) {
    return (
      <ActivityTracker>
        <WebShell>{stack}</WebShell>
      </ActivityTracker>
    );
  }

  return (
    // Time spent in the app (Settings → Team activity)
    <ActivityTracker>
      {/* Phone push: token, taps, app icon number */}
      <PushSetup />
      {/* 📵 Call lock: this phone's part (2.8.0) */}
      <CallLockSetup />
      {stack}
      {/* 🆕 After an update: what changed (once) */}
      <WhatsNewOnUpdate />
    </ActivityTracker>
  );
}

function CallLockSetup() {
  const { profile } = useAuth();
  useEffect(() => {
    if (profile?.id) setupNativeCallLock(profile.id);
  }, [profile?.id]);
  return null;
}
