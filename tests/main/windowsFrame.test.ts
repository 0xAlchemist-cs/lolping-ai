import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useDarkWindowFrame } from '../../src/main/windowsFrame';

const h = vi.hoisted(() => ({
  platform: 'win',
  execFile: vi.fn<(path: string, args: string[], options: object, callback: (error: Error | null) => void) => void>(),
}));
vi.mock('node:child_process', () => ({ execFile: h.execFile }));
vi.mock('../../src/main/paths', () => ({ get PLATFORM() { return h.platform; } }));

beforeEach(() => {
  h.platform = 'win';
  h.execFile.mockReset();
  vi.stubEnv('SystemRoot', 'C:\\Windows');
});
afterEach(() => vi.unstubAllEnvs());

const window = { isDestroyed: () => false, getNativeWindowHandle: () => Buffer.from([42, 0, 0, 0, 0, 0, 0, 0]) };

describe('useDarkWindowFrame', () => {
  it('uses a bounded hidden command with only a numeric handle and owner PID, keeping the process ownership guard', async () => {
    h.execFile.mockImplementation((_path, _args, _options, callback) => callback(null));
    expect(await useDarkWindowFrame(window)).toBe(true);
    const [path, args, options] = h.execFile.mock.calls[0];
    expect(path.replaceAll('\\', '/')).toBe('C:/Windows/System32/WindowsPowerShell/v1.0/powershell.exe');
    expect(options).toMatchObject({ windowsHide: true, timeout: 5000, maxBuffer: 1024 });
    expect(args).toContain('-NonInteractive');
    expect(args.at(-1)).toContain('GetWindowThreadProcessId');
    expect(args.at(-1)).toContain('$actualPid -ne $ownerPid');
    expect(args.at(-1)).toContain('DwmSetWindowAttribute($hwnd, 20, [ref]$dark, 4)');
    expect(args.at(-1)).toMatch(new RegExp(`} 42 ${process.pid}$`));
  });

  it.each(['mac', 'linux'])('starts no child process on %s', async (platform) => {
    h.platform = platform;
    expect(await useDarkWindowFrame(window)).toBe(false);
    expect(h.execFile).not.toHaveBeenCalled();
  });

  it('rejects destroyed windows, missing Windows paths and malformed handles without invoking a command', async () => {
    expect(await useDarkWindowFrame({ ...window, isDestroyed: () => true })).toBe(false);
    expect(await useDarkWindowFrame({ ...window, getNativeWindowHandle: () => Buffer.alloc(1) })).toBe(false);
    vi.stubEnv('SystemRoot', '');
    expect(await useDarkWindowFrame(window)).toBe(false);
    expect(h.execFile).not.toHaveBeenCalled();
  });

  it('settles unavailable/failed styling without throwing or retrying', async () => {
    h.execFile.mockImplementation((_path, _args, _options, callback) => callback(new Error('synthetic failure')));
    expect(await useDarkWindowFrame(window)).toBe(false);
    expect(h.execFile).toHaveBeenCalledOnce();
  });

  it('does not report readiness for a window closed while the child process was pending', async () => {
    let dead = false;
    const pending = useDarkWindowFrame({ ...window, isDestroyed: () => dead });
    dead = true;
    h.execFile.mock.calls[0][3](null);
    expect(await pending).toBe(false);
  });
});
