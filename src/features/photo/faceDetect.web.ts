import type { Face } from './faceDetect';

export type { Face } from './faceDetect';

// =====================================================================
// 🙂 Find the faces in a picture, in the browser (MediaPipe face
//   detector, BlazeFace short range). The program and the model are on
//   our own website (/mediapipe/, copied there when the site is built);
//   nothing leaves the computer. null = it could not start (an old
//   browser, or the files are missing): the studio then guesses the head
//   from the cut-out outline.
// =====================================================================

const BASE = '/mediapipe';

type Detector = {
  detect: (image: HTMLCanvasElement) => {
    detections: {
      boundingBox?: {
        originX: number;
        originY: number;
        width: number;
        height: number;
      };
      categories?: { score: number }[];
      keypoints?: { x: number; y: number }[];
    }[];
  };
};

let ready: Promise<Detector | null> | null = null;

// A plain browser import() that the bundler leaves alone
// eslint-disable-next-line @typescript-eslint/no-implied-eval
const nativeImport = new Function('url', 'return import(url)') as (url: string) => Promise<unknown>;

function load(): Promise<Detector | null> {
  if (!ready) {
    ready = (async () => {
      try {
        // The browser loads the module itself (the bundler can't pack MediaPipe)
        const vision = (await nativeImport(`${BASE}/vision_bundle.js`)) as typeof import('@mediapipe/tasks-vision');
        const detector = await vision.FaceDetector.createFromOptions(
          {
            wasmLoaderPath: `${BASE}/vision_wasm_internal.js`,
            wasmBinaryPath: `${BASE}/vision_wasm_internal.wasm`,
          },
          {
            baseOptions: {
              modelAssetPath: `${BASE}/blaze_face_short_range.tflite`,
            },
            runningMode: 'IMAGE',
            minDetectionConfidence: 0.4,
          },
        );
        return detector as unknown as Detector;
      } catch (e) {
        console.warn('Face finder could not start', e);
        ready = null; // try again next time
        return null;
      }
    })();
  }
  return ready;
}

/** Start loading early (the studio opens) */
export function warmUp(): void {
  void load();
}

/** The faces, biggest first; null when the face finder could not start */
export async function detectFaces(pic: HTMLCanvasElement): Promise<Face[] | null> {
  const d = await load();
  if (!d) return null;
  // The model works on small pictures: give it at most 1024 px
  const k = Math.min(1, 1024 / Math.max(pic.width, pic.height));
  let src = pic;
  if (k < 1) {
    src = document.createElement('canvas');
    src.width = Math.round(pic.width * k);
    src.height = Math.round(pic.height * k);
    src.getContext('2d')!.drawImage(pic, 0, 0, src.width, src.height);
  }
  let res: ReturnType<Detector['detect']>;
  try {
    res = d.detect(src);
  } catch (e) {
    console.warn('Face finder failed', e);
    return null;
  }
  const W = pic.width;
  const H = pic.height;
  const faces: Face[] = [];
  for (const det of res.detections ?? []) {
    const b = det.boundingBox;
    if (!b) continue;
    const kp = det.keypoints ?? [];
    // keypoints (0–1): right eye, left eye, nose tip, mouth, right ear, left ear
    const pt = (i: number) => (kp[i] ? { x: kp[i].x * W, y: kp[i].y * H } : null);
    faces.push({
      x: b.originX / k,
      y: b.originY / k,
      w: b.width / k,
      h: b.height / k,
      rightEye: pt(0),
      leftEye: pt(1),
      mouth: pt(3),
      score: det.categories?.[0]?.score ?? 0,
    });
  }
  return faces.sort((a, b) => b.w * b.h - a.w * a.h);
}
