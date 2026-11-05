import AsyncStorage from '@react-native-async-storage/async-storage';
import { useCallback, useEffect, useRef, useState } from 'react';

import { supabase } from '@/shared/lib/supabase';

// =====================================================================
// ⚡ The last data of a screen, kept on the phone: the app opens with
//   what it showed last time at once, then the fresh data replaces it
//   (what WhatsApp and Facebook do). Kept per person; removed when
//   someone signs out, so the next person never sees it.
// =====================================================================

const PREFIX = 'saved:v1:';
let userId: string | null = null;

const ready = supabase.auth
  .getSession()
  .then(({ data }) => {
    userId = data.session?.user.id ?? null;
  })
  .catch(() => undefined);
supabase.auth.onAuthStateChange((event, session) => {
  const next = session?.user.id ?? null;
  if (event === 'SIGNED_OUT' || (userId && next && next !== userId)) clearSaved().catch(() => undefined);
  userId = next;
});

const fullKey = (key: string) => (userId ? `${PREFIX}${userId}:${key}` : null);

export async function readSaved<T>(key: string): Promise<T | null> {
  await ready;
  const k = fullKey(key);
  if (!k) return null;
  try {
    const raw = await AsyncStorage.getItem(k);
    return raw ? (JSON.parse(raw) as T) : null;
  } catch {
    return null;
  }
}

export function writeSaved(key: string, value: unknown) {
  ready.then(() => {
    const k = fullKey(key);
    if (!k) return;
    try {
      AsyncStorage.setItem(k, JSON.stringify(value)).catch(() => undefined);
    } catch {
      // too big or not JSON: skip
    }
  });
}

export async function clearSaved() {
  const keys = (await AsyncStorage.getAllKeys()).filter((k) => k.startsWith(PREFIX));
  if (keys.length) await AsyncStorage.multiRemove(keys);
}

/**
 * Like useState, but the first value comes from the phone (last time's),
 * and every new value is kept for next time. Fresh data always wins.
 */
export function useSavedState<T>(key: string | null, initial: T): [T, (v: T) => void] {
  const [value, setValue] = useState<T>(initial);
  const fresh = useRef(false);
  useEffect(() => {
    fresh.current = false;
    if (!key) return;
    let live = true;
    readSaved<T>(key).then((v) => {
      if (live && v != null && !fresh.current) setValue(v);
    });
    return () => {
      live = false;
    };
  }, [key]);
  const set = useCallback(
    (v: T) => {
      fresh.current = true;
      setValue(v);
      if (key) writeSaved(key, v);
    },
    [key],
  );
  return [value, set];
}
