import { Platform } from 'react-native';

// ---------------------------------------------------------------------
// Colors
// ---------------------------------------------------------------------
const light = {
  // Brand
  primary: '#3557D4',
  primaryDark: '#2440A8',
  primarySoft: '#E1E8FB',
  accent: '#F2A93B',

  // Text
  text: '#14213D',
  textMuted: '#5B6478',
  textOnPrimary: '#FFFFFF',

  // Surfaces
  background: '#F7F8FB',
  surface: '#FFFFFF',
  border: '#E3E7F0',

  // Status
  success: '#1F6B42',
  successSoft: '#E3F3EA',
  warning: '#8A5300',
  warningSoft: '#FDEFD8',
  danger: '#B23A0B',
  dangerSoft: '#FDE6DC',
  info: '#2440A8',
  infoSoft: '#E1E8FB',

  // Lead rating
  hot: '#D9480F',
  warm: '#E0901C',
  cold: '#64748B',
};

export type Colors = { [K in keyof typeof light]: string };

// 🌐🌙 The website's dark colours (the phone app stays light)
const dark: Colors = {
  primary: '#6E8BFF',
  primaryDark: '#4C6BE6',
  primarySoft: '#1E2949',
  accent: '#F2A93B',

  text: '#E7EBF4',
  textMuted: '#9AA4BB',
  textOnPrimary: '#FFFFFF',

  background: '#0D1322',
  surface: '#161E31',
  border: '#28324B',

  success: '#3FB97A',
  successSoft: '#14301F',
  warning: '#E6A845',
  warningSoft: '#3A2B12',
  danger: '#F2805E',
  dangerSoft: '#3C1D15',
  info: '#8CA6FF',
  infoSoft: '#1E2949',

  hot: '#F26B3A',
  warm: '#E9A43C',
  cold: '#94A3B8',
};

/** 🌐 Website colour choice (Settings in the top bar): light / dark / system */
export type WebTheme = 'light' | 'dark' | 'system';
export const WEB_THEME_KEY = 'web_theme';

export function webThemeChoice(): WebTheme {
  try {
    const raw = typeof localStorage !== 'undefined' ? localStorage.getItem(WEB_THEME_KEY) : null;
    const v = raw ? (JSON.parse(raw) as WebTheme) : 'system';
    return v === 'light' || v === 'dark' ? v : 'system';
  } catch {
    return 'system';
  }
}

function startsDark(): boolean {
  if (Platform.OS !== 'web' || typeof window === 'undefined') return false;
  const choice = webThemeChoice();
  if (choice !== 'system') return choice === 'dark';
  return !!window.matchMedia?.('(prefers-color-scheme: dark)').matches;
}

/** True when the website is shown in dark colours (always false on the phone) */
export const isDark = startsDark();

// Chosen once when the page opens (all styles are built from it); a new
// choice reloads the page.
export const colors: Colors = isDark ? dark : light;

// ---------------------------------------------------------------------
// Spacing (4-point scale)
// ---------------------------------------------------------------------
export const spacing = {
  xs: 4,
  sm: 8,
  md: 12,
  lg: 16,
  xl: 24,
  xxl: 32,
} as const;

// ---------------------------------------------------------------------
// Corner radius
// ---------------------------------------------------------------------
export const radius = {
  sm: 8,
  md: 12,
  lg: 16,
  xl: 24,
  pill: 999,
} as const;

// ---------------------------------------------------------------------
// Font sizes and weights
// ---------------------------------------------------------------------
export const fontSize = {
  caption: 12,
  small: 14,
  body: 16,
  title: 20,
  heading: 24,
  display: 32,
} as const;

export const fontWeight = {
  regular: '400',
  medium: '500',
  semibold: '600',
  bold: '700',
} as const;

export const theme = { colors, spacing, radius, fontSize, fontWeight } as const;
export type Theme = typeof theme;
