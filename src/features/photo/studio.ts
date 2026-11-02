import type { Face } from './faceDetect';
import { findHead, type Pic } from '@/features/files/passport';

// =====================================================================
// 🖼 Photo Studio, the drawing part (website only: canvas in the browser)
//   A Look says where the photo sits in the output and how it looks:
//   centre (cx, cy in output px), scale (output px per photo px), tilt,
//   mirror, light, the background colour and how soft its edge is.
//   The same drawing makes the small preview and the full picture.
// =====================================================================

export type Look = {
  cx: number;
  cy: number;
  scale: number;
  /** degrees, a small straightening (the quarter turns turn the photo itself) */
  tilt: number;
  flip: boolean;
  brightness: number;
  contrast: number;
  saturation: number;
  /** -1 cool … +1 warm */
  warmth: number;
  bgOn: boolean;
  bg: string;
  /** soft edge around the person, output px */
  feather: number;
};

export const NEUTRAL = { brightness: 1, contrast: 1, saturation: 1, warmth: 0 };

/** Where the head is, in px of the photo */
export type HeadBox = {
  /** the middle of the head, at the top of the hair */
  topX: number;
  topY: number;
  /** the chin */
  chinX: number;
  chinY: number;
  /** degrees the head leans (eyes not level); 0 when not known */
  roll: number;
  /** how it was found */
  by: 'face' | 'outline';
};

const rad = (d: number) => (d * Math.PI) / 180;

// ---------------------------------------------------------------------
// Finding the head
// ---------------------------------------------------------------------

/** The top of the hair above the face, from the cut-out (see-through outside the person) */
function hairTop(mask: Pic, photoW: number, x: number, from: number, to: number, half: number): number | null {
  const f = mask.width / photoW;
  const x0 = Math.max(0, Math.round((x - half) * f));
  const x1 = Math.min(mask.width, Math.round((x + half) * f));
  const y0 = Math.max(0, Math.round(from * f));
  const y1 = Math.min(mask.height, Math.round(to * f));
  if (x1 - x0 < 2 || y1 - y0 < 2) return null;
  const data = mask.getContext('2d', { willReadFrequently: true })!.getImageData(x0, y0, x1 - x0, y1 - y0).data;
  const w = x1 - x0;
  const need = Math.max(2, Math.round(w * 0.08));
  for (let y = 0; y < y1 - y0; y++) {
    let n = 0;
    for (let i = 0; i < w; i++) if (data[(y * w + i) * 4 + 3] > 128) n += 1;
    if (n >= need) return (y0 + y) / f;
  }
  return null;
}

/** From the face finder (eyes and mouth), the hair from the cut-out when there is one */
export function headFromFace(face: Face, photo: Pic, mask: Pic | null): HeadBox {
  const { rightEye, leftEye, mouth } = face;
  if (rightEye && leftEye && mouth) {
    const ex = (rightEye.x + leftEye.x) / 2;
    const ey = (rightEye.y + leftEye.y) / 2;
    // Image-left eye to image-right eye; the face's "down" is at right angles
    const [a, b] = rightEye.x <= leftEye.x ? [rightEye, leftEye] : [leftEye, rightEye];
    const roll = (Math.atan2(b.y - a.y, b.x - a.x) * 180) / Math.PI;
    const dm = Math.hypot(mouth.x - ex, mouth.y - ey) || face.h * 0.4;
    const ux = -Math.sin(rad(roll));
    const uy = Math.cos(rad(roll));
    // Eyes sit about half way between the top of the head and the chin
    const chinX = ex + ux * dm * 1.65;
    const chinY = ey + uy * dm * 1.65;
    let topX = ex - ux * dm * 1.8;
    let topY = ey - uy * dm * 1.8;
    if (mask) {
      const hair = hairTop(mask, photo.width, ex, ey - dm * 2.8, ey - dm * 1.1, face.w * 0.3);
      if (hair != null) {
        const t = (ey - hair) / uy;
        topX = ex - ux * t;
        topY = hair;
      }
    }
    return {
      topX,
      topY,
      chinX,
      chinY,
      roll: Math.abs(roll) <= 20 ? roll : 0,
      by: 'face',
    };
  }
  const cx = face.x + face.w / 2;
  let top = face.y - face.h * 0.42;
  if (mask) {
    const hair = hairTop(mask, photo.width, cx, face.y - face.h * 1.0, face.y + face.h * 0.2, face.w * 0.3);
    if (hair != null) top = hair;
  }
  return {
    topX: cx,
    topY: top,
    chinX: cx,
    chinY: face.y + face.h * 1.05,
    roll: 0,
    by: 'face',
  };
}

