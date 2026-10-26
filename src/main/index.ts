import { app, clipboard, dialog, Menu, powerMonitor, screen, shell, systemPreferences } from 'electron';
import { randomBytes, randomInt } from 'node:crypto';
import { lookup } from 'node:dns/promises';
import { readFileSync } from 'node:fs';
import { userInfo } from 'node:os';
import { join } from 'node:path';
import { resolveLang, strings, type Strings } from '../shared/i18n';
import { SETTINGS_CH, type About, type AppStatus, type PanelAction, type PanelState } from '../shared/ipc';
import { announcedEmoteHashes } from '../shared/emotes';
import { featureOn, liveKeys, roomFeaturesOff } from '../shared/features';
import { hotkeyLabel } from '../shared/keys';
import { LOGO_TEXTURE } from '../shared/pings';
import { configCommand, type HelperStatus } from '../shared/protocol';
import type { ActionPingId, QuickActionError } from '../shared/quickActions';
import type { RoomState } from '../shared/room';
import type { VoteKind } from '../shared/roomProtocol';
import { formatRoomCode, parseRoomCode } from '../shared/roomCode';
import { sameTagRgb, tagWire } from '../shared/roomColors';
import { overlaySettings, soundLevel, type Settings } from '../shared/settings';
import { parseTextInput } from '../shared/textCommands';
import { updateErrorText, type UpdateState } from '../shared/update';
import { registerAppScheme, serveAppScheme } from './appProtocol';
import { resolveTarget, toShared } from './displayNumbers';
import { EmoteCache } from './emoteCache';
import { EmoteLibrary, resolveEmoteArt } from './emoteLibrary';
import { EmoteTransfer } from './emoteTransfer';
import { checkEndpoint, guardResolvedAddresses, isExplicitLoopback, validModel, type AiErrorCode } from '../shared/aiConfig';
import { closeExplainWindow, openExplainWindow, registerExplainWindow, type VisionUpload } from './explainWindow';
import { AiRequests, createExplainAsk } from './aiRequest';
import { createAiDiagnostics } from './aiDiagnostics';
import type { CancelSource } from './aiClient';
import { AiKeyStore } from './aiKeyStore';
import { captureVision } from './visionCapture';
import { withCaptureWindowsHidden } from './captureWindows';
import { isFile } from './fileState';
import { InputBridge } from './inputBridge';
import { DesktopBridge } from './desktopBridge';
import { closeDesktopSystemTasks } from './desktopSystem';
import { QuickActionExecutor } from './quickActionExecutor';
import { launchQuickActionProgram, verifyQuickActionProgram } from './quickActionProgram';
import { registerQuickActionsIpc } from './quickActionsIpc';
import { LanTransport } from './lanTransport';
import { RELAYS } from './relays';
import { RelayTransport } from './relayTransport';
import { OverlayManager, type SharedEmote, type SharedPing } from './overlayManager';
import { assetPath, buildResourcePath, desktopHelperExePath, helperExePath, IS_LINUX, IS_MAC, PLATFORM, rendererRootPath, settingsDir } from './paths';
import { deriveRoomKeys } from './roomCrypto';
import { RoomHistory } from './roomHistory';
import { PanelWindows } from './panelWindows';
import { MAX_MEMBERS, RoomManager, type RoomToast } from './roomManager';
import { postLine, startRoomText, type RoomTextDeps } from './roomText';
import { RoomVotes, voteResultLine } from './roomVotes';
import { registerSettingsIpc } from './settingsIpc';
import { SettingsStore } from './settingsStore';
import { onSettingsWindowGone, openSettingsWindow, settingsWindow } from './settingsWindow';
import { closeTextWindow, onTextWindowGone, openTextWindow, registerTextWindow } from './textWindow';
import { AppTray, trayUpdateFrom, type TrayMode } from './tray';
import { trayUpdateHandlers } from './trayUpdate';
import { MacBackend, RELEASES_API } from './updateMac';
import { WinBackend } from './updateWin';
import { Updater } from './updater';
import { setLinuxAutostart } from './linuxAutostart';
import { syncWindowsLoginItem } from './windowsLoginItem';

const ACCESSIBILITY_PANE = 'x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility';

// X11 uses root-window pixels. Keep Electron in the same coordinate space on every monitor.
if (IS_LINUX) {
  app.commandLine.appendSwitch('ozone-platform', 'x11');
  app.commandLine.appendSwitch('force-device-scale-factor', '1');
}

registerAppScheme();
app.setAppUserModelId('com.lolping.app');

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => openSettingsWindow());
  app.on('activate', () => openSettingsWindow()); // macOS: opened again from Finder or Launchpad while running
  void app.whenReady().then(start);
}

/** The OS account name: the default name under this machine's pings in a room. */
function osUserName(): string {
  try {
    return userInfo().username;
  } catch {
    return 'Player';
  }
}

/**
 * The relays to use. Development builds take a comma-separated LOLPING_RELAYS instead, so "no relay reachable" can
 * be tried without touching the firewall; packaged builds always use the pinned list.
 */
