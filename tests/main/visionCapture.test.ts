import { desktopCapturer, nativeImage, screen, type NativeImage } from 'electron';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  CAPTURE_TIMEOUT_MS, captureVision, focusCropRect, MAX_CAPTURE_PIXELS, visionImagePoint, type VisionCaptureDeps,
} from '../../src/main/visionCapture';
import { MAX_VISION_DATA_URL_CHARS, type VisionTarget } from '../../src/shared/vision';
import type { Rect } from '../../src/main/coords';

vi.mock('electron', () => ({ desktopCapturer: { getSources: vi.fn() }, screen: { getAllDisplays: vi.fn() },
  nativeImage: { createFromBuffer: vi.fn() } }));

type Size = { width: number; height: number };

class ImageDouble {
  crops: Rect[] = [];
  encodedBytes = 12;
  empty = false;
  onEncode: (() => void) | null = null;
  scales = [1];
  constructor(readonly size: Size) {}
  getSize(): Size { return this.size; }
  getScaleFactors(): number[] { return this.scales; }
  isEmpty(): boolean { return this.empty; }
  crop(rect: Rect): NativeImage {
    this.crops.push(rect);
    const image = new ImageDouble({ width: rect.width, height: rect.height });
    image.encodedBytes = this.encodedBytes;
    return image.native();
  }
  resize(size: Size): NativeImage {
    const image = new ImageDouble(size);
    image.encodedBytes = this.encodedBytes;
    return image.native();
  }
  toJPEG(): Buffer {
    this.onEncode?.();
    return Buffer.alloc(this.encodedBytes, 42);
  }
  toPNG(): Buffer { return Buffer.from('local image double'); }
  native(): NativeImage { return this as unknown as NativeImage; }
}

const targetAt = (width = 1920, height = 1080, scaleFactor = 1): VisionTarget => ({
  displayId: 7, x: width / 2, y: height / 2,
  bounds: { x: 0, y: 0, width, height }, scaleFactor,
});

function fixture(target = targetAt(), size = { width: 1920, height: 1080 }) {
  const image = new ImageDouble(size);
  const source = { display_id: String(target.displayId), thumbnail: image.native() };
  const displays = [{ id: target.displayId, bounds: { ...target.bounds }, scaleFactor: target.scaleFactor }];
  const getSources = vi.fn<VisionCaptureDeps['getSources']>(async () => [source]);
  const deps: VisionCaptureDeps = { getDisplays: () => displays, getSources };
  return { image, source, displays, getSources, deps };
}

afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); });

