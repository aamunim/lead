// 🙂 Face finding runs only on the website (faceDetect.web.ts)
export type Face = {
  /** box, in px of the picture */
  x: number;
  y: number;
  w: number;
  h: number;
  /** eyes and mouth (px), when found */
  rightEye: { x: number; y: number } | null;
  leftEye: { x: number; y: number } | null;
  mouth: { x: number; y: number } | null;
  score: number;
};

export async function detectFaces(_pic: unknown): Promise<Face[] | null> {
  return null;
}
export function warmUp(): void {}