function relayUrls(): readonly string[] {
  const custom = app.isPackaged ? undefined : process.env.LOLPING_RELAYS;
  const urls = custom?.split(',').map((u) => u.trim()).filter((u) => u.startsWith('wss://')) ?? [];
  return urls.length > 0 ? urls : RELAYS;
}

/** macOS: the app, Edit and Window menus, so Cmd+Q, Cmd+W and the clipboard shortcuts work in the settings window. */
function setMacMenu(): void {
  Menu.setApplicationMenu(Menu.buildFromTemplate([{ role: 'appMenu' }, { role: 'editMenu' }, { role: 'windowMenu' }]));
}

function start(): void {
  const library = new EmoteLibrary(join(settingsDir(), 'emotes'));
  const cache = new EmoteCache(join(settingsDir(), 'emote-cache'), Date.now);
  void cache.present();
  serveAppScheme({
    rendererRoot: rendererRootPath(),
    emoteDirs: () => [library.dir, cache.dir], // the library wins; the cache only fills the gaps
  });
  if (IS_MAC) {
    app.dock?.hide(); // a menu bar app: the Dock icon only shows while settings are open
    setMacMenu();
  }
  const store = new SettingsStore(settingsDir(), undefined, PLATFORM, { name: osUserName(), color: randomInt(8) });
  let settings = store.load();
  const loginItemBackend = {
    read: (options: { path: string; args: string[] }) => app.getLoginItemSettings(options),
    write: (options: Parameters<typeof app.setLoginItemSettings>[0]) => app.setLoginItemSettings(options),
  };
  let loginItemFailed = false;
  if (app.isPackaged && PLATFORM === 'win') {
    try {
      const actual = syncWindowsLoginItem(settings.launchAtStartup, process.execPath, loginItemBackend);
      if (actual !== settings.launchAtStartup) settings = store.update({ launchAtStartup: actual });
    } catch { loginItemFailed = true; }
  }
  // An imported emote whose still is gone is dropped; normalising the shorter list repairs the wheel slots that used it.
  const kept = library.present(settings.customEmotes);
  if (kept.length !== settings.customEmotes.length) settings = store.update({ customEmotes: kept });
  // The language setting, or the system display language when it's 'auto'.
  const text = (): Strings => strings(resolveLang(settings.language, app.getLocale()), PLATFORM);
  let enabled = settings.enabledOnStart;
  let quitting = false; // read by pushStatus: once true, the tray and overlays are gone
  let capturing = false; // the settings page is listening for a key, so the helper must stay suspended
  let textOpen = false;
  let screenLocked = false;
  let sleeping = false;

  const overlays = new OverlayManager(
    overlaySettings(settings),
    (ref, remote) =>
      resolveEmoteArt(ref, settings.customEmotes, remote, (hash) => {
        if (!settings.friendEmotes || !cache.has(hash)) return false; // off: friends' images show as the placeholder
        cache.touch(hash); // a shown still is the most recently used at the next cache sweep
        return true;
      }),
  );
  overlays.start();
  if (loginItemFailed) overlays.toast(text().launchAtStartup, text().loginItemFailed);
  const bridge = new InputBridge({ command: helperExePath() });
  const desktop = new DesktopBridge({ command: desktopHelperExePath() });
  const quickExecutor = new QuickActionExecutor({
    platform: PLATFORM, desktop,
    verifyProgram: verifyQuickActionProgram,
    launchProgram: launchQuickActionProgram,
    openUrl: (url) => shell.openExternal(url),
  });
  const quickActionsAvailable = (): boolean => PLATFORM === 'win' && enabled && !quitting
    && !capturing && !textOpen && !screenLocked && !sleeping && bridge.status === 'running'
    && featureOn(settings, 'quickActions');
  const syncQuickActions = (): void => {
    overlays.setQuickActionsEnabled(quickActionsAvailable());
    quickExecutor.cancelPending();
  };
  const quickFailure = (code: QuickActionError): void => {
    if (!quitting) overlays.toast(text().quickActionFailedTitle, text().quickActionErrors[code]);
  };
  const clearProgramSelections = registerQuickActionsIpc({
    platform: PLATFORM, store, window: settingsWindow,
    pickProgram: async (owner) => {
      const result = await dialog.showOpenDialog(owner, { properties: ['openFile'], filters: [{ name: '.exe', extensions: ['exe'] }] });
      return result.canceled ? null : result.filePaths[0] ?? null;
    },
    verifyProgram: verifyQuickActionProgram,
    execute: (binding, allowed) => quickExecutor.execute(binding, () => !quitting && !screenLocked && !sleeping && allowed()),
    onError: quickFailure,
  });
  overlays.on('quickAction', (id: ActionPingId) => {
    const snapshot = settings;
    const binding = snapshot.quickActions.bindings[id];
    if (!quickActionsAvailable() || !binding?.enabled) return;
    const allowed = (): boolean => quickActionsAvailable() && settings === snapshot;
    void quickExecutor.execute(binding, allowed).then((result) => {
      if (!result.ok && result.code !== 'disabled' && allowed()) quickFailure(result.code);
    });
  });
  powerMonitor.on('suspend', () => { sleeping = true; syncQuickActions(); });
  powerMonitor.on('resume', () => { sleeping = false; syncQuickActions(); });
  powerMonitor.on('lock-screen', () => { screenLocked = true; syncQuickActions(); });
  powerMonitor.on('unlock-screen', () => { screenLocked = false; syncQuickActions(); });

  // Updates: only in an installed build, or in a development build pointed at a test server with LOLPING_UPDATE_TEST_URL.
  const testUrl = app.isPackaged ? undefined : process.env.LOLPING_UPDATE_TEST_URL || undefined;
  // Linux packages are updated manually until a Linux release feed is published.
  const updater = !IS_LINUX && (app.isPackaged || testUrl) ? createUpdater() : null;
  function createUpdater(): Updater {
    const backend = IS_MAC
      ? new MacBackend({
        apiBase: testUrl ?? RELEASES_API,
        currentVersion: app.getVersion(),
        fetch,
        downloadsDir: app.getPath('downloads'),
        focus: () => app.focus({ steal: true }), // the dialog is shown from a menu bar app, which is not the active one
        showDialog: (message) => dialog.showMessageBox({ message, buttons: ['OK'] }).then(() => undefined),
        openPath: (path) => shell.openPath(path),
        dialogText: () => text().updateMacDialog,
        quit: () => app.quit(),
      })
      : new WinBackend({
        testUrl,
        log: (line) => console.log('[update]', line),
        toast: () => overlays.toast(text().restartingToUpdate, ''),
        isQuitting: () => quitting,
      });
    return new Updater({
      backend,
      now: Date.now,
      autoCheck: () => settings.autoUpdateCheck,
      notifiedVersion: () => settings.updateNotifiedVersion,
      setNotifiedVersion: (version) => void store.update({ updateNotifiedVersion: version }),
      errorText: (kind, reason) => {
        console.warn('[update]', kind, reason); // the whole reason goes to the log; the card shows its first line
        return updateErrorText(text(), kind, reason);
      },
    });
  }

  // Room: pings shared with other lolPing users, on the network and through public relays.
  const lan = new LanTransport();
  const relay = new RelayTransport({ urls: relayUrls() });
  const room = new RoomManager({
    transports: [lan, relay],
    now: Date.now,
    randomBytes: (n) => randomBytes(n),
    deriveKeys: deriveRoomKeys,
    appVersion: app.getVersion(),
    profile: () => ({
      name: settings.displayName, ...tagWire(settings.tagColor, settings.tagColorCustom), limit: settings.incomingPingLimit,
      nf: roomFeaturesOff(settings),
    }),
    resolveTarget: (d) => {
      const target = resolveTarget(overlays.numbered(), d);
      return target ? { displayId: target.id, width: target.bounds.width, height: target.bounds.height } : null;
    },
    // With emotes switched off we announce none, so friends don't send stills for emotes we won't use.
    announceEmotes: () => (featureOn(settings, 'emotes') ? announcedEmoteHashes(settings.emoteWheel, settings.clickEmoteId) : []),
  });
  // Custom emote stills travel both ways: this side asks for friends' hashes and answers wants for our own.
  const transfer = new EmoteTransfer({
    now: Date.now,
    enabled: () => settings.friendEmotes && featureOn(settings, 'emotes'),
    have: (hash) => isFile(join(library.dir, `${hash}.webp`), false) || cache.has(hash),
    still: (hash) => {
      try {
        return new Uint8Array(readFileSync(join(library.dir, `${hash}.webp`)));
      } catch {
        return null;
      }
    },
    announced: () => announcedEmoteHashes(settings.emoteWheel, settings.clickEmoteId),
    put: (hash, bytes) => void cache.put(hash, bytes),
    routeOf: (peer) => room.routeKind(peer),
    sendToLan: (peer, body) => room.sendToLan(peer, body),
    broadcastShared: (body) => room.broadcastShared(body),
    spareSharedToken: (keep) => room.spareSharedToken(keep),
  });
  room.on('emotes', (peer: string, hashes: string[]) => transfer.announced(peer, hashes));
  room.on('want', (w: Parameters<EmoteTransfer['onWant']>[0]) => transfer.onWant(w));
  room.on('chunk', (c: Parameters<EmoteTransfer['onChunk']>[0]) => transfer.onChunk(c));
  room.on('memberGone', (peer: string) => transfer.memberGone(peer));
  const roomState = (): RoomState => {
    const all = screen.getAllDisplays();
    return {
      ...room.state(),
      displays: overlays.numbered().map((d) => {
        const scale = all.find((x) => x.id === d.id)?.scaleFactor ?? 1; // show pixels, as the OS display settings do
        return { number: d.number, width: Math.round(d.bounds.width * scale), height: Math.round(d.bounds.height * scale), primary: d.primary };
      }),
    };
  };
  const clipboardCode = async (): Promise<string | null> => {
    // Strict: nobody typed this, so only an unmistakable code counts, never words that happen to pass the check.
    const parsed = parseRoomCode(await clipboard.readText().catch(() => ''), { strict: true });
    return parsed.ok ? formatRoomCode(parsed.code) : null;
  };
  const copyRoomCode = (): void => {
    const code = room.state().code;
    if (code) void clipboard.writeText(code).catch(() => undefined);
  };

  // macOS Accessibility. Without it the helper can't create its event tap, so it isn't started: a timer waits for
  // the permission instead. `staleAccess`: macOS lists lolPing as allowed, yet the helper still has no access.
  let accessTimer: NodeJS.Timeout | null = null;
  let staleAccess = false;
  const trusted = (): boolean => !IS_MAC || systemPreferences.isTrustedAccessibilityClient(false);
  const stopWaitingForAccess = (): void => {
    if (accessTimer) clearInterval(accessTimer);
    accessTimer = null;
  };
  const waitForAccess = (): void => {
    if (accessTimer) return;
    accessTimer = setInterval(() => {
      if (!trusted()) return;
      stopWaitingForAccess();
      staleAccess = false;
      bridge.retry();
    }, 1500);
    overlays.cancelWheel();
    pushStatus();
  };
  const startHelper = (): void => {
    staleAccess = false;
    if (trusted()) bridge.retry();
    else waitForAccess();
  };

  const helperStatus = (): HelperStatus => (accessTimer ? 'noAccess' : bridge.status);
  const status = (): AppStatus => ({ enabled, helper: helperStatus(), staleAccess });
  const trayMode = (): TrayMode => {
    const h = helperStatus();
    if (h === 'failed' || h === 'noAccess') return h;
    return enabled ? 'on' : 'off';
  };
  const tray = new AppTray(
    assetPath('textures', `${LOGO_TEXTURE}.png`),
    {
      openSettings: () => openSettingsWindow(),
      setEnabled: (on) => setEnabled(on),
      retryHelper: startHelper,
      quit: () => app.quit(),
      room: {
        joinClipboard: () => {
          void clipboardCode().then((code) => {
            if (code) void room.join(code);
            else overlays.toast(text().toastNoCode, text().toastNoCodeBody);
          });
        },
        create: () => void room.create(),
        copyCode: copyRoomCode,
        setMuted: (on) => store.update({ roomMuted: on }),
        leave: () => room.leave(),
        openSettings: () => openSettingsWindow('room'),
      },
      // The tray has no card to show a result on, so the handlers toast it. Nothing to toast on once the overlays are gone.
      update: updater
        ? trayUpdateHandlers({ updater, toast: (title, body) => { if (!quitting) overlays.toast(title, body); }, text })
        : { check: () => undefined, start: () => undefined },
    },
    text(),
    IS_MAC ? { on: buildResourcePath('trayTemplate.png'), off: buildResourcePath('trayOffTemplate.png') } : undefined,
  );
  tray.setRoomsShown(featureOn(settings, 'rooms'));
  /** Sends to the settings window if there is one that is still alive (the updater also reports while the app quits). */
  function sendToSettings(channel: string, payload: unknown): void {
    const w = settingsWindow();
    if (w && !w.webContents.isDestroyed()) w.webContents.send(channel, payload);
  }
  if (updater) {
    updater.on('state', (s: UpdateState) => {
      if (quitting) return; // the tray and windows are going away
      tray.setUpdate(trayUpdateFrom(s));
      sendToSettings(SETTINGS_CH.updateState, s);
    });
    updater.on('notify', (version: string) => {
      if (!quitting) overlays.toast(text().updateToastTitle, text().updateToastBody(version));
    });
    tray.setUpdate(trayUpdateFrom(updater.state));
  }
  function pushRoom(): void {
    if (quitting) return;
    const s = roomState();
    tray.setRoom({ code: s.code, count: s.members.length, muted: settings.roomMuted });
    settingsWindow()?.webContents.send(SETTINGS_CH.roomChanged, s);
  }
  const syncRoomFlags = (): void => room.setStatusFlags({ paused: !enabled, roomMuted: settings.roomMuted });
  room.on('state', pushRoom);
  // The vote widget and the roster live in their own windows that never take focus.
  const panels = new PanelWindows();
  // The room keys (Alt+T and the panel key) are the helper's only while a room is active, so they reach other apps otherwise.
  let live = liveKeys(settings, { active: false }, enabled);
  const sendConfig = (): void => {
    live = liveKeys(settings, { active: room.state().phase === 'active' }, enabled);
    // The helper stops reporting a held panel key once it is off, so the roster would stay up: hide it here.
    if (!live.panel) panels.hideRoster();
    bridge.send(configCommand(settings, enabled, live));
  };
  room.on('state', () => {
    const next = liveKeys(settings, { active: room.state().phase === 'active' }, enabled);
    if (next.text !== live.text || next.panel !== live.panel) sendConfig();
  });
  overlays.on('displays', pushRoom);
  room.on('remotePing', (p) => overlays.spawnRemote(p));
  overlays.on('shared', (p: SharedPing) => {
    const shared = toShared(overlays.numbered(), p.displayId, p.x, p.y);
    if (shared) room.sendPing(p.id, shared);
  });
  // The explain window opens only on the wheel's own Enemy Missing release: wheelPing comes from the overlay's
  // report alone, so trigger+click, previews and room members can never open it.
  overlays.on('wheelPing', (p: SharedPing) => {
    if (p.id !== 'missing' || !featureOn(settings, 'aiExplain') || quitting) return;
    const display = screen.getAllDisplays().find((d) => d.id === p.displayId);
    if (!display) return;
    const point = process.platform === 'win32'
      ? { x: display.bounds.x + p.x, y: display.bounds.y + p.y } : screen.getCursorScreenPoint();
    openExplainWindow(point,
      { ...text().explainWindow, errors: text().aiError },
      process.platform === 'win32' ? { displayId: p.displayId, x: p.x, y: p.y,
        bounds: { ...display.bounds }, scaleFactor: display.scaleFactor } : undefined);
  });

  // P1B: real model answers. One request at a time; the key lives only in the key store and the Authorization header.
  const aiKeys = new AiKeyStore(settingsDir());
  let aiHasKey = false;
  void aiKeys.has().then((has) => {
    aiHasKey = has;
  });
  /** Development builds may point at a local mock server; a packaged build never may. Mirrors LOLPING_RELAYS' rule. */
  const aiAllowLocal = !app.isPackaged && process.env.LOLPING_AI_ALLOW_LOCALHOST === '1';
  const aiConfigured = (): boolean =>
    featureOn(settings, 'aiExplain') && settings.aiBaseUrl.length > 0 && settings.aiModel.length > 0 && aiHasKey;
  const aiCancel = (source?: CancelSource): void => aiRequests.cancel(source);
  /** Everything checked before any bytes leave: endpoint shape, model, key, and the DNS answer for the host. */
  async function aiPrepare(): Promise<
    { ok: true; baseUrl: string; model: string; key: string } | { ok: false; code: AiErrorCode }
  > {
    const endpoint = checkEndpoint(settings.aiBaseUrl, aiAllowLocal);
    const model = settings.aiModel.trim();
    if (!endpoint.ok) return { ok: false, code: endpoint.code === 'privateAddress' ? 'private' : 'endpoint' };
    if (!validModel(model)) return { ok: false, code: 'endpoint' };
    const key = await aiKeys.get();
    if (!key) return { ok: false, code: 'noKey' };
    if (!aiAllowLocal || !isExplicitLoopback(endpoint.endpoint.host)) {
      const guard = await guardResolvedAddresses(endpoint.endpoint.host, async (host) =>
        lookup(host, { all: true }));
      if (!guard.ok) return { ok: false, code: guard.code === 'privateAddress' ? 'private' : 'resolve' };
    }
    return { ok: true, baseUrl: endpoint.endpoint.url, model, key };
  }
  const aiRecipient = (): { baseUrl: string; model: string } | null => {
    const endpoint = checkEndpoint(settings.aiBaseUrl, aiAllowLocal);
    return aiConfigured() && endpoint.ok && validModel(settings.aiModel)
      ? { baseUrl: endpoint.endpoint.url, model: settings.aiModel.trim() } : null;
  };
  const aiRequests = new AiRequests({ prepare: aiPrepare, recipient: aiRecipient,
    fetchImpl: (url, init) => globalThis.fetch(url, init), now: Date.now });
  async function aiRun(
    question: string,
    maxTokens: number,
    onDelta: ((t: string) => void) | null,
    upload?: VisionUpload,
  ): Promise<{ ok: true } | { ok: false; code: AiErrorCode }> {
    return aiRequests.run(question, maxTokens, onDelta, upload);
  }
  const aiDiagnostics = createAiDiagnostics(app.isPackaged, process.env.LOLPING_AI_DIAGNOSTICS,
    line => console.info('[ai-diagnostic]', line));
  registerExplainWindow({
    ask: createExplainAsk(aiRequests, aiDiagnostics.enabled ? aiDiagnostics.stream : undefined, () => settings.aiMaxTokens),
    diagnostics: aiDiagnostics,
    cancel: aiCancel,
    configured: aiConfigured,
    openSettings: () => openSettingsWindow('features'),
    capture: (target) => withCaptureWindowsHidden(() => captureVision(target)),
    recipient: aiRecipient,
  });
  room.on('remoteEmote', (p) => {
    if (featureOn(settings, 'emotes')) overlays.spawnRemoteEmote(p);
  });
  overlays.on('sharedEmote', (p: SharedEmote) => {
    const shared = toShared(overlays.numbered(), p.displayId, p.x, p.y);
    // The effect rides on the message, so friends see the one its sender picked even before they have the image.
    const fx = settings.customEmotes.find((c) => c.id === p.ref)?.fx;
    if (shared) room.sendEmote(p.ref, shared, fx);
  });
  // This session's room lines: members' text and alive lines while the text feature is on, and our own.
  const history = new RoomHistory(() => refreshRoster());
  const lineDeps: Pick<RoomTextDeps, 'show' | 'history' | 'now'> = {
    show: (p) => overlays.spawnText({ ...p, style: settings.roomTextStyle }),
    history,
    now: Date.now,
  };
  let stopRoomText: (() => void) | null = null;
  const syncRoomText = (): void => {
    const on = featureOn(settings, 'roomText');
    if (on && !stopRoomText) stopRoomText = startRoomText({ room, ...lineDeps, text });
    else if (!on && stopRoomText) {
      stopRoomText();
      stopRoomText = null;
    }
  };
  syncRoomText();
  // Names are kept for the session: a result may name a member who has just left.
  const memberNames = new Map<string, string>();
  room.on('state', () => {
    const s = room.state();
    if (s.phase === 'idle') {
      history.clear();
      memberNames.clear();
      closeTextWindow(); // its text and commands only make sense in a room, and a kick leaves it open otherwise
    }
    for (const m of s.members) memberNames.set(m.peer, m.name);
  });
  const panelState = (view: PanelState['view'], vote: PanelState['vote'], voteOver = false): PanelState => ({
    view, lang: resolveLang(settings.language, app.getLocale()), max: MAX_MEMBERS, room: room.state(), history: history.lines(),
    vote, voteOver, textOn: featureOn(settings, 'roomText'), votesOn: featureOn(settings, 'roomVotes'),
    volume: soundLevel(settings),
  });
  /** An open roster follows the room and its history; a hidden one ignores this. */
  function refreshRoster(): void {
    panels.update(panelState('roster', null));
  }
  room.on('state', refreshRoster);
  panels.on('action', (a: PanelAction) => {
    switch (a.t) {
      case 'ballot':
        roomVotes?.answer(a.yes);
        break;
      case 'alive':
        // The cursor, as the text box does: the page's own screen point is not in DIPs on every display setup.
        sendOwnAlive(a.peer, screen.getCursorScreenPoint());
        break;
      case 'mute':
        room.muteMember(a.peer, a.on);
        break;
      case 'kick':
        startVote('kick', a.peer);
        break;
      case 'vote':
        startVote(a.kind);
        break;
    }
  });
  const startVote = (kind: VoteKind, target?: string): void => {
    if (roomVotes?.start(kind, target) === 'busy') overlays.toast(text().voteBusy, '');
  };
  // Votes run while the feature is on; with it off, members' votes and ballots are ignored here.
  let roomVotes: RoomVotes | null = null;
  const syncRoomVotes = (): void => {
    const on = featureOn(settings, 'roomVotes');
    if (on && !roomVotes) {
      roomVotes = new RoomVotes({
        room,
        now: Date.now,
        randomId: () => randomBytes(4).toString('hex'),
        onView: (v, over) => (v ? panels.showVote(panelState('vote', v, over)) : panels.hideVote()),
        onResult: (o) => {
          const display = screen.getPrimaryDisplay();
          postLine(lineDeps, {
            kind: 'vote', owner: 'vote', tag: null, displayId: display.id, x: display.bounds.width / 2, y: display.bounds.height * 0.2,
            text: voteResultLine(o, (peer) => memberNames.get(peer) ?? '?', text()),
          });
        },
        onKicked: () => {
          room.leave(); // also forgets the room code, so it isn't rejoined at the next start
          overlays.toast(text().kickedYou, '');
        },
      });
    } else if (!on && roomVotes) {
      roomVotes.stop();
      roomVotes = null;
    }
  };
  syncRoomVotes();
  room.on('saveCode', (code: string | null) => store.update({ lastRoomCode: code }));
  room.on('toast', (n: RoomToast) => {
    const t = text();
    const code = room.state().code ?? '';
    if (n.kind === 'joinedRoom') overlays.toast(t.toastRoomJoined(n.code), t.toastRoomJoinedBody);
    else if (n.kind === 'full') overlays.toast(t.toastRoomFull, t.toastRoomFullBody);
    else if (n.kind === 'joined') overlays.toast(t.toastMemberJoined(n.name), code);
    else if (n.kind === 'left') overlays.toast(t.toastMemberLeft(n.name), code);
    else if (n.kind === 'kicked') overlays.toast(t.toastMemberKicked(n.name), code);
    else overlays.toast(t.toastMemberLost(n.name), code);
  });
  powerMonitor.on('resume', () => {
    lan.rebind();
    relay.wake();
  });

  function pushStatus(): void {
    if (quitting) return;
    tray.set(trayMode(), enabled);
    settingsWindow()?.webContents.send(SETTINGS_CH.statusChanged, status());
  }
  const about = (): About => ({
    version: app.getVersion(),
    problems: [
      ...store.problems,
      ...(store.emoteKeyClashed ? [text().problemEmoteKeyClash] : []),
      ...[...overlays.missingAssets].map((a) => text().missingAsset(a)),
    ],
    limitations: text().limitations,
  });

  function setEnabled(on: boolean): void {
    if (on === enabled) return;
    enabled = on;
    syncQuickActions();
    sendConfig(); // also refreshes the config re-sent after restarts
    if (!on) overlays.dropKeptPings();
    const t = text();
    overlays.toast(on ? t.toastOn : t.toastOff, t.toastToggleHint(hotkeyLabel(store.get().toggleHotkey, PLATFORM)));
    syncRoomFlags();
    pushStatus();
  }

  const syncSuspended = (): void => {
    bridge.send({ type: 'suspend', on: capturing || textOpen });
    syncQuickActions();
  };
  /** A screen point (DIPs) as our own lines and the room see it: its display, the point inside it, and the shared form. */
  const ownSpot = (at: { x: number; y: number }) => {
    const display = screen.getDisplayNearestPoint(at);
    const x = at.x - display.bounds.x;
    const y = at.y - display.bounds.y;
    return { displayId: display.id, x, y, shared: toShared(overlays.numbered(), display.id, x, y) };
  };
  const ownTag = () => ({ name: settings.displayName, ...tagWire(settings.tagColor, settings.tagColorCustom) });
  /** Shows our own text where the box was opened, and sends it to the room. */
  const sendOwnText = (message: string, at: { x: number; y: number }): void => {
    const { shared, ...spot } = ownSpot(at);
    postLine(lineDeps, { kind: 'text', owner: 'self', tag: ownTag(), ...spot, text: message });
    if (shared) room.sendText(message, shared);
  };
  /** "<name> - Alive" for the member whose name tag was clicked in the panel, shown here and sent to the room. */
  const sendOwnAlive = (peer: string, at: { x: number; y: number }): void => {
    const who = room.state().members.find((m) => m.peer === peer);
    if (!who || !featureOn(settings, 'roomText')) return;
    const { shared, ...spot } = ownSpot(at);
    postLine(lineDeps, { kind: 'alive', owner: 'self', tag: ownTag(), ...spot, text: text().aliveLine(who.name) });
    if (shared) room.sendAlive(peer, shared);
  };
  registerTextWindow((raw, at) => {
    const input = parseTextInput(raw);
    switch (input.kind) {
      case 'text':
        sendOwnText(input.text, at);
        return 'sent';
      case 'unknown':
        return 'unknown';
      case 'ff':
      case 'ready':
        if (!roomVotes) return 'votesOff';
        // Typing the command of the vote that is open means yes.
        if (roomVotes.current()?.kind === input.kind) roomVotes.answer(true);
        else if (roomVotes.start(input.kind) === 'busy') overlays.toast(text().voteBusy, '');
        return 'sent';
      case 'noff':
        if (!roomVotes) return 'votesOff';
        if (roomVotes.current()?.kind === 'ff') roomVotes.answer(false);
        return 'sent';
      default:
        return 'sent'; // nothing usable was typed: just close
    }
  });
  onTextWindowGone(() => {
    textOpen = false;
    syncSuspended();
  });
  const openText = (): void => {
    if (!live.text || textOpen || capturing) return;
    textOpen = true;
    syncSuspended();
    const t = text();
    try {
      openTextWindow(screen.getCursorScreenPoint(), {
        placeholder: t.textBoxPlaceholder, hint: t.textBoxHint, unknown: t.textBoxUnknown, votesOff: t.textBoxVotesOff,
      });
    } catch (err) {
      // No window will ever close to release the suspend, so release it here.
      console.warn('[text]', err);
      textOpen = false;
      syncSuspended();
    }
  };
  bridge.on('event', (ev) => {
    if (ev.type === 'toggled') setEnabled(ev.enabled);
    else if (ev.type === 'textRequested') openText();
    else if (ev.type === 'panel') {
      if (!ev.show) panels.hideRoster();
      else if (live.panel) panels.showRoster(screen.getCursorScreenPoint(), panelState('roster', null));
    } else if (ev.type === 'ready') {
      // A restarted helper starts unsuspended: re-apply an active key capture.
      if (capturing || textOpen) syncSuspended();
      panels.hideRoster(); // a restarted helper lost the panel key's up, so a shown roster would stay up
    } else if (ev.type === 'error') console.warn('[helper]', ev.code ?? '', ev.message);
    else overlays.handle(ev);
  });
  bridge.on('status', (s: HelperStatus) => {
    syncQuickActions();
    // A helper that is starting or has stopped can no longer send the cancel that dismisses a wheel left on screen.
    if (s !== 'running') overlays.cancelWheel();
    if (s === 'noAccess' && IS_MAC) {
      // Allowed but still refused is an entry left over from an earlier build. Otherwise wait for the user to allow it.
      if (trusted()) staleAccess = true;
      else waitForAccess();
      openSettingsWindow();
    }
    pushStatus();
    if (s === 'failed') overlays.toast(text().toastHelperStopped, text().toastHelperStoppedBody);
  });
  bridge.on('log', (line: string) => console.log('[helper]', line));

  store.on('change', (s: Settings) => {
    const previous = settings;
    settings = s;
    syncQuickActions();
    sendConfig();
    syncRoomText();
    syncRoomVotes();
    overlays.updateSettings(overlaySettings(s));
    settingsWindow()?.webContents.send(SETTINGS_CH.changed, s);
    if (s.language !== previous.language) tray.setText(text());
    if (
      s.displayName !== previous.displayName || s.tagColor !== previous.tagColor
      || !sameTagRgb(s.tagColorCustom, previous.tagColorCustom)
      || featureOn(s, 'roomText') !== featureOn(previous, 'roomText')
      || featureOn(s, 'roomVotes') !== featureOn(previous, 'roomVotes')
    ) room.profileChanged();
    if (featureOn(s, 'rooms') !== featureOn(previous, 'rooms')) {
      if (!featureOn(s, 'rooms')) room.leave();
      tray.setRoomsShown(featureOn(s, 'rooms'));
    }
    if (s.autoUpdateCheck !== previous.autoUpdateCheck) updater?.setAutoCheck(s.autoUpdateCheck);
    // Switching the feature off closes its card: with aiExplain off, no window, no listener effects.
    if (featureOn(s, 'aiExplain') !== featureOn(previous, 'aiExplain') && !featureOn(s, 'aiExplain')) {
      closeExplainWindow(); // its 'closed' handler cancels the stream too
      aiCancel();
    }
    if (s.roomMuted !== previous.roomMuted) {
      syncRoomFlags();
      pushRoom();
    }
    if (s.allowInternet !== previous.allowInternet) {
      room.setInternetAllowed(s.allowInternet);
      pushRoom();
    }
  });

  registerSettingsIpc({
    setLoginItem: (enabled) => {
      if (!app.isPackaged) return;
      if (IS_LINUX) setLinuxAutostart(enabled);
      else if (IS_MAC) app.setLoginItemSettings({ openAtLogin: enabled });
      else syncWindowsLoginItem(enabled, process.execPath, loginItemBackend, true);
    },
    store,
    library,
    ai: {
      status: () => ({
        encryptionAvailable: aiKeys.encryptionAvailable(),
        hasKey: aiHasKey,
        configured: aiConfigured(),
      }),
      setKey: async (raw) => {
        const r = await aiKeys.set(raw);
        if (r.ok) aiHasKey = true;
        return r;
      },
      clearKey: async () => {
        await aiKeys.clear();
        aiHasKey = false;
        aiCancel(); // a stream without its key is a stream that should not be running
      },
      test: async () => {
        const r = await aiRun('ping', 1, null);
        return r.ok ? { ok: true } : { ok: false, code: r.code };
      },
    },
    getStatus: status,
    setEnabled,
    preview: (id) => overlays.previewPing(id),
    previewEmote: (ref) => overlays.previewEmote(ref),
    about,
    retryHelper: startHelper,
    setCapturing: (on) => {
      // Each key control announces its initial false state; those repeats must not abort an unrelated action.
      if (capturing === on) return;
      capturing = on;
      syncSuspended();
    },
    openAccessibility: () => {
      if (!IS_MAC) return;
      systemPreferences.isTrustedAccessibilityClient(true); // adds lolPing to the list and shows the system prompt
      void shell.openExternal(ACCESSIBILITY_PANE);
      if (!trusted()) waitForAccess();
    },
    text,
    platform: PLATFORM,
    update: updater
      ? { state: () => updater.state, notesUrl: () => updater.notesUrl, check: () => updater.check(true), start: () => updater.startUpdate() }
      : undefined,
    room: {
      state: roomState,
      create: () => room.create(),
      join: (t) => room.join(t),
      leave: () => room.leave(),
      mute: (peer, on) => room.muteMember(peer, on),
      clipboardCode,
      copyCode: copyRoomCode,
      retryInternet: () => relay.retryNow(),
    },
  });
  // The page can't report that it went away mid-capture (window closed, renderer crashed): release the suspend here.
  onSettingsWindowGone(() => {
    clearProgramSelections();
    quickExecutor.cancelPending();
    if (!capturing) return;
    capturing = false;
    syncSuspended();
  });

  sendConfig();
  if (trusted()) bridge.start();
  else waitForAccess();
  pushStatus();
  syncRoomFlags();
  room.setInternetAllowed(settings.allowInternet);
  pushRoom();
  if (settings.rejoinRoom && settings.lastRoomCode && featureOn(settings, 'rooms')) void room.join(settings.lastRoomCode);
  if (IS_MAC) {
    // A menu bar app: open settings only when there is something to do, otherwise point at the menu bar icon.
    if (store.firstRun || !trusted()) openSettingsWindow();
    else overlays.toast(text().toastMenuBar, text().toastMenuBarBody);
  } else if (!process.argv.includes('--hidden')) {
    openSettingsWindow();
  }

  updater?.start();

  app.on('window-all-closed', () => {
    /* stay running: the overlays are the app */
  });
  app.on('before-quit', (event) => {
    if (quitting) return;
    quitting = true;
    quickExecutor.close();
    desktop.close();
    closeDesktopSystemTasks();
    clearProgramSelections();
    event.preventDefault();
    updater?.stop(); // aborts a download and drops a check in flight; an install that is quitting the app is left alone
    room.quit(); // says bye, so the others see "left" instead of waiting for a timeout
    transfer.stop();
    stopWaitingForAccess();
    tray.destroy();
    panels.destroy();
    overlays.destroy();
    closeExplainWindow();
    void Promise.allSettled([bridge.stop(), store.flush(), lan.whenClosed(), relay.whenClosed()]).then(() => app.exit(0));
  });
}
