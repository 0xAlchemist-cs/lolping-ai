/** A wheel centre in display-local DIPs, frozen with the display geometry at the gesture. */
export interface VisionTarget {
  displayId: number;
  x: number;
  y: number;
  bounds: { x: number; y: number; width: number; height: number };
  scaleFactor: number;
}

export type VisionErrorCode = 'unavailable' | 'displayGone' | 'displayChanged' | 'empty' | 'tooLarge'
  | 'captureFailed' | 'windowsNotHidden' | 'busy' | 'stale';

/** Only these bounded JPEG images may cross the card's IPC boundary. Markers are normalised image coordinates. */
export interface VisionImage {
  dataUrl: string;
  width: number;
  height: number;
  marker: { x: number; y: number };
}

export interface VisionPreview {
  displayId: number;
  original: { x: number; y: number; width: number; height: number };
  crop: { x: number; y: number; width: number; height: number };
  local: VisionImage;
  full: VisionImage;
}

export type VisionResult = { ok: true; preview: VisionPreview } | { ok: false; code: VisionErrorCode };

/** The session comes from main, never from a renderer-supplied display or cursor position. */
export type VisionReply = { sessionId: number; result: VisionResult };

export interface VisionText {
  open: string;
  close: string;
  loading: string;
  privacy: string;
  timing: string;
  local: string;
  full: string;
  marker: string;
  errors: Record<VisionErrorCode, string>;
}

export const MAX_VISION_DATA_URL_CHARS = 8 * 1024 * 1024;
