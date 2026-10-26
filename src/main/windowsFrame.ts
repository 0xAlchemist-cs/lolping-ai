import type { BrowserWindow } from 'electron';
import { execFile } from 'node:child_process';
import { join } from 'node:path';
import { PLATFORM } from './paths';

/** Only numeric HWND/PID arguments enter this fixed command; it never reads window contents or app settings. */
const DARK_FRAME_COMMAND = `& { param([long]$handle, [uint32]$ownerPid)
Add-Type -TypeDefinition 'using System; using System.Runtime.InteropServices; public static class LolPingDarkFrame {
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  [DllImport("dwmapi.dll")] public static extern int DwmSetWindowAttribute(IntPtr h, int attr, ref int value, int size);
}'
[uint32]$actualPid = 0
$hwnd = [IntPtr]::new($handle)
[void][LolPingDarkFrame]::GetWindowThreadProcessId($hwnd, [ref]$actualPid)
if ($actualPid -ne $ownerPid) { exit 1 }
[int]$dark = 1
if ([LolPingDarkFrame]::DwmSetWindowAttribute($hwnd, 20, [ref]$dark, 4) -ne 0) { exit 1 }
}`;

/** Styles this Windows card's native resize gutter without changing the app/system theme or native resize behavior. */
export function useDarkWindowFrame(window: Pick<BrowserWindow, 'isDestroyed' | 'getNativeWindowHandle'>): Promise<boolean> {
  const windowsRoot = process.env.SystemRoot;
  if (PLATFORM !== 'win' || !windowsRoot || window.isDestroyed()) return Promise.resolve(false);
  const bytes = window.getNativeWindowHandle();
  const handle = bytes.length === 8 ? bytes.readBigUInt64LE() : bytes.length === 4 ? BigInt(bytes.readUInt32LE()) : 0n;
  if (handle === 0n || handle > 0x7fffffffffffffffn) return Promise.resolve(false);
  return new Promise((resolve) => {
    execFile(join(windowsRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'),
      ['-NoProfile', '-NonInteractive', '-WindowStyle', 'Hidden', '-Command',
        `${DARK_FRAME_COMMAND} ${handle.toString()} ${process.pid}`],
      { windowsHide: true, timeout: 5000, maxBuffer: 1024 },
      (error) => resolve(!error && !window.isDestroyed()));
  });
}
