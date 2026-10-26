// ---------------------------------------------------------------------
// Colors
// ---------------------------------------------------------------------
export const colors = {
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
} as const;

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