/** No face found: from the cut-out's outline */
export function headFromOutline(photo: Pic, mask: Pic): HeadBox | null {
  const h = findHead(mask);
  if (!h) return null;
  const x = h.cx * photo.width;
  return {
    topX: x,
    topY: h.top * photo.height,
    chinX: x,
    chinY: h.chin * photo.height,
    roll: 0,
    by: 'outline',
  };
}

// ---------------------------------------------------------------------
// Placing
// ---------------------------------------------------------------------

/** Where a photo point lands in the output */
export function toOutput(look: Look, photo: Pic, px: number, py: number): { x: number; y: number } {
  const dx = (px - photo.width / 2) * look.scale * (look.flip ? -1 : 1);
  const dy = (py - photo.height / 2) * look.scale;
  const c = Math.cos(rad(look.tilt));
  const s = Math.sin(rad(look.tilt));
  return { x: look.cx + dx * c - dy * s, y: look.cy + dx * s + dy * c };
}

/** The head takes facePct% of the height, topPct% room above, in the middle */
export function placeHead(
  base: Look,
  photo: Pic,
  head: HeadBox,
  W: number,
  H: number,
  facePct: number,
  topPct: number,
  straighten: boolean,
): Look {
  const headPx = Math.hypot(head.chinX - head.topX, head.chinY - head.topY);
  const scale = ((facePct / 100) * H) / Math.max(1, headPx);
  const tilt = straighten ? -head.roll : 0;
  const look: Look = { ...base, scale, tilt, cx: 0, cy: 0 };
  const mx = (head.topX + head.chinX) / 2;
  const my = (head.topY + head.chinY) / 2;
  const at = toOutput(look, photo, mx, my);
  const wantY = (topPct / 100) * H + ((facePct / 100) * H) / 2;
  return { ...look, cx: W / 2 - at.x, cy: wantY - at.y };
}

/** The whole photo fills the frame (no head found) */
export function fillFrame(base: Look, photo: Pic, W: number, H: number): Look {
  const scale = Math.max(W / photo.width, H / photo.height);
  return { ...base, scale, tilt: 0, cx: W / 2, cy: H / 2 };
}

/** Zoom around a point of the output */
export function zoomAt(look: Look, factor: number, ox: number, oy: number): Look {
  const scale = Math.min(40, Math.max(0.01, look.scale * factor));
  const f = scale / look.scale;
  return {
    ...look,
    scale,
    cx: ox + (look.cx - ox) * f,
    cy: oy + (look.cy - oy) * f,
  };
}

// ---------------------------------------------------------------------
// Drawing
// ---------------------------------------------------------------------

function filterOf(look: Look): string {
  const parts: string[] = [];
  if (look.brightness !== 1) parts.push(`brightness(${look.brightness})`);
  if (look.contrast !== 1) parts.push(`contrast(${look.contrast})`);
  if (look.saturation !== 1) parts.push(`saturate(${look.saturation})`);
  if (look.warmth > 0) parts.push(`sepia(${(look.warmth * 0.35).toFixed(3)})`);
  if (look.warmth < 0) parts.push(`hue-rotate(${(look.warmth * 12).toFixed(1)}deg)`);
  return parts.length ? parts.join(' ') : 'none';
}

function place(ctx: CanvasRenderingContext2D, look: Look, photo: Pic, k: number) {
  ctx.setTransform(k, 0, 0, k, 0, 0);
  ctx.translate(look.cx, look.cy);
  ctx.rotate(rad(look.tilt));
  ctx.scale(look.flip ? -look.scale : look.scale, look.scale);
}

