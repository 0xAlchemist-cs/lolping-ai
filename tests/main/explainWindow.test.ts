import { EventEmitter } from 'node:events';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { EXPLAIN_CH, type ExplainApi, type ExplainEvent, type ExplainText } from '../../src/shared/ipc';
import { AiRequests, type PreparedAi } from '../../src/main/aiRequest';
import type { AiFetch } from '../../src/main/aiClient';
import { strings } from '../../src/shared/i18n';
import { MAX_VISION_DATA_URL_CHARS, type VisionPreview, type VisionResult, type VisionTarget } from '../../src/shared/vision';

const { windows } = vi.hoisted(() => ({ windows: [] as unknown[] }));
const { handles } = vi.hoisted(() => ({ handles: new Map<string, (event: unknown, raw: unknown) => unknown>() }));
const { sends } = vi.hoisted(() => ({ sends: new Map<string, (event: unknown, raw: unknown) => void>() }));
const { darkFrame } = vi.hoisted(() => ({ darkFrame: vi.fn<() => Promise<boolean>>() }));
vi.mock('../../src/main/windowsFrame', () => ({ useDarkWindowFrame: darkFrame }));

vi.mock('electron', async () => {
  const { EventEmitter: Emitter } = await import('node:events');
  class FakeContents extends Emitter {
    openHandler: ((details: { url: string }) => { action: string }) | null = null;
    sent: Array<[string, unknown]> = [];
    mainFrame = { send: (channel: string, payload: unknown): void => { this.send(channel, payload); } };
    setWindowOpenHandler(handler: (details: { url: string }) => { action: string }): void {
      this.openHandler = handler;
    }
    send(channel: string, payload: unknown): void {
      this.sent.push([channel, payload]);
      this.emit(channel, payload);
    }
  }
  class FakeWindow extends Emitter {
    webContents = new FakeContents();
    destroyed = false;
    shown = false;
    constructor(readonly options: Record<string, unknown>) {
      super();
      windows.push(this);
    }
    isDestroyed(): boolean {
      return this.destroyed;
    }
    setAlwaysOnTop(): void {}
    show(): void {
      this.shown = true;
    }
    focus(): void {
      this.emit('focus');
    }
    close(): void {
      this.destroyed = true;
      this.emit('closed');
    }
  }
  const display = { id: 1, bounds: { x: 0, y: 0, width: 1920, height: 1080 }, workArea: { x: 0, y: 0, width: 1920, height: 1040 } };
  const screen = { getDisplayNearestPoint: () => ({ ...display, workArea: currentWorkArea }) };
  const ipcMain = {
    handle: (channel: string, fn: (event: unknown, raw: unknown) => unknown) => handles.set(channel, fn),
    on: (channel: string, fn: (event: unknown, raw: unknown) => void) => sends.set(channel, fn),
  };
  return { BrowserWindow: FakeWindow, ipcMain, screen: { ...screen,
    getAllDisplays: () => displayPresent ? [{ ...display, ...TARGET, id: TARGET.displayId }] : [] },
    nativeImage: { createFromDataURL: () => ({ isEmpty: () => false, getSize: () => ({ width: 2, height: 1 }) }) } };
});

vi.mock('../../src/main/paths', () => ({
  IS_MAC: false, IS_LINUX: false,
  loadPage: () => Promise.resolve(),
  pageUrl: () => 'lolping://app/explain/index.html',
  preloadPath: () => 'preload.js',
}));

vi.mock('../../src/main/coords', () => ({ placeInside: (p: unknown, size: { width: number; height: number }) => ({ x: 10, y: 10, ...size }) }));

type FakeContents = EventEmitter & { sent: Array<[string, unknown]>; mainFrame: unknown;
  openHandler: ((d: { url: string }) => { action: string }) | null };
type FakeWindow = EventEmitter & { webContents: FakeContents; shown: boolean; options: Record<string, unknown>; close(): void };
type Mod = typeof import('../../src/main/explainWindow');
let mod: Mod;

const WORDS: ExplainText = { ...strings('en').explainWindow, errors: strings('en').aiError };

/** A deps double that records asks and lets the test push events back through the captured sink. */
let asked: Array<{ q: string; id: number; sink: (ev: ExplainEvent) => void }> = [];
let cancelled = 0;
const deps = {
  ask: (q: string, id: number, sink: (ev: ExplainEvent) => void) => {
    asked.push({ q, id, sink });
  },
  cancel: () => {
    cancelled += 1;
  },
  configured: () => configuredFlag,
  openSettings: () => {
    openedSettings += 1;
  },
  capture: vi.fn<(target: VisionTarget) => Promise<VisionResult>>(),
};
let configuredFlag = true;
let openedSettings = 0;
let displayPresent = true;
let currentWorkArea = { x: 0, y: 0, width: 1920, height: 1040 };

beforeEach(async () => {
  vi.useFakeTimers();
  windows.length = 0;
  handles.clear();
  sends.clear();
  asked = [];
  cancelled = 0;
  configuredFlag = true;
  openedSettings = 0;
  displayPresent = true;
  currentWorkArea = { x: 0, y: 0, width: 1920, height: 1040 };
  deps.capture.mockReset();
  darkFrame.mockReset().mockResolvedValue(true);
  deps.capture.mockResolvedValue({ ok: true, preview: PREVIEW });
  vi.resetModules();
  mod = await import('../../src/main/explainWindow');
  mod.registerExplainWindow(deps);
});

