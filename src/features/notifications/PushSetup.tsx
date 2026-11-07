import * as Notifications from 'expo-notifications';
import { useEffect } from 'react';
import { AppState } from 'react-native';

import { countUnread, markRead } from '@/features/notifications/api';
import { openNotificationTarget } from '@/features/notifications/open';
import { registerForPush, setBadge } from '@/features/notifications/push';

// =====================================================================
// 📲 Push for the signed-in user (lives in the (app) layout)
//   - turns on push for this phone (asks for permission the first time)
//   - a tap on a push opens its lead (or leads) and marks it read,
//     also when the tap started the app
//   - keeps the app icon number = unread
// =====================================================================

type PushData = {
  notification_id?: string;
  lead_id?: string;
  lead_ids?: string[];
  route?: string;
};

function openResponse(response: Notifications.NotificationResponse) {
  const data = (response.notification.request.content.data ?? {}) as PushData;
  if (data.notification_id) {
    markRead([data.notification_id])
      .then(() => countUnread().then(setBadge))
      .catch(() => undefined);
  }
  openNotificationTarget(data);
}

const REGISTER_MS = 6 * 60 * 60 * 1000;
let lastRegister = 0;
const TOKEN_REGISTER_MS = 10 * 60 * 1000;
let lastTokenRegister = 0;
let lastDeviceToken: string | null = null;

export function PushSetup() {
  useEffect(() => {
    lastRegister = Date.now();
    registerForPush();

    // The tap that opened the app (it was closed)
    const first = Notifications.getLastNotificationResponse();
    if (first) {
      Notifications.clearLastNotificationResponse();
      // Let the screens mount before moving
      setTimeout(() => openResponse(first), 300);
    }

    // Taps while the app is open or in the background
    const tap = Notifications.addNotificationResponseReceivedListener((response) => {
      Notifications.clearLastNotificationResponse();
      openResponse(response);
    });

    // 🔔 Google gave this phone a new push token: tell the database right away.
    //   ⚠️ Android also sends this event every time the app itself asks for the
    //   token (registerForPush does), so reacting to every event made an endless
    //   loop: Google + Expo + the database, again and again, all day (2.8.2–2.8.5).
    //   Now: only a token that is really different, and at most every 10 minutes.
    const token = Notifications.addPushTokenListener(({ data }) => {
      const t = typeof data === 'string' ? data : JSON.stringify(data);
      if (t === lastDeviceToken) return;
      const first = lastDeviceToken === null;
      lastDeviceToken = t;
      if (first) return; // the answer to our own request on start
      if (Date.now() - lastTokenRegister < TOKEN_REGISTER_MS) return;
      lastTokenRegister = Date.now();
      registerForPush(false);
    });

    // Back to the front: the token may have changed, the badge too
    const state = AppState.addEventListener('change', (s) => {
      if (s !== 'active') return;
      // ⚡ Google + Expo + the database: at most every 6 hours (a new token
      //   comes through the listener above at once). Before, this ran after
      //   every phone call and slowed the app down.
      if (Date.now() - lastRegister >= REGISTER_MS) {
        lastRegister = Date.now();
        registerForPush(false);
      }
      countUnread().then(setBadge);
    });

    countUnread().then(setBadge);

    return () => {
      tap.remove();
      token.remove();
      state.remove();
    };
  }, []);

  return null;
}
