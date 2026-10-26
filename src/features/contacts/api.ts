// The classic contacts API now lives under "expo-contacts/legacy"
import * as Contacts from 'expo-contacts/legacy';

import { isValidBdMobile, normalizePhone } from '@/features/leads/api';
import { getSetting, updateSetting } from '@/features/settings/api';
import { supabase } from '@/shared/lib/supabase';
import type { Json } from '@/shared/types/database';

// =====================================================================
// Types
// =====================================================================
export type ContactNumber = {
  raw: string;          // as written in the phone
  normalized: string;   // 01711234567
  label: string | null; // "mobile", "home"…
  valid: boolean;       // a Bangladeshi mobile number
};

export type PhoneContact = {
  id: string;
  name: string;
  numbers: ContactNumber[];
};

export type SaveContactRow = { name: string; phone: string };

export type SaveContactOptions = {
  sourceId: string | null;
  rating: string | null;
  tagIds: string[];
  courseIds: string[];
  /** true = use assignedTo (null = Unassigned); false = Auto (assignment rules) */
  assignManual: boolean;
  assignedTo: string | null;
};

export type SaveContactResult = {
  created: number;
  createdIds: string[];
  alreadyLeads: number;
  invalid: number;
};

// =====================================================================
// Errors
// =====================================================================
function toError(error: { message: string }): Error {
  const m = error.message.toLowerCase();
  if (m.includes('network request failed') || m.includes('fetch')) {
    return new Error('No internet connection. Please try again.');
  }
  return new Error(error.message);
}

// =====================================================================
// Permission (the phone's own contacts permission)
// =====================================================================
export type ContactsPermission = 'granted' | 'denied' | 'undetermined';

export async function getContactsPermission(): Promise<{ status: ContactsPermission; canAskAgain: boolean }> {
  const { status, canAskAgain } = await Contacts.getPermissionsAsync();
  return { status: status as ContactsPermission, canAskAgain };
}

export async function askContactsPermission(): Promise<{ status: ContactsPermission; canAskAgain: boolean }> {
  const { status, canAskAgain } = await Contacts.requestPermissionsAsync();
  return { status: status as ContactsPermission, canAskAgain };
}

// =====================================================================
// Reading the phone's contacts
// =====================================================================
/**
 * Every contact that has at least one phone number, A–Z.
 * Numbers are tidied up; the same number twice in one contact is kept once.
 */
export async function loadPhoneContacts(): Promise<PhoneContact[]> {
  const { data } = await Contacts.getContactsAsync({
    fields: [Contacts.Fields.Name, Contacts.Fields.PhoneNumbers],
    sort: Contacts.SortTypes.FirstName,
  });

  const out: PhoneContact[] = [];
  for (const c of data) {
    const seen = new Set<string>();
    const numbers: ContactNumber[] = [];

    for (const p of c.phoneNumbers ?? []) {
      const raw = (p.number ?? p.digits ?? '').trim();
      if (!raw) continue;
      const normalized = normalizePhone(raw);
      if (!normalized || seen.has(normalized)) continue;
      seen.add(normalized);
      numbers.push({
        raw,
        normalized,
        label: p.label ?? null,
        valid: isValidBdMobile(normalized),
      });
    }
    if (numbers.length === 0) continue;

    // Bangladeshi mobile numbers first
    numbers.sort((a, b) => Number(b.valid) - Number(a.valid));

    const name = (c.name ?? [c.firstName, c.lastName].filter(Boolean).join(' ')).trim();
    out.push({ id: c.id ?? `${name}-${numbers[0].normalized}`, name: name || numbers[0].raw, numbers });
  }

  out.sort((a, b) => a.name.localeCompare(b.name));
  return out;
}

// =====================================================================
// Which numbers are already leads (checked against ALL leads)
// =====================================================================
export async function findExistingLeadPhones(phones: string[]): Promise<Set<string>> {
  const unique = [...new Set(phones.filter(Boolean))];
  const found = new Set<string>();

  for (let i = 0; i < unique.length; i += 500) {
    const { data, error } = await supabase.rpc('existing_lead_phones', { p_phones: unique.slice(i, i + 500) });
    if (error) throw toError(error);
    for (const p of (data ?? []) as string[]) found.add(normalizePhone(p));
  }
  return found;
}

// =====================================================================
// May this user use the feature? (Settings → Phone contacts access)
// =====================================================================
export async function canImportContacts(): Promise<boolean> {
  const { data, error } = await supabase.rpc('can_import_contacts');
  if (error) return false;
  return !!data;
}

// =====================================================================
// Save marked contacts as leads / undo
// =====================================================================
const SAVE_CHUNK = 500;

export async function saveContactsAsLeads(
  rows: SaveContactRow[],
  options: SaveContactOptions,
  onProgress?: (done: number, total: number) => void,
): Promise<SaveContactResult> {
  const result: SaveContactResult = { created: 0, createdIds: [], alreadyLeads: 0, invalid: 0 };

  for (let i = 0; i < rows.length; i += SAVE_CHUNK) {
    const { data, error } = await supabase.rpc('save_contacts_as_leads', {
      p_rows: rows.slice(i, i + SAVE_CHUNK) as unknown as Json,
      p_options: {
        source_id: options.sourceId,
        rating: options.rating,
        tag_ids: options.tagIds,
        course_ids: options.courseIds,
        assign_manual: options.assignManual,
        assigned_to: options.assignedTo,
      } as unknown as Json,
    });

    if (error) {
      throw toError({
        message:
          result.created > 0
            ? `${error.message} (${result.created} were saved before this; you can undo them.)`
            : error.message,
      });
    }

    const part = data as unknown as {
      created: number;
      created_ids: string[] | null;
      already_leads: number;
      invalid: number;
    };
    result.created += part.created;
    result.createdIds.push(...(part.created_ids ?? []));
    result.alreadyLeads += part.already_leads;
    result.invalid += part.invalid;

    onProgress?.(Math.min(i + SAVE_CHUNK, rows.length), rows.length);
  }

  return result;
}

/** Takes back leads you just saved from contacts (within 24 hours). */
export async function undoContactsSave(leadIds: string[]): Promise<number> {
  if (leadIds.length === 0) return 0;
  const { data, error } = await supabase.rpc('undo_contacts_save', { p_lead_ids: leadIds });
  if (error) throw toError(error);
  return (data as number) ?? 0;
}

// =====================================================================
// Admin setting: who may use Phone contacts
// =====================================================================
export type ContactsAccessMode = 'all' | 'roles' | 'users';

export type ContactsAccess = {
  mode: ContactsAccessMode;
  roles: string[];     // role keys, when mode = 'roles'
  user_ids: string[];  // user ids, when mode = 'users'
};

export const DEFAULT_CONTACTS_ACCESS: ContactsAccess = {
  mode: 'all',
  roles: ['admin', 'team_lead'],
  user_ids: [],
};

export async function getContactsAccess(): Promise<ContactsAccess> {
  try {
    const saved = await getSetting<Partial<ContactsAccess>>('contacts_import');
    return { ...DEFAULT_CONTACTS_ACCESS, ...(saved ?? {}) };
  } catch {
    return DEFAULT_CONTACTS_ACCESS;
  }
}

export async function saveContactsAccess(access: ContactsAccess): Promise<void> {
  await updateSetting('contacts_import', access as unknown as Json);
}