/**
 * Draw into a canvas of (W·k) × (H·k). k < 1 for the preview.
 * plain: the photo as it came (no light, no background): "Before".
 */
export function drawLook(
  target: HTMLCanvasElement,
  W: number,
  H: number,
  k: number,
  photo: Pic,
  mask: Pic | null,
  look: Look,
  plain = false,
): void {
  const cw = Math.max(1, Math.round(W * k));
  const ch = Math.max(1, Math.round(H * k));
  if (target.width !== cw) target.width = cw;
  if (target.height !== ch) target.height = ch;
  const ctx = target.getContext('2d')!;
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  const cut = !plain && look.bgOn && !!mask;
  ctx.fillStyle = cut ? look.bg : '#ffffff';
  ctx.fillRect(0, 0, cw, ch);

  const layer = document.createElement('canvas');
  layer.width = cw;
  layer.height = ch;
  const lc = layer.getContext('2d')!;
  lc.imageSmoothingEnabled = true;
  lc.imageSmoothingQuality = 'high';
  place(lc, look, photo, k);
  lc.filter = plain ? 'none' : filterOf(look);
  lc.drawImage(photo, -photo.width / 2, -photo.height / 2);
  lc.filter = 'none';
  if (cut && mask) {
    // keep the person only; a little blur makes the edge soft
    lc.globalCompositeOperation = 'destination-in';
    if (look.feather > 0) lc.filter = `blur(${Math.max(0.3, look.feather * k)}px)`;
    lc.drawImage(mask, -photo.width / 2, -photo.height / 2, photo.width, photo.height);
    lc.filter = 'none';
    lc.globalCompositeOperation = 'source-over';
  }
  ctx.drawImage(layer, 0, 0);
}

// ---------------------------------------------------------------------
// Auto light: brings the face to a normal brightness and spread
// ---------------------------------------------------------------------
export function autoLight(
  photo: Pic,
  mask: Pic | null,
  /** the face (px of the photo): its skin sets the brightness */
  face?: { x: number; y: number; w: number; h: number } | null,
): Pick<Look, 'brightness' | 'contrast' | 'saturation'> {
  const S = 160;
  const k = S / Math.max(photo.width, photo.height);
  const w = Math.max(1, Math.round(photo.width * k));
  const h = Math.max(1, Math.round(photo.height * k));
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  const ctx = c.getContext('2d', { willReadFrequently: true })!;
  ctx.drawImage(photo, 0, 0, w, h);
  const px = ctx.getImageData(0, 0, w, h).data;
  let alpha: Uint8ClampedArray | null = null;
  if (mask) {
    ctx.clearRect(0, 0, w, h);
    ctx.drawImage(mask, 0, 0, w, h);
    alpha = ctx.getImageData(0, 0, w, h).data;
  }
  const hist = new Array<number>(256).fill(0);
  const faceHist = new Array<number>(256).fill(0);
  let n = 0;
  let nf = 0;
  for (let i = 0; i < px.length; i += 4) {
    if (alpha && alpha[i + 3] < 128) continue;
    if (face) {
      const x = ((i / 4) % w) / k;
      const y = Math.floor(i / 4 / w) / k;
      if (
        x > face.x + face.w * 0.2 &&
        x < face.x + face.w * 0.8 &&
        y > face.y + face.h * 0.25 &&
        y < face.y + face.h * 0.85
      ) {
        faceHist[Math.round(0.2126 * px[i] + 0.7152 * px[i + 1] + 0.0722 * px[i + 2])] += 1;
        nf += 1;
      }
    }
    const l = Math.round(0.2126 * px[i] + 0.7152 * px[i + 1] + 0.0722 * px[i + 2]);
    hist[l] += 1;
    n += 1;
  }
  if (n < 50) return { brightness: 1, contrast: 1, saturation: 1 };
  const pct = (h: number[], total: number, p: number) => {
    let acc = 0;
    for (let v = 0; v < 256; v++) {
      acc += h[v];
      if (acc >= total * p) return v;
    }
    return 255;
  };
  const lo = pct(hist, n, 0.02);
  const hi = pct(hist, n, 0.98);
  const contrast = Math.min(1.3, Math.max(0.9, 210 / Math.max(40, hi - lo)));
  // The face's skin to a normal light (else the whole person to a middle grey)
  const brightness =
    nf >= 20
      ? Math.min(1.3, Math.max(0.8, 150 / Math.max(30, pct(faceHist, nf, 0.5))))
      : Math.min(1.3, Math.max(0.8, 120 / Math.max(30, pct(hist, n, 0.5))));
  return {
    brightness: Math.round(brightness * 100) / 100,
    contrast: Math.round(contrast * 100) / 100,
    saturation: 1.06,
  };
}

