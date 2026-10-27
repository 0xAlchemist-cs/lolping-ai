import { EventEmitter } from 'node:events';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({ windows: [] as unknown[], application: null as EventEmitter | null,
  system: vi.fn<() => Promise<boolean>>(),
  execFile: vi.fn((_path: unknown, _args: unknown, _options: unknown, callback: (e: Error) => void) => callback(new Error('untrusted command'))),
}));
vi.mock('../../src/main/desktopSystem', () => ({ runDesktopSystemTask: h.system }));
vi.mock('node:child_process', () => ({ execFile: h.execFile }));
vi.mock('electron', async () => {
  const { EventEmitter: Emitter } = await import('node:events');
  h.application = new Emitter();
  return { app: h.application, BrowserWindow: { getAllWindows: () => h.windows } };
});

class Window extends EventEmitter {
  visible = true;
  focused = false;
  protected = false;
  dead = false;
  failHide = false;
  isVisible(): boolean { return this.visible; }
  isFocused(): boolean { return this.focused; }
  isContentProtected(): boolean { return this.protected; }
  isDestroyed(): boolean { return this.dead; }
  isMinimized(): boolean { return false; }
  setContentProtection(value: boolean): void { this.protected = value; }
  hide(): void {
    if (this.failHide) throw new Error('hide failed');
    this.visible = false;
    this.focused = false;
    this.emit('blur');
  }
  showInactive(): void { this.visible = true; this.emit('show'); }
  focus(): void { this.focused = true; }
}

let capture: typeof import('../../src/main/captureWindows').withCaptureWindowsHidden;
beforeEach(async () => {
  h.windows = [];
  h.system.mockReset();
  h.execFile.mockClear();
  vi.resetModules();
  capture = (await import('../../src/main/captureWindows')).withCaptureWindowsHidden;
});

describe('captureWindows', () => {
  it.skipIf(process.platform !== 'win32')('flushes composition without using an environment-selected system program', async () => {
    vi.stubEnv('SystemRoot', 'Z:\\untrusted');
    h.system.mockResolvedValue(true);
    try {
      const { waitForDesktopComposition } = await import('../../src/main/captureWindows');
      await expect(waitForDesktopComposition()).resolves.toBeUndefined();
      expect(h.execFile).not.toHaveBeenCalled();
    } finally { vi.unstubAllEnvs(); }
  });
  it('waits for composition with all windows hidden and restores their previous state', async () => {
    const overlay = new Window();
    const card = new Window();
    card.focused = true;
    const hidden = new Window();
    hidden.visible = false;
    hidden.protected = true;
    h.windows = [overlay, card, hidden];
    let composed = false;
    const value = await capture(async () => {
      expect(composed).toBe(true);
      expect(h.windows.every((w) => !(w as Window).visible && (w as Window).protected)).toBe(true);
      return 42;
    }, { composed: async () => { composed = true; } });
    expect(value).toBe(42);
    expect(overlay.visible).toBe(true);
    expect(card.visible && card.focused).toBe(true);
    expect(overlay.protected || card.protected || hidden.visible).toBe(false);
    expect(hidden.protected).toBe(true);
    expect(h.application?.listenerCount('browser-window-created')).toBe(0);
  });

  it.each(['capture', 'composition', 'hide'])('restores all windows when %s fails', async (failure) => {
    const first = new Window();
    const second = new Window();
    second.failHide = failure === 'hide';
    h.windows = [first, second];
    await expect(capture(async () => { throw new Error('capture failed'); }, {
      composed: async () => { if (failure === 'composition') throw new Error('composition failed'); },
    })).rejects.toThrow();
    expect(first.visible && second.visible).toBe(true);
    expect(first.protected || second.protected).toBe(false);
    expect(first.listenerCount('show') + second.listenerCount('show')).toBe(0);
    expect(await capture(async () => true, { windows: () => [], composed: async () => undefined })).toBe(true);
  });

  it('keeps newly created and re-shown windows hidden until capture finishes', async () => {
    const first = new Window();
    const late = new Window();
    late.visible = false;
    h.windows = [first];
    await capture(async () => {
      h.windows.push(late);
      h.application?.emit('browser-window-created', {}, late);
      late.showInactive();
      first.showInactive();
      expect(first.visible || late.visible).toBe(false);
    }, { composed: async () => undefined });
    expect(first.visible && late.visible).toBe(true);
  });

  it('never resurrects destroyed windows and refuses overlapping capture scopes', async () => {
    const w = new Window();
    h.windows = [w];
    await capture(async () => {
      await expect(capture(async () => undefined)).rejects.toThrow('busy');
      w.dead = true;
    }, { composed: async () => undefined });
    expect(w.visible).toBe(false);
  });

  it('refuses a capture when a window still reports itself visible after hiding', async () => {
    const w = new Window();
    w.hide = () => undefined;
    h.windows = [w];
    const task = vi.fn(async () => undefined);
    await expect(capture(task, { composed: async () => undefined })).rejects.toThrow('windowsNotHidden');
    expect(task).not.toHaveBeenCalled();
  });

  it('still restores visibility if restoring content protection fails', async () => {
    const w = new Window();
    w.setContentProtection = (value) => {
      if (!value) throw new Error('protection restore failed');
      w.protected = value;
    };
    h.windows = [w];
    await expect(capture(async () => undefined, { composed: async () => undefined })).rejects.toThrow('windowsNotHidden');
    expect(w.visible).toBe(true);
  });

  it('rejects contamination if hiding a re-shown window fails without throwing out of its event handler', async () => {
    const w = new Window();
    h.windows = [w];
    await expect(capture(async () => {
      w.failHide = true;
      expect(() => w.showInactive()).not.toThrow();
      return 'must be discarded';
    }, { composed: async () => undefined })).rejects.toThrow('windowsNotHidden');
    expect(w.visible).toBe(true);
  });
});
