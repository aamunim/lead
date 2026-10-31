import { Ionicons } from '@expo/vector-icons';
import { Tabs } from 'expo-router';
import { useEffect, useState } from 'react';
import { AppState } from 'react-native';

import { useAuth } from '@/features/auth/AuthProvider';
import { canSeeStudents, getStudentsSettings } from '@/features/students/api';
import { colors, fontWeight } from '@/shared/theme';
import { isWeb } from '@/features/web/api';

export default function TabsLayout() {
  const { profile, hasPermission } = useAuth();
  const isAdmin = hasPermission('settings.manage');

  // 🎓 Students tab: Settings → Students decides who sees it
  const [studentsTab, setStudentsTab] = useState(false);
  useEffect(() => {
    const check = () =>
      getStudentsSettings()
        .then((s) => setStudentsTab(canSeeStudents(s, profile, isAdmin)))
        .catch(() => undefined);
    check();
    const sub = AppState.addEventListener('change', (state) => state === 'active' && check());
    return () => sub.remove();
  }, [profile, isAdmin]);

  return (
    <Tabs
      screenOptions={{
        tabBarActiveTintColor: colors.primary,
        tabBarInactiveTintColor: colors.textMuted,
        // 🌐 Website: the menu on the left replaces the tabs
        tabBarStyle: isWeb ? { display: 'none' } : { backgroundColor: colors.surface, borderTopColor: colors.border },
        tabBarLabelStyle: { fontWeight: fontWeight.semibold },
        headerStyle: { backgroundColor: colors.primary },
        headerTintColor: colors.textOnPrimary,
        headerTitleStyle: { fontWeight: fontWeight.bold },
      }}
    >
      <Tabs.Screen
        name="index"
        options={{
          title: 'Home',
          headerShown: false,
          tabBarIcon: ({ color, size, focused }) => (
            <Ionicons name={focused ? 'home' : 'home-outline'} color={color} size={size} />
          ),
        }}
      />
      <Tabs.Screen
        name="leads"
        options={{
          title: 'Leads',
          tabBarIcon: ({ color, size, focused }) => (
            <Ionicons name={focused ? 'people' : 'people-outline'} color={color} size={size} />
          ),
        }}
      />
      <Tabs.Screen
        name="students"
        options={{
          title: 'Students',
          href: studentsTab ? undefined : null,
          tabBarIcon: ({ color, size, focused }) => (
            <Ionicons name={focused ? 'school' : 'school-outline'} color={color} size={size} />
          ),
        }}
      />
      <Tabs.Screen
        name="more"
        options={{
          title: 'More',
          tabBarIcon: ({ color, size, focused }) => (
            <Ionicons name={focused ? 'menu' : 'menu-outline'} color={color} size={size} />
          ),
        }}
      />
    </Tabs>
  );
}