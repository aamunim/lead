import { Stack } from 'expo-router';

import { ActivityTracker } from '@/features/activity/ActivityTracker';
import { PushSetup } from '@/features/notifications/PushSetup';
import { colors, fontWeight } from '@/shared/theme';
import { isWeb } from '@/features/web/api';
import { WebShell } from '@/features/web/WebShell';

export default function AppLayout() {
  const stack = (
    <Stack
      screenOptions={{
        // 🌐 Website: a light header under its own top bar
        headerStyle: { backgroundColor: isWeb ? colors.surface : colors.primary },
        headerTintColor: isWeb ? colors.primary : colors.textOnPrimary,
        headerTitleStyle: { fontWeight: fontWeight.bold },
        headerBackTitle: 'Back',
        contentStyle: { backgroundColor: colors.background },
        animation: 'slide_from_right',
      }}
    >
      {/* Tabs: Home and Leads */}
      <Stack.Screen name="(tabs)" options={{ headerShown: false }} />

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
      {stack}
    </ActivityTracker>
  );
}
