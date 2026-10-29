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

export function PushSetup() {
  useEffect(() => {
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

    // Back to the front: the token may have changed, the badge too
    const state = AppState.addEventListener('change', (s) => {
      if (s !== 'active') return;
      registerForPush(false);
      countUnread().then(setBadge);
    });

    countUnread().then(setBadge);

    return () => {
      tap.remove();
      state.remove();
    };
  }, []);

  return null;
}
