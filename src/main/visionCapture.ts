import { desktopCapturer, nativeImage, screen, type NativeImage } from 'electron';
import { MAX_VISION_DATA_URL_CHARS, type VisionErrorCode, type VisionResult, type VisionTarget } from '../shared/vision';
import type { Rect } from './coords';

/** Limits decoded capture memory, including thumbnails of other sources returned by Electron. */
export const MAX_CAPTURE_PIXELS = 32 * 1024 * 1024;
const MAX_CAPTURE_SIDE = 8192;
const FULL_PREVIEW_SIZE = { width: 1920, height: 1080 };
const CROP_SIZE = { width: 640, height: 480 };
export const CAPTURE_TIMEOUT_MS = 10_000;
let electronCapturePending = false;

interface Size { width: number; height: number }
interface Point { x: number; y: number }
interface CaptureDisplay { id: number; bounds: Rect; scaleFactor: number }
interface CaptureSource { display_id: string; thumbnail: NativeImage }

export interface VisionCaptureDeps {
  getDisplays(): readonly CaptureDisplay[];
  getSources(options: { types: ('screen')[]; thumbnailSize: Size; fetchWindowIcons: boolean }): Promise<CaptureSource[]>;
}

const electronDeps: VisionCaptureDeps = {
  getDisplays: () => screen.getAllDisplays(),
  getSources: (options) => desktopCapturer.getSources(options),
};

const clamp = (n: number, min: number, max: number): number => Math.max(min, Math.min(n, max));
const validSize = (size: Size): boolean => Number.isSafeInteger(size.width) && Number.isSafeInteger(size.height)
  && size.width > 0 && size.height > 0;
const boundedSize = (size: Size): boolean => validSize(size) && size.width <= MAX_CAPTURE_SIDE
  && size.height <= MAX_CAPTURE_SIDE && size.width * size.height <= MAX_CAPTURE_PIXELS;

/** Local overlay DIPs → actual image pixels; global display origins and guessed DPI ratios never enter this mapping. */
export function visionImagePoint(target: VisionTarget, image: Size): Point {
  if (!validSize(image) || !Number.isFinite(target.x) || !Number.isFinite(target.y)
    || !Number.isFinite(target.bounds.width) || !Number.isFinite(target.bounds.height)
    || target.bounds.width <= 0 || target.bounds.height <= 0) throw new RangeError('Invalid capture coordinates');
  return {
    x: clamp(Math.floor(target.x * image.width / target.bounds.width), 0, image.width - 1),
    y: clamp(Math.floor(target.y * image.height / target.bounds.height), 0, image.height - 1),
  };
}

/** A positive integer crop entirely within the real image, shifted inward at edges instead of truncated there. */
export function focusCropRect(point: Point, image: Size, crop: Size = CROP_SIZE): Rect {
  if (!validSize(image) || !validSize(crop) || !Number.isFinite(point.x) || !Number.isFinite(point.y)) {
    throw new RangeError('Invalid crop coordinates');
  }
  const width = Math.min(crop.width, image.width);
  const height = Math.min(crop.height, image.height);
  return {
    x: clamp(Math.floor(point.x - width / 2), 0, image.width - width),
    y: clamp(Math.floor(point.y - height / 2), 0, image.height - height),
    width,
    height,
  };
}

function targetError(target: VisionTarget, displays: readonly CaptureDisplay[]): VisionErrorCode | null {
  const display = displays.find((d) => d.id === target.displayId);
  if (!display) return 'displayGone';
  if (display.scaleFactor !== target.scaleFactor || (['x', 'y', 'width', 'height'] as const)
    .some((key) => display.bounds[key] !== target.bounds[key])) return 'displayChanged';
  return null;
}

function jpeg(image: NativeImage): string {
  const bytes = image.toJPEG(85);
  if (bytes.length === 0) throw new Error('Empty encoded image');
  // Check before base64 expansion as well as before the IPC result leaves this module.
  if (bytes.length > MAX_VISION_DATA_URL_CHARS * 3 / 4) throw new RangeError('Capture payload too large');
  return `data:image/jpeg;base64,${bytes.toString('base64')}`;
}

function pixelImage(image: NativeImage): NativeImage {
  // crop() uses the ImageSkia logical extent. A non-1x representation must become a single 1x image
  // before image-pixel crop coordinates are passed to it (normally Windows screen thumbnails are already 1x).
  const scales = image.getScaleFactors();
  return scales.length === 1 && scales[0] === 1
    ? image : nativeImage.createFromBuffer(image.toPNG({ scaleFactor: 1 }));
}

