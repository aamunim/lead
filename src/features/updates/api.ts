import { requireOptionalNativeModule } from 'expo-modules-core';

// =====================================================================
// 🔄 EAS Update: new app code without a new build
//   The phone looks for an update when the app opens (expo-updates) and
//   again when it comes back to the front (at most every 30 minutes).
//   A downloaded update runs after a restart: the banner offers it, or it
//   starts by itself the next time the app is opened.
//   Builds made before expo-updates was added (older APKs, an older dev
//   client) don't have its native part: then all of this is simply off,
//   instead of the app failing to start.
// =====================================================================

type UpdatesModule = typeof import('expo-updates');

/** expo-updates, or null when this build doesn't have it */
export const Updates: UpdatesModule | null = requireOptionalNativeModule('ExpoUpdates')
  ? // eslint-disable-next-line @typescript-eslint/no-require-imports
    (require('expo-updates') as UpdatesModule)
  : null;

const CHECK_EVERY_MS = 30 * 60 * 1000;
let lastCheck = 0;

const usable = () => !!Updates && Updates.isEnabled && !__DEV__;

/** Look for an update and download it (quietly; errors are ignored) */
export async function checkAndDownload(force = false): Promise<'none' | 'downloaded' | 'off'> {
  if (!Updates || !usable()) return 'off';
  if (!force && Date.now() - lastCheck < CHECK_EVERY_MS) return 'none';
  lastCheck = Date.now();
  try {
    const check = await Updates.checkForUpdateAsync();
    if (!check.isAvailable) return 'none';
    const fetched = await Updates.fetchUpdateAsync();
    return fetched.isNew ? 'downloaded' : 'none';
  } catch {
    return 'none';
  }
}

export async function restartWithUpdate(): Promise<void> {
  if (Updates) await Updates.reloadAsync();
}

/** What is running on this phone (More → About) */
export function currentVersionInfo() {
  return {
    enabled: usable(),
    channel: Updates?.channel ?? null,
    runtimeVersion: Updates?.runtimeVersion ?? null,
    updateId: Updates?.updateId ?? null,
    /** true = the code that came with the build (no update yet) */
    builtIn: Updates?.isEmbeddedLaunch ?? true,
    createdAt: Updates?.createdAt ?? null,
  };
}
