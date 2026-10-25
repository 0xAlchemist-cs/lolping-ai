import { BrowserWindow, ipcMain, nativeImage, screen, type IpcMainInvokeEvent } from 'electron';
import { EXPLAIN_CH, type ExplainEvent, type ExplainState, type ExplainText } from '../shared/ipc';
import { parseQuestion } from '../shared/explain';
import { placeInside } from './coords';
import { IS_MAC, loadPage, pageUrl, preloadPath } from './paths';
import { MAX_VISION_DATA_URL_CHARS, type VisionReply, type VisionResult, type VisionTarget } from '../shared/vision';
import type { VisionImage } from '../shared/vision';
import type { AiErrorCode } from '../shared/aiConfig';
import { VisionSnapshotError, VisionSnapshots } from './visionSnapshot';

export interface VisionUpload {
  images: readonly VisionImage[];
  recipient: { baseUrl: string; model: string };
  expiresAt: number;
  /** Main-owned session/revision guard; never supplied by the renderer. */
  isCurrent: () => boolean;
}

/** Start large enough to review a screenshot; native edges let the user resize without extra IPC. */
const WIDTH = 560;
const HEIGHT = 600;
/** If the card has no keyboard focus by then, it closes instead of sitting over the desktop. */
const FOCUS_WAIT_MS = 2500;

/** Everything the window needs from the app; injected so tests drive the protocol without a model. */
export interface ExplainDeps {
  /** Starts one streamed answer; every event it produces goes through `sink`. Must never throw. */
  ask: (question: string, id: number, sink: (ev: ExplainEvent) => void, upload?: VisionUpload) => void;
  /** Stops whatever `ask` started. Called on stop, close, and when a new ask replaces an old one. */
  cancel: () => void;
  /** True when endpoint, model and key are all in place. */
  configured: () => boolean;
  /** Opens the settings window at the AI section. */
  openSettings: () => void;
  /** Local capture only. No model, settings or key access belongs in this dependency. */
  capture?: (target: VisionTarget) => Promise<VisionResult>;
  /** Non-secret endpoint identity; null keeps local preview available without enabling upload. */
  recipient?: () => { baseUrl: string; model: string } | null;
}

