import { EventEmitter } from 'node:events';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { EXPLAIN_CH, type ExplainEvent, type ExplainText } from '../../src/shared/ipc';
import { strings } from '../../src/shared/i18n';

const { windows } = vi.hoisted(() => ({ windows: [] as unknown[] }));
const { handles } = vi.hoisted(() => ({ handles: new Map<string, (event: unknown, raw: unknown) => unknown>() }));
const { sends } = vi.hoisted(() => ({ sends: new Map<string, (event: unknown, raw: unknown) => void>() }));

vi.mock('electron', async () => {
  const { EventEmitter: Emitter } = await import('node:events');
  class FakeContents extends Emitter {
    openHandler: ((details: { url: string }) => { action: string }) | null = null;
    sent: Array<[string, unknown]> = [];
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

type FakeContents = EventEmitter & { sent: Array<[string, unknown]>; openHandler: ((d: { url: string }) => { action: string }) | null };
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
};
let configuredFlag = true;
let openedSettings = 0;

beforeEach(async () => {
  windows.length = 0;
  handles.clear();
  sends.clear();
  asked = [];
  cancelled = 0;
  configuredFlag = true;
  openedSettings = 0;
  vi.resetModules();
  mod = await import('../../src/main/explainWindow');
  mod.registerExplainWindow(deps);
});

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
    expect(await handles.get(EXPLAIN_CH.state)!({ sender: win.webContents }, undefined)).toEqual({ configured: false });
    expect(await handles.get(EXPLAIN_CH.state)!({ sender: {} }, undefined)).toBeNull();
    sends.get(EXPLAIN_CH.openSettings)!({ sender: win.webContents }, undefined);
    expect(openedSettings).toBe(1);
    sends.get(EXPLAIN_CH.openSettings)!({ sender: {} }, undefined);
    expect(openedSettings).toBe(1);
  });
});