class FlowElement extends EventTarget {
  hidden = false;
  disabled = false;
  checked = false;
  value = '';
  textContent = '';
  complete = false;
  naturalWidth = 0;
  readonly attrs = new Map<string, string>();
  readonly style: Record<string, string> = {};
  readonly classes = new Set<string>();
  readonly classList = {
    add: (name: string) => this.classes.add(name), remove: (name: string) => this.classes.delete(name),
    toggle: (name: string, on: boolean) => on ? this.classes.add(name) : this.classes.delete(name),
  };
  set src(value: string) { this.attrs.set('src', value); this.complete = false; this.naturalWidth = 0; }
  get src(): string { return this.attrs.get('src') ?? ''; }
  setAttribute(name: string, value: string): void { this.attrs.set(name, value); }
  removeAttribute(name: string): void { this.attrs.delete(name); }
  focus(): void {}
  click(): void { if (!this.disabled && !this.hidden) this.dispatchEvent(new Event('click')); }
  loaded(): void { this.complete = true; this.naturalWidth = 2; this.dispatchEvent(new Event('load')); }
}

function deferredFlow<T>() {
  let resolve: (value: T) => void = () => undefined;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

/** Actual renderer -> authorized main IPC -> snapshots -> preparation -> actual client, with only OS/network fakes. */
async function flow(options: { pendingPreparation?: boolean; status?: number; holdStream?: boolean;
  streamEnd?: 'length' | 'malformed' | 'network' | 'eof' } = {}) {
  const { TEST_JPEG_DATA_URL, TEST_JPEG_BASE64 } = await import('./fixtures/visionJpeg');
  const jpeg = Buffer.from(TEST_JPEG_BASE64, 'base64');
  const fullUrl = 'data:image/jpeg;base64,' + Buffer.concat([jpeg.subarray(0, 2),
    Buffer.from([0xff, 0xfe, 0, 6, 102, 117, 108, 108]), jpeg.subarray(2)]).toString('base64');
  const image = (dataUrl: string) => ({ dataUrl, width: 2, height: 1, marker: { x: .5, y: .5 } });
  const preview = { ...PREVIEW, local: image(TEST_JPEG_DATA_URL), full: image(fullUrl) };
  let recipient = { baseUrl: 'https://mock.invalid/v1', model: 'mock-vision' };
  const ready: PreparedAi = { ok: true, ...recipient, key: 'synthetic-fixture' };
  const preparation = deferredFlow<PreparedAi>();
  const resume = deferredFlow<void>();
  const trace: string[] = [];
  const fetchImpl = vi.fn<AiFetch>(async (_url, init) => {
    trace.push('client.fetch');
    const payload = JSON.parse(init.body) as { stream: boolean; messages: Array<{ content: Array<{
      type: string; image_url?: { url: string };
    }> }> };
    expect(payload.stream).toBe(true);
    const images = payload.messages[0].content.filter((part) => part.type === 'image_url');
    expect(images.length).toBe(2);
    // Compare booleans so a test failure cannot dump encoded image data.
    expect(images[0].image_url?.url === preview.local.dataUrl).toBe(true);
    expect(images[1].image_url?.url === preview.full.dataUrl).toBe(true);
    return { ok: !options.status, status: options.status ?? 200, body: (async function* () {
      if (options.status) { yield new TextEncoder().encode('{"error":{"message":"synthetic private echo"}}'); return; }
      yield new TextEncoder().encode('data: {"choices":[{"delta":{"content":"mock dual answer"}}]}\n\n');
      if (options.holdStream) await resume.promise;
      if (options.streamEnd === 'network') throw new TypeError('synthetic disconnect');
      if (options.streamEnd === 'eof') return;
      if (options.streamEnd === 'malformed') yield new TextEncoder().encode('data: {broken}\n\n');
      if (options.streamEnd === 'length') yield new TextEncoder().encode('data: {"choices":[{"finish_reason":"length"}]}\n\n');
      yield new TextEncoder().encode('data: [DONE]\n\n');
    })() };
  });
  const requests = new AiRequests({ prepare: async () => {
    trace.push('main.prepare'); return options.pendingPreparation ? preparation.promise : ready;
  }, recipient: () => recipient, fetchImpl, now: Date.now });
  let running = Promise.resolve<{ ok: boolean; code?: string }>({ ok: true });
  const capture = vi.fn(async (): Promise<VisionResult> => {
    trace.push('capture.success'); return { ok: true, preview };
  });
  mod.registerExplainWindow({ ...deps, capture, recipient: () => recipient, cancel: () => requests.cancel(),
    ask: (question, id, sink, upload) => {
      trace.push('main.ask');
      running = requests.run(question, 32, (text) => sink({ kind: 'delta', id, text }), upload).then((result) => {
        trace.push(result.ok ? 'sse.done' : `failure.${result.code}`);
        sink(result.ok ? { kind: 'done', id } : { kind: 'error', id, code: result.code });
        return result;
      });
    } });
  mod.openExplainWindow({ x: 10, y: 20 }, WORDS, TARGET);
  const win = windows[0] as FakeWindow;
  const ui = new Map<string, FlowElement>();
  win.emit('focus'); // A real ready-to-show card takes focus before the user can send.
  const get = (id: string): FlowElement => {
    let element = ui.get(id);
    if (!element) { element = new FlowElement(); ui.set(id, element); }
    return element;
  };
  const invoke = <T>(channel: string, raw?: unknown): Promise<T> =>
    Promise.resolve(handles.get(channel)?.(ownerEvent(win), raw)) as Promise<T>;
  const send = (channel: string, raw?: unknown): void => sends.get(channel)?.(ownerEvent(win), raw);
  const api: ExplainApi = {
    strings: async () => WORDS, state: () => invoke(EXPLAIN_CH.state), capture: (id) => invoke(EXPLAIN_CH.capture, id),
    ask: (question) => invoke(EXPLAIN_CH.ask, question),
    askVision: (input) => { trace.push('renderer.askVision'); return invoke(EXPLAIN_CH.askVision, input); },
    stop: () => send(EXPLAIN_CH.stop), close: () => send(EXPLAIN_CH.close), openSettings: () => undefined,
    closePreview: (id) => send(EXPLAIN_CH.closePreview, id),
    on: (callback) => { win.webContents.on(EXPLAIN_CH.event, callback); return () => undefined; },
    onVisionSession: (callback) => { win.webContents.on(EXPLAIN_CH.visionSession, callback); return () => undefined; },
  };
  vi.stubGlobal('document', Object.assign(new EventTarget(), { getElementById: get, title: '' }));
  vi.stubGlobal('window', Object.assign(new EventTarget(), { explainApi: api }));
  vi.stubGlobal('navigator', { clipboard: { writeText: async () => undefined } });
  vi.stubGlobal('requestAnimationFrame', (callback: () => void) => callback());
  await import('../../src/renderer/explain/main');
  await Promise.resolve();
  const open = async () => {
    get('previewOpen').click();
    await vi.waitFor(() => expect(get('visionLocal').src !== '').toBe(true));
    get('visionLocal').loaded(); get('visionFull').loaded();
  };
  const both = () => { get('visionIncludeFull').checked = true; get('visionIncludeFull').dispatchEvent(new Event('change')); };
  return { get, win, trace, fetchImpl, capture, preparation, resume, ready, open, both,
    finish: () => running, change: () => { recipient = { ...recipient, model: 'changed' }; } };
}

describe('explainWindow dual-image integration', () => {
  it.each([['length', 'outputLimit'], ['malformed', 'badResponse'], ['network', 'network'], ['eof', 'badResponse']] as const)(
    'keeps the partial answer through renderer/main/client on %s without a false completion', async (streamEnd, code) => {
      const t = await flow({ streamEnd }); await t.open(); t.both(); t.get('visionSend').click();
      await vi.waitFor(() => expect(t.get('send').disabled).toBe(false));
      expect(t.get('body').textContent).toBe('mock dual answer');
      expect(t.get('copy').disabled).toBe(false);
      expect(t.get('stop').hidden).toBe(true);
      expect(t.get('hint').textContent).not.toBe(WORDS.generating);
      expect(code === 'outputLimit' ? t.get('hint').textContent : t.get('failureText').textContent).toBe(WORDS.errors[code]);
      expect(t.fetchImpl).toHaveBeenCalledOnce();
      expect(t.trace).toContain(`failure.${code}`);
      expect(t.trace).not.toContain('sse.done');
    });
  it('sends exactly the two reviewed images once and exits generating after actual SSE done', async () => {
    const t = await flow(); await t.open(); t.both();
    expect(t.get('visionSelection').textContent).toBe(WORDS.vision.selectedBoth);
    expect(t.get('visionSend').disabled).toBe(false);
    t.get('visionQuestion').value = 'Explain the relationship';
    t.get('visionSend').click(); t.get('visionSend').click();
    expect(await t.finish()).toEqual({ ok: true });
    expect(t.fetchImpl).toHaveBeenCalledTimes(1);
    expect(t.trace).toEqual(['capture.success', 'renderer.askVision', 'main.ask', 'main.prepare', 'client.fetch', 'sse.done']);
    expect(t.get('body').textContent).toBe('mock dual answer');
    expect(t.get('hint').textContent).toBe('');
    expect(t.get('send').disabled).toBe(false);
    expect(t.get('stop').hidden).toBe(true);
  });

  it('recovers an expired preview only after explicit recapture, reselecting full scope and a new send click', async () => {
    const t = await flow(); await t.open(); t.both();
    vi.advanceTimersByTime(120_000);
    expect(t.get('visionSend').attrs.get('data-block-reason')).toBe('expired');
    t.get('visionSend').click();
    expect(t.fetchImpl).not.toHaveBeenCalled();
    await t.open();
    expect(t.get('visionIncludeFull').checked).toBe(false);
    expect(t.capture).toHaveBeenCalledTimes(2);
    t.both(); t.get('visionSend').click();
    expect(await t.finish()).toEqual({ ok: true });
    expect(t.fetchImpl).toHaveBeenCalledTimes(1);
  });

  it.each(['expiry', 'capture', 'config', 'session', 'close', 'stop'] as const)(
    'starts no client request after %s during preparation and leaves no thinking state', async (action) => {
      const t = await flow({ pendingPreparation: true }); await t.open(); t.both();
      t.get('visionSend').click();
      if (action === 'expiry') vi.advanceTimersByTime(120_000);
      if (action === 'capture' || action === 'close') {
        await t.open();
        if (action === 'close') t.get('previewClose').click();
      }
      if (action === 'config') t.change();
      if (action === 'session') mod.openExplainWindow({ x: 10, y: 20 }, WORDS, TARGET);
      if (action === 'stop') t.get('stop').click();
      t.preparation.resolve(t.ready);
      const result = await t.finish();
      expect(result).toEqual({ ok: false, code: action === 'expiry' ? 'snapshotExpired'
        : action === 'config' ? 'configChanged' : action === 'capture' ? 'snapshotStale' : 'aborted' });
      expect(t.fetchImpl).not.toHaveBeenCalled();
      expect(t.get('send').disabled).toBe(false);
      expect(t.get('hint').textContent).toBe('');
    });

  it('cancels a running dual-image stream without allowing a late completion to change the stopped UI', async () => {
    const t = await flow({ holdStream: true }); await t.open(); t.both(); t.get('visionSend').click();
    await vi.waitFor(() => expect(t.get('body').textContent).toBe('mock dual answer'));
    t.get('stop').click();
    t.resume.resolve();
    expect(await t.finish()).toEqual({ ok: false, code: 'aborted' });
    expect(t.fetchImpl).toHaveBeenCalledTimes(1);
    expect(t.get('send').disabled).toBe(false);
    expect(t.get('hint').textContent).toBe('');
  });

  it('shows a fixed service rejection and requires new review without automatic retry', async () => {
    const t = await flow({ status: 403 }); await t.open(); t.both(); t.get('visionSend').click();
    expect(await t.finish()).toEqual({ ok: false, code: 'permission' });
    expect(t.get('failureText').textContent).toBe(WORDS.errors.permission);
    t.get('retry').click();
    expect(t.fetchImpl).toHaveBeenCalledTimes(1);
    expect(t.capture).toHaveBeenCalledTimes(1);
    await t.open();
    expect(t.capture).toHaveBeenCalledTimes(2);
    expect(t.get('visionIncludeFull').checked).toBe(false);
    expect(t.get('visionSend').disabled).toBe(false);
    expect(t.fetchImpl).toHaveBeenCalledTimes(1);
  });
});

describe('explainWindow confirmed vision upload', () => {
  it('opens a resizable card with useful minimum bounds and the existing sandbox', () => {
    mod.openExplainWindow({ x: 20, y: 30 }, WORDS, TARGET);
    expect((windows[0] as FakeWindow).options).toMatchObject({
      width: 560, height: 600, minWidth: 400, minHeight: 360, resizable: true, maximizable: true,
      webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false },
    });
  });

  it('fits the initial card and its minimum size inside a small display work area', () => {
    currentWorkArea = { x: -800, y: 0, width: 360, height: 320 };
    mod.openExplainWindow({ x: -600, y: 30 }, WORDS, TARGET);
    expect((windows[0] as FakeWindow).options).toMatchObject({
      width: 360, height: 320, minWidth: 360, minHeight: 320,
    });
  });
  it('refuses an unconfirmed upload without an image snapshot', async () => {
    mod.openExplainWindow({ x: 20, y: 30 }, WORDS, TARGET);
    const win = windows[0] as FakeWindow;
    expect(await handles.get(EXPLAIN_CH.askVision)?.(ownerEvent(win), {
      sessionId: session(win), snapshotId: 1, question: 'why?', scope: 'local', confirmed: false,
    })).toMatchObject({ ok: false, code: 'consentRequired' });
    expect(asked).toEqual([]);
  });
  async function prepare() {
    const { TEST_JPEG_DATA_URL } = await import('./fixtures/visionJpeg');
    const picture = { dataUrl: TEST_JPEG_DATA_URL, width: 2, height: 1, marker: { x: 0.5, y: 0.5 } };
    const preview = { ...PREVIEW, local: picture, full: { ...picture } };
    deps.capture.mockResolvedValue({ ok: true, preview });
    let recipient = { baseUrl: 'https://example.org/v1', model: 'glm-5.3-flash' };
    const uploads: import('../../src/main/explainWindow').VisionUpload[] = [];
    mod.registerExplainWindow({ ...deps, recipient: () => recipient,
      ask: (q, id, sink, upload) => { deps.ask(q, id, sink); if (upload) uploads.push(upload); } });
    mod.openExplainWindow({ x: 20, y: 30 }, WORDS, TARGET);
    const win = windows[0] as FakeWindow;
    const reply = await handles.get(EXPLAIN_CH.capture)?.(ownerEvent(win), session(win)) as {
      snapshot: { snapshotId: number; recipient: { domain: string; model: string } };
    };
    return { win, preview, uploads, reply, changeRecipient: () => { recipient = { ...recipient, model: 'other' }; },
      send: (overrides: Record<string, unknown> = {}) => handles.get(EXPLAIN_CH.askVision)?.(ownerEvent(win), {
        sessionId: session(win), snapshotId: reply.snapshot?.snapshotId,
        scope: 'local', question: 'Explain this', confirmed: true, ...overrides,
      }) };
  }

  it('uploads exactly the approved local JPEG once without recapturing or adding the full image', async () => {
    const { send, uploads, preview, reply } = await prepare();
    expect(reply.snapshot).toMatchObject({ recipient: { domain: 'example.org', model: 'glm-5.3-flash' } });
    expect(await send()).toMatchObject({ ok: true, id: expect.any(Number) });
    expect(uploads.map(({ images, recipient }) => ({ images, recipient }))).toEqual([{ images: [preview.local], recipient: {
      baseUrl: 'https://example.org/v1', model: 'glm-5.3-flash' } }]);
    expect(uploads[0].expiresAt).toBe(Date.now() + 120_000);
    expect(uploads[0].isCurrent()).toBe(true);
    expect(await send()).toMatchObject({ ok: false });
    expect(uploads).toHaveLength(1);
    expect(deps.capture.mock.calls).toHaveLength(1);
  });

  it('uploads both approved JPEGs only with explicit full-screen selection', async () => {
    const { send, uploads, preview } = await prepare();
    expect(await send({ scope: 'localAndFull' })).toMatchObject({ ok: true });
    expect(uploads[0].images).toEqual([preview.local, preview.full]);
  });

  it('ends the renderer stream when a reopened preview is closed during a vision answer', async () => {
    const { send, win } = await prepare();
    const reply = await send() as { ok: true; id: number };
    await handles.get(EXPLAIN_CH.capture)?.(ownerEvent(win), session(win));
    sends.get(EXPLAIN_CH.closePreview)?.(ownerEvent(win), session(win));
    expect(win.webContents.sent.filter(([channel]) => channel === EXPLAIN_CH.event)).toEqual([
      [EXPLAIN_CH.event, { kind: 'error', id: reply.id, code: 'aborted' }],
    ]);
    expect(cancelled).toBe(2);
    asked[0].sink({ kind: 'delta', id: reply.id, text: 'late screenshot answer' });
    asked[0].sink({ kind: 'done', id: reply.id });
    expect(win.webContents.sent.filter(([channel]) => channel === EXPLAIN_CH.event)).toHaveLength(1);
  });

  it('restores ordinary blur closing after consuming preview consent and a vision failure', async () => {
    const { send, win } = await prepare();
    const reply = await send() as { ok: true; id: number };
    asked[0].sink({ kind: 'error', id: reply.id, code: 'rate' });
    win.emit('focus');
    win.emit('blur');
    expect(handles.get(EXPLAIN_CH.state)?.(ownerEvent(win), undefined)).toBeNull();
  });

  it.each(['outputLimit', 'stop'] as const)('keeps displayed partial text after %s when focus moves away', async (terminal) => {
    const { send, win } = await prepare();
    const reply = await send() as { ok: true; id: number };
    asked[0].sink({ kind: 'delta', id: reply.id, text: 'Partial synthetic answer' });
    if (terminal === 'outputLimit') asked[0].sink({ kind: 'error', id: reply.id, code: 'outputLimit' });
    else sends.get(EXPLAIN_CH.stop)?.(ownerEvent(win), undefined);
    win.emit('focus');
    win.emit('blur');
    expect(handles.get(EXPLAIN_CH.state)?.(ownerEvent(win), undefined)).not.toBeNull();
  });

  it('rejects forged payloads, missing consent and foreign frames before starting a request', async () => {
    const { send, uploads, win } = await prepare();
    for (const input of [{ confirmed: false }, { images: ['file:///private'] }, { dataUrl: 'fake' },
      { snapshotId: -1 }, { sessionId: -1 }, { scope: 'all' }, { question: '' }]) {
      expect(await send(input)).toMatchObject({ ok: false });
    }
    expect(await handles.get(EXPLAIN_CH.askVision)?.({ sender: win.webContents, senderFrame: {} }, {})).toBeNull();
    expect(uploads).toEqual([]);
  });

  it('invalidates approval when preview closes, recipient changes or display disappears', async () => {
    const first = await prepare();
    first.changeRecipient();
    expect(await first.send()).toMatchObject({ ok: false });
    const second = await prepare();
    displayPresent = false;
    expect(await second.send()).toMatchObject({ ok: false });
    displayPresent = true;
    const third = await prepare();
    sends.get(EXPLAIN_CH.closePreview)?.(ownerEvent(third.win), session(third.win));
    expect(await third.send()).toMatchObject({ ok: false });
    expect([...first.uploads, ...second.uploads, ...third.uploads]).toEqual([]);
  });

  it('refuses expired snapshots without sending and keeps ordinary text asks image-free', async () => {
    const { send, win, uploads } = await prepare();
    vi.advanceTimersByTime(120001);
    expect(await send()).toMatchObject({ ok: false });
    expect(await handles.get(EXPLAIN_CH.ask)?.(ownerEvent(win), 'text only')).toBeGreaterThan(0);
    expect(uploads).toEqual([]);
  });
});

