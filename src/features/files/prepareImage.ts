// =====================================================================
// 🖼 Website: a picture made to the paper's size and weight before upload
//   • exact size (e.g. 300 × 300): stretched to exactly that, nothing cut
//     off (the shape may change)
//   • else: the longest side at most N px (shape kept)
//   Then JPEG quality steps down (0.9 → 0.4) until it is under the KB
//   limit. Runs in the browser (canvas); the phone app uploads as is.
// =====================================================================

export type Prepared = { blob: Blob; width: number; height: number; quality: number; underLimit: boolean };

async function loadImage(blob: Blob): Promise<HTMLImageElement> {
  const url = URL.createObjectURL(blob);
  try {
    const img = new Image();
    img.decoding = 'async';
    img.src = url;
    await img.decode();
    return img;
  } finally {
    // the decoded picture stays usable after the URL goes
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
}

function toJpeg(canvas: HTMLCanvasElement, quality: number): Promise<Blob> {
  return new Promise((resolve, reject) =>
    canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('Could not make the picture.'))), 'image/jpeg', quality),
  );
}

export async function prepareImage(
  source: Blob,
  rule: { exact: { width: number; height: number } | null; maxSide: number; maxKb: number },
): Promise<Prepared> {
  const img = await loadImage(source);
  let width: number;
  let height: number;
  if (rule.exact) {
    width = rule.exact.width;
    height = rule.exact.height;
  } else {
    const scale = Math.min(1, rule.maxSide / Math.max(img.naturalWidth, img.naturalHeight));
    width = Math.max(1, Math.round(img.naturalWidth * scale));
    height = Math.max(1, Math.round(img.naturalHeight * scale));
  }

  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('This browser cannot change pictures.');
  ctx.fillStyle = '#ffffff'; // a transparent PNG gets a white page
  ctx.fillRect(0, 0, width, height);
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(img, 0, 0, width, height);

  const limit = rule.maxKb * 1024;
  let best: Blob | null = null;
  let quality = 0.9;
  for (const q of [0.9, 0.82, 0.74, 0.66, 0.58, 0.5, 0.42, 0.35]) {
    const b = await toJpeg(canvas, q);
    best = b;
    quality = q;
    if (b.size <= limit) break;
  }
  return { blob: best!, width, height, quality, underLimit: best!.size <= limit };
}
