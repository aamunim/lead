import { useEffect } from 'react';
import { Appearance, AppState, DevSettings, Platform } from 'react-native';

import { Updates } from '@/features/updates/api';
import { isDark, phoneThemeChoice, savePhoneThemeChoice, type PhoneTheme } from '@/shared/theme';

// =====================================================================
// 🌗 More → Appearance: Light · Dark · System (the phone's setting).
//   Every screen takes its colours once when it loads, so a change
//   restarts the app for a moment (the same as on the website).
// =====================================================================

export const APPEARANCE: { value: PhoneTheme; label: string; icon: string }[] = [
  { value: 'system', label: 'System', icon: '📱' },
  { value: 'light', label: 'Light', icon: '☀️' },
  { value: 'dark', label: 'Dark', icon: '🌙' },
];

export const currentAppearance = phoneThemeChoice;

async function restart(): Promise<void> {
  try {
    if (Updates && !__DEV__) await Updates.reloadAsync();
    else DevSettings.reload();
  } catch {
    DevSettings.reload();
  }
}

/** Saves the choice and restarts the app when the colours change */
export async function setAppearance(t: PhoneTheme): Promise<void> {
  savePhoneThemeChoice(t);
  const wantDark = t === 'system' ? Appearance.getColorScheme() === 'dark' : t === 'dark';
  if (wantDark !== isDark) await restart();
}

/** "System": the phone switched light / dark → show the app the same way */
export function ThemeFollower() {
  useEffect(() => {
    if (Platform.OS === 'web') return;
    const check = () => {
      if (phoneThemeChoice() !== 'system') return;
      if ((Appearance.getColorScheme() === 'dark') !== isDark) restart();
    };
    const a = AppState.addEventListener('change', (s) => s === 'active' && check());
    const b = Appearance.addChangeListener(() => {
      if (AppState.currentState === 'active') check();
    });
    return () => {
      a.remove();
      b.remove();
    };
  }, []);
  return null;
}
