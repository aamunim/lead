import AsyncStorage from '@react-native-async-storage/async-storage';
import Constants from 'expo-constants';
import * as Device from 'expo-device';
import { useEffect, useRef } from 'react';
import { AppState, View, type AppStateStatus } from 'react-native';

import { getDeviceId, isCallLogAvailable } from '@/features/call-sync/api';
import { supabase } from '@/shared/lib/supabase';

// =====================================================================
// ⏱ Time spent in THIS app (Settings → Team activity)
//   A "session" runs while the app is on screen and being used:
//     - starts when the app opens (or on the first touch after a pause)
//     - stops when the app goes to the background, or after N minutes
//       with no touch / scroll (the idle rule, default 10)
//   Every 5 minutes, and when a session stops, it is sent to the database.
//   Sends that fail (no internet) are kept on the phone and sent later.
// =====================================================================

const TICK_MS = 15 * 1000;
const PING_MS = 5 * 60 * 1000;
const PENDING_KEY = 'activity.pending';

type Session = {
  id: string;
  startedAt: number;
  lastActiveAt: number; // last moment counted as active
  activeMs: number;
  lastPingAt: number;
};

type Report = {
  p_id: string;
  p_started_at: string;
  p_last_seen_at: string;
  p_active_sec: number;
  p_ended: boolean;
  p_device_id?: string;
  p_device_label?: string;
  p_app_version?: string;
};

function uuid(): string {
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    return (c === 'x' ? r : (r & 0x3) | 0x8).toString(16);
  });
}

const deviceLabel = [Device.manufacturer, Device.modelName].filter(Boolean).join(' ') || undefined;
const appVersion = Constants.expoConfig?.version ?? undefined;

async function send(report: Report): Promise<boolean> {
  try {
    const { error } = await supabase.rpc('report_app_session', report);
    return !error;
  } catch {
    return false;
  }
}

/** Keep failed sends (only the newest per session) and try them again later */
async function queue(report: Report) {
  try {
    const now = JSON.parse((await AsyncStorage.getItem(PENDING_KEY)) ?? '[]') as Report[];
    const next = [...now.filter((r) => r.p_id !== report.p_id), report].slice(-50);
    await AsyncStorage.setItem(PENDING_KEY, JSON.stringify(next));
  } catch {
    // nothing more to do
  }
}

async function flushQueue() {
  try {
    const now = JSON.parse((await AsyncStorage.getItem(PENDING_KEY)) ?? '[]') as Report[];
    if (now.length === 0) return;
    const left: Report[] = [];
    for (const r of now) if (!(await send(r))) left.push(r);
    await AsyncStorage.setItem(PENDING_KEY, JSON.stringify(left));
  } catch {
    // try again next time
  }
}

export function ActivityTracker({ children }: { children: React.ReactNode }) {
  const session = useRef<Session | null>(null);
  const lastTouch = useRef(Date.now());
  const appActive = useRef(AppState.currentState === 'active');
  const settings = useRef({ enabled: true, idleMs: 10 * 60 * 1000 });
  const touchRef = useRef<() => void>(() => undefined);

  useEffect(() => {
    let deviceId: string | undefined;
    try {
      deviceId = (isCallLogAvailable ? getDeviceId() : null) ?? undefined;
    } catch {
      deviceId = undefined;
    }

    const report = (s: Session, ended: boolean) => {
      const r: Report = {
        p_id: s.id,
        p_started_at: new Date(s.startedAt).toISOString(),
        p_last_seen_at: new Date(s.lastActiveAt).toISOString(),
        p_active_sec: Math.round(s.activeMs / 1000),
        p_ended: ended,
        p_device_id: deviceId,
        p_device_label: deviceLabel,
        p_app_version: appVersion,
      };
      s.lastPingAt = Date.now();
      send(r).then((ok) => {
        if (!ok) queue(r);
      });
    };

    const start = () => {
      if (!settings.current.enabled || session.current) return;
      const now = Date.now();
      session.current = { id: uuid(), startedAt: now, lastActiveAt: now, activeMs: 0, lastPingAt: now };
      report(session.current, false);
    };

    const stop = () => {
      const s = session.current;
      if (!s) return;
      session.current = null;
      report(s, true);
    };

    // Count the time since the last tick while the app is used; stop when idle
    const tick = () => {
      const s = session.current;
      if (!s || !appActive.current) return;
      const now = Date.now();
      if (now - lastTouch.current > settings.current.idleMs) {
        stop();
        return;
      }
      s.activeMs += Math.min(now - s.lastActiveAt, TICK_MS * 2);
      s.lastActiveAt = now;
      if (now - s.lastPingAt >= PING_MS) report(s, false);
    };

    // Settings first, then the first session
    supabase
      .rpc('activity_setting')
      .then(({ data }) => {
        const v = (data ?? {}) as { enabled?: boolean; idle_minutes?: number };
        settings.current = {
          enabled: v.enabled !== false,
          idleMs: Math.max(1, Number(v.idle_minutes) || 10) * 60 * 1000,
        };
      })
      .then(() => {
        lastTouch.current = Date.now();
        if (appActive.current) start();
        flushQueue();
      });

    const timer = setInterval(tick, TICK_MS);

    const sub = AppState.addEventListener('change', (state: AppStateStatus) => {
      const active = state === 'active';
      if (active && !appActive.current) {
        appActive.current = true;
        lastTouch.current = Date.now();
        start();
        flushQueue();
      } else if (!active && appActive.current) {
        tick(); // count up to now
        appActive.current = false;
        stop();
      }
    });

    // Expose the touch handler to the wrapper below
    touchRef.current = () => {
      lastTouch.current = Date.now();
      if (appActive.current && !session.current) start();
    };

    return () => {
      clearInterval(timer);
      sub.remove();
      stop();
    };
  }, []);

  // Any touch or scroll anywhere in the app counts as "being used"
  return (
    <View style={{ flex: 1 }} onTouchStart={() => touchRef.current()}>
      {children}
    </View>
  );
}