afterEach(() => { mod.closeExplainWindow(); vi.useRealTimers(); vi.unstubAllGlobals(); });

const TARGET: VisionTarget = { displayId: 2, x: 123, y: 234,
  bounds: { x: -1920, y: 0, width: 1920, height: 1080 }, scaleFactor: 1 };
const PREVIEW: VisionPreview = { displayId: 2, original: { x: 123, y: 234, width: 1920, height: 1080 },
  crop: { x: 0, y: 0, width: 640, height: 480 },
  local: { dataUrl: 'data:image/jpeg;base64,bG9jYWw=', width: 640, height: 480, marker: { x: 0.2, y: 0.5 } },
  full: { dataUrl: 'data:image/jpeg;base64,ZnVsbA==', width: 1920, height: 1080, marker: { x: 0.1, y: 0.2 } } };

const ownerEvent = (w: FakeWindow) => ({ sender: w.webContents, senderFrame: w.webContents.mainFrame });
function session(w: FakeWindow): number {
  return (handles.get(EXPLAIN_CH.state)?.(ownerEvent(w), undefined) as { visionSessionId: number }).visionSessionId;
}

describe('explainWindow streaming protocol', () => {
  it.each(['done', 'error'] as const)('forwards only one terminal event after %s and discards later deltas', async (kind) => {
    mod.openExplainWindow({ x: 100, y: 100 }, WORDS);
    const w = windows[0] as FakeWindow;
    const id = handles.get(EXPLAIN_CH.ask)?.(ownerEvent(w), 'synthetic terminal') as number;
    const emit = asked[0].sink;
    const terminal: ExplainEvent = kind === 'done' ? { kind, id } : { kind, id, code: 'network' };
    emit({ kind: 'delta', id, text: 'partial' });
    emit(terminal);
    emit(terminal);
    emit({ kind: 'delta', id, text: 'late corruption' });
    emit({ kind: 'error', id, code: 'server' });
    expect(w.webContents.sent.filter(([channel]) => channel === EXPLAIN_CH.event).map(([, event]) => event))
      .toEqual([{ kind: 'delta', id, text: 'partial' }, terminal]);
  });
  it('streams an ask: id out, deltas in, done ends it', async () => {
    mod.openExplainWindow({ x: 100, y: 100 }, WORDS);
    const contents = (windows[0] as FakeWindow).webContents;
    const id = (await handles.get(EXPLAIN_CH.ask)!({ sender: contents, senderFrame: contents.mainFrame }, '  why?  ')) as number;
    expect(id).toBeGreaterThan(0);
    expect(asked).toEqual([{ q: 'why?', id, sink: expect.any(Function) }]);
    asked[0].sink({ kind: 'delta', id, text: 'Hello' });
    asked[0].sink({ kind: 'delta', id, text: ' world' });
    asked[0].sink({ kind: 'done', id });
    const events = contents.sent.filter(([c]) => c === EXPLAIN_CH.event).map(([, p]) => p);
    expect(events).toEqual([
      { kind: 'delta', id, text: 'Hello' },
      { kind: 'delta', id, text: ' world' },
      { kind: 'done', id },
    ]);
  });

  it('rejects an ask from another sender and an unusable question', async () => {
    mod.openExplainWindow({ x: 100, y: 100 }, WORDS);
    expect(await handles.get(EXPLAIN_CH.ask)!({ sender: {} }, 'why?')).toBeNull();
    const contents = (windows[0] as FakeWindow).webContents;
    expect(await handles.get(EXPLAIN_CH.ask)!({ sender: contents, senderFrame: contents.mainFrame }, '   ')).toBeNull();
    expect(asked).toEqual([]);
  });

  it('a second ask cancels the first and invalidates its late events', async () => {
    mod.openExplainWindow({ x: 100, y: 100 }, WORDS);
    const contents = (windows[0] as FakeWindow).webContents;
    const first = (await handles.get(EXPLAIN_CH.ask)!({ sender: contents, senderFrame: contents.mainFrame }, 'one')) as number;
    expect(cancelled).toBe(1);
    const second = (await handles.get(EXPLAIN_CH.ask)!({ sender: contents, senderFrame: contents.mainFrame }, 'two')) as number;
    expect(second).toBeGreaterThan(first);
    // The first stream finishes late: every event must die at the sink.
    asked[0].sink({ kind: 'delta', id: first, text: 'late' });
    asked[0].sink({ kind: 'done', id: first });
    expect(contents.sent.filter(([c]) => c === EXPLAIN_CH.event)).toEqual([]);
  });

  it('stop cancels and invalidates; the window stays open for the next ask', async () => {
    mod.openExplainWindow({ x: 100, y: 100 }, WORDS);
    const win = windows[0] as FakeWindow;
    const id = (await handles.get(EXPLAIN_CH.ask)!({ sender: win.webContents, senderFrame: win.webContents.mainFrame }, 'slow one')) as number;
    sends.get(EXPLAIN_CH.stop)!({ sender: win.webContents, senderFrame: win.webContents.mainFrame }, undefined);
    expect(cancelled).toBe(2); // once from the ask's replace step, once from the stop itself
    asked[0].sink({ kind: 'delta', id, text: 'too late' });
    expect(win.webContents.sent.filter(([c]) => c === EXPLAIN_CH.event)).toEqual([]);
    const next = (await handles.get(EXPLAIN_CH.ask)!({ sender: win.webContents, senderFrame: win.webContents.mainFrame }, 'again')) as number;
    expect(next).toBeGreaterThan(id);
  });

  it('closing the window cancels the stream and late events go nowhere', async () => {
    mod.openExplainWindow({ x: 100, y: 100 }, WORDS);
    const win = windows[0] as FakeWindow;
    const id = (await handles.get(EXPLAIN_CH.ask)!({ sender: win.webContents, senderFrame: win.webContents.mainFrame }, 'q')) as number;
    win.close();
    expect(cancelled).toBe(2); // the ask's replace step, then the closed handler
    asked[0].sink({ kind: 'done', id });
    // Nothing to assert numerically: the sink must simply not touch the destroyed window.
  });

  it('reports configuration state to its own renderer only', async () => {
    configuredFlag = false;
    mod.openExplainWindow({ x: 100, y: 100 }, WORDS);
    const win = windows[0] as FakeWindow;
    expect(await handles.get(EXPLAIN_CH.state)!({ sender: win.webContents, senderFrame: win.webContents.mainFrame }, undefined)).toMatchObject({ configured: false });
    expect(await handles.get(EXPLAIN_CH.state)!({ sender: {} }, undefined)).toBeNull();
    sends.get(EXPLAIN_CH.openSettings)!({ sender: win.webContents, senderFrame: win.webContents.mainFrame }, undefined);
    expect(openedSettings).toBe(1);
    sends.get(EXPLAIN_CH.openSettings)!({ sender: {} }, undefined);
    expect(openedSettings).toBe(1);
  });
});

