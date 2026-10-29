import { useCallback, useEffect, useRef } from 'react';
import { AppState } from 'react-native';

import {
    canSyncCalls,
    isCallLogAvailable,
    isCallSyncEnabled,
    setPhoneCallSync,
    syncCallsNow,
} from '@/features/call-sync/api';
import { onNetworkChange } from '@/shared/lib/network';

const MIN_GAP_MS = 60 * 1000; // never more than once a minute

/**
 * Keeps the phone's call log in sync while the user is signed in:
 *   - when the app opens
 *   - whenever the app comes back to the front (e.g. after a call)
 * If an admin turns sync off for this user, capture on the phone stops too.
 * Does nothing in Expo Go, on iPhone, or before the user turns sync on.
 */
export function useAutoCallSync(active: boolean) {
  const lastRun = useRef(0);

  const run = useCallback(async (force = false) => {
    if (!active || !isCallLogAvailable) return;
    if (!force && Date.now() - lastRun.current < MIN_GAP_MS) return;
    lastRun.current = Date.now();

    try {
      const allowed = await canSyncCalls();
      if (!allowed) {
        // Admin switched it off: stop capturing on this phone as well
        if (isCallSyncEnabled()) setPhoneCallSync(false);
        return;
      }
      if (!isCallSyncEnabled()) return; // the user hasn't turned it on yet
      await syncCallsNow();
    } catch {
      // No internet etc.: calls stay in the phone's queue for next time
    }
  }, [active]);

  // When the user becomes active (app opened / signed in)
  useEffect(() => {
    run(true);
  }, [run]);

  // Internet is back: send the calls that waited on the phone
  useEffect(() => {
    const off = onNetworkChange((online) => {
      if (online) run(true);
    });
    return off;
  }, [run]);

  // Whenever the app comes back to the front
  useEffect(() => {
    const sub = AppState.addEventListener('change', (state) => {
      if (state === 'active') run();
    });
    return () => sub.remove();
  }, [run]);
}