import { AppState } from 'react-native';

// =====================================================================
// 📶 Is the server reachable?
//   - every request through the Supabase client reports here: a
//     "Network request failed" means offline, any answer means online
//   - while offline, checks again every 15 seconds (and when the app
//     comes back to the front), so the banner goes away by itself
// =====================================================================

type Listener = (online: boolean) => void;

let online = true;
const listeners = new Set<Listener>();
let timer: ReturnType<typeof setInterval> | null = null;

const HEALTH_URL = `${process.env.EXPO_PUBLIC_SUPABASE_URL}/auth/v1/health`;
const API_KEY = process.env.EXPO_PUBLIC_SUPABASE_ANON_KEY ?? '';
const RETRY_MS = 15 * 1000;

export function isOnline(): boolean {
  return online;
}

export function onNetworkChange(listener: Listener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

function set(next: boolean) {
  if (next === online) return;
  online = next;
  if (online && timer) {
    clearInterval(timer);
    timer = null;
  }
  if (!online && !timer) timer = setInterval(() => checkNow(), RETRY_MS);
  listeners.forEach((l) => l(online));
}

/** A failed fetch that means "no connection" (not an error answer from the server) */
function isNetworkError(e: unknown): boolean {
  const m = e instanceof Error ? e.message.toLowerCase() : String(e).toLowerCase();
  return m.includes('network request failed') || m.includes('failed to fetch') || m.includes('network error');
}

/** Ask the server once; returns true when it answered */
export async function checkNow(): Promise<boolean> {
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), 6000);
  try {
    await fetch(HEALTH_URL, { headers: { apikey: API_KEY }, signal: controller.signal });
    set(true);
    return true;
  } catch {
    set(false);
    return false;
  } finally {
    clearTimeout(t);
  }
}

/** fetch for the Supabase client: reports online / offline as requests go */
export const trackedFetch: typeof fetch = async (input, init) => {
  try {
    const res = await fetch(input, init);
    set(true);
    return res;
  } catch (e) {
    if (isNetworkError(e)) set(false);
    throw e;
  }
};

// Back to the front while offline: check right away
AppState.addEventListener('change', (state) => {
  if (state === 'active' && !online) checkNow();
});