describe('explainWindow local capture lifecycle', () => {
  it('waits for native frame preparation before showing without expiring the focus watchdog while hidden', async () => {
    let finish: (ok: boolean) => void = () => undefined;
    darkFrame.mockReturnValueOnce(new Promise((resolve) => { finish = resolve; }));
    mod.openExplainWindow({ x: 10, y: 20 }, WORDS, TARGET);
    const w = windows[0] as FakeWindow;
    w.emit('ready-to-show');
    vi.advanceTimersByTime(2600);
    expect(w.shown).toBe(false);
    expect(handles.get(EXPLAIN_CH.state)?.(ownerEvent(w), undefined)).not.toBeNull();
    finish(true);
    await Promise.resolve();
    expect(w.shown).toBe(true);
  });

  it('ignores a late native frame result after closing and opens a replacement if styling is unavailable', async () => {
    let finish: (ok: boolean) => void = () => undefined;
    darkFrame.mockReturnValueOnce(new Promise((resolve) => { finish = resolve; }));
    mod.openExplainWindow({ x: 10, y: 20 }, WORDS, TARGET);
    const old = windows[0] as FakeWindow;
    old.emit('ready-to-show');
    old.close();
    darkFrame.mockResolvedValueOnce(false);
    mod.openExplainWindow({ x: 10, y: 20 }, WORDS, TARGET);
    const replacement = windows[1] as FakeWindow;
    replacement.emit('ready-to-show');
    finish(true);
    await Promise.resolve();
    expect(old.shown).toBe(false);
    expect(replacement.shown).toBe(true);
  });
  it('uses the frozen wheel centre without a key, an ask, a fetch or a stream cancellation', async () => {
    configuredFlag = false;
    const fetch = vi.fn(() => { throw new Error('capture must stay local'); });
    vi.stubGlobal('fetch', fetch);
    const target = { ...TARGET, bounds: { ...TARGET.bounds } };
    mod.openExplainWindow({ x: 10, y: 20 }, WORDS, target);
    target.x = 999;
    const w = windows[0] as FakeWindow;
    const id = session(w);
    const reply = await handles.get(EXPLAIN_CH.capture)?.(ownerEvent(w), id);
    expect(reply).toEqual({ sessionId: id, result: { ok: true, preview: PREVIEW } });
    expect(deps.capture).toHaveBeenCalledExactlyOnceWith(TARGET);
    expect(asked).toEqual([]);
    expect(cancelled).toBe(0);
    expect(fetch).not.toHaveBeenCalled();
  });

  it('rejects foreign frames and renderer-chosen positions before capture', async () => {
    mod.openExplainWindow({ x: 10, y: 20 }, WORDS, TARGET);
    const w = windows[0] as FakeWindow;
    const id = session(w);
    const handle = handles.get(EXPLAIN_CH.capture);
    for (const event of [{ sender: {} }, { sender: w.webContents },
      { sender: w.webContents, senderFrame: {} }, { sender: w.webContents, senderFrame: null }]) {
      expect(await handle?.(event, id)).toBeNull();
    }
    for (const raw of [id - 1, { sessionId: id, displayId: 1 }, null, '1']) {
      expect(await handle?.(ownerEvent(w), raw)).toBeNull();
    }
    expect(deps.capture).not.toHaveBeenCalled();
  });

  it('suppresses blur and the focus watchdog during capture, then keeps preview readable', async () => {
    mod.openExplainWindow({ x: 10, y: 20 }, WORDS, TARGET);
    const w = windows[0] as FakeWindow;
    let finish: (result: VisionResult) => void = () => undefined;
    deps.capture.mockImplementation(() => new Promise((resolve) => { finish = resolve; }));
    const pending = handles.get(EXPLAIN_CH.capture)?.(ownerEvent(w), session(w));
    vi.advanceTimersByTime(2600);
    w.emit('focus');
    w.emit('blur');
    expect(windows).toHaveLength(1);
    expect(await handles.get(EXPLAIN_CH.state)?.(ownerEvent(w), undefined)).not.toBeNull();
    finish({ ok: true, preview: PREVIEW });
    await pending;
    w.emit('blur');
    expect(await handles.get(EXPLAIN_CH.state)?.(ownerEvent(w), undefined)).not.toBeNull();
    sends.get(EXPLAIN_CH.closePreview)?.(ownerEvent(w), session(w));
    w.emit('blur');
    expect(await handles.get(EXPLAIN_CH.state)?.(ownerEvent(w), undefined)).toBeNull();
  });

  it('deduplicates rapid clicks and discards a result after the preview is closed', async () => {
    mod.openExplainWindow({ x: 10, y: 20 }, WORDS, TARGET);
    const w = windows[0] as FakeWindow;
    const id = session(w);
    let finish: (result: VisionResult) => void = () => undefined;
    deps.capture.mockImplementation(() => new Promise((resolve) => { finish = resolve; }));
    const handle = handles.get(EXPLAIN_CH.capture);
    const pending = handle?.(ownerEvent(w), id);
    expect(await handle?.(ownerEvent(w), id)).toEqual({ sessionId: id, result: { ok: false, code: 'busy' } });
    sends.get(EXPLAIN_CH.closePreview)?.(ownerEvent(w), id);
    finish({ ok: true, preview: PREVIEW });
    expect(await pending).toBeNull();
    expect(deps.capture).toHaveBeenCalledTimes(1);
  });

  it('replaces the location on a second question and never delivers the first screenshot to it', async () => {
    mod.openExplainWindow({ x: 10, y: 20 }, WORDS, TARGET);
    const w = windows[0] as FakeWindow;
    const old = session(w);
    let finish: (result: VisionResult) => void = () => undefined;
    deps.capture.mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
    const pending = handles.get(EXPLAIN_CH.capture)?.(ownerEvent(w), old);
    mod.openExplainWindow({ x: 20, y: 30 }, WORDS, { ...TARGET, x: 777 });
    expect(session(w)).toBeGreaterThan(old);
    expect(w.webContents.sent).toContainEqual([EXPLAIN_CH.visionSession, session(w)]);
    finish({ ok: true, preview: PREVIEW });
    expect(await pending).toBeNull();
    await handles.get(EXPLAIN_CH.capture)?.(ownerEvent(w), session(w));
    expect(deps.capture.mock.calls[1][0].x).toBe(777);
  });

  it('discards capture after a closed window and leaves a new card usable', async () => {
    mod.openExplainWindow({ x: 10, y: 20 }, WORDS, TARGET);
    const w = windows[0] as FakeWindow;
    let finish: (result: VisionResult) => void = () => undefined;
    deps.capture.mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
    const pending = handles.get(EXPLAIN_CH.capture)?.(ownerEvent(w), session(w));
    w.close();
    mod.openExplainWindow({ x: 20, y: 30 }, WORDS, TARGET);
    const next = windows[1] as FakeWindow;
    const focused = vi.fn();
    next.on('focus', focused);
    next.emit('ready-to-show');
    await Promise.resolve();
    finish({ ok: true, preview: PREVIEW });
    expect(await pending).toBeNull();
    expect(next.shown).toBe(true);
    expect(focused).toHaveBeenCalledOnce();
    expect(await handles.get(EXPLAIN_CH.capture)?.(ownerEvent(next), session(next))).toMatchObject({ result: { ok: true } });
  });

  it('returns capture failures and enforces the image IPC bound', async () => {
    mod.openExplainWindow({ x: 10, y: 20 }, WORDS, TARGET);
    const w = windows[0] as FakeWindow;
    const id = session(w);
    deps.capture.mockRejectedValueOnce(new Error('composition failure'));
    expect(await handles.get(EXPLAIN_CH.capture)?.(ownerEvent(w), id)).toEqual({ sessionId: id,
      result: { ok: false, code: 'windowsNotHidden' } });
    deps.capture.mockResolvedValueOnce({ ok: false, code: 'displayGone' });
    expect(await handles.get(EXPLAIN_CH.capture)?.(ownerEvent(w), id)).toMatchObject({ result: { code: 'displayGone' } });
    deps.capture.mockResolvedValueOnce({ ok: true, preview: { ...PREVIEW,
      full: { ...PREVIEW.full, dataUrl: 'a'.repeat(MAX_VISION_DATA_URL_CHARS) } } });
    expect(await handles.get(EXPLAIN_CH.capture)?.(ownerEvent(w), id)).toMatchObject({ result: { code: 'tooLarge' } });
  });

  it('retains the existing streamed answer and stop behaviour through a preview', async () => {
    mod.openExplainWindow({ x: 10, y: 20 }, WORDS, TARGET);
    const w = windows[0] as FakeWindow;
    const id = await handles.get(EXPLAIN_CH.ask)?.(ownerEvent(w), 'why?') as number;
    await handles.get(EXPLAIN_CH.capture)?.(ownerEvent(w), session(w));
    asked[0].sink({ kind: 'delta', id, text: 'answer' });
    sends.get(EXPLAIN_CH.closePreview)?.(ownerEvent(w), session(w));
    asked[0].sink({ kind: 'done', id });
    w.emit('focus');
    w.emit('blur');
    expect(await handles.get(EXPLAIN_CH.state)?.(ownerEvent(w), undefined)).not.toBeNull();
    expect(w.webContents.sent).toContainEqual([EXPLAIN_CH.event, { kind: 'delta', id, text: 'answer' }]);
    sends.get(EXPLAIN_CH.stop)?.(ownerEvent(w), undefined);
    expect(cancelled).toBe(2);
  });
});
