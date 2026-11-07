import { Platform } from 'react-native';

// =====================================================================
// 🌐 A newer website version came out while this tab was open
//   The open tab still has the old code; a part it loads later (a page
//   opened for the first time) is from the new version or gone, so it
//   fails: "Requiring unknown module 773", "Loading chunk … failed",
//   "Unexpected token '<'". Loading the page again gets the new version.
//   At most once a minute, so a real fault can never loop.
// =====================================================================

const KEY = 'web.staleReloadAt';
const STALE =
  /Requiring unknown module|Loading chunk|ChunkLoadError|Failed to fetch dynamically imported module|Importing a module script failed|Unexpected token '<'/i;

export function isStaleBuildError(e: unknown): boolean {
  const text = e instanceof Error ? `${e.name}: ${e.message}` : typeof e === 'string' ? e : '';
  return STALE.test(text);
}

/** true: the page is loading again (show "Updating…", don't report a crash) */
export function reloadForNewVersion(e: unknown): boolean {
  if (Platform.OS !== 'web' || typeof window === 'undefined' || !isStaleBuildError(e)) return false;
  try {
    const last = Number(window.sessionStorage.getItem(KEY) ?? 0);
    if (Date.now() - last < 60_000) return false; // just tried: show the error instead
    window.sessionStorage.setItem(KEY, String(Date.now()));
  } catch {
    // no sessionStorage: still try once
  }
  window.location.reload();
  return true;
}

/** Errors outside React (a part that failed to load) */
export function installStaleBuildReload(): void {
  if (Platform.OS !== 'web' || typeof window === 'undefined') return;
  window.addEventListener('error', (ev) => {
    reloadForNewVersion(ev.error ?? ev.message);
  });
  window.addEventListener('unhandledrejection', (ev) => {
    reloadForNewVersion(ev.reason);
  });
}
