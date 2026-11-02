import { listPaperRules } from '@/features/files/uploadRules';
import { getSetting } from '@/features/settings/api';
import { supabase } from '@/shared/lib/supabase';
import type { Json } from '@/shared/types/database';

// =====================================================================
// 🖼 Photo Studio sizes
//   • the papers' own picture sizes (Settings → Upload rules)
//   • sizes people saved here (everyone sees them; admins and the
//     Admission Officer save / remove)
//   • Custom: px, mm or inches (+ DPI)
// =====================================================================

export type Unit = 'px' | 'mm' | 'in';

export type Preset = {
  id: string;
  name: string;
  width: number;
  height: number;
  unit: Unit;
  /** dots per inch (mm / in → px; the print sheet) */
  dpi: number;
  /** the head (hair to chin): % of the height */
  face_pct: number;
  /** room above the hair: % of the height */
  top_pct: number;
  /** background colour */
  bg: string;
  /** largest file (KB); 0 = no limit */
  max_kb: number;
  format: 'jpg' | 'png';
  /** where it came from */
  source?: 'paper' | 'saved';
};

export const DEFAULT_BG = '#CFE6FA';

export const CUSTOM: Preset = {
  id: 'custom',
  name: 'Custom',
  width: 300,
  height: 300,
  unit: 'px',
  dpi: 300,
  face_pct: 55,
  top_pct: 10,
  bg: DEFAULT_BG,
  max_kb: 0,
  format: 'jpg',
};

/** The size in pixels */
export function pixels(p: Pick<Preset, 'width' | 'height' | 'unit' | 'dpi'>): {
  w: number;
  h: number;
} {
  const f = p.unit === 'px' ? 1 : p.unit === 'mm' ? p.dpi / 25.4 : p.dpi;
  return {
    w: Math.max(16, Math.round(p.width * f)),
    h: Math.max(16, Math.round(p.height * f)),
  };
}

/** The size on paper, in inches (for the print sheet) */
export function inches(p: Pick<Preset, 'width' | 'height' | 'unit' | 'dpi'>): {
  w: number;
  h: number;
} {
  if (p.unit === 'in') return { w: p.width, h: p.height };
  if (p.unit === 'mm') return { w: p.width / 25.4, h: p.height / 25.4 };
  const dpi = p.dpi || 300;
  return { w: p.width / dpi, h: p.height / dpi };
}

export function sizeLabel(p: Preset): string {
  const { w, h } = pixels(p);
  return p.unit === 'px' ? `${w} × ${h} px` : `${p.width} × ${p.height} ${p.unit} · ${w} × ${h} px`;
}

function clean(raw: Partial<Preset>): Preset | null {
  const width = Number(raw.width);
  const height = Number(raw.height);
  if (!raw.name || !(width > 0) || !(height > 0)) return null;
  return {
    ...CUSTOM,
    ...raw,
    id: String(raw.id ?? `p${Math.random().toString(36).slice(2, 9)}`),
    name: String(raw.name),
    width,
    height,
    unit: raw.unit === 'mm' || raw.unit === 'in' ? raw.unit : 'px',
    dpi: Number(raw.dpi) > 0 ? Number(raw.dpi) : 300,
    face_pct: Number(raw.face_pct) > 0 ? Number(raw.face_pct) : 55,
    top_pct: Number(raw.top_pct) >= 0 ? Number(raw.top_pct) : 10,
    bg: typeof raw.bg === 'string' && /^#[0-9a-f]{6}$/i.test(raw.bg) ? raw.bg : DEFAULT_BG,
    max_kb: Number(raw.max_kb) > 0 ? Number(raw.max_kb) : 0,
    format: raw.format === 'png' ? 'png' : 'jpg',
    source: 'saved',
  };
}

export async function listSavedPresets(): Promise<Preset[]> {
  const raw = await getSetting<Partial<Preset>[]>('photo_presets').catch(() => null);
  return (Array.isArray(raw) ? raw : []).map(clean).filter((p): p is Preset => !!p);
}

export async function saveSavedPresets(list: Preset[]): Promise<void> {
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  const value = list.map(({ source, ...p }) => p);
  const { error } = await supabase.rpc('set_photo_presets', {
    p_presets: value as unknown as Json,
  });
  if (error) {
    throw new Error(
      /could not find the function/i.test(error.message)
        ? 'The database is not updated yet (npx supabase db push).'
        : error.message,
    );
  }
}

/** The papers with an exact picture size (Upload rules) */
export async function paperPresets(): Promise<Preset[]> {
  const rules = await listPaperRules().catch(() => []);
  return rules
    .filter((r) => r.is_active && r.img_width && r.img_height)
    .map((r) => ({
      ...CUSTOM,
      id: `paper:${r.id}`,
      name: r.name,
      width: r.img_width!,
      height: r.img_height!,
      unit: 'px' as const,
      face_pct: r.passport ? r.face_pct || 55 : CUSTOM.face_pct,
      bg: r.passport ? r.bg_color || DEFAULT_BG : DEFAULT_BG,
      max_kb: r.img_max_kb ?? 0,
      source: 'paper' as const,
    }));
}
