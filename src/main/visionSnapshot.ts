import { MAX_VISION_DATA_URL_CHARS, type VisionImage, type VisionPreview } from '../shared/vision';

export const VISION_SNAPSHOT_TTL_MS = 120_000;
const JPEG_PREFIX = 'data:image/jpeg;base64,';
const MAX_IMAGE_BYTES = 3 * 1024 * 1024;
const MAX_TOTAL_BYTES = 6 * 1024 * 1024;
const MAX_IMAGE_SIDE = 8192;
const MAX_IMAGE_PIXELS = 32 * 1024 * 1024;
export type VisionSnapshotCode = 'imageInvalid' | 'imageTooLarge' | 'snapshotExpired' | 'snapshotStale';
export class VisionSnapshotError extends Error {
  constructor(readonly code: VisionSnapshotCode) { super(code); }
}
type Recipient = { baseUrl: string; model: string };
type DecodeImage = (dataUrl: string) => { width: number; height: number } | null;
const invalid = (): never => { throw new VisionSnapshotError('imageInvalid'); };
const tooLarge = (): never => { throw new VisionSnapshotError('imageTooLarge'); };

/** Reads frame dimensions without asking a decoder to allocate the claimed pixel buffer. */
function jpegSize(bytes: Buffer): { width: number; height: number } {
  if (bytes.length < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8) return invalid();
  let offset = 2;
  let size: { width: number; height: number } | null = null;
  let scanned = false;
  while (offset < bytes.length) {
    if (bytes[offset++] !== 0xff) return invalid();
    while (bytes[offset] === 0xff) offset++;
    const marker = bytes[offset++];
    if (marker === 0xd9) {
      if (!size || !scanned || offset !== bytes.length) return invalid();
      return size;
    }
    if (marker === undefined || marker === 0 || marker === 0xd8 || (marker >= 0xd0 && marker <= 0xd7)) {
      return invalid();
    }
    if (offset + 2 > bytes.length) return invalid();
    const length = bytes.readUInt16BE(offset);
    if (length < 2 || offset + length > bytes.length) return invalid();
    if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
      if (size || length < 11 || length !== 8 + 3 * bytes[offset + 7]) return invalid();
      size = { width: bytes.readUInt16BE(offset + 5), height: bytes.readUInt16BE(offset + 3) };
      if (!size.width || !size.height) return invalid();
      if (size.width > MAX_IMAGE_SIDE || size.height > MAX_IMAGE_SIDE
        || size.width * size.height > MAX_IMAGE_PIXELS) return tooLarge();
    }
    offset += length;
    if (marker === 0xda) {
      if (!size || length < 6) return invalid();
      let entropyBytes = 0;
      while (offset < bytes.length) {
        if (bytes[offset] !== 0xff) { entropyBytes++; offset++; continue; }
        const next = bytes[offset + 1];
        if (next === 0 || (next >= 0xd0 && next <= 0xd7)) { entropyBytes++; offset += 2; continue; }
        break;
      }
      if (entropyBytes === 0) return invalid();
      scanned = true;
    }
  }
  return invalid();
}

/** Validates bounded JPEG bytes and metadata before any image can be used in a request. */
export function validateVisionImages(images: readonly VisionImage[], decode?: DecodeImage): void {
  if (!Array.isArray(images) || images.length < 1 || images.length > 2) return invalid();
  let totalChars = 0;
  let totalBytes = 0;
  const buffers: Buffer[] = [];
  for (const image of images) {
    if (!image || typeof image.dataUrl !== 'string' || !image.dataUrl.startsWith(JPEG_PREFIX)) return invalid();
    totalChars += image.dataUrl.length;
    if (totalChars > MAX_VISION_DATA_URL_CHARS) return tooLarge();
    if (!Number.isSafeInteger(image.width) || !Number.isSafeInteger(image.height)
      || image.width <= 0 || image.height <= 0) return invalid();
    if (image.width > MAX_IMAGE_SIDE || image.height > MAX_IMAGE_SIDE
      || image.width * image.height > MAX_IMAGE_PIXELS) return tooLarge();
    if (!image.marker || !Number.isFinite(image.marker.x) || !Number.isFinite(image.marker.y)
      || image.marker.x < 0 || image.marker.x > 1 || image.marker.y < 0 || image.marker.y > 1) return invalid();
    const payload = image.dataUrl.slice(JPEG_PREFIX.length);
    if (payload.length > Math.ceil(MAX_IMAGE_BYTES / 3) * 4) return tooLarge();
    if (!payload.length || payload.length % 4 !== 0 || !/^[A-Za-z0-9+/]+={0,2}$/.test(payload)) return invalid();
    const bytes = Buffer.from(payload, 'base64');
    if (bytes.length > MAX_IMAGE_BYTES) return tooLarge();
    if (bytes.toString('base64') !== payload) return invalid();
    totalBytes += bytes.length;
    if (totalBytes > MAX_TOTAL_BYTES) return tooLarge();
    buffers.push(bytes);
  }
  for (let index = 0; index < images.length; index++) {
    const image = images[index];
    const frame = jpegSize(buffers[index]);
    if (frame.width !== image.width || frame.height !== image.height) return invalid();
    if (decode) {
      let actual: ReturnType<DecodeImage>;
      try { actual = decode(image.dataUrl); } catch { return invalid(); }
      if (!actual || actual.width !== image.width || actual.height !== image.height) return invalid();
    }
  }
}