// ---------------------------------------------------------------------
// The file
// ---------------------------------------------------------------------
function toBlob(c: HTMLCanvasElement, type: string, quality?: number): Promise<Blob> {
  return new Promise((resolve, reject) =>
    c.toBlob((b) => (b ? resolve(b) : reject(new Error('Could not make the picture.'))), type, quality),
  );
}

/** Write the DPI into a JPEG (JFIF header), so it prints at the right size */
async function withDpi(jpeg: Blob, dpi: number): Promise<Blob> {
  const bytes = new Uint8Array(await jpeg.arrayBuffer());
  // FF D8 FF E0 len(2) 'J' 'F' 'I' 'F' 0 ver(2) units density-x(2) density-y(2)
  if (
    bytes[0] === 0xff &&
    bytes[1] === 0xd8 &&
    bytes[2] === 0xff &&
    bytes[3] === 0xe0 &&
    String.fromCharCode(bytes[6], bytes[7], bytes[8], bytes[9]) === 'JFIF'
  ) {
    const d = Math.max(1, Math.min(65535, Math.round(dpi)));
    bytes[13] = 1;
    bytes[14] = d >> 8;
    bytes[15] = d & 0xff;
    bytes[16] = d >> 8;
    bytes[17] = d & 0xff;
    return new Blob([bytes], { type: 'image/jpeg' });
  }
  return jpeg;
}

export type Made = { blob: Blob; quality: number | null; underLimit: boolean };

/** JPEG under maxKb (best quality that fits), or PNG */
export async function makeFile(c: HTMLCanvasElement, format: 'jpg' | 'png', maxKb: number, dpi: number): Promise<Made> {
  if (format === 'png') {
    const blob = await toBlob(c, 'image/png');
    return {
      blob,
      quality: null,
      underLimit: !maxKb || blob.size <= maxKb * 1024,
    };
  }
  const limit = maxKb > 0 ? maxKb * 1024 : Infinity;
  let best = await toBlob(c, 'image/jpeg', 0.95);
  if (best.size <= limit) return { blob: await withDpi(best, dpi), quality: 0.95, underLimit: true };
  let lo = 0.2;
  let hi = 0.95;
  let found: { blob: Blob; q: number } | null = null;
  for (let i = 0; i < 7; i++) {
    const q = (lo + hi) / 2;
    const b = await toBlob(c, 'image/jpeg', q);
    if (b.size <= limit) {
      found = { blob: b, q };
      lo = q;
    } else {
      hi = q;
      best = b;
    }
  }
  if (found)
    return {
      blob: await withDpi(found.blob, dpi),
      quality: found.q,
      underLimit: true,
    };
  const smallest = await toBlob(c, 'image/jpeg', 0.2);
  return {
    blob: await withDpi(smallest.size < best.size ? smallest : best, dpi),
    quality: 0.2,
    underLimit: false,
  };
}

export function download(blob: Blob, name: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
}

// ---------------------------------------------------------------------
// 🖨 Print sheet: copies on 4R (6 × 4 in) or A4, with cut lines
// ---------------------------------------------------------------------
export type Paper = '4r' | 'a4';
export const PAPERS: Record<Paper, { label: string; w: number; h: number }> = {
  '4r': { label: '4R (6 × 4 in)', w: 6, h: 4 },
  a4: { label: 'A4', w: 8.27, h: 11.69 },
};

