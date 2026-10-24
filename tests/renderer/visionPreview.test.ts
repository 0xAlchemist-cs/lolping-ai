import { afterEach, describe, expect, it, vi } from 'vitest';
import { VisionPreview, type VisionElements } from '../../src/renderer/explain/visionPreview';
import { strings } from '../../src/shared/i18n';
import type { VisionReply } from '../../src/shared/vision';

/** The DOM operations the preview uses, without a browser or image persistence. */
class Element extends EventTarget {
  hidden = false;
  disabled = false;
  textContent = '';
  alt = '';
  readonly attrs = new Map<string, string>();
  readonly style: Record<string, string> = {};
  readonly classes = new Set<string>();
  readonly classList = {
    add: (name: string) => this.classes.add(name),
    remove: (name: string) => this.classes.delete(name),
  };
  set src(value: string) { this.attrs.set('src', value); }
  get src(): string { return this.attrs.get('src') ?? ''; }
  set width(value: number) { this.attrs.set('width', String(value)); }
  set height(value: number) { this.attrs.set('height', String(value)); }
  setAttribute(name: string, value: string): void { this.attrs.set(name, value); }
  removeAttribute(name: string): void { this.attrs.delete(name); }
  click(): void { this.dispatchEvent(new Event('click')); }
}

const words = strings('en').explainWindow.vision;
const image = (data: string, width: number, height: number, x: number, y: number) => ({
  dataUrl: `data:image/jpeg;base64,${data}`, width, height, marker: { x, y },
});
const reply = (sessionId = 1): VisionReply => ({
  sessionId,
  result: { ok: true, preview: {
    displayId: 77, original: { x: 960, y: 540, width: 1920, height: 1080 },
    crop: { x: 640, y: 300, width: 640, height: 480 },
    local: image(`local-${sessionId}`, 640, 480, 0.5, 0.5), full: image(`full-${sessionId}`, 1280, 720, 0.25, 0.75),
  } },
});

function deferred() {
  let resolve: (value: VisionReply | null) => void = () => undefined;
  const promise = new Promise<VisionReply | null>((done) => { resolve = done; });
  return { promise, resolve };
}

function setup(capture = vi.fn<(id: number) => Promise<VisionReply | null>>(async (id) => reply(id))) {
  const ui = {
    open: new Element(), close: new Element(), text: new Element(), preview: new Element(),
    privacy: new Element(), timing: new Element(), status: new Element(), images: new Element(),
    local: new Element(), full: new Element(), localCaption: new Element(), fullCaption: new Element(),
    localMarker: new Element(), fullMarker: new Element(),
  };
  const api = { capture, closePreview: vi.fn() };
  const preview = new VisionPreview(api, ui as unknown as VisionElements);
  preview.setWords(words);
  preview.setSession(1);
  preview.setAvailable(true);
  return { preview, ui, api };
}

afterEach(() => vi.unstubAllGlobals());

