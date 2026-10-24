import { BrowserWindow, ipcMain, screen } from 'electron';
import { EXPLAIN_CH, type ExplainEvent, type ExplainState, type ExplainText } from '../shared/ipc';
import { parseQuestion } from '../shared/explain';
import { placeInside } from './coords';
import { IS_MAC, loadPage, pageUrl, preloadPath } from './paths';

/** The card's size in DIPs: a question box, the streamed answer and two buttons. */
const WIDTH = 460;
const HEIGHT = 360;
/** If the card has no keyboard focus by then, it closes instead of sitting over the desktop. */
const FOCUS_WAIT_MS = 2500;

/** Everything the window needs from the app; injected so tests drive the protocol without a model. */
export interface ExplainDeps {
  /** Starts one streamed answer; every event it produces goes through `sink`. Must never throw. */
  ask: (question: string, id: number, sink: (ev: ExplainEvent) => void) => void;
  /** Stops whatever `ask` started. Called on stop, close, and when a new ask replaces an old one. */
  cancel: () => void;
  /** True when endpoint, model and key are all in place. */
  configured: () => boolean;
  /** Opens the settings window at the AI section. */
  openSettings: () => void;
}

let win: BrowserWindow | null = null;
let words: ExplainText | null = null;
let deps: ExplainDeps | null = null;
let currentId = 0;
let generating = false;
let hasAnswer = false;
const goneListeners: Array<() => void> = [];

export function onExplainWindowGone(cb: () => void): void {
  goneListeners.push(cb);
}

/** Closes the card if it is open: the feature was switched off, or the app is quitting. Also cancels a stream. */
export function closeExplainWindow(): void {
  if (win && !win.isDestroyed()) win.close();
}

/** Registers the card's IPC once. The deps carry everything app-specific; they are read at call time. */
export function registerExplainWindow(d: ExplainDeps): void {
  deps = d;
  ipcMain.handle(EXPLAIN_CH.ask, (event, raw: unknown): number | null => {
    if (win?.webContents !== event.sender || !deps) return null;
    const q = parseQuestion(raw);
    if (!q) return null;
    deps.cancel(); // a new question explicitly replaces the old one
    currentId += 1;
    generating = true;
    hasAnswer = false;
    const id = currentId;
    deps.ask(q, id, (ev) => sink(ev));
    return id;
  });
  ipcMain.on(EXPLAIN_CH.stop, (event) => {
    if (win?.webContents !== event.sender) return;
    currentId += 1; // everything still in flight is stale now
    generating = false;
    deps?.cancel();
  });
  ipcMain.on(EXPLAIN_CH.close, (event) => {
    if (win?.webContents === event.sender) win.close();
  });
  ipcMain.on(EXPLAIN_CH.openSettings, (event) => {
    if (win?.webContents === event.sender) deps?.openSettings();
  });
  ipcMain.handle(EXPLAIN_CH.strings, (event): ExplainText | null => (win?.webContents === event.sender ? words : null));
  ipcMain.handle(EXPLAIN_CH.state, (event): ExplainState | null => {
    if (win?.webContents !== event.sender) return null;
    return { configured: deps?.configured() ?? false };
  });
}

/** Only the newest stream may draw, and only while the window exists — late events from a replaced or dead request die here. */
function sink(ev: ExplainEvent): void {
  if (ev.id !== currentId || !win || win.isDestroyed()) return;
  win.webContents.send(EXPLAIN_CH.event, ev);
  if (ev.kind === 'done') {
    generating = false;
    hasAnswer = true;
  } else if (ev.kind === 'error') {
    generating = false;
  }
}

/** Opens the card with its top-left corner at `point` (a screen point in DIPs), inside that display's work area. */
export function openExplainWindow(point: { x: number; y: number }, text: ExplainText): void {
  if (win && !win.isDestroyed()) {
    // A second gesture while the card is up shows the card it already has; spawning another would steal focus twice.
    win.show();
    win.focus();
    return;
  }
  words = text;
  currentId += 1; // anything from a previous card's lifetime is stale
  generating = false;
  hasAnswer = false;
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
    currentId += 1;
    generating = false;
    hasAnswer = false;
    deps?.cancel();
    for (const cb of goneListeners) cb();
  });
  w.setAlwaysOnTop(true, 'screen-saver'); // above the overlay, like the text box
  let focused = false;
  w.on('focus', () => {
    focused = true;
  });
  // Clicking away closes an empty, idle card — the P1A behaviour. While an answer is streaming or on screen the card
  // stays, so reading it or glancing at another window never throws the answer away. Esc and ✕ always close.
  w.on('blur', () => {
    if (focused && !generating && !hasAnswer) w.close();
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
