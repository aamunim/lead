import AsyncStorage from '@react-native-async-storage/async-storage';

import type { MyProfile } from '@/features/auth/api';
import type { WhoRule } from '@/features/pipeline/api';
import { getSetting, updateSetting } from '@/features/settings/api';
import type { Json } from '@/shared/types/database';

// =====================================================================
// 📋 Pipeline board (Leads → Board): settings and the remembered view
// =====================================================================

export type BoardSettings = {
  /** Board view on the Leads tab */
  enabled: boolean;
  /** Admitted and Lost columns at the end of the board */
  closed_columns: boolean;
  /** Who can use the board (admins always can) */
  who: WhoRule;
};

export const DEFAULT_BOARD: BoardSettings = {
  enabled: true,
  closed_columns: true,
  who: { mode: 'all', roles: [], user_ids: [] },
};

export async function getBoardSettings(): Promise<BoardSettings> {
  try {
    const saved = await getSetting<Partial<BoardSettings>>('board');
    return {
      ...DEFAULT_BOARD,
      ...(saved ?? {}),
      who: { ...DEFAULT_BOARD.who, ...(saved?.who ?? {}) },
    };
  } catch {
    return DEFAULT_BOARD;
  }
}

export async function saveBoardSettings(settings: BoardSettings): Promise<void> {
  await updateSetting('board', settings as unknown as Json);
}

/** May this person use the board? Admins (settings.manage) always may. */
export function canUseBoard(settings: BoardSettings, profile: MyProfile | null, isAdmin: boolean): boolean {
  if (!settings.enabled || !profile) return false;
  if (isAdmin) return true;
  const { who } = settings;
  if (who.mode === 'roles') return who.roles.includes(profile.role_key);
  if (who.mode === 'users') return who.user_ids.includes(profile.id);
  return true;
}

// --- List or Board, kept on this phone ------------------------------------
export type LeadsView = 'list' | 'board';
const VIEW_KEY = 'leads.view';

export async function loadLeadsView(): Promise<LeadsView> {
  try {
    return (await AsyncStorage.getItem(VIEW_KEY)) === 'board' ? 'board' : 'list';
  } catch {
    return 'list';
  }
}

export function saveLeadsView(view: LeadsView): void {
  AsyncStorage.setItem(VIEW_KEY, view).catch(() => undefined);
}
