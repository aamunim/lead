import { useFocusEffect } from 'expo-router';
import { useCallback, useRef } from 'react';

// =====================================================================
// ⚡ Like useFocusEffect, but a screen coming back into view within a
//   short while (30 seconds) keeps what it has instead of asking the
//   server for everything again. A change in what it depends on (the
//   callback) loads again at once.
// =====================================================================

export function useFocusRefresh(effect: () => void | (() => void), freshMs = 30_000) {
  const last = useRef<{ fn: unknown; at: number } | null>(null);
  useFocusEffect(
    useCallback(() => {
      if (last.current && last.current.fn === effect && Date.now() - last.current.at < freshMs) return;
      last.current = { fn: effect, at: Date.now() };
      return effect();
    }, [effect, freshMs]),
  );
}
