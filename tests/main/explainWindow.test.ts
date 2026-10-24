import { EventEmitter } from 'node:events';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { EXPLAIN_CH, type ExplainEvent, type ExplainText } from '../../src/shared/ipc';
import { strings } from '../../src/shared/i18n';
import { MAX_VISION_DATA_URL_CHARS, type VisionPreview, type VisionResult, type VisionTarget } from '../../src/shared/vision';

const { windows } = vi.hoisted(() => ({ windows: [] as unknown[] }));
const { handles } = vi.hoisted(() => ({ handles: new Map<string, (event: unknown, raw: unknown) => unknown>() }));
const { sends } = vi.hoisted(() => ({ sends: new Map<string, (event: unknown, raw: unknown) => void>() }));

vi.mock('electron', async () => {
  const { EventEmitter: Emitter } = await import('node:events');
  class FakeContents extends Emitter {
    openHandler: ((details: { url: string }) => { action: string }) | null = null;
    sent: Array<[string, unknown]> = [];
    mainFrame = { send: (channel: string, payload: unknown): void => { this.sent.push([channel, payload]); } };
    setWindowOpenHandler(handler: (details: { url: string }) => { action: string }): void {
      this.openHandler = handler;
    }
    send(channel: string, payload: unknown): void {
      this.sent.push([channel, payload]);
    }
  }
  class FakeWindow extends Emitter {
    webContents = new FakeContents();
    destroyed = false;
    shown = false;
    constructor() {
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
  const screen = { getDisplayNearestPoint: () => display };
  const ipcMain = {
    handle: (channel: string, fn: (event: unknown, raw: unknown) => unknown) => handles.set(channel, fn),
    on: (channel: string, fn: (event: unknown, raw: unknown) => void) => sends.set(channel, fn),
  };
  return { BrowserWindow: FakeWindow, ipcMain, screen };
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
type FakeWindow = EventEmitter & { webContents: FakeContents; shown: boolean; close(): void };
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

beforeEach(async () => {
  vi.useFakeTimers();
  windows.length = 0;
  handles.clear();
  sends.clear();
  asked = [];
  cancelled = 0;
  configuredFlag = true;
  openedSettings = 0;
  deps.capture.mockReset();
  deps.capture.mockResolvedValue({ ok: true, preview: PREVIEW });
  vi.resetModules();
  mod = await import('../../src/main/explainWindow');
  mod.registerExplainWindow(deps);
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
  it('streams an ask: id out, deltas in, done ends it', async () => {
    mod.openExplainWindow({ x: 100, y: 100 }, WORDS);
    const contents = (windows[0] as FakeWindow).webContents;
    const id = (await handles.get(EXPLAIN_CH.ask)!({ sender: contents }, '  why?  ')) as number;
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
    expect(await handles.get(EXPLAIN_CH.ask)!({ sender: contents }, '   ')).toBeNull();
    expect(asked).toEqual([]);
  });

  it('a second ask cancels the first and invalidates its late events', async () => {
    mod.openExplainWindow({ x: 100, y: 100 }, WORDS);
    const contents = (windows[0] as FakeWindow).webContents;
    const first = (await handles.get(EXPLAIN_CH.ask)!({ sender: contents }, 'one')) as number;
    expect(cancelled).toBe(1);
    const second = (await handles.get(EXPLAIN_CH.ask)!({ sender: contents }, 'two')) as number;
    expect(second).toBeGreaterThan(first);
    // The first stream finishes late: every event must die at the sink.
    asked[0].sink({ kind: 'delta', id: first, text: 'late' });
    asked[0].sink({ kind: 'done', id: first });
    expect(contents.sent.filter(([c]) => c === EXPLAIN_CH.event)).toEqual([]);
  });

  it('stop cancels and invalidates; the window stays open for the next ask', async () => {
    mod.openExplainWindow({ x: 100, y: 100 }, WORDS);
    const win = windows[0] as FakeWindow;
    const id = (await handles.get(EXPLAIN_CH.ask)!({ sender: win.webContents }, 'slow one')) as number;
    sends.get(EXPLAIN_CH.stop)!({ sender: win.webContents }, undefined);
    expect(cancelled).toBe(2); // once from the ask's replace step, once from the stop itself
    asked[0].sink({ kind: 'delta', id, text: 'too late' });
    expect(win.webContents.sent.filter(([c]) => c === EXPLAIN_CH.event)).toEqual([]);
    const next = (await handles.get(EXPLAIN_CH.ask)!({ sender: win.webContents }, 'again')) as number;
    expect(next).toBeGreaterThan(id);
  });

  it('closing the window cancels the stream and late events go nowhere', async () => {
    mod.openExplainWindow({ x: 100, y: 100 }, WORDS);
    const win = windows[0] as FakeWindow;
    const id = (await handles.get(EXPLAIN_CH.ask)!({ sender: win.webContents }, 'q')) as number;
    win.close();
    expect(cancelled).toBe(2); // the ask's replace step, then the closed handler
    asked[0].sink({ kind: 'done', id });
    // Nothing to assert numerically: the sink must simply not touch the destroyed window.
  });

  it('reports configuration state to its own renderer only', async () => {
    configuredFlag = false;
    mod.openExplainWindow({ x: 100, y: 100 }, WORDS);
    const win = windows[0] as FakeWindow;
    expect(await handles.get(EXPLAIN_CH.state)!({ sender: win.webContents }, undefined)).toMatchObject({ configured: false });
    expect(await handles.get(EXPLAIN_CH.state)!({ sender: {} }, undefined)).toBeNull();
    sends.get(EXPLAIN_CH.openSettings)!({ sender: win.webContents }, undefined);
    expect(openedSettings).toBe(1);
    sends.get(EXPLAIN_CH.openSettings)!({ sender: {} }, undefined);
    expect(openedSettings).toBe(1);
  });
});

describe('explainWindow local capture lifecycle', () => {
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