describe('VisionPreview', () => {
  it('waits for an explicit preview click and does not capture when only a session changes', () => {
    const { preview, ui, api } = setup();
    expect(api.capture).not.toHaveBeenCalled();
    expect(ui.open.hidden).toBe(false);
    expect(ui.preview.hidden).toBe(true);
    preview.setSession(2);
    expect(api.capture).not.toHaveBeenCalled();
    preview.setAvailable(false);
    expect(ui.open.hidden).toBe(true);
  });

  it('shows both images, dimensions, fixed markers and the local-only status without changing text content', async () => {
    const { preview, ui, api } = setup();
    ui.text.textContent = 'Existing question and streamed answer';
    const pending = preview.open();
    expect(ui.status.textContent).toBe(words.loading);
    expect(ui.text.hidden).toBe(true);
    await pending;
    expect(api.capture).toHaveBeenCalledWith(1);
    expect(ui.images.hidden).toBe(false);
    expect(ui.local.src).toBe('data:image/jpeg;base64,local-1');
    expect(ui.full.src).toBe('data:image/jpeg;base64,full-1');
    expect(ui.local.attrs.get('width')).toBe('640');
    expect(ui.localCaption.textContent).toBe(`${words.local} · 640 × 480`);
    expect(ui.fullMarker.style).toEqual({ left: '25%', top: '75%' });
    expect(ui.localMarker.style).toEqual({ left: '50%', top: '50%' });
    expect(ui.localMarker.attrs.get('aria-label')).toBe(words.marker);
    expect(ui.privacy.textContent).toBe(words.privacy);
    expect(ui.timing.textContent).toBe(words.timing);
    ui.close.click();
    expect(ui.text.hidden).toBe(false);
    expect(ui.text.textContent).toBe('Existing question and streamed answer');
  });

  it('releases image sources and dimensions on close and on a new ping', async () => {
    const { preview, ui, api } = setup();
    await preview.open();
    ui.close.click();
    expect(api.closePreview).toHaveBeenCalledWith(1);
    for (const img of [ui.local, ui.full]) {
      expect(img.attrs.has('src')).toBe(false);
      expect(img.attrs.has('width')).toBe(false);
      expect(img.attrs.has('height')).toBe(false);
    }
    await preview.open();
    preview.setSession(2);
    expect(ui.local.src).toBe('');
    expect(ui.full.src).toBe('');
    expect(ui.preview.hidden).toBe(true);
    expect(ui.text.hidden).toBe(false);
    expect(ui.localCaption.textContent).toBe('');
  });

  it('drops a pending screenshot after close and lets the same ping be captured again', async () => {
    const old = deferred();
    const capture = vi.fn<(id: number) => Promise<VisionReply | null>>()
      .mockReturnValueOnce(old.promise).mockResolvedValue(reply());
    const { preview, ui } = setup(capture);
    const pending = preview.open();
    preview.close();
    await preview.open();
    expect(ui.local.src).not.toBe('');
    old.resolve({ sessionId: 1, result: { ok: false, code: 'captureFailed' } });
    await pending;
    expect(ui.local.src).toBe('data:image/jpeg;base64,local-1');
    expect(ui.status.textContent).toBe('');
  });

  it('never associates an older capture with a new ping even if the initial state arrives late', async () => {
    const old = deferred();
    const capture = vi.fn<(id: number) => Promise<VisionReply | null>>()
      .mockReturnValueOnce(old.promise).mockResolvedValue(reply(2));
    const { preview, ui } = setup(capture);
    const pending = preview.open();
    preview.setSession(2);
    preview.setSession(1);
    await preview.open();
    expect(capture).toHaveBeenLastCalledWith(2);
    old.resolve(reply(1));
    await pending;
    expect(ui.local.src).toBe('data:image/jpeg;base64,local-2');
    expect(ui.preview.hidden).toBe(false);
    expect(ui.status.textContent).toBe('');
  });

  it('coalesces rapid clicks while a capture is pending', async () => {
    const capture = deferred();
    const { preview, ui, api } = setup(vi.fn(() => capture.promise));
    const pending = preview.open();
    ui.open.click();
    ui.open.click();
    expect(api.capture).toHaveBeenCalledTimes(1);
    capture.resolve(reply());
    await pending;
    expect(ui.images.hidden).toBe(false);
  });

  it('shows capture errors and permits returning to the unchanged text form', async () => {
    const { preview, ui } = setup(vi.fn(async () => ({
      sessionId: 1, result: { ok: false as const, code: 'displayGone' as const },
    })));
    await preview.open();
    expect(ui.status.textContent).toBe(words.errors.displayGone);
    expect(ui.status.classes.has('warn')).toBe(true);
    expect(ui.images.hidden).toBe(true);
    expect(ui.close.hidden).toBe(false);
    ui.close.click();
    expect(ui.text.hidden).toBe(false);
    expect(ui.open.disabled).toBe(false);
  });

  it('turns an IPC rejection or mismatched session into a local error without retaining images', async () => {
    const { preview, ui } = setup(vi.fn().mockRejectedValue(new Error('IPC closed')));
    await preview.open();
    expect(ui.status.textContent).toBe(words.errors.captureFailed);
    expect(ui.local.src).toBe('');
    const other = setup(vi.fn(async () => reply(50)));
    await other.preview.open();
    expect(other.ui.status.textContent).toBe(words.errors.stale);
    expect(other.ui.full.src).toBe('');
  });

  it('releases images on teardown and ignores in-flight replies after the window unloads', async () => {
    const capture = deferred();
    const { preview, ui } = setup(vi.fn(() => capture.promise));
    const pending = preview.open();
    preview.destroy();
    capture.resolve(reply());
    await pending;
    expect(ui.local.src).toBe('');
    expect(ui.full.src).toBe('');
    expect(ui.preview.hidden).toBe(true);
    ui.open.click();
    expect(ui.preview.hidden).toBe(true);
  });

  it('previews without asking a model, reading a key, fetching, or copying a screenshot', async () => {
    const fetch = vi.fn();
    const writeText = vi.fn();
    const ask = vi.fn();
    const readKey = vi.fn();
    vi.stubGlobal('fetch', fetch);
    vi.stubGlobal('navigator', { clipboard: { writeText } });
    const api = { capture: vi.fn(async () => reply()), closePreview: vi.fn(), ask, readKey };
    const { ui } = setup();
    const preview = new VisionPreview(api, ui as unknown as VisionElements);
    preview.setWords(words);
    preview.setSession(1);
    preview.setAvailable(true);
    await preview.open();
    preview.close();
    expect(api.capture).toHaveBeenCalledOnce();
    expect(ui.local.src).toBe('');
    expect(fetch).not.toHaveBeenCalled();
    expect(ask).not.toHaveBeenCalled();
    expect(readKey).not.toHaveBeenCalled();
    expect(writeText).not.toHaveBeenCalled();
  });
});
