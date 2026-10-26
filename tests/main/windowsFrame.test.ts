import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useDarkWindowFrame } from '../../src/main/windowsFrame';

const h = vi.hoisted(() => ({ platform: 'win', system: vi.fn<() => Promise<boolean>>(), execFile: vi.fn() }));
vi.mock('node:child_process', () => ({ execFile: h.execFile }));
vi.mock('../../src/main/desktopSystem', () => ({ runDesktopSystemTask: h.system }));
vi.mock('../../src/main/paths', () => ({ get PLATFORM() { return h.platform; } }));

beforeEach(() => {
  h.platform = 'win';
  h.system.mockReset();
  h.execFile.mockReset();
});
afterEach(() => vi.unstubAllEnvs());
const window = { isDestroyed: () => false, getNativeWindowHandle: () => Buffer.from([42, 0, 0, 0, 0, 0, 0, 0]) };

describe('useDarkWindowFrame', () => {
  it('styles the owned window without launching an environment-selected system program', async () => {
    vi.stubEnv('SystemRoot', 'Z:\\untrusted');
    h.system.mockResolvedValue(true);
    expect(await useDarkWindowFrame(window)).toBe(true);
    expect(h.execFile).not.toHaveBeenCalled();
    expect(h.system.mock.calls[0]).toEqual([{ type: 'styleWindow', hwnd: '42', ownerPid: String(process.pid) }]);
  });

  it.each(['mac', 'linux'])('starts no native task on %s', async (platform) => {
    h.platform = platform;
    expect(await useDarkWindowFrame(window)).toBe(false);
    expect(h.system).not.toHaveBeenCalled();
  });

  it('rejects destroyed windows and malformed handles before a task starts', async () => {
    expect(await useDarkWindowFrame({ ...window, isDestroyed: () => true })).toBe(false);
    expect(await useDarkWindowFrame({ ...window, getNativeWindowHandle: () => Buffer.alloc(1) })).toBe(false);
    expect(await useDarkWindowFrame({ ...window, getNativeWindowHandle: () => Buffer.alloc(8) })).toBe(false);
    expect(h.system).not.toHaveBeenCalled();
  });

  it('settles unavailable or failed styling without throwing or retrying', async () => {
    h.system.mockResolvedValue(false);
    expect(await useDarkWindowFrame(window)).toBe(false);
    h.system.mockRejectedValue(new Error('synthetic failure'));
    expect(await useDarkWindowFrame(window)).toBe(false);
    expect(h.system).toHaveBeenCalledTimes(2);
  });

  it('does not report readiness for a window closed during the native task', async () => {
    let dead = false;
    let finish: ((value: boolean) => void) | undefined;
    h.system.mockImplementation(() => new Promise<boolean>((resolve) => { finish = resolve; }));
    const pending = useDarkWindowFrame({ ...window, isDestroyed: () => dead });
    dead = true;
    finish?.(true);
    expect(await pending).toBe(false);
  });
});
