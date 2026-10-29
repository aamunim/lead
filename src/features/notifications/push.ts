import AsyncStorage from '@react-native-async-storage/async-storage';
import Constants from 'expo-constants';
import * as Device from 'expo-device';
import * as Notifications from 'expo-notifications';
import { Platform } from 'react-native';

import { getDeviceId } from '@/features/call-sync/api';
import { supabase } from '@/shared/lib/supabase';

// =====================================================================
// 📲 Phone push (expo-notifications)
//   - asks for permission once, makes the Android channel "leads"
//   - saves this phone's push token for the signed-in user
//   - the database sends the pushes (notify() → Expo push service)
// =====================================================================

const TOKEN_KEY = 'push.token';

/** The channel the database sends to (channelId 'leads') */
const CHANNEL_ID = 'leads';

// While the app is open, still show the banner (the 🔔 list updates too)
Notifications.setNotificationHandler({
  handleNotification: async () => ({
    shouldShowBanner: true,
    shouldShowList: true,
    shouldPlaySound: true,
    shouldSetBadge: true,
  }),
});

async function ensureChannel() {
  if (Platform.OS !== 'android') return;
  await Notifications.setNotificationChannelAsync(CHANNEL_ID, {
    name: 'Leads',
    description: 'Leads given to you, next calls, visits and other alerts',
    importance: Notifications.AndroidImportance.MAX,
    vibrationPattern: [0, 250, 250, 250],
    lockscreenVisibility: Notifications.AndroidNotificationVisibility.PRIVATE,
  });
}

export type PushPermission = 'granted' | 'denied' | 'undetermined';

export async function getPushPermission(): Promise<PushPermission> {
  const { status } = await Notifications.getPermissionsAsync();
  return status as PushPermission;
}

/**
 * Turn on push for this phone and the signed-in user.
 * Asks for permission when it was never asked. Returns false when push
 * can't be used (no permission, emulator, no internet).
 */
export async function registerForPush(ask = true): Promise<boolean> {
  try {
    if (!Device.isDevice) return false;
    // The channel must exist before Android 13 shows the permission prompt
    await ensureChannel();

    let { status } = await Notifications.getPermissionsAsync();
    if (status !== 'granted' && ask) {
      ({ status } = await Notifications.requestPermissionsAsync());
    }
    if (status !== 'granted') return false;

    const projectId = Constants.expoConfig?.extra?.eas?.projectId ?? Constants.easConfig?.projectId;
    const { data: token } = await Notifications.getExpoPushTokenAsync({ projectId });

    const { error } = await supabase.rpc('register_push_token', {
      p_token: token,
      p_device_id: getDeviceId() ?? undefined,
      p_platform: Platform.OS,
    });
    if (error) return false;
    await AsyncStorage.setItem(TOKEN_KEY, token);
    return true;
  } catch {
    return false;
  }
}

/** On sign out: this phone stops getting this user's pushes */
export async function unregisterPush(): Promise<void> {
  try {
    const token = await AsyncStorage.getItem(TOKEN_KEY);
    if (!token) return;
    await supabase.rpc('remove_push_token', { p_token: token });
    await AsyncStorage.removeItem(TOKEN_KEY);
  } catch {
    // Signing out must never fail because of this
  }
}

/** The app icon number = unread in the 🔔 list */
export async function setBadge(count: number): Promise<void> {
  try {
    await Notifications.setBadgeCountAsync(count);
  } catch {
    // Some launchers have no badge
  }
}
