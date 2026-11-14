import AsyncStorage from '@react-native-async-storage/async-storage';
import { File, UploadType } from 'expo-file-system';
import { useSyncExternalStore } from 'react';
import { Platform, type ImageSourcePropType } from 'react-native';

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
export type BrandSaved = Partial<Omit<Brand, 'logo_url'>> & { logo_url?: string | null };

const KEY = 'brand_v1';
const HEX = /^#[0-9A-Fa-f]{6}$/;

function merge(saved: BrandSaved | null | undefined): Brand {
  const s = saved ?? {};
  const text = (v: unknown, d: string) => (typeof v === 'string' && v.trim() ? v.trim() : d);
  const color = (v: unknown, d: string) => (typeof v === 'string' && HEX.test(v) ? v.toUpperCase() : d);
  const points = Array.isArray(s.web_points)
    ? s.web_points
        .filter((p) => p && typeof p.text === 'string' && p.text.trim())
        .slice(0, 5)
        .map((p) => ({ icon: String(p.icon ?? '').slice(0, 8), text: p.text.trim() }))
    : null;
  return {
    logo_url: typeof s.logo_url === 'string' && s.logo_url ? s.logo_url : null,
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

function set(next: BrandSaved) {
  const json = JSON.stringify(next ?? {});
  if (json === JSON.stringify(raw)) return;
  raw = next ?? {};
  current = merge(raw);
  listeners.forEach((l) => l());
  AsyncStorage.setItem(KEY, json).catch(() => undefined);
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

let started = false;
/** Read the kept copy, then ask for a fresh one (once per app start; again with force) */
export async function loadBrand(force = false): Promise<void> {
  if (started && !force) return;
  started = true;
  if (!force && Platform.OS !== 'web') {
    try {
      const s = await AsyncStorage.getItem(KEY);
      if (s) set(JSON.parse(s) as BrandSaved);
    } catch {
      // nothing kept
    }
  }
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

/** The logo picture: the uploaded one, or the app's own */
export function logoSource(b: Brand, own: ImageSourcePropType): ImageSourcePropType {
  return b.logo_url ? { uri: b.logo_url } : own;
}

/** "© 2026 College" unless a line of its own is set */
export function copyrightLine(b: Brand): string {
  return b.copyright || `© ${new Date().getFullYear()} ${b.college}`;
}

// --- Settings → Branding (Super Admin) ----------------------------------

/** What is saved now (for the Settings page; empty fields = the app's own) */
export async function getBrandSaved(): Promise<BrandSaved> {
  const { data, error } = await supabase.from('app_settings').select('value').eq('key', 'branding').maybeSingle();
  if (error) throw new Error(error.message);
  if (!data) throw new Error('The database is not updated yet (Branding).');
  return ((data as { value: BrandSaved }).value ?? {}) as BrandSaved;
}

export async function saveBrand(next: BrandSaved): Promise<void> {
  const { data, error } = await supabase
    .from('app_settings')
    .update({ value: next as never })
    .eq('key', 'branding')
    .select('key');
  if (error) throw new Error(error.message);
  if (!data?.length) throw new Error('Could not save. Only a Super Admin can change the branding.');
  await loadBrand(true);
}

/** 🖼 A new logo picture → its public link (saved with the rest on Save) */
export async function uploadLogo(uri: string, mime = 'image/png'): Promise<string> {
  const { data } = await supabase.auth.getSession();
  const session = data.session;
  if (!session) throw new Error('Please sign in again.');
  const ext = mime.includes('png') ? 'png' : mime.includes('webp') ? 'webp' : 'jpg';
  const path = `logo/${Date.now()}.${ext}`;
  if (Platform.OS === 'web') {
    const blob = await (await fetch(uri)).blob();
    if (blob.size > 1024 * 1024) throw new Error('The picture is too big (1 MB at most).');
    const { error } = await supabase.storage.from('branding').upload(path, blob, { contentType: mime });
    if (error) throw new Error(/bucket/i.test(error.message) ? 'The database is not updated yet.' : error.message);
  } else {
    const res = await new File(uri).upload(
      `${process.env.EXPO_PUBLIC_SUPABASE_URL}/storage/v1/object/branding/${path}`,
      {
        httpMethod: 'POST',
        uploadType: UploadType.BINARY_CONTENT,
        mimeType: mime,
        headers: {
          Authorization: `Bearer ${session.access_token}`,
          apikey: process.env.EXPO_PUBLIC_SUPABASE_ANON_KEY ?? '',
          'Content-Type': mime,
        },
      },
    );
    if (res.status < 200 || res.status >= 300) {
      if (/bucket not found/i.test(res.body)) throw new Error('The database is not updated yet.');
      if (/too large|exceeded|size/i.test(res.body)) throw new Error('The picture is too big (1 MB at most).');
      throw new Error('Could not upload the picture.');
    }
  }
  return supabase.storage.from('branding').getPublicUrl(path).data.publicUrl;
}
