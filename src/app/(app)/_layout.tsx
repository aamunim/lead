import { Stack } from 'expo-router';

import { ActivityTracker } from '@/features/activity/ActivityTracker';
import { PushSetup } from '@/features/notifications/PushSetup';
import { colors, fontWeight } from '@/shared/theme';

export default function AppLayout() {
  return (
    // Time spent in the app (Settings → Team activity)
    <ActivityTracker>
      {/* Phone push: token, taps, app icon number */}
      <PushSetup />
      <Stack
        screenOptions={{
          headerStyle: { backgroundColor: colors.primary },
          headerTintColor: colors.textOnPrimary,
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
    </ActivityTracker>
  );
}