let win: BrowserWindow | null = null;
let words: ExplainText | null = null;
let deps: ExplainDeps | null = null;
let currentId = 0;
let generating = false;
let hasAnswer = false;
let visionSessionId = 0;
let visionRevision = 0;
let visionTarget: VisionTarget | null = null;
let captureInProgress = false;
let previewOpen = false;
let visionGenerating = false;
const snapshots = new VisionSnapshots({ decode: (dataUrl) => {
  const image = nativeImage.createFromDataURL(dataUrl);
  return image.isEmpty() ? null : image.getSize();
} });
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
    if (!win || !ownsMainFrame(event, win) || !deps) return null;
    const q = parseQuestion(raw);
    if (!q) return null;
    currentId += 1;
    deps.cancel(); // Invalidate first: cancellation can synchronously emit a final event.
    visionGenerating = false;
    generating = true;
    hasAnswer = false;
    const id = currentId;
    deps.ask(q, id, (ev) => sink(ev));
    return id;
  });
  ipcMain.handle(EXPLAIN_CH.askVision, (event, raw: unknown) => {
    if (!win || !ownsMainFrame(event, win) || !deps) return null;
    const fail = (code: AiErrorCode) => ({ ok: false as const, code });
    if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return fail('consentRequired');
    const input = raw as Record<string, unknown>;
    if (input.confirmed !== true) return fail('consentRequired');
    if (Object.keys(input).some((key) => !['sessionId', 'snapshotId', 'scope', 'question', 'confirmed'].includes(key))) {
      return fail('imageInvalid');
    }
    const question = parseQuestion(input.question);
    if (!question || input.sessionId !== visionSessionId || !Number.isSafeInteger(input.snapshotId)
      || (input.scope !== 'local' && input.scope !== 'localAndFull')) return fail('snapshotStale');
    if (!previewOpen || captureInProgress || generating) return fail('snapshotStale');
    if (!deps.configured()) return fail('noKey');
    const recipient = deps.recipient?.();
    if (!recipient) return fail('endpoint');
    const target = visionTarget;
    const display = target && screen.getAllDisplays().find((d) => d.id === target.displayId);
    if (!target || !display || display.scaleFactor !== target.scaleFactor
      || (['x', 'y', 'width', 'height'] as const).some((key) => display.bounds[key] !== target.bounds[key])) {
      snapshots.clear();
      return fail('snapshotStale');
    }
    try {
      const { images, expiresAt } = snapshots.consume(visionSessionId, input.snapshotId as number, input.scope, recipient);
      previewOpen = false;
      currentId += 1;
      deps.cancel();
      generating = true;
      visionGenerating = true;
      hasAnswer = false;
      const id = currentId;
      const owner = win;
      const session = visionSessionId;
      const revision = visionRevision;
      deps.ask(question, id, sink, { images, recipient, expiresAt,
        isCurrent: () => win === owner && !owner.isDestroyed() && currentId === id
          && visionSessionId === session && visionRevision === revision });
      return { ok: true as const, id };
    } catch (error) {
      return fail(error instanceof VisionSnapshotError ? error.code : 'imageInvalid');
    }
  });
  ipcMain.on(EXPLAIN_CH.stop, (event) => {
    if (!win || !ownsMainFrame(event, win)) return;
    currentId += 1; // everything still in flight is stale now
    generating = false;
    visionGenerating = false;
    deps?.cancel();
  });
  ipcMain.on(EXPLAIN_CH.close, (event) => {
    if (win && ownsMainFrame(event, win)) win.close();
  });
  ipcMain.on(EXPLAIN_CH.openSettings, (event) => {
    if (win && ownsMainFrame(event, win)) deps?.openSettings();
  });
  ipcMain.handle(EXPLAIN_CH.strings, (event): ExplainText | null => (win && ownsMainFrame(event, win) ? words : null));
  ipcMain.handle(EXPLAIN_CH.state, (event): ExplainState | null => {
    if (!win || !ownsMainFrame(event, win)) return null;
    return { configured: deps?.configured() ?? false, visionSessionId, captureAvailable: !!visionTarget && !!deps?.capture };
  });
  ipcMain.handle(EXPLAIN_CH.capture, async (event, raw: unknown): Promise<VisionReply | null> => {
    const owner = win;
    if (!owner || !ownsMainFrame(event, owner) || raw !== visionSessionId) return null;
    const sessionId = visionSessionId;
    if (captureInProgress) return { sessionId, result: { ok: false, code: 'busy' } };
    const capture = deps?.capture;
    const target = visionTarget;
    if (!capture || !target) return { sessionId, result: { ok: false, code: 'unavailable' } };
    const revision = ++visionRevision;
    snapshots.clear();
    const recipient = deps?.recipient?.();
    captureInProgress = true; // Set before hiding: hide emits blur synchronously on Windows.
    previewOpen = true;
    try {
      const result = await capture(target);
      if (win !== owner || owner.isDestroyed() || !ownsMainFrame(event, owner)
        || sessionId !== visionSessionId || revision !== visionRevision) return null;
      if (result.ok && result.preview.local.dataUrl.length + result.preview.full.dataUrl.length > MAX_VISION_DATA_URL_CHARS) {
        return { sessionId, result: { ok: false, code: 'tooLarge' } };
      }
      if (result.ok && recipient) {
        const currentRecipient = deps?.recipient?.();
        if (currentRecipient?.baseUrl !== recipient.baseUrl || currentRecipient.model !== recipient.model) {
          return { sessionId, result }; // Preview remains local; changed configuration needs a fresh preview to upload.
        }
        try {
          const snapshot = snapshots.capture(sessionId, result.preview, recipient);
          return { sessionId, result, snapshot: { ...snapshot,
            recipient: { domain: new URL(recipient.baseUrl).hostname, model: recipient.model } } };
        } catch (error) {
          return { sessionId, result: { ok: false, code: error instanceof VisionSnapshotError
            && error.code === 'imageTooLarge' ? 'tooLarge' : 'captureFailed' } };
        }
      }
      return { sessionId, result };
    } catch {
      if (win !== owner || owner.isDestroyed() || revision !== visionRevision || !ownsMainFrame(event, owner)) return null;
      return { sessionId, result: { ok: false, code: 'windowsNotHidden' } };
    } finally {
      captureInProgress = false;
      // A replacement card may have reached ready-to-show while the capture scope kept it hidden.
      if (win && win !== owner && !win.isDestroyed()) {
        win.show();
        win.focus();
      }
    }
  });
  ipcMain.on(EXPLAIN_CH.closePreview, (event, raw: unknown) => {
    if (!win || !ownsMainFrame(event, win) || raw !== visionSessionId) return;
    visionRevision += 1;
    previewOpen = false;
    snapshots.clear();
    if (visionGenerating) {
      sink({ kind: 'error', id: currentId, code: 'aborted' });
      currentId += 1;
      generating = false;
      visionGenerating = false;
      deps?.cancel();
    }
  });
}

