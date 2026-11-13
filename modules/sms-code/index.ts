import { requireOptionalNativeModule } from 'expo-modules-core';
import { Platform } from 'react-native';

// =====================================================================
// 🔐 The sign-in code SMS, read by the phone itself (Android, from app
//   build 2.8.6 on). An older build has no native part: everything here
//   then does nothing, and the keyboard's "code from SMS" suggestion is
//   the way in.
// =====================================================================
type Native = {
  appHash(): string | null;
  waitForSms(): Promise<string | null>;
  stop(): void;
};

const native = Platform.OS === 'android' ? requireOptionalNativeModule<Native>('SmsCode') : null;

/** Can this phone read the code SMS by itself? */
export const canReadSmsCode = native != null;

/** This app's 11-letter code for the SMS's last line ('' when there is none) */
export function smsAppHash(): string {
  try {
    return native?.appHash() ?? '';
  } catch {
    return '';
  }
}

/** Waits (up to 5 minutes) for the code SMS; its 6-digit code, or null */
export async function waitForSmsCode(): Promise<string | null> {
  if (!native) return null;
  try {
    const text = await native.waitForSms();
    return text?.match(/\b(\d{6})\b/)?.[1] ?? null;
  } catch {
    return null;
  }
}

/** Stops waiting (leaving the page, or the code was typed) */
export function stopSmsCode(): void {
  try {
    native?.stop();
  } catch {
    // nothing to stop
  }
}
