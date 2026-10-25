import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  validateVisionImages, VisionSnapshotError, VisionSnapshots, VISION_SNAPSHOT_TTL_MS,
} from '../../src/main/visionSnapshot';
import type { VisionImage, VisionPreview } from '../../src/shared/vision';

import { TEST_JPEG_BASE64 as JPEG, TEST_JPEG_DATA_URL } from './fixtures/visionJpeg';
const image = (): VisionImage => ({
  dataUrl: TEST_JPEG_DATA_URL, width: 2, height: 1, marker: { x: 0.25, y: 0.5 },
});
const preview = (): VisionPreview => ({
  displayId: 1, original: { x: 0, y: 0, width: 2, height: 1 },
  crop: { x: 0, y: 0, width: 2, height: 1 }, local: image(), full: image(),
});
const recipient = { baseUrl: 'https://example.org/v1', model: 'vision-model' };
const decoded = () => ({ width: 2, height: 1 });
function expectCode(run: () => unknown, code: VisionSnapshotError['code']): void {
  expect(run).toThrow(expect.objectContaining({ code }));
}

afterEach(() => { vi.useRealTimers(); });

describe('visionSnapshot', () => {
  it('accepts one or two complete JPEG images without changing their bytes', () => {
    const original = image();
    validateVisionImages([original]);
    validateVisionImages([original, image()], decoded);
    expect(original.dataUrl).toBe(`data:image/jpeg;base64,${JPEG}`);
  });

  it.each([{ images: [] }, { images: [image(), image(), image()] }])('refuses an unsupported image count', ({ images }) => {
    expectCode(() => validateVisionImages(images), 'imageInvalid');
  });

  it.each([
    'https://example.org/screen.jpg', 'file:///screen.jpg', 'data:image/png;base64,AAAA',
    'data:image/jpeg;base64,', 'data:image/jpeg;base64,%%%%',
    `data:image/jpeg;base64,${JPEG}\n`, `data:image/jpeg;base64,${JPEG.slice(0, -1)}`,
    'data:image/jpeg;base64,/9j/2Q==', 'data:image/jpeg;base64,bm90IGEganBlZw==',
  ])('refuses remote, malformed or incomplete JPEG data', (dataUrl) => {
    expectCode(() => validateVisionImages([{ ...image(), dataUrl }]), 'imageInvalid');
  });

  it('refuses noncanonical padding bits and JPEGs truncated after the frame header', () => {
    const bytes = Buffer.from(JPEG, 'base64');
    expectCode(() => validateVisionImages([{ ...image(), dataUrl: image().dataUrl.replace('/2Q==', '/2R==') }]),
      'imageInvalid');
    expectCode(() => validateVisionImages([{ ...image(),
      dataUrl: `data:image/jpeg;base64,${bytes.subarray(0, 180).toString('base64')}` }]), 'imageInvalid');
  });

  it.each([
    { width: 0 }, { height: -1 }, { width: 2.5 }, { width: NaN }, { height: Infinity },
    { width: 3 }, { marker: { x: -0.1, y: 0.5 } }, { marker: { x: 0.5, y: NaN } },
  ])('refuses invalid dimensions, metadata mismatches or markers %o', (invalid) => {
    expectCode(() => validateVisionImages([{ ...image(), ...invalid }]), 'imageInvalid');
  });

  it('refuses oversized dimensions and encoded payloads before decoding', () => {
    expectCode(() => validateVisionImages([{ ...image(), width: 8193 }]), 'imageTooLarge');
    expectCode(() => validateVisionImages([{ ...image(), width: 8192, height: 8192 }]), 'imageTooLarge');
    const large = `data:image/jpeg;base64,${Buffer.alloc(3 * 1024 * 1024 + 1).toString('base64')}`;
    expectCode(() => validateVisionImages([{ ...image(), dataUrl: large }]), 'imageTooLarge');
  });

  it('caps the combined data URL size even when both images meet the individual byte cap', () => {
    const dataUrl = `data:image/jpeg;base64,${Buffer.alloc(3 * 1024 * 1024).toString('base64')}`;
    expectCode(() => validateVisionImages([{ ...image(), dataUrl }, { ...image(), dataUrl }]), 'imageTooLarge');
  });

  it('refuses native decode failures and mismatched decoded dimensions', () => {
    expectCode(() => validateVisionImages([image()], () => null), 'imageInvalid');
    expectCode(() => validateVisionImages([image()], () => ({ width: 1, height: 1 })), 'imageInvalid');
    expectCode(() => validateVisionImages([image()], () => { throw new Error('private image information'); }),
      'imageInvalid');
  });

  it('retains an immutable copy of exactly the approved local and full JPEGs', () => {
    const store = new VisionSnapshots({ now: () => 10, decode: decoded });
    const source = preview();
    const ref = store.capture(1, source, recipient);
    source.local.dataUrl = 'file:///changed.jpg';
    source.local.marker.x = 1;
    const selected = store.select(1, ref.snapshotId, 'localAndFull', recipient);
    expect(selected).toEqual([image(), image()]);
    expect(Object.isFrozen(selected)).toBe(true);
    expect(Object.isFrozen(selected[0])).toBe(true);
    expect(Object.isFrozen(selected[0].marker)).toBe(true);
    expect(store.select(1, ref.snapshotId, 'local', recipient)).toEqual([image()]);
    expect(ref.expiresAt).toBe(120010);
    store.clear();
  });

  it('consumes approval exactly once and preserves its original deadline without extending it', () => {
    const store = new VisionSnapshots({ now: () => 10, decode: decoded });
    const ref = store.capture(1, preview(), recipient);
    const approval = store.consume(1, ref.snapshotId, 'localAndFull', recipient);
    expect(approval.expiresAt).toBe(120010);
    expect(approval.images.length).toBe(2);
    expect(Object.isFrozen(approval.images)).toBe(true);
    expectCode(() => store.consume(1, ref.snapshotId, 'localAndFull', recipient), 'snapshotStale');
  });

  it('keeps the local image first and includes only the selected scope', () => {
    const store = new VisionSnapshots({ now: () => 10, decode: decoded });
    const source = preview();
    const bytes = Buffer.from(JPEG, 'base64');
    // A JPEG comment gives the full image distinct, valid bytes without changing its geometry.
    source.full.dataUrl = `data:image/jpeg;base64,${Buffer.concat([
      bytes.subarray(0, 2), Buffer.from([0xff, 0xfe, 0, 6, 102, 117, 108, 108]), bytes.subarray(2),
    ]).toString('base64')}`;
    const ref = store.capture(1, source, recipient);
    expect(store.select(1, ref.snapshotId, 'local', recipient).map((value) => value.dataUrl))
      .toEqual([TEST_JPEG_DATA_URL]);
    expect(store.select(1, ref.snapshotId, 'localAndFull', recipient).map((value) => value.dataUrl))
      .toEqual([TEST_JPEG_DATA_URL, source.full.dataUrl]);
    store.clear();
  });

  it('refuses a wrong session or revision and keeps replacement snapshots distinct', () => {
    const store = new VisionSnapshots({ now: () => 10, decode: decoded });
    const first = store.capture(1, preview(), recipient);
    expectCode(() => store.select(2, first.snapshotId, 'local', recipient), 'snapshotStale');
    const second = store.capture(2, preview(), recipient);
    expect(second.snapshotId).toBeGreaterThan(first.snapshotId);
    expectCode(() => store.select(1, first.snapshotId, 'local', recipient), 'snapshotStale');
    expect(store.select(2, second.snapshotId, 'local', recipient)).toEqual([image()]);
    store.clear();
  });

  it.each([{ ...recipient, model: 'changed' }, { ...recipient, baseUrl: 'https://other.example/v1' }])(
    'invalidates consent when its recipient changes', (changed) => {
      const store = new VisionSnapshots({ now: () => 10, decode: decoded });
      const ref = store.capture(1, preview(), recipient);
      expectCode(() => store.select(1, ref.snapshotId, 'local', changed), 'snapshotStale');
      expectCode(() => store.select(1, ref.snapshotId, 'local', recipient), 'snapshotStale');
    },
  );

  it('expires at the exact deadline even when the injected clock advances without timers', () => {
    let time = 10;
    const store = new VisionSnapshots({ now: () => time, decode: decoded });
    const ref = store.capture(1, preview(), recipient);
    time = ref.expiresAt;
    expectCode(() => store.select(1, ref.snapshotId, 'local', recipient), 'snapshotExpired');
    store.clear();
  });

  it('releases its snapshot and timer at the TTL without requiring another request', () => {
    vi.useFakeTimers();
    const store = new VisionSnapshots({ now: () => 10, decode: decoded });
    const ref = store.capture(1, preview(), recipient);
    vi.advanceTimersByTime(VISION_SNAPSHOT_TTL_MS);
    expect(vi.getTimerCount()).toBe(0);
    expectCode(() => store.select(1, ref.snapshotId, 'local', recipient), 'snapshotExpired');
  });

  it('clears images and their expiry timer on lifecycle cleanup', () => {
    vi.useFakeTimers();
    const store = new VisionSnapshots({ now: () => 10, decode: decoded });
    const ref = store.capture(1, preview(), recipient);
    store.clear();
    expect(vi.getTimerCount()).toBe(0);
    expectCode(() => store.select(1, ref.snapshotId, 'local', recipient), 'snapshotStale');
  });

  it('validates before retaining a capture and again before selecting it', () => {
    let readable = true;
    const store = new VisionSnapshots({ now: () => 10, decode: () => readable ? decoded() : null });
    const ref = store.capture(1, preview(), recipient);
    readable = false;
    expectCode(() => store.select(1, ref.snapshotId, 'local', recipient), 'imageInvalid');
    expectCode(() => store.capture(2, preview(), recipient), 'imageInvalid');
    expectCode(() => store.select(1, ref.snapshotId, 'local', recipient), 'snapshotStale');
  });
});