interface Snapshot {
  sessionId: number;
  snapshotId: number;
  expiresAt: number;
  recipient: Recipient;
  images: readonly VisionImage[];
}

function ownImage(image: VisionImage): VisionImage {
  return Object.freeze({
    dataUrl: image.dataUrl, width: image.width, height: image.height,
    marker: Object.freeze({ x: image.marker.x, y: image.marker.y }),
  });
}

/** Holds one main-owned preview until expiry or an explicit lifecycle cleanup. */
export class VisionSnapshots {
  private readonly now: () => number;
  private readonly decode?: DecodeImage;
  private revision = 0;
  private snapshot: Snapshot | null = null;
  private expiredSnapshotId: number | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;

  constructor(deps: { now?: () => number; decode?: DecodeImage } = {}) {
    this.now = deps.now ?? Date.now;
    this.decode = deps.decode;
  }

  capture(sessionId: number, preview: VisionPreview, recipient: Recipient): { snapshotId: number; expiresAt: number } {
    this.clear();
    const images = Object.freeze([ownImage(preview.local), ownImage(preview.full)]);
    validateVisionImages(images, this.decode);
    const snapshotId = ++this.revision;
    const expiresAt = this.now() + VISION_SNAPSHOT_TTL_MS;
    this.snapshot = { sessionId, snapshotId, expiresAt, recipient: { ...recipient }, images };
    this.timer = setTimeout(() => this.expire(), VISION_SNAPSHOT_TTL_MS);
    this.timer.unref?.();
    return { snapshotId, expiresAt };
  }

  select(sessionId: number, snapshotId: number, scope: 'local' | 'localAndFull',
    recipient: Recipient): readonly VisionImage[] {
    if (this.snapshot && this.now() >= this.snapshot.expiresAt) this.expire();
    if (!this.snapshot && this.expiredSnapshotId === snapshotId) throw new VisionSnapshotError('snapshotExpired');
    const current = this.snapshot;
    if (!current || current.sessionId !== sessionId || current.snapshotId !== snapshotId
      || (scope !== 'local' && scope !== 'localAndFull')) throw new VisionSnapshotError('snapshotStale');
    if (current.recipient.baseUrl !== recipient.baseUrl || current.recipient.model !== recipient.model) {
      this.clear();
      throw new VisionSnapshotError('snapshotStale');
    }
    const images = scope === 'local' ? Object.freeze([current.images[0]]) : current.images;
    try { validateVisionImages(images, this.decode); } catch (error) { this.clear(); throw error; }
    return images;
  }

  clear(): void {
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = null;
    this.snapshot = null;
    this.expiredSnapshotId = null;
  }

  /** Consumes approval while retaining its original deadline for the final pre-network check. */
  consume(sessionId: number, snapshotId: number, scope: 'local' | 'localAndFull', recipient: Recipient): {
    images: readonly VisionImage[]; expiresAt: number;
  } {
    const images = this.select(sessionId, snapshotId, scope, recipient);
    const current = this.snapshot;
    if (!current) throw new VisionSnapshotError('snapshotStale');
    const expiresAt = current.expiresAt;
    this.clear();
    return { images, expiresAt };
  }

  private expire(): void {
    const expired = this.snapshot?.snapshotId ?? null;
    this.clear();
    this.expiredSnapshotId = expired;
  }
}