async function captureSources(deps: VisionCaptureDeps, requested: Size): Promise<CaptureSource[]> {
  const request = deps.getSources({ types: ['screen'], thumbnailSize: requested, fetchWindowIcons: false });
  if (deps === electronDeps) {
    electronCapturePending = true;
    // A deadline cannot cancel Electron's native capture. Keep the real provider busy until that original
    // promise settles, so repeated clicks after a timeout cannot queue more native screen allocations.
    void request.then(() => { electronCapturePending = false; }, () => { electronCapturePending = false; });
  }
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await new Promise<CaptureSource[]>((resolve, reject) => {
      timer = setTimeout(() => reject(new Error('Capture timed out')), CAPTURE_TIMEOUT_MS);
      void request.then(resolve, reject);
    });
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

/** Captures only for local preview. Callers own window exclusion and session cancellation; this module retains no images. */
export async function captureVision(target: VisionTarget, deps: VisionCaptureDeps = electronDeps): Promise<VisionResult> {
  try {
    if (deps === electronDeps && electronCapturePending) return { ok: false, code: 'busy' };
    const displays = deps.getDisplays();
    const before = targetError(target, displays);
    if (before) return { ok: false, code: before };
    const requested = {
      width: Math.round(target.bounds.width * target.scaleFactor),
      height: Math.round(target.bounds.height * target.scaleFactor),
    };
    // getSources cannot filter one monitor. Bound its all-screen thumbnail allocation before asking Electron;
    // other thumbnails are neither encoded nor sent, and die with this call.
    if (!boundedSize(requested) || requested.width * requested.height * displays.length > MAX_CAPTURE_PIXELS) {
      return { ok: false, code: 'tooLarge' };
    }
    const sources = await captureSources(deps, requested);
    const after = targetError(target, deps.getDisplays());
    if (after) return { ok: false, code: after };
    let pixels = 0;
    for (const source of sources) {
      if (!source.thumbnail.isEmpty()) {
        for (const scale of source.thumbnail.getScaleFactors()) {
          const size = source.thumbnail.getSize(scale);
          if (!boundedSize(size)) return { ok: false, code: 'tooLarge' };
          pixels += size.width * size.height;
        }
      }
    }
    if (pixels > MAX_CAPTURE_PIXELS) return { ok: false, code: 'tooLarge' };
    const matches = sources.filter((source) => source.display_id === String(target.displayId));
    if (matches.length !== 1) return { ok: false, code: 'displayGone' };
    if (matches[0].thumbnail.isEmpty()) return { ok: false, code: 'empty' };
    const image = pixelImage(matches[0].thumbnail);
    const originalSize = image.getSize(1);
    if (image.isEmpty() || !validSize(originalSize)) return { ok: false, code: 'empty' };
    const point = visionImagePoint(target, originalSize);
    const crop = focusCropRect(point, originalSize);
    const local = image.crop(crop);
    if (local.isEmpty()) return { ok: false, code: 'empty' };
    const factor = Math.min(1, FULL_PREVIEW_SIZE.width / originalSize.width, FULL_PREVIEW_SIZE.height / originalSize.height);
    const full = factor < 1 ? image.resize({
      width: Math.max(1, Math.round(originalSize.width * factor)),
      height: Math.max(1, Math.round(originalSize.height * factor)),
      quality: 'good',
    }) : image;
    if (full.isEmpty()) return { ok: false, code: 'empty' };
    const localData = jpeg(local);
    const fullData = jpeg(full);
    if (localData.length + fullData.length > MAX_VISION_DATA_URL_CHARS) return { ok: false, code: 'tooLarge' };
    const finalCheck = targetError(target, deps.getDisplays());
    if (finalCheck) return { ok: false, code: finalCheck };
    return {
      ok: true,
      preview: {
        displayId: target.displayId,
        original: { ...point, ...originalSize },
        crop,
        local: {
          dataUrl: localData, ...local.getSize(1),
          marker: { x: (point.x - crop.x + 0.5) / crop.width, y: (point.y - crop.y + 0.5) / crop.height },
        },
        full: {
          dataUrl: fullData, ...full.getSize(1),
          marker: { x: (point.x + 0.5) / originalSize.width, y: (point.y + 0.5) / originalSize.height },
        },
      },
    };
  } catch (error) {
    // Never include Electron exception messages: they can contain screen or window titles.
    return { ok: false, code: error instanceof RangeError ? 'tooLarge' : 'captureFailed' };
  }
}
