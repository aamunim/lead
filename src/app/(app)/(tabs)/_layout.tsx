import { Tabs } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useEffect, useRef, useState } from 'react';
import { Animated, AppState, Dimensions, Pressable, StyleSheet, View, type PressableProps } from 'react-native';

import { useAuth } from '@/features/auth/AuthProvider';
import { MIcon, md, type MIconName } from '@/features/home/md';
import { canSeeStudents, getStudentsSettings } from '@/features/students/api';
import { colors, fontWeight } from '@/shared/theme';
import { isWeb } from '@/features/web/api';

export default function TabsLayout() {
  const { profile, hasPermission } = useAuth();
  const isAdmin = hasPermission('settings.manage');
  // The phone's own navigation (3 buttons or the gesture line) sits under the tab bar
  const insets = useSafeAreaInsets();

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
        // ✨ Tab change: the whole page slides (springy, like turning pages)
        sceneStyleInterpolator: pageSlide,
        transitionSpec: { animation: 'spring', config: { stiffness: 260, damping: 30, mass: 1 } },
        tabBarActiveTintColor: md.onPrimaryC,
        tabBarInactiveTintColor: colors.textMuted,
        // 🌐 Website: the menu on the left replaces the tabs
        tabBarStyle: isWeb
          ? { display: 'none' }
          : {
              backgroundColor: md.surface1,
              borderTopWidth: 0,
              elevation: 0,
              paddingTop: 8,
              // room for the phone's ◁ ○ □ buttons (or the gesture line) below the tabs
              paddingBottom: Math.max(insets.bottom, 8),
              height: 64 + Math.max(insets.bottom, 8),
            },
        tabBarLabelStyle: { fontSize: 12, fontWeight: fontWeight.semibold, marginTop: 2 },
        tabBarActiveBackgroundColor: 'transparent',
        tabBarButton: (props) => (
          <Pressable
            {...(props as PressableProps)}
            android_ripple={{ color: 'rgba(53,87,212,0.10)', borderless: true, radius: 44 }}
          />
        ),
        // 🌐 Website: its own top bar replaces the blue header
        ...(isWeb ? { headerShown: false } : {}),
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
          tabBarIcon: ({ focused }) => <PillIcon focused={focused} on="home-filled" off="home" />,
        }}
      />
      <Tabs.Screen
        name="leads"
        options={{
          title: 'Leads',
          tabBarIcon: ({ focused }) => <PillIcon focused={focused} on="people" off="people-outline" />,
        }}
      />
      <Tabs.Screen
        name="students"
        options={{
          title: 'Students',
          href: studentsTab ? undefined : null,
          tabBarIcon: ({ focused }) => <PillIcon focused={focused} on="school" off="school" />,
        }}
      />
      <Tabs.Screen
        name="more"
        options={{
          title: 'More',
          // its own Material top bar (🔔 ⚙️)
          headerShown: false,
          tabBarIcon: ({ focused }) => <PillIcon focused={focused} on="menu" off="menu" />,
        }}
      />
    </Tabs>
  );
}

/**
 * The whole page slides: the new tab's page comes in from its side while
 * the old one slides out the other way (like turning pages), with a
 * light fade at the far ends so the edges never look hard.
 */
function pageSlide({ current }: { current: { progress: Animated.AnimatedInterpolation<number> } }) {
  const w = Dimensions.get('window').width;
  const p = current.progress;
  return {
    sceneStyle: {
      opacity: p.interpolate({ inputRange: [-1, -0.85, 0, 0.85, 1], outputRange: [0, 0.6, 1, 0.6, 0] }),
      transform: [{ translateX: p.interpolate({ inputRange: [-1, 0, 1], outputRange: [-w, 0, w] }) }],
    },
  };
}

/** Material 3 navigation bar icon: the pill springs in, the icon pops */
function PillIcon({ focused, on, off }: { focused: boolean; on: MIconName; off: MIconName }) {
  const grow = useRef(new Animated.Value(focused ? 1 : 0)).current;
  const pop = useRef(new Animated.Value(1)).current;
  useEffect(() => {
    Animated.spring(grow, { toValue: focused ? 1 : 0, useNativeDriver: true, speed: 16, bounciness: 8 }).start();
    if (focused) {
      pop.setValue(0.7);
      Animated.spring(pop, { toValue: 1, useNativeDriver: true, speed: 14, bounciness: 14 }).start();
    }
  }, [focused, grow, pop]);
  return (
    <View style={styles.pillBox}>
      <Animated.View
        style={[
          styles.pill,
          {
            opacity: grow,
            transform: [{ scaleX: grow.interpolate({ inputRange: [0, 1], outputRange: [0.3, 1] }) }],
          },
        ]}
      />
      <Animated.View
        style={{
          transform: [
            { scale: pop },
            { translateY: pop.interpolate({ inputRange: [0.7, 1, 1.2], outputRange: [2, 0, -2] }) },
          ],
        }}
      >
        <MIcon name={focused ? on : off} size={24} color={focused ? md.onPrimaryC : colors.textMuted} />
      </Animated.View>
    </View>
  );
}

const styles = StyleSheet.create({
  pillBox: { width: 64, height: 32, alignItems: 'center', justifyContent: 'center' },
  pill: { position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, borderRadius: 16, backgroundColor: md.primaryC },
});
