import { Platform } from 'react-native';

import type { MyProfile } from '@/features/auth/api';
import type { WhoRule } from '@/features/pipeline/api';
import { getSetting, updateSetting } from '@/features/settings/api';
import type { Json } from '@/shared/types/database';

// =====================================================================
// 🌐 The website (app.sparc.college): the same app in a browser, with
//   some modules only (Students, Reports, Team activity, Import / Export,
//   Discounts, Templates, Notifications). Settings → Website decides who
//   may use it; admins always may.
// =====================================================================

export const isWeb = Platform.OS === 'web';

export type WebSettings = { enabled: boolean; who: WhoRule };

export const DEFAULT_WEB_SETTINGS: WebSettings = {
  enabled: true,
  who: { mode: 'roles', roles: ['team_lead'], user_ids: [] },
};

export async function getWebSettings(): Promise<WebSettings> {
  try {
    const saved = await getSetting<Partial<WebSettings>>('web');
    return {
      ...DEFAULT_WEB_SETTINGS,
      ...(saved ?? {}),
      who: { ...DEFAULT_WEB_SETTINGS.who, ...(saved?.who ?? {}) },
    };
  } catch {
    return DEFAULT_WEB_SETTINGS;
  }
}

export async function saveWebSettings(s: WebSettings): Promise<void> {
  await updateSetting('web', s as unknown as Json);
}

/** May this person use the website? (admins always, when it is on) */
export function canUseWeb(s: WebSettings, profile: MyProfile | null, isAdmin: boolean): boolean {
  if (!profile) return false;
  if (isAdmin) return true;
  if (!s.enabled) return false;
  if (s.who.mode === 'roles') return s.who.roles.includes(profile.role_key);
  if (s.who.mode === 'users') return s.who.user_ids.includes(profile.id);
  return true;
}