export function sheetFits(paper: Paper, photoIn: { w: number; h: number }): number {
  const p = PAPERS[paper];
  const gap = 0.1;
  const margin = 0.15;
  const cols = Math.floor((p.w - 2 * margin + gap) / (photoIn.w + gap));
  const rows = Math.floor((p.h - 2 * margin + gap) / (photoIn.h + gap));
  return Math.max(0, cols) * Math.max(0, rows);
}

export function makeSheet(
  photo: HTMLCanvasElement,
  photoIn: { w: number; h: number },
  paper: Paper,
  copies: number,
  dpi = 300,
): HTMLCanvasElement {
  const p = PAPERS[paper];
  const gap = 0.1;
  const margin = 0.15;
  const cols = Math.max(1, Math.floor((p.w - 2 * margin + gap) / (photoIn.w + gap)));
  const rows = Math.max(1, Math.floor((p.h - 2 * margin + gap) / (photoIn.h + gap)));
  const n = Math.min(copies, cols * rows);
  const usedCols = Math.min(cols, n);
  const usedRows = Math.ceil(n / usedCols);
  const c = document.createElement('canvas');
  c.width = Math.round(p.w * dpi);
  c.height = Math.round(p.h * dpi);
  const ctx = c.getContext('2d')!;
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, c.width, c.height);
  const pw = photoIn.w * dpi;
  const ph = photoIn.h * dpi;
  const g = gap * dpi;
  const x0 = (c.width - (usedCols * pw + (usedCols - 1) * g)) / 2;
  const y0 = (c.height - (usedRows * ph + (usedRows - 1) * g)) / 2;
  ctx.imageSmoothingQuality = 'high';
  ctx.strokeStyle = '#9aa3b2';
  ctx.lineWidth = 1;
  for (let i = 0; i < n; i++) {
    const x = Math.round(x0 + (i % usedCols) * (pw + g));
    const y = Math.round(y0 + Math.floor(i / usedCols) * (ph + g));
    ctx.drawImage(photo, x, y, Math.round(pw), Math.round(ph));
    ctx.strokeRect(x - 0.5, y - 0.5, Math.round(pw) + 1, Math.round(ph) + 1);
  }
  return c;
}

export async function sheetFile(c: HTMLCanvasElement, dpi = 300): Promise<Blob> {
  return withDpi(await toBlob(c, 'image/jpeg', 0.95), dpi);
}

// ---------------------------------------------------------------------
// 🕘 The last results, kept in this browser only (IndexedDB)
// ---------------------------------------------------------------------
export type Recent = {
  id: string;
  name: string;
  blob: Blob;
  w: number;
  h: number;
  at: number;
};
const DB = 'photo-studio';
const STORE = 'recent';
const KEEP = 12;

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE, { keyPath: 'id' });
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

export async function listRecent(): Promise<Recent[]> {
  try {
    const db = await openDb();
    const all = await new Promise<Recent[]>((resolve, reject) => {
      const req = db.transaction(STORE).objectStore(STORE).getAll();
      req.onsuccess = () => resolve(req.result as Recent[]);
      req.onerror = () => reject(req.error);
    });
    db.close();
    return all.sort((a, b) => b.at - a.at);
  } catch {
    return [];
  }
}

export async function addRecent(item: Omit<Recent, 'id' | 'at'>): Promise<Recent[]> {
  try {
    const db = await openDb();
    const old = await listRecent();
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(STORE, 'readwrite');
      const store = tx.objectStore(STORE);
      store.put({
        ...item,
        id: `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
        at: Date.now(),
      });
      for (const r of old.slice(KEEP - 1)) store.delete(r.id);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
    db.close();
  } catch {
    // private window: nothing is kept
  }
  return listRecent();
}

export async function clearRecent(): Promise<void> {
  try {
    const db = await openDb();
    await new Promise<void>((resolve) => {
      const tx = db.transaction(STORE, 'readwrite');
      tx.objectStore(STORE).clear();
      tx.oncomplete = () => resolve();
      tx.onerror = () => resolve();
    });
    db.close();
  } catch {
    // nothing
  }
}
