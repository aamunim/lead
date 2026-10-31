import AsyncStorage from '@react-native-async-storage/async-storage';

import { searchDigits, type LeadListItem } from '@/features/leads/api';

// =====================================================================
// 🔍 Lead search helpers: what matched (for the card), and the last
//   searches on this phone (Leads and Students kept apart)
// =====================================================================

/** Where in the text the search is found, or null (case and spaces ignored) */
export function findText(value: string | null | undefined, search: string): [number, number] | null {
  if (!value || !search) return null;
  const at = value.toLowerCase().indexOf(search.toLowerCase());
  return at < 0 ? null : [at, at + search.length];
}

/** Where in a phone number the digits are found (a number is shown as it is stored) */
export function findDigits(value: string | null | undefined, search: string): [number, number] | null {
  const digits = searchDigits(search);
  if (!value || digits.length < 3) return null;
  const at = value.indexOf(digits);
  return at < 0 ? null : [at, at + digits.length];
}

/**
 * The line to show under the name when the match is not in the name or
 * the phone on the card, e.g. "Guardian: Karim Uddin · 01811234567"
 */
export function otherMatch(lead: LeadListItem, search: string): string | null {
  const s = search.trim();
  if (!s) return null;
  if (findText(lead.name, s) || findDigits(lead.phone, s) || findText(lead.student_ref, s)) return null;
  if (findDigits(lead.alt_phone, s)) return `Other phone: ${lead.alt_phone}`;
  if (findText(lead.guardian_name, s) || findDigits(lead.guardian_phone, s)) {
    return `Guardian: ${[lead.guardian_name, lead.guardian_phone].filter(Boolean).join(' · ')}`;
  }
  if (findDigits(lead.whatsapp_number, s)) return `WhatsApp: ${lead.whatsapp_number}`;
  if (findText(lead.whatsapp_username, s.replace(/^@+/, ''))) return `WhatsApp: @${lead.whatsapp_username}`;
  if (findText(lead.email, s)) return `Email: ${lead.email}`;
  if (findText(lead.area, s)) return `Area: ${lead.area}`;
  return null;
}

// ---------------------------------------------------------------------
// Recent searches (on this phone only)
// ---------------------------------------------------------------------
const MAX_RECENT = 8;
const key = (students: boolean) => `recent_searches_${students ? 'students' : 'leads'}`;

export async function loadRecentSearches(students: boolean): Promise<string[]> {
  try {
    const raw = await AsyncStorage.getItem(key(students));
    const list = raw ? (JSON.parse(raw) as unknown) : [];
    return Array.isArray(list) ? list.filter((x): x is string => typeof x === 'string').slice(0, MAX_RECENT) : [];
  } catch {
    return [];
  }
}

async function store(students: boolean, list: string[]): Promise<string[]> {
  await AsyncStorage.setItem(key(students), JSON.stringify(list)).catch(() => undefined);
  return list;
}

/** Newest first, no repeats (case ignored), at most 8 */
export async function addRecentSearch(students: boolean, text: string): Promise<string[]> {
  const t = text.trim();
  const list = await loadRecentSearches(students);
  if (t.length < 2) return list;
  return store(students, [t, ...list.filter((x) => x.toLowerCase() !== t.toLowerCase())].slice(0, MAX_RECENT));
}

export async function removeRecentSearch(students: boolean, text: string): Promise<string[]> {
  return store(students, (await loadRecentSearches(students)).filter((x) => x !== text));
}

export async function clearRecentSearches(students: boolean): Promise<string[]> {
  return store(students, []);
}
