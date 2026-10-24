import { app, BrowserWindow } from 'electron';
import { execFile } from 'node:child_process';
import { join } from 'node:path';

/** A constant command, with no image, window title or user input passed to the child. */
const FLUSH_COMMAND = `Add-Type -TypeDefinition 'using System.Runtime.InteropServices; public static class LolPingDwm { [DllImport("dwmapi.dll")] public static extern int DwmFlush(); }'; if ([LolPingDwm]::DwmFlush() -ne 0) { exit 1 }`;

/** Requests a DWM present after hide; this is not a cross-process rendering fence (see docs/design.md). */
export function waitForDesktopComposition(): Promise<void> {
  if (process.platform !== 'win32') return Promise.reject(new Error('windowsNotHidden'));
  const windowsRoot = process.env.SystemRoot;
  if (!windowsRoot) return Promise.reject(new Error('windowsNotHidden'));
  return new Promise((resolve, reject) => {
    execFile(join(windowsRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'),
      ['-NoProfile', '-NonInteractive', '-WindowStyle', 'Hidden', '-Command', FLUSH_COMMAND],
      { windowsHide: true, timeout: 5000, maxBuffer: 1024 },
      (error) => error ? reject(new Error('windowsNotHidden')) : resolve());
  });
}

export interface CaptureWindowsOptions {
  windows?: () => BrowserWindow[];
  composed?: () => Promise<void>;
}

let active = false;

/** Hides this app's windows for one capture, then restores each surviving window's visibility and protection. */
export async function withCaptureWindowsHidden<T>(task: () => Promise<T>, options: CaptureWindowsOptions = {}): Promise<T> {
  if (active) throw new Error('busy');
  active = true;
  const windows = options.windows ?? (() => BrowserWindow.getAllWindows());
  const composed = options.composed ?? waitForDesktopComposition;
  const states = new Map<BrowserWindow, { visible: boolean; focused: boolean; protected: boolean; show: () => void }>();
  let restoring = false;
  let hideFailed = false;
  const hide = (w: BrowserWindow): void => {
    if (w.isDestroyed() || states.has(w)) return;
    const state = {
      visible: w.isVisible(), focused: w.isFocused(), protected: w.isContentProtected(),
      show: (): void => {
        if (restoring || w.isDestroyed()) return;
        state.visible = true; // ready-to-show or a new gesture requested this window during the capture.
        try { w.hide(); } catch { hideFailed = true; }
      },
    };
    states.set(w, state);
    w.on('show', state.show);
    w.setContentProtection(true);
    w.hide();
  };
  const created = (_event: Electron.Event, w: BrowserWindow): void => {
    try { if (windows().includes(w)) hide(w); } catch { hideFailed = true; }
  };
  const checkHidden = (): void => {
    if (hideFailed || [...states.keys()].some((w) => !w.isDestroyed() && w.isVisible())) {
      throw new Error('windowsNotHidden');
    }
  };
  try {
    app.on('browser-window-created', created);
    for (const w of windows()) hide(w);
    await composed();
    for (const w of windows()) hide(w);
    checkHidden();
    const result = await task();
    checkHidden();
    return result;
  } finally {
    restoring = true;
    app.removeListener('browser-window-created', created);
    let failed = false;
    let focus: BrowserWindow | null = null;
    for (const [w, state] of states) {
      w.removeListener('show', state.show);
      if (w.isDestroyed()) continue;
      try {
        w.setContentProtection(state.protected);
      } catch {
        failed = true;
      }
      try {
        if (state.visible && !w.isMinimized()) w.showInactive();
        if (state.focused && state.visible) focus = w;
      } catch {
        failed = true; // One lost window must not stop the others being restored.
      }
    }
    try {
      if (focus && !focus.isDestroyed()) focus.focus();
    } finally {
      states.clear();
      active = false;
    }
    if (failed) throw new Error('windowsNotHidden');
  }
}