function ownsMainFrame(event: Pick<IpcMainInvokeEvent, 'sender' | 'senderFrame'>, owner: BrowserWindow): boolean {
  return !owner.isDestroyed() && event.sender === owner.webContents
    && event.senderFrame !== null && event.senderFrame === owner.webContents.mainFrame;
}

/** Only the newest stream may draw, and only while the window exists — late events from a replaced or dead request die here. */
function sink(ev: ExplainEvent): void {
  if (ev.id !== currentId || !win || win.isDestroyed()) return;
  win.webContents.send(EXPLAIN_CH.event, ev);
  if (ev.kind === 'done') {
    generating = false;
    visionGenerating = false;
    hasAnswer = true;
  } else if (ev.kind === 'error') {
    generating = false;
    visionGenerating = false;
  }
}

/** Opens the card with its top-left corner at `point` (a screen point in DIPs), inside that display's work area. */
export function openExplainWindow(point: { x: number; y: number }, text: ExplainText, target?: VisionTarget): void {
  visionSessionId += 1;
  visionRevision += 1;
  snapshots.clear();
  if (visionGenerating) {
    currentId += 1;
    generating = false;
    visionGenerating = false;
    deps?.cancel();
  }
  visionTarget = target ? { ...target, bounds: { ...target.bounds } } : null;
  previewOpen = false;
  if (win && !win.isDestroyed()) {
    // A second gesture while the card is up shows the card it already has; spawning another would steal focus twice.
    win.webContents.mainFrame.send(EXPLAIN_CH.visionSession, visionSessionId);
    if (!captureInProgress) {
      win.show();
      win.focus();
    }
    return;
  }
  words = text;
  currentId += 1; // anything from a previous card's lifetime is stale
  generating = false;
  hasAnswer = false;
  const area = screen.getDisplayNearestPoint(point).workArea;
  const width = Math.min(WIDTH, area.width);
  const height = Math.min(HEIGHT, area.height);
  const spot = placeInside(point, { width, height }, area);
  const w = new BrowserWindow({
    ...spot,
    width,
    height,
    minWidth: Math.min(400, area.width),
    minHeight: Math.min(360, area.height),
    frame: false,
    backgroundColor: '#12141c',
    resizable: true,
    minimizable: false,
    maximizable: true,
    fullscreenable: false,
    skipTaskbar: true,
    alwaysOnTop: true,
    show: false,
    // macOS: a non-activating panel takes key focus without making lolPing the active app.
    ...(IS_MAC ? { type: 'panel' as const } : {}),
    webPreferences: { preload: preloadPath('explain'), spellcheck: false, sandbox: true, contextIsolation: true,
      nodeIntegration: false, ...(process.platform === 'win32' ? { backgroundThrottling: false } : {}) },
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
    visionTarget = null;
    visionRevision += 1;
    previewOpen = false;
    snapshots.clear();
    visionGenerating = false;
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
    if (focused && !generating && !hasAnswer && !captureInProgress && !previewOpen) w.close();
  });
  const focusTimer = setTimeout(() => {
    if (!w.isDestroyed() && !focused && !captureInProgress && !previewOpen) w.close();
  }, FOCUS_WAIT_MS);
  w.once('closed', () => clearTimeout(focusTimer));
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
