import AsyncStorage from '@react-native-async-storage/async-storage';
import { useSyncExternalStore } from 'react';
import { Platform } from 'react-native';

import { supabase } from '@/shared/lib/supabase';
import { APP_COLLEGE, APP_PRODUCT, SYSTEM } from '@/features/web/brand';

// =====================================================================
// 🎨 Branding (Settings → Branding, Super Admin): the logo, names, words
//   and colours on the sign-in page, Home and the website.
//   The last one is kept on this phone/browser, so pages open at once
//   with it; a fresh copy is asked for in the background (also before
//   sign-in). Anything not set uses the app's own words and logo.
// =====================================================================

export type WebPoint = { icon: string; text: string };

export type Brand = {
  logo_url: string | null;
  short_name: string;
  college: string;
  product: string;
  system: string;
  login_title: string;
  login_note: string;
  login_footer: string;
  web_title: string;
  copyright: string;
  web_points: WebPoint[];
  hero_color: string;
  web_color: string;
  accent_color: string;
  home_greeting: boolean;
  home_names: boolean;
};

export const DEFAULT_WEB_POINTS: WebPoint[] = [
  { icon: '🎓', text: 'Students and admissions in one place' },
  { icon: '🏛', text: 'Submitted Online, Received by ITTC, NU ID' },
  { icon: '💰', text: 'Fees, discounts, payments and papers' },
];

export const DEFAULT_BRAND: Brand = {
  logo_url: null,
  short_name: 'ITTC',
  college: APP_COLLEGE,
  product: APP_PRODUCT,
  system: SYSTEM,
  login_title: 'Welcome back 👋',
  login_note: '',
  login_footer: 'New to the team?',
  web_title: '',
  copyright: '',
  web_points: DEFAULT_WEB_POINTS,
  hero_color: '#1D3FA8',
  web_color: '#0B2A4A',
  accent_color: '#EC202B',
  home_greeting: true,
  home_names: true,
};

/** What is saved (only what differs from the app's own; empty = default) */
export type BrandSaved = Partial<Omit<Brand, 'logo_url'>> & { logo_path?: string | null };

/** Only a picture in our own public "branding" folder (never another website) */
export const LOGO_PATH = /^logo\/[A-Za-z0-9_-]+\.(png|jpe?g|webp)$/;
export function logoUrl(path: string | null | undefined): string | null {
  if (!path || !LOGO_PATH.test(path)) return null;
  return `${process.env.EXPO_PUBLIC_SUPABASE_URL}/storage/v1/object/public/branding/${path}`;
}

const KEY = 'brand_v1';
const HEX = /^#[0-9A-Fa-f]{6}$/;

function merge(saved: BrandSaved | null | undefined): Brand {
  const s = saved ?? {};
  const text = (v: unknown, d: string) => (typeof v === 'string' && v.trim() ? v.trim() : d);
  const color = (v: unknown, d: string) => (typeof v === 'string' && HEX.test(v.trim()) ? v.trim().toUpperCase() : d);
  const points = Array.isArray(s.web_points)
    ? s.web_points
        .filter((p) => p && typeof p.text === 'string' && p.text.trim())
        .slice(0, 5)
        .map((p) => ({ icon: String(p.icon ?? '').slice(0, 8), text: p.text.trim() }))
    : null;
  return {
    logo_url: logoUrl(s.logo_path),
    short_name: text(s.short_name, DEFAULT_BRAND.short_name),
    college: text(s.college, DEFAULT_BRAND.college),
    product: text(s.product, DEFAULT_BRAND.product),
    system: text(s.system, DEFAULT_BRAND.system),
    login_title: text(s.login_title, DEFAULT_BRAND.login_title),
    login_note: text(s.login_note, ''),
    login_footer: text(s.login_footer, DEFAULT_BRAND.login_footer),
    web_title: text(s.web_title, ''),
    copyright: text(s.copyright, ''),
    web_points: points ?? DEFAULT_WEB_POINTS,
    hero_color: color(s.hero_color, DEFAULT_BRAND.hero_color),
    web_color: color(s.web_color, DEFAULT_BRAND.web_color),
    accent_color: color(s.accent_color, DEFAULT_BRAND.accent_color),
    home_greeting: typeof s.home_greeting === 'boolean' ? s.home_greeting : true,
    home_names: typeof s.home_names === 'boolean' ? s.home_names : true,
  };
}

// --- the store (one copy for the whole app) ---------------------------
let raw: BrandSaved = {};
let current: Brand = DEFAULT_BRAND;
const listeners = new Set<() => void>();

function set(next: BrandSaved, keep = true) {
  const json = JSON.stringify(next ?? {});
  if (json === JSON.stringify(raw)) return;
  raw = next ?? {};
  current = merge(raw);
  listeners.forEach((l) => l());
  if (keep) AsyncStorage.setItem(KEY, json).catch(() => undefined);
}

// the website can read its copy at once (no flash of the old logo)
if (Platform.OS === 'web') {
  try {
    const s = typeof localStorage !== 'undefined' ? localStorage.getItem(KEY) : null;
    if (s) {
      raw = JSON.parse(s) as BrandSaved;
      current = merge(raw);
    }
  } catch {
    // nothing kept
  }
}

// 📱 The phone's kept copy (read at start; the splash waits for it, at most a moment)
let keptRead: Promise<void> | null = null;
function readKept(): Promise<void> {
  if (Platform.OS === 'web') return Promise.resolve();
  keptRead ??= AsyncStorage.getItem(KEY)
    .then((s) => {
      if (s) set(JSON.parse(s) as BrandSaved, false);
    })
    .catch(() => undefined);
  return keptRead;
}

/** Resolves when the kept copy is in (never waits more than 300 ms) */
export function brandKept(): Promise<void> {
  return Promise.race([readKept(), new Promise<void>((r) => setTimeout(r, 300))]);
}

let started = false;
/** Read the kept copy, then ask for a fresh one (once per app start; again with force) */
export async function loadBrand(force = false): Promise<void> {
  if (started && !force) return;
  started = true;
  await readKept();
  try {
    const { data, error } = await supabase.rpc('app_brand' as never);
    // an old database without branding: keep the app's own
    if (!error && data && typeof data === 'object') set(data as BrandSaved);
  } catch {
    // offline: the kept copy stays
  }
}

const subscribe = (l: () => void) => {
  listeners.add(l);
  return () => {
    listeners.delete(l);
  };
};
const snapshot = () => current;

/** The branding to show (re-draws when it changes) */
export function useBrand(): Brand {
  return useSyncExternalStore(subscribe, snapshot, snapshot);
}

/** "© 2026 College" unless a line of its own is set */
export function copyrightLine(b: Brand): string {
  return b.copyright || `© ${new Date().getFullYear()} ${b.college}`;
}
