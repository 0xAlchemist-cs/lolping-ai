import type { BrowserWindow } from 'electron';
import { PLATFORM } from './paths';
import { runDesktopSystemTask } from './desktopSystem';

/** Styles only this process's window using the bounded bundled helper. */
export async function useDarkWindowFrame(window: Pick<BrowserWindow, 'isDestroyed' | 'getNativeWindowHandle'>): Promise<boolean> {
  if (PLATFORM !== 'win' || window.isDestroyed()) return false;
  try {
    const bytes = window.getNativeWindowHandle();
    const handle = bytes.length === 8 ? bytes.readBigUInt64LE() : bytes.length === 4 ? BigInt(bytes.readUInt32LE()) : 0n;
    if (handle === 0n || handle > 0x7fffffffffffffffn) return false;
    const ready = await runDesktopSystemTask({ type: 'styleWindow', hwnd: handle.toString(), ownerPid: String(process.pid) });
    return ready && !window.isDestroyed();
  } catch { return false; }
}
