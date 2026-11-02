import { supabase } from '@/shared/lib/supabase';

// =====================================================================
// 🪪 Passport photo (website, in the browser)
//   1. cutout(): the server asks remove.bg for the person (see-through PNG)
//   2. findHead(): from the person's outline: top of the hair, the chin,
//      the middle (row widths: the head, then the neck, then the shoulders)
//   3. autoCrop(): the passport rule: the head (hair to chin) takes face%
//      of the height, a little room above, centred
//   4. render(): the exact size, the light-blue (or chosen) background,
//      brightness; the editor moves / zooms / turns it
// =====================================================================

const FUNCTIONS = `${process.env.EXPO_PUBLIC_SUPABASE_URL}/functions/v1`;

/** A picture ready to draw (the original, or the cut-out person) */
export type Pic = HTMLCanvasElement;

export async function loadPic(blob: Blob, maxSide = 2000): Promise<Pic> {
  const url = URL.createObjectURL(blob);
  try {
    const img = new Image();
    img.src = url;
    await img.decode();
    const scale = Math.min(1, maxSide / Math.max(img.naturalWidth, img.naturalHeight));
    const c = document.createElement('canvas');
    c.width = Math.round(img.naturalWidth * scale);
    c.height = Math.round(img.naturalHeight * scale);
    c.getContext('2d')!.drawImage(img, 0, 0, c.width, c.height);
    return c;
  } finally {
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
}

/** A quarter turn (90° right or left) */
export function turn(p: Pic, right: boolean): Pic {
  const c = document.createElement('canvas');
  c.width = p.height;
  c.height = p.width;
  const ctx = c.getContext('2d')!;
  ctx.translate(c.width / 2, c.height / 2);
  ctx.rotate(((right ? 1 : -1) * Math.PI) / 2);
  ctx.drawImage(p, -p.width / 2, -p.height / 2);
  return c;
}

function toBlob(c: HTMLCanvasElement, type: string, quality?: number): Promise<Blob> {
  return new Promise((resolve, reject) =>
    c.toBlob((b) => (b ? resolve(b) : reject(new Error('Could not make the picture.'))), type, quality),
  );
}

/** The person cut out (remove.bg through our server). Throws with a readable message. */
export async function cutout(p: Pic): Promise<Pic> {
  const { data } = await supabase.auth.getSession();
  const token = data.session?.access_token;
  if (!token) throw new Error('Please sign in again.');
  const form = new FormData();
  form.append('file', new File([await toBlob(p, 'image/jpeg', 0.9)], 'photo.jpg', { type: 'image/jpeg' }));
  let r: Response;
  try {
    r = await fetch(`${FUNCTIONS}/photo-cutout`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, apikey: process.env.EXPO_PUBLIC_SUPABASE_ANON_KEY ?? '' },
      body: form,
    });
  } catch {
    throw new Error('No internet connection.');
  }
  if (!r.ok) {
    const body = (await r.json().catch(() => ({}))) as { error?: string };
    throw new Error(
      r.status === 404 && !body.error
        ? 'The background remover is not set up yet.'
        : (body.error ?? 'Could not remove the background.'),
    );
  }
  return loadPic(await r.blob(), 4000);
}

/** Where the head is, in 0–1 of the picture (from the cut-out person's outline) */
export type Head = { top: number; chin: number; cx: number };

export function findHead(person: Pic): Head | null {
  const W = 240;
  const H = Math.max(1, Math.round((person.height / person.width) * W));
  const c = document.createElement('canvas');
  c.width = W;
  c.height = H;
  const ctx = c.getContext('2d', { willReadFrequently: true })!;
  ctx.drawImage(person, 0, 0, W, H);
  const alpha = ctx.getImageData(0, 0, W, H).data;

  // Each row: how wide the person is, and where its middle is
  const width: number[] = [];
  const mid: number[] = [];
  for (let y = 0; y < H; y++) {
    let l = -1;
    let r = -1;
    for (let x = 0; x < W; x++) {
      if (alpha[(y * W + x) * 4 + 3] > 128) {
        if (l < 0) l = x;
        r = x;
      }
    }
    width.push(l < 0 ? 0 : r - l + 1);
    mid.push(l < 0 ? 0 : (l + r) / 2);
  }
  const minW = W * 0.02;
  const top = width.findIndex((w) => w > minW);
  if (top < 0) return null;

  // Down from the hair: the head's width grows, then (below the chin) the shoulders
  let headW = 0;
  let sum = 0;
  let n = 0;
  for (let y = top; y < H; y++) {
    if (headW > 0 && y - top > 1.1 * headW) break;
    headW = Math.max(headW, width[y]);
    if (width[y] > minW) {
      sum += mid[y];
      n += 1;
    }
  }
  if (headW < minW || n === 0) return null;
  const chin = Math.min(H, top + 1.25 * headW);
  return { top: top / H, chin: chin / H, cx: sum / n / W };
}

/** The part of the picture to keep (0–1 of the picture; may go past the edges) */
export type Crop = { x: number; y: number; w: number; h: number };

/** The passport rule: the head (hair to chin) takes facePct% of the height */
export function autoCrop(head: Head, pic: Pic, outW: number, outH: number, facePct: number): Crop {
  const faceH = (head.chin - head.top) * pic.height; // px
  const cropH = faceH / (facePct / 100);
  const cropW = cropH * (outW / outH);
  const topPx = head.top * pic.height - 0.12 * cropH;
  const leftPx = head.cx * pic.width - cropW / 2;
  return { x: leftPx / pic.width, y: topPx / pic.height, w: cropW / pic.width, h: cropH / pic.height };
}

/** The whole picture, as large as fits the shape (no head found / by hand) */
export function centerCrop(pic: Pic, outW: number, outH: number): Crop {
  const want = outW / outH;
  const have = pic.width / pic.height;
  if (have > want) {
    const w = want / have;
    return { x: (1 - w) / 2, y: 0, w, h: 1 };
  }
  const h = have / want;
  return { x: 0, y: (1 - h) / 2, w: 1, h };
}

/** Make the final picture (exact size) */
export function render(
  photo: Pic,
  person: Pic | null,
  crop: Crop,
  o: { width: number; height: number; background: string | null; brightness: number },
): HTMLCanvasElement {
  const out = document.createElement('canvas');
  out.width = o.width;
  out.height = o.height;
  const ctx = out.getContext('2d')!;
  ctx.fillStyle = o.background ?? '#ffffff';
  ctx.fillRect(0, 0, o.width, o.height);

  const draw = (src: Pic, target: CanvasRenderingContext2D) =>
    target.drawImage(
      src,
      crop.x * src.width,
      crop.y * src.height,
      crop.w * src.width,
      crop.h * src.height,
      0,
      0,
      o.width,
      o.height,
    );

  const layer = document.createElement('canvas');
  layer.width = o.width;
  layer.height = o.height;
  const lc = layer.getContext('2d')!;
  lc.imageSmoothingQuality = 'high';
  lc.filter = o.brightness !== 1 ? `brightness(${o.brightness})` : 'none';
  draw(photo, lc);
  lc.filter = 'none';
  if (o.background && person) {
    // keep only the person (the cut-out's see-through parts take the background)
    lc.globalCompositeOperation = 'destination-in';
    draw(person, lc);
    lc.globalCompositeOperation = 'source-over';
  }
  ctx.drawImage(layer, 0, 0);
  return out;
}

export async function canvasToJpeg(c: HTMLCanvasElement, quality = 0.92): Promise<Blob> {
  return toBlob(c, 'image/jpeg', quality);
}
