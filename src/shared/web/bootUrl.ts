import { Platform } from 'react-native';

// =====================================================================
// 🌐 The address the website was opened (or reloaded) at.
//   While the sign-in is checked, the router sends everyone to the start
//   page, so we keep the address here and go back to it once signed in.
// =====================================================================

const PUBLIC = ['/', '/login', '/sign-up', '/loading', '/error', '/setup', '/pending', '/change-password'];

let boot: string | null =
  Platform.OS === 'web' && typeof window !== 'undefined' ? window.location.pathname + window.location.search : null;

if (boot && PUBLIC.includes(boot.split('?')[0].replace(/\/+$/, '') || '/')) boot = null;

/** The page to open after sign-in (only once) */
export function takeBootUrl(): string | null {
  const url = boot;
  boot = null;
  return url;
}
