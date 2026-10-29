import { Alert, Linking } from 'react-native';

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

// expo-clipboard is only in newer app builds; older ones just show the username
let clipboard: { setStringAsync: (text: string) => Promise<boolean> } | null = null;
try {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  clipboard = require('expo-clipboard');
} catch {
  clipboard = null;
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
async function openUrl(url: string, fallback?: string): Promise<boolean> {
  try {
    await Linking.openURL(url);
    return true;
  } catch {
    if (fallback) {
      try {
        await Linking.openURL(fallback);
        return true;
      } catch {
        // fall through
      }
    }
    Alert.alert('Could not open', 'WhatsApp is not available on this phone.');
    return false;
  }
}

/**
 * Open the lead's WhatsApp chat: the WhatsApp number, else the phone.
 * With only a username, copy it and open WhatsApp (search there and paste).
 * Returns false when WhatsApp did not open.
 */
export async function openWhatsApp(lead: LeadContact): Promise<boolean> {
  const number = lead.whatsapp_number || lead.phone;
  if (number) {
    const d = waDigits(number);
    return openUrl(`whatsapp://send?phone=${d}`, `https://wa.me/${d}`);
  }

  const username = lead.whatsapp_username;
  if (!username) return false;

  let copied = false;
  try {
    copied = !!clipboard && (await clipboard.setStringAsync('@' + username));
  } catch {
    copied = false;
  }

  return new Promise((resolve) => {
    Alert.alert(
      `@${username}`,
      copied
        ? 'Username copied. In WhatsApp, tap search and paste it to find the chat.'
        : 'In WhatsApp, tap search and type this username to find the chat.',
      [
        { text: 'Cancel', style: 'cancel', onPress: () => resolve(false) },
        { text: 'Open WhatsApp', onPress: () => openUrl('whatsapp://', 'https://wa.me/').then(resolve) },
      ],
      { cancelable: true, onDismiss: () => resolve(false) },
    );
  });
}
