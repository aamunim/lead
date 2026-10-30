import { Alert, Linking, Platform, ToastAndroid } from 'react-native';

// =====================================================================
// 📇 How to reach a lead
//   A lead has at least one of: phone (Bangladesh), WhatsApp number
//   (any country) or WhatsApp username.
// =====================================================================

export type LeadContact = {
  phone: string | null;
  whatsapp_number?: string | null;
  whatsapp_username?: string | null;
};

// expo-clipboard and expo-intent-launcher are only in newer app builds;
// older ones fall back to a WhatsApp link
let clipboard: { setStringAsync: (text: string) => Promise<boolean> } | null = null;
try {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  clipboard = require('expo-clipboard');
} catch {
  clipboard = null;
}
let launcher: { openApplication: (packageName: string) => void } | null = null;
try {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  launcher = require('expo-intent-launcher');
} catch {
  launcher = null;
}

// =====================================================================
// Tidy and check (same rules as the database)
// =====================================================================
/** 01711… stays; another country becomes +<digits> */
export function normalizeWaNumber(input: string): string {
  const raw = input.trim();
  let d = raw.replace(/\D/g, '');
  if (!d) return '';
  let bd = d;
  if (bd.length === 13 && bd.startsWith('880')) bd = '0' + bd.slice(3);
  else if (bd.length === 10 && bd.startsWith('1')) bd = '0' + bd;
  const plusForeign = raw.startsWith('+') && !d.startsWith('880');
  if (/^01[3-9]\d{8}$/.test(bd) && !plusForeign) return bd;
  if (d.startsWith('00')) d = d.slice(2);
  return '+' + d;
}

export function isValidWaNumber(input: string): boolean {
  const n = normalizeWaNumber(input);
  return /^01[3-9]\d{8}$/.test(n) || /^\+[1-9]\d{7,14}$/.test(n);
}

export function normalizeWaUsername(input: string): string {
  return input.trim().replace(/^@+/, '').toLowerCase();
}

/** 3–35 letters, numbers, "." or "_", with at least one letter */
export function isValidWaUsername(input: string): boolean {
  const u = normalizeWaUsername(input);
  return /^[a-z0-9._]{3,35}$/.test(u) && /[a-z]/.test(u);
}

// =====================================================================
// Showing
// =====================================================================
/** Phone, else WhatsApp number, else @username */
export function contactLabel(lead: LeadContact): string {
  if (lead.phone) return lead.phone;
  if (lead.whatsapp_number) return lead.whatsapp_number;
  if (lead.whatsapp_username) return '@' + lead.whatsapp_username;
  return '';
}

/** Only WhatsApp: no phone to call or text */
export function whatsAppOnly(lead: LeadContact): boolean {
  return !lead.phone;
}

export function canWhatsApp(lead: LeadContact): boolean {
  return !!(lead.phone || lead.whatsapp_number || lead.whatsapp_username);
}

// 01711234567 → 8801711234567, +971… → 971…
function waDigits(n: string): string {
  if (n.startsWith('+')) return n.slice(1);
  return n.startsWith('0') ? `88${n}` : n;
}

// =====================================================================
// Opening WhatsApp
// =====================================================================
// Tries each link in turn; false when none opened
async function openFirst(urls: string[]): Promise<boolean> {
  for (const url of urls) {
    try {
      await Linking.openURL(url);
      return true;
    } catch {
      // try the next one
    }
  }
  Alert.alert('Could not open', 'WhatsApp is not available on this phone.');
  return false;
}

/**
 * Open WhatsApp itself (its chat list), for a lead with only a username.
 *   - newer builds: start the app (WhatsApp, else WhatsApp Business)
 *   - older builds: a share link with the username as text; WhatsApp then
 *     shows "Send to…" with search (an empty link says "couldn't open")
 */
async function openWhatsAppHome(username: string): Promise<boolean> {
  if (launcher && Platform.OS === 'android') {
    for (const pkg of ['com.whatsapp', 'com.whatsapp.w4b']) {
      try {
        launcher.openApplication(pkg);
        return true;
      } catch {
        // not installed: try the next one
      }
    }
  }
  return openFirst([`whatsapp://send?text=${encodeURIComponent('@' + username)}`]);
}

/**
 * Open the lead's WhatsApp chat: the WhatsApp number, else the phone.
 * text: a message already typed in the chat (a template); the user taps Send.
 * With only a username, copy it and open WhatsApp (search there and paste);
 * a template's text is copied instead, after the username.
 * Returns false when WhatsApp did not open.
 */
export async function openWhatsApp(lead: LeadContact, text?: string): Promise<boolean> {
  const number = lead.whatsapp_number || lead.phone;
  if (number) {
    const d = waDigits(number);
    const t = text ? encodeURIComponent(text) : '';
    return openFirst([
      `whatsapp://send?phone=${d}${t ? `&text=${t}` : ''}`,
      `https://wa.me/${d}${t ? `?text=${t}` : ''}`,
    ]);
  }

  const username = lead.whatsapp_username;
  if (!username) return false;

  // A template for a username-only lead: copy the message; the user finds the chat and pastes
  if (text) {
    let copiedText = false;
    try {
      copiedText = !!clipboard && (await clipboard.setStringAsync(text));
    } catch {
      copiedText = false;
    }
    return new Promise((resolve) => {
      Alert.alert(
        `@${username}`,
        copiedText
          ? 'The message is copied. In WhatsApp, search this username, open the chat and paste.'
          : 'In WhatsApp, search this username and open the chat. (This app version can’t copy the message.)',
        [
          { text: 'Cancel', style: 'cancel', onPress: () => resolve(false) },
          { text: 'Open WhatsApp', onPress: () => openWhatsAppHome(username).then(resolve) },
        ],
        { cancelable: true, onDismiss: () => resolve(false) },
      );
    });
  }

  let copied = false;
  try {
    copied = !!clipboard && (await clipboard.setStringAsync('@' + username));
  } catch {
    copied = false;
  }

  // Copied: go straight to WhatsApp, with a short reminder
  if (copied) {
    if (Platform.OS === 'android') {
      ToastAndroid.show(`@${username} copied. In WhatsApp, search and paste it.`, ToastAndroid.LONG);
    }
    return openWhatsAppHome(username);
  }

  // Not copied (older app build): show the username first
  return new Promise((resolve) => {
    Alert.alert(
      `@${username}`,
      'In WhatsApp, tap search and type this username to find the chat.',
      [
        { text: 'Cancel', style: 'cancel', onPress: () => resolve(false) },
        { text: 'Open WhatsApp', onPress: () => openWhatsAppHome(username).then(resolve) },
      ],
      { cancelable: true, onDismiss: () => resolve(false) },
    );
  });
}

/** Open the phone's SMS app to this number, with a message already typed (optional) */
export async function openSms(phone: string, text?: string): Promise<boolean> {
  try {
    await Linking.openURL(text ? `sms:${phone}?body=${encodeURIComponent(text)}` : `sms:${phone}`);
    return true;
  } catch {
    Alert.alert('Could not open', 'SMS is not available on this phone.');
    return false;
  }
}
