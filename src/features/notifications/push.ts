import AsyncStorage from '@react-native-async-storage/async-storage';
import Constants from 'expo-constants';
import * as Device from 'expo-device';
import * as Notifications from 'expo-notifications';
import { Platform } from 'react-native';

import { getDeviceId } from '@/features/call-sync/api';
import { installedAppVersion } from '@/features/updates/StoreUpdateCard';
import { deviceLabel } from '@/shared/lib/deviceLabel';
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

/** The phone's own state (shown on Notification check, sent to the database) */
export type PushState = {
  permission: PushPermission;
  /** Android: the "Leads" channel is not switched off (null: not Android / unknown) */
  channelOn: boolean | null;
  token: string | null;
  tokenError: string | null;
};

export async function pushState(ask = false): Promise<PushState> {
  const out: PushState = { permission: 'undetermined', channelOn: null, token: null, tokenError: null };
  if (!Device.isDevice) return { ...out, tokenError: 'Not a real phone (emulator)' };
  try {
    // The channel must exist before Android 13 shows the permission prompt
    await ensureChannel();
    let { status } = await Notifications.getPermissionsAsync();
    if (status !== 'granted' && ask) ({ status } = await Notifications.requestPermissionsAsync());
    out.permission = status as PushPermission;
    if (Platform.OS === 'android') {
      const ch = await Notifications.getNotificationChannelAsync(CHANNEL_ID).catch(() => null);
      out.channelOn = ch ? ch.importance !== Notifications.AndroidImportance.NONE : null;
    }
    if (status !== 'granted') return out;
    const projectId = Constants.expoConfig?.extra?.eas?.projectId ?? Constants.easConfig?.projectId;
    try {
      out.token = (await Notifications.getExpoPushTokenAsync({ projectId })).data;
    } catch (e) {
      // e.g. no Google Play services, no internet, blocked by the phone
      out.tokenError = e instanceof Error ? e.message.slice(0, 280) : 'Could not get a push token';
    }
  } catch (e) {
    out.tokenError = e instanceof Error ? e.message.slice(0, 280) : 'Push is not available';
  }
  return out;
}

/**
 * Turn on push for this phone and the signed-in user.
 * Asks for permission when it was never asked. Tells the database what this
 * phone can do (allowed? channel on? token?), so admins see why pushes fail.
 * Returns false when push can't be used (no permission, emulator, no internet).
 */
export async function registerForPush(ask = true): Promise<boolean> {
  // 🌐 The website gets no push (notifications come to the phone app)
  if (Platform.OS === 'web') return false;
  try {
    const st = await pushState(ask);
    const deviceId = getDeviceId() ?? undefined;
    const label = deviceLabel();
    const { error } = await supabase.rpc(
      'push_check_in' as never,
      {
        p_device_id: deviceId ?? `no-id-${Platform.OS}`,
        p_permission: st.permission,
        p_channel_on: st.channelOn,
        p_token: st.token,
        p_platform: Platform.OS,
        // the installed app (an App update changes only the JavaScript version)
        p_app_version: installedAppVersion() ?? Constants.expoConfig?.version ?? null,
        p_device_label: label ?? null,
        p_token_error: st.tokenError,
      } as never,
    );
    // The database is older: the old way (token only)
    if (error && st.token) {
      const old = await supabase.rpc('register_push_token', {
        p_token: st.token,
        p_device_id: deviceId,
        p_platform: Platform.OS,
      });
      if (old.error) return false;
    } else if (error) return false;
    if (!st.token) return false;
    await AsyncStorage.setItem(TOKEN_KEY, st.token);
    return true;
  } catch {
    return false;
  }
}

/** 🔔 A test push to myself; and how my phones did lately */
export async function sendTestPush(): Promise<{ phones: number }> {
  const { data, error } = await supabase.rpc('send_test_push' as never);
  if (error)
    throw new Error(
      /could not find the function/i.test(error.message) ? 'The database is not updated yet.' : error.message,
    );
  return { phones: Number((data as { phones?: number } | null)?.phones ?? 0) };
}

export type MyPushStatus = {
  tokens: number;
  lastOkAt: Date | null;
  lastError: string | null;
  lastTest: { status: string | null; error: string | null; at: Date } | null;
};

export async function myPushStatus(): Promise<MyPushStatus | null> {
  const { data, error } = await supabase.rpc('my_push_status' as never);
  if (error || !data) return null;
  const d = data as {
    tokens?: number;
    last_ok_at?: string | null;
    last_error?: string | null;
    last_test?: { status: string | null; error: string | null; at: string } | null;
  };
  return {
    tokens: Number(d.tokens ?? 0),
    lastOkAt: d.last_ok_at ? new Date(d.last_ok_at) : null,
    lastError: d.last_error ?? null,
    lastTest: d.last_test ? { ...d.last_test, at: new Date(d.last_test.at) } : null,
  };
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