describe('visionCapture', () => {
  it.each([
    [1920, 1080, 1, 1920, 1080],
    [2048, 1152, 1.25, 2560, 1440],
    [2560, 1440, 1.5, 3840, 2160],
  ])('maps local DIPs for %i×%i at %f using the actual %i×%i image', async (dipWidth, dipHeight, scale, width, height) => {
    const target = targetAt(dipWidth, dipHeight, scale);
    const { deps, getSources } = fixture(target, { width, height });
    const result = await captureVision(target, deps);
    expect(getSources.mock.calls[0][0].thumbnailSize).toEqual({ width, height });
    expect(result).toMatchObject({ ok: true, preview: {
      original: { x: width / 2, y: height / 2, width, height },
      crop: { x: width / 2 - 320, y: height / 2 - 240, width: 640, height: 480 },
      local: { width: 640, height: 480 },
    } });
  });

  it('uses the returned dimensions rather than assuming thumbnailSize was honoured', async () => {
    const target = targetAt(2048, 1152, 1.25);
    const { deps } = fixture(target, { width: 1600, height: 900 });
    const result = await captureVision(target, deps);
    expect(result).toMatchObject({ ok: true, preview: {
      original: { x: 800, y: 450, width: 1600, height: 900 },
      crop: { x: 480, y: 210, width: 640, height: 480 },
    } });
  });

  it('normalizes a non-1x NativeImage representation before using pixel crop coordinates', async () => {
    const target = targetAt();
    const f = fixture();
    f.image.scales = [2];
    const normalized = new ImageDouble({ width: 1920, height: 1080 });
    vi.mocked(nativeImage.createFromBuffer).mockReturnValue(normalized.native());
    expect(await captureVision(target, f.deps)).toMatchObject({ ok: true, preview: {
      crop: { x: 640, y: 300, width: 640, height: 480 },
    } });
    expect(f.image.crops).toEqual([]);
    expect(normalized.crops).toEqual([{ x: 640, y: 300, width: 640, height: 480 }]);
  });

  it.each([[-2048, 0], [0, -1152], [-2048, -1152]])('ignores the global origin (%i,%i) on a mixed-DPI secondary', async (x, y) => {
    const target = { ...targetAt(2048, 1152, 1.25), bounds: { x, y, width: 2048, height: 1152 } };
    const f = fixture(target, { width: 2560, height: 1440 });
    f.displays.unshift({ id: 1, bounds: { x: 0, y: 0, width: 1920, height: 1080 }, scaleFactor: 1 });
    const other = new ImageDouble({ width: 1920, height: 1080 });
    f.getSources.mockResolvedValue([{ display_id: '1', thumbnail: other.native() }, f.source]);
    expect(await captureVision(target, f.deps)).toMatchObject({ ok: true, preview: {
      displayId: 7, original: { x: 1280, y: 720 },
    } });
    expect(other.crops).toEqual([]);
    expect(f.image.crops).toHaveLength(1);
  });

  it.each([
    [0, 0, 0, 0],
    [1920, 0, 1280, 0],
    [0, 1080, 0, 600],
    [1920, 1080, 1280, 600],
    [-900, -900, 0, 0],
    [9000, 9000, 1280, 600],
  ])('keeps the crop in bounds for local position (%i,%i)', (x, y, cropX, cropY) => {
    const point = visionImagePoint({ ...targetAt(), x, y }, { width: 1920, height: 1080 });
    expect(focusCropRect(point, { width: 1920, height: 1080 })).toEqual({ x: cropX, y: cropY, width: 640, height: 480 });
  });

  it('reduces the crop to fit a tiny display and keeps the marker inside both images', async () => {
    const target = { ...targetAt(320, 200), x: 320, y: 0 };
    const result = await captureVision(target, fixture(target, { width: 320, height: 200 }).deps);
    expect(result).toMatchObject({ ok: true, preview: {
      original: { x: 319, y: 0 }, crop: { x: 0, y: 0, width: 320, height: 200 },
      local: { width: 320, height: 200, marker: { x: 319.5 / 320, y: 0.5 / 200 } },
      full: { width: 320, height: 200, marker: { x: 319.5 / 320, y: 0.5 / 200 } },
    } });
  });

  it('keeps the full display aspect and the original marker when compressing a 4K preview', async () => {
    const target = { ...targetAt(2560, 1440, 1.5), x: 640, y: 360 };
    const result = await captureVision(target, fixture(target, { width: 3840, height: 2160 }).deps);
    expect(result).toMatchObject({ ok: true, preview: {
      original: { x: 960, y: 540, width: 3840, height: 2160 },
      full: { width: 1920, height: 1080, marker: { x: 960.5 / 3840, y: 540.5 / 2160 } },
    } });
  });

  it('returns an explicit capture failure when Electron rejects without leaking the exception text', async () => {
    const f = fixture();
    f.getSources.mockRejectedValue(new Error('secret window title'));
    expect(await captureVision(targetAt(), f.deps)).toEqual({ ok: false, code: 'captureFailed' });
  });

  it('times out a stalled provider and drops its late image without cropping it', async () => {
    vi.useFakeTimers();
    const f = fixture();
    let finish: (value: typeof f.source[]) => void = () => undefined;
    f.getSources.mockImplementation(() => new Promise((resolve) => { finish = resolve; }));
    const pending = captureVision(targetAt(), f.deps);
    await vi.advanceTimersByTimeAsync(CAPTURE_TIMEOUT_MS);
    expect(await pending).toEqual({ ok: false, code: 'captureFailed' });
    finish([f.source]);
    await Promise.resolve();
    expect(f.image.crops).toEqual([]);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('keeps the real Electron provider busy after timeout until its native promise settles', async () => {
    vi.useFakeTimers();
    const f = fixture();
    vi.mocked(screen.getAllDisplays).mockReturnValue(f.displays as ReturnType<typeof screen.getAllDisplays>);
    let finish: (value: typeof f.source[]) => void = () => undefined;
    vi.mocked(desktopCapturer.getSources).mockImplementationOnce(() => new Promise((resolve) => {
      finish = resolve as (value: typeof f.source[]) => void;
    }));
    const pending = captureVision(targetAt());
    await vi.advanceTimersByTimeAsync(CAPTURE_TIMEOUT_MS);
    expect(await pending).toEqual({ ok: false, code: 'captureFailed' });
    expect(await captureVision(targetAt())).toEqual({ ok: false, code: 'busy' });
    finish([f.source]);
    await Promise.resolve();
    vi.mocked(desktopCapturer.getSources).mockResolvedValueOnce([f.source] as Awaited<ReturnType<typeof desktopCapturer.getSources>>);
    expect(await captureVision(targetAt())).toMatchObject({ ok: true });
    expect(vi.getTimerCount()).toBe(0);
  });

  it('clears the capture deadline when the image arrives successfully', async () => {
    vi.useFakeTimers();
    expect(await captureVision(targetAt(), fixture().deps)).toMatchObject({ ok: true });
    expect(vi.getTimerCount()).toBe(0);
  });

  it('rejects a removed target before asking Electron and never falls back to a primary display', async () => {
    const f = fixture();
    f.displays[0].id = 1;
    expect(await captureVision(targetAt(), f.deps)).toEqual({ ok: false, code: 'displayGone' });
    expect(f.getSources).not.toHaveBeenCalled();
  });

  it('refuses sources with no matching display_id or an ambiguous matching source', async () => {
    const f = fixture();
    f.source.display_id = '1';
    expect(await captureVision(targetAt(), f.deps)).toEqual({ ok: false, code: 'displayGone' });
    f.source.display_id = '7';
    f.getSources.mockResolvedValue([f.source, f.source]);
    expect(await captureVision(targetAt(), f.deps)).toEqual({ ok: false, code: 'displayGone' });
  });

  it('returns empty for an empty native image', async () => {
    const f = fixture();
    f.image.empty = true;
    expect(await captureVision(targetAt(), f.deps)).toEqual({ ok: false, code: 'empty' });
  });

  it('rejects changed display geometry and scaling before capture', async () => {
    const f = fixture();
    f.displays[0].scaleFactor = 1.25;
    expect(await captureVision(targetAt(), f.deps)).toEqual({ ok: false, code: 'displayChanged' });
    f.displays[0].scaleFactor = 1;
    f.displays[0].bounds.x = -1920;
    expect(await captureVision(targetAt(), f.deps)).toEqual({ ok: false, code: 'displayChanged' });
    expect(f.getSources).not.toHaveBeenCalled();
  });

  it('rechecks a target removed or resized while the capture promise is pending', async () => {
    const f = fixture();
    f.getSources.mockImplementation(async () => {
      f.displays.length = 0;
      return [f.source];
    });
    expect(await captureVision(targetAt(), f.deps)).toEqual({ ok: false, code: 'displayGone' });
    const resized = fixture();
    resized.getSources.mockImplementation(async () => {
      resized.displays[0].bounds.width = 1280;
      return [resized.source];
    });
    expect(await captureVision(targetAt(), resized.deps)).toEqual({ ok: false, code: 'displayChanged' });
  });

  it('bounds all-screen requested allocation before asking Electron', async () => {
    const target = targetAt(7680, 4320);
    const f = fixture(target);
    f.displays.push({ id: 1, bounds: { ...target.bounds }, scaleFactor: 1 });
    expect(7680 * 4320 * 2).toBeGreaterThan(MAX_CAPTURE_PIXELS);
    expect(await captureVision(target, f.deps)).toEqual({ ok: false, code: 'tooLarge' });
    expect(f.getSources).not.toHaveBeenCalled();
  });

  it('rejects an unexpectedly huge returned image before cropping or JPEG encoding', async () => {
    const f = fixture(targetAt(), { width: 16384, height: 16384 });
    expect(await captureVision(targetAt(), f.deps)).toEqual({ ok: false, code: 'tooLarge' });
    expect(f.image.crops).toEqual([]);
  });

  it('caps the aggregate JPEG payload before it can cross IPC', async () => {
    const f = fixture();
    f.image.encodedBytes = MAX_VISION_DATA_URL_CHARS / 2;
    expect(await captureVision(targetAt(), f.deps)).toEqual({ ok: false, code: 'tooLarge' });
  });

  it('has no network output or dependency on API configuration during local preview', async () => {
    const network = vi.fn(() => { throw new Error('Network forbidden'); });
    vi.stubGlobal('fetch', network);
    const result = await captureVision(targetAt(), fixture().deps);
    expect(result.ok).toBe(true);
    expect(network).not.toHaveBeenCalled();
  });

  it.each([
    { width: 0, height: 100 }, { width: 100, height: 0 },
    { width: 1.5, height: 2 }, { width: NaN, height: 20 },
  ])('rejects invalid crop dimensions %o instead of returning a zero or fractional rectangle', (size) => {
    expect(() => focusCropRect({ x: 0, y: 0 }, size)).toThrow(RangeError);
  });
});
