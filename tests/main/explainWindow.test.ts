import { EventEmitter } from 'node:events';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { EXPLAIN_CH } from '../../src/shared/ipc';

const { windows } = vi.hoisted(() => ({ windows: [] as unknown[] }));
const { asks } = vi.hoisted(() => ({ asks: new Map<string, (event: unknown, raw: unknown) => Promise<unknown>>() }));
const { handlers } = vi.hoisted(() => ({ handlers: new Map<string, (event: unknown, raw: unknown) => void>() }));

vi.mock('electron', async () => {
  const { EventEmitter: Emitter } = await import('node:events');
  class FakeContents extends Emitter {
    openHandler: ((details: { url: string }) => { action: string }) | null = null;
    setWindowOpenHandler(handler: (details: { url: string }) => { action: string }): void {
      this.openHandler = handler;
    }
  }
  class FakeWindow extends Emitter {
    webContents = new FakeContents();
    destroyed = false;
    shown = false;
    focused = false;
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
      this.focused = true;
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
    handle: (channel: string, fn: (event: unknown, raw: unknown) => Promise<unknown>) => asks.set(channel, fn),
    on: (channel: string, fn: (event: unknown, raw: unknown) => void) => handlers.set(channel, fn),
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

import type { ExplainText } from '../../src/shared/ipc';
import { strings } from '../../src/shared/i18n';

type FakeWindow = EventEmitter & { webContents: EventEmitter & { openHandler: ((d: { url: string }) => { action: string }) | null }; shown: boolean };
type Mod = typeof import('../../src/main/explainWindow');
let mod: Mod;

const WORDS: ExplainText = strings('en').explainWindow;

beforeEach(async () => {
  windows.length = 0;
  asks.clear();
  handlers.clear();
  vi.resetModules();
  mod = await import('../../src/main/explainWindow');
  mod.registerExplainWindow((q) => `SIMULATED:${q}`);
});

describe('explainWindow lifecycle', () => {
  it('opens one window, and a second open shows the same window instead of a second one', () => {
    mod.openExplainWindow({ x: 100, y: 100 }, WORDS);
    expect(windows).toHaveLength(1);
    mod.openExplainWindow({ x: 400, y: 300 }, WORDS);
    expect(windows).toHaveLength(1);
    expect((windows[0] as FakeWindow).shown).toBe(true);
  });

  it('tells its gone-listeners when it closes', () => {
    const gone = vi.fn();
    mod.onExplainWindowGone(gone);
    mod.openExplainWindow({ x: 100, y: 100 }, WORDS);
    expect(gone).not.toHaveBeenCalled();
    (windows[0] as FakeWindow & { close(): void }).close();
    expect(gone).toHaveBeenCalledTimes(1);
  });

  it('never leaves the page it was given, and opens no window', () => {
    mod.openExplainWindow({ x: 100, y: 100 }, WORDS);
    const contents = (windows[0] as FakeWindow).webContents;
    const blocked = (url: string): boolean => {
      const event = { url, preventDefault: vi.fn() };
      contents.emit('will-navigate', event, url);
      return event.preventDefault.mock.calls.length > 0;
    };
    expect(blocked('https://example.com/')).toBe(true);
    expect(blocked('file:///C:/x.html')).toBe(true);
    expect(blocked('lolping://app/explain/index.html')).toBe(false);
    expect(contents.openHandler).not.toBeNull();
    expect(contents.openHandler?.({ url: 'https://example.com/' })).toEqual({ action: 'deny' });
  });
});

describe('explainWindow IPC', () => {
  it('answers a question from its own renderer with the simulated answer', async () => {
    mod.openExplainWindow({ x: 100, y: 100 }, WORDS);
    const sender = (windows[0] as FakeWindow).webContents;
    expect(await asks.get(EXPLAIN_CH.ask)!({ sender }, '  why?  ')).toBe('SIMULATED:why?');
    expect(await asks.get(EXPLAIN_CH.strings)!({ sender }, undefined)).toEqual(WORDS);
  });

  it('rejects a question from another sender, and a question with nothing in it', async () => {
    mod.openExplainWindow({ x: 100, y: 100 }, WORDS);
    expect(await asks.get(EXPLAIN_CH.ask)!({ sender: {} }, 'why?')).toBeNull();
    const sender = (windows[0] as FakeWindow).webContents;
    expect(await asks.get(EXPLAIN_CH.ask)!({ sender }, '   ')).toBeNull();
    expect(await asks.get(EXPLAIN_CH.ask)!({ sender }, 42)).toBeNull();
  });

  it('closes on the close channel from its own renderer only', () => {
    mod.openExplainWindow({ x: 100, y: 100 }, WORDS);
    const win = windows[0] as FakeWindow & { close(): void; destroyed: boolean };
    handlers.get(EXPLAIN_CH.close)!({ sender: {} }, undefined);
    expect(win.destroyed).toBe(false);
    handlers.get(EXPLAIN_CH.close)!({ sender: win.webContents }, undefined);
    expect(win.destroyed).toBe(true);
  });
});
