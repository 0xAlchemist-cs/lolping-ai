import { BrowserWindow, ipcMain, screen } from 'electron';
import { EXPLAIN_CH, type ExplainText } from '../shared/ipc';
import { parseQuestion } from '../shared/explain';
import type { Strings } from '../shared/i18n';
import { placeInside } from './coords';
import { IS_MAC, loadPage, pageUrl, preloadPath } from './paths';

/** The card's size in DIPs: a question box, the simulated answer and two buttons. */
const WIDTH = 460;
const HEIGHT = 360;
/** If the card has no keyboard focus by then, it closes instead of sitting over the desktop. */
const FOCUS_WAIT_MS = 2500;

let win: BrowserWindow | null = null;
let words: ExplainText | null = null;
let answerWith: ((q: string) => string) | null = null;
const goneListeners: Array<() => void> = [];

export function onExplainWindowGone(cb: () => void): void {
  goneListeners.push(cb);
}

/** Closes the card if it is open: the feature was switched off, or the app is quitting. */
export function closeExplainWindow(): void {
  if (win && !win.isDestroyed()) win.close();
}

/**
 * Registers the card's IPC once. `buildAnswer` turns a validated question into the simulated answer; it is read at
 * call time, so a language change reaches an already-open card.
 */
export function registerExplainWindow(buildAnswer: (q: string) => string): void {
  answerWith = buildAnswer;
  ipcMain.handle(EXPLAIN_CH.ask, (event, raw: unknown): string | null => {
    if (win?.webContents !== event.sender) return null;
    const q = parseQuestion(raw);
    if (!q || !answerWith) return null;
    return answerWith(q);
  });
  ipcMain.on(EXPLAIN_CH.close, (event) => {
    if (win?.webContents === event.sender) win.close();
  });
  ipcMain.handle(EXPLAIN_CH.strings, (event): ExplainText | null => (win?.webContents === event.sender ? words : null));
}

/** Opens the card with its top-left corner at `point` (a screen point in DIPs), inside that display's work area. */
export function openExplainWindow(point: { x: number; y: number }, text: Strings['explainWindow']): void {
  if (win && !win.isDestroyed()) {
    // A second gesture while the card is up shows the card it already has; spawning another would steal focus twice.
    win.show();
    win.focus();
    return;
  }
  words = text;
  const spot = placeInside(point, { width: WIDTH, height: HEIGHT }, screen.getDisplayNearestPoint(point).workArea);
  const w = new BrowserWindow({
    ...spot,
    width: WIDTH,
    height: HEIGHT,
    frame: false,
    backgroundColor: '#12141c',
    resizable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    alwaysOnTop: true,
    show: false,
    // macOS: a non-activating panel takes key focus without making lolPing the active app.
    ...(IS_MAC ? { type: 'panel' as const } : {}),
    webPreferences: { preload: preloadPath('explain'), spellcheck: false },
  });
  win = w;
  // Every way the card can end goes through close(), whose 'closed' event tells the app it is gone.
  try {
    setup(w);
  } catch (err) {
    w.destroy();
    throw err;
  }
}

function setup(w: BrowserWindow): void {
  w.on('closed', () => {
    if (win === w) win = null;
    for (const cb of goneListeners) cb();
  });
  w.setAlwaysOnTop(true, 'screen-saver'); // above the overlay, like the text box
  let focused = false;
  w.on('focus', () => {
    focused = true;
  });
  // Clicking away closes, once the card has had focus: it never litters the desktop. Selecting the answer keeps
  // focus inside the card, so copying works.
  w.on('blur', () => {
    if (focused) w.close();
  });
  setTimeout(() => {
    if (!w.isDestroyed() && !focused) w.close();
  }, FOCUS_WAIT_MS);
  w.once('ready-to-show', () => {
    w.show();
    w.focus();
  });
  const closeIfAlive = (): void => {
    if (!w.isDestroyed()) w.close();
  };
  w.webContents.on('did-fail-load', closeIfAlive);
  w.webContents.on('render-process-gone', closeIfAlive);
  const ownUrl = new URL(pageUrl('explain'));
  w.webContents.on('will-navigate', (event) => {
    try {
      const target = new URL(event.url);
      if (target.protocol !== ownUrl.protocol || target.host !== ownUrl.host || target.pathname !== ownUrl.pathname) {
        event.preventDefault();
      }
    } catch {
      event.preventDefault();
    }
  });
  w.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  loadPage(w, 'explain').catch(closeIfAlive);
}
