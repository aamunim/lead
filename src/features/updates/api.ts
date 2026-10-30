import * as Updates from 'expo-updates';

// =====================================================================
// 🔄 EAS Update: new app code without a new build
//   The phone looks for an update when the app opens (expo-updates) and
//   again when it comes back to the front (at most every 30 minutes).
//   A downloaded update runs after a restart: the banner offers it, or it
//   starts by itself the next time the app is opened.
//   Not in development (Metro) builds: there the code comes from the PC.
// =====================================================================

const CHECK_EVERY_MS = 30 * 60 * 1000;
let lastCheck = 0;

/** Look for an update and download it (quietly; errors are ignored) */
export async function checkAndDownload(force = false): Promise<'none' | 'downloaded' | 'off'> {
  if (!Updates.isEnabled || __DEV__) return 'off';
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

export function restartWithUpdate(): Promise<void> {
  return Updates.reloadAsync();
}

/** What is running on this phone (More → About) */
export function currentVersionInfo() {
  return {
    enabled: Updates.isEnabled && !__DEV__,
    channel: Updates.channel,
    runtimeVersion: Updates.runtimeVersion,
    updateId: Updates.updateId,
    /** true = the code that came with the build (no update yet) */
    builtIn: Updates.isEmbeddedLaunch,
    createdAt: Updates.createdAt,
  };
}
