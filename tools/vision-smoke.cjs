/*
 * Run after npm run build: node tools/vision-smoke.cjs
 * Uses real production sandbox preloads, explain UI and Windows desktopCapturer.
 * The desktop target and cursor movement are synthetic; physical Alt + drag needs separate manual evidence.
 * Captured images stay in memory. Only pass/fail and geometry metadata are printed.
 */
const { existsSync, mkdirSync } = require('node:fs');
const { join, resolve } = require('node:path');
const { spawnSync } = require('node:child_process');

if (!process.versions.electron) {
  const root = resolve(__dirname, '..');
  for (const path of ['out/preload/overlay.js', 'out/preload/explain.js', 'out/renderer/explain/index.html']) {
    if (!existsSync(join(root, path))) throw new Error('Run npm run build before the vision smoke check.');
  }
  const output = join(root, 'out', 'vision-smoke');
  mkdirSync(output, { recursive: true });
  require('esbuild').buildSync({
    entryPoints: [__filename], outfile: join(output, 'main.cjs'), bundle: true, platform: 'node',
    format: 'cjs', target: 'node22', external: ['electron', 'esbuild'], logLevel: 'silent',
  });
  const env = { ...process.env, LOLPING_VISION_SMOKE_ROOT: root };
  delete env.ELECTRON_RUN_AS_NODE;
  delete env.ELECTRON_RENDERER_URL;
  const electronBinary = process.env.LOLPING_VISION_SMOKE_ELECTRON || require('electron');
  const child = spawnSync(electronBinary, [join(output, 'main.cjs'),
    `--user-data-dir=${join(output, `profile-${Date.now()}`)}`], {
    cwd: root, env, encoding: 'utf8', windowsHide: true, timeout: 120000,
  });
  if (child.stdout) process.stdout.write(child.stdout);
  if (child.stderr) process.stderr.write(child.stderr);
  if (child.error) console.error(`Vision smoke process failed: ${child.error.code ?? 'launchFailed'}`);
  process.exit(child.status ?? 1);
} else {
  runElectron();
}

function runElectron() {
  const { app, BrowserWindow, clipboard, ipcMain, nativeImage, screen, session } = require('electron');
  const { registerAppScheme, serveAppScheme } = require('../src/main/appProtocol.ts');
  const { captureVision } = require('../src/main/visionCapture.ts');
  const { withCaptureWindowsHidden } = require('../src/main/captureWindows.ts');
  const { openExplainWindow, closeExplainWindow, registerExplainWindow } = require('../src/main/explainWindow.ts');
  const { strings } = require('../src/shared/i18n.ts');
  const { DEFAULT_SETTINGS, overlaySettings } = require('../src/shared/settings.ts');
  const { OVERLAY_PINGED } = require('../src/shared/ipc.ts');
  const fs = require('node:fs');
  const root = process.env.LOLPING_VISION_SMOKE_ROOT;
  if (!root) throw new Error('Run the smoke check through its Node launcher.');
  app.setAppPath(root);
  app.commandLine.appendSwitch('disable-background-networking');
  registerAppScheme();
  app.on('window-all-closed', () => {});
  const failures = [];
  let externalRequests = 0;
  let fetchCalls = 0;
  let clipboardWrites = 0;
  let fileWrites = 0;
  let asks = 0;
  let cancels = 0;
  let settingsOpened = 0;
  let configurations = 0;
  let captures = 0;
  let pendingAnswer = null;
  let lastCapture = null;
  let captureError = null;
  let targetWindow = null;
  let overlay = null;
  let card = null;
  let restoreCursor = () => {};
  let exitCode = 1;
  let wheelPing = null;

  const check = (condition, code) => { if (!condition) throw new Error(code); };
  const evaluate = (script) => card.webContents.executeJavaScript(script);
  const waitUntil = async (probe, code, timeout = 15000) => {
    const deadline = Date.now() + timeout;
    while (Date.now() < deadline) {
      if (await probe()) return;
      await new Promise((done) => setTimeout(done, 25));
    }
    throw new Error(code);
  };
  const waitForPaint = (window) => window.webContents.executeJavaScript(
    'new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)))');

  app.on('web-contents-created', (_event, contents) => {
    contents.on('preload-error', () => failures.push('preloadError'));
    contents.on('render-process-gone', () => failures.push('rendererGone'));
    contents.on('did-fail-load', (_event, code) => { if (code !== -3) failures.push('pageLoadFailed'); });
  });

  /** Capture itself must not touch the AI client, clipboard, network or file APIs. */
  function guardLocalCapture() {
    const restorers = [];
    const replace = (object, key, replacement) => {
      const previous = object[key];
      object[key] = replacement;
      restorers.push(() => { object[key] = previous; });
    };
    replace(globalThis, 'fetch', () => { fetchCalls += 1; throw new Error('captureFetch'); });
    for (const key of Object.keys(clipboard).filter((key) => key.startsWith('write'))) {
      replace(clipboard, key, () => { clipboardWrites += 1; throw new Error('captureClipboard'); });
    }
    for (const key of ['writeFile', 'writeFileSync', 'appendFile', 'appendFileSync', 'createWriteStream']) {
      replace(fs, key, () => { fileWrites += 1; throw new Error('captureFileWrite'); });
    }
    for (const key of ['writeFile', 'appendFile']) {
      replace(fs.promises, key, () => { fileWrites += 1; throw new Error('captureFileWrite'); });
    }
    return () => { for (const restore of restorers.reverse()) restore(); };
  }

  function inspectPreview(preview, expectedTarget) {
    check(preview.displayId === expectedTarget.displayId, 'wrongDisplay');
    const image = nativeImage.createFromDataURL(preview.local.dataUrl);
    const full = nativeImage.createFromDataURL(preview.full.dataUrl);
    check(!image.isEmpty() && !full.isEmpty(), 'decodeFailed');
    check(image.getSize().width === preview.local.width && image.getSize().height === preview.local.height,
      'localDimensionsMismatch');
    check(full.getSize().width === preview.full.width && full.getSize().height === preview.full.height,
      'fullDimensionsMismatch');
    const x = Math.floor(expectedTarget.x * preview.original.width / expectedTarget.bounds.width);
    const y = Math.floor(expectedTarget.y * preview.original.height / expectedTarget.bounds.height);
    check(preview.original.x === x && preview.original.y === y, 'originalPointMoved');
    check(preview.crop.width === Math.min(640, preview.original.width)
      && preview.crop.height === Math.min(480, preview.original.height), 'cropSizeMismatch');
    const bitmap = image.toBitmap();
    const localX = x - preview.crop.x;
    const localY = y - preview.crop.y;
    const index = (localY * preview.local.width + localX) * 4;
    // The synthetic target is green; the covering lolPing test overlay is magenta.
    check(bitmap[index + 1] > 130 && bitmap[index + 1] > bitmap[index] + 40
      && bitmap[index + 1] > bitmap[index + 2] + 40, 'ownWindowsContaminatedCapture');
    return {
      displayId: preview.displayId,
      original: { width: preview.original.width, height: preview.original.height },
      crop: { width: preview.crop.width, height: preview.crop.height },
      full: { width: preview.full.width, height: preview.full.height },
      marker: preview.local.marker,
      fullMarker: preview.full.marker,
    };
  }

  function moveCursor(display) {
    if (process.platform !== 'win32' || !process.env.SystemRoot) return false;
    const powershell = join(process.env.SystemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
    const original = screen.dipToScreenPoint(screen.getCursorScreenPoint());
    const moved = screen.dipToScreenPoint({
      x: display.bounds.x + Math.floor(display.bounds.width * 0.85),
      y: display.bounds.y + Math.floor(display.bounds.height * 0.85),
    });
    const move = (point) => spawnSync(powershell, ['-NoProfile', '-NonInteractive', '-WindowStyle', 'Hidden',
      '-Command', 'Add-Type -TypeDefinition \'using System.Runtime.InteropServices; public static class LolPingSmokeCursor {'
      + ' [DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y); }\'; '
      + `if (-not [LolPingSmokeCursor]::SetCursorPos(${point.x}, ${point.y})) { exit 1 }`],
    { windowsHide: true, stdio: 'pipe', timeout: 10000 });
    restoreCursor = () => { move(original); };
    return move(moved).status === 0;
  }

  app.whenReady().then(async () => {
    try {
      check(process.platform === 'win32', 'windowsDesktopRequired');
      session.defaultSession.webRequest.onBeforeRequest((details, callback) => {
        const external = /^(https?|wss?):/.test(details.url);
        if (external) externalRequests += 1;
        callback({ cancel: external });
      });
      serveAppScheme({ rendererRoot: join(root, 'out', 'renderer'), emoteDirs: () => [] });
      ipcMain.on(OVERLAY_PINGED, (event, ping) => {
        if (event.sender === overlay?.webContents) wheelPing = ping;
      });
      const words = { ...strings('en').explainWindow, errors: strings('en').aiError };
      registerExplainWindow({
        configured: () => { configurations += 1; return false; },
        cancel: () => { cancels += 1; },
        openSettings: () => { settingsOpened += 1; },
        ask: (_question, id, sink) => { asks += 1; pendingAnswer = { id, sink }; },
        capture: async (target) => {
          captures += 1;
          const restore = guardLocalCapture();
          const configuredBefore = configurations;
          const asksBefore = asks;
          try {
            return await withCaptureWindowsHidden(async () => {
              const result = await captureVision(target);
              if (result.ok) lastCapture = inspectPreview(result.preview, target);
              else captureError = `captureApi${result.code}`;
              check(configurations === configuredBefore && asks === asksBefore, 'captureUsedAiConfiguration');
              return result;
            }, { windows: () => BrowserWindow.getAllWindows().filter((window) => window !== targetWindow) });
          } catch (error) {
            captureError = /^[a-zA-Z][a-zA-Z0-9]{0,60}$/.test(error.message) ? error.message : 'captureFailed';
            throw error;
          } finally {
            restore();
          }
        },
      });

      const displays = screen.getAllDisplays();
      const results = [];
      for (const display of displays) {
        const bounds = display.bounds;
        targetWindow = new BrowserWindow({
          ...bounds, frame: false, show: false, skipTaskbar: true, focusable: false,
          enableLargerThanScreen: true, backgroundColor: '#20c060',
          webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false },
        });
        targetWindow.setAlwaysOnTop(true, 'screen-saver');
        await targetWindow.loadURL('data:text/html,<html><body style="margin:0;background:%2320c060">'
          + '<p style="padding:24px;color:black">Synthetic local capture verification target</p></body></html>');
        targetWindow.showInactive();
        await waitForPaint(targetWindow);
        overlay = new BrowserWindow({
          ...bounds, frame: false, show: false, skipTaskbar: true, focusable: false,
          enableLargerThanScreen: true, backgroundColor: '#ff00ff',
          webPreferences: { preload: join(root, 'out/preload/overlay.js'),
            sandbox: true, contextIsolation: true, nodeIntegration: false },
        });
        overlay.setAlwaysOnTop(true, 'screen-saver');
        await overlay.loadURL('lolping://app/overlay/index.html');
        await waitUntil(() => overlay.webContents.executeJavaScript('!!document.getElementById("emoteWheel")'),
          'overlayRendererMissing');
        await overlay.webContents.executeJavaScript('document.body.style.background="#ff00ff"');
        overlay.webContents.send('overlay:settings', overlaySettings({ ...DEFAULT_SETTINGS, muted: true, keepLastPing: true }));
        overlay.showInactive();
        await waitForPaint(overlay);
        check(await overlay.webContents.executeJavaScript(
          'typeof window.overlay?.on === "function" && typeof window.overlay?.reportPing === "function"'),
        'overlayBridgeMissing');
        const target = {
          displayId: display.id, x: Math.floor(bounds.width * 0.31), y: Math.floor(bounds.height * 0.42),
          bounds: { ...bounds }, scaleFactor: display.scaleFactor,
        };
        wheelPing = null;
        overlay.webContents.send('wheel:open', { x: target.x, y: target.y });
        await waitUntil(() => overlay.webContents.executeJavaScript(
          'document.getElementById("wheel").classList.contains("open")'), 'syntheticWheelDidNotOpen');
        overlay.webContents.send('wheel:move', { x: target.x - 150, y: target.y });
        overlay.webContents.send('wheel:release', { x: target.x - 150, y: target.y });
        await waitUntil(() => wheelPing !== null, 'syntheticWheelDidNotReport');
        check(wheelPing.id === 'missing' && wheelPing.x === target.x && wheelPing.y === target.y,
          'wheelCentreChanged');
        await waitUntil(() => overlay.webContents.executeJavaScript(
          '!!document.querySelector("#pings .ping img")?.naturalWidth'), 'pingArtMissing');
        const existing = new Set(BrowserWindow.getAllWindows());
        openExplainWindow({ x: bounds.x + target.x, y: bounds.y + target.y }, words, target);
        card = BrowserWindow.getAllWindows().find((window) => !existing.has(window));
        check(card, 'explainWindowMissing');
        await waitUntil(() => evaluate('typeof window.explainApi?.capture === "function"'
          + ' && document.getElementById("previewOpen") && !document.getElementById("previewOpen").hidden'
          + ' && !document.getElementById("previewOpen").disabled'), 'explainBridgeMissing');
        const preferences = card.webContents.getLastWebPreferences();
        check(preferences.sandbox !== false && preferences.contextIsolation !== false
          && preferences.nodeIntegration !== true, 'explainSandboxDisabled');
        const state = await evaluate('window.explainApi.state()');
        check(state && !state.configured && state.captureAvailable, 'captureRequiresApiKey');
        const movedCursor = moveCursor(display);
        lastCapture = null;
        captureError = null;
        await evaluate('document.getElementById("previewOpen").click()');
        await waitUntil(() => {
          if (captureError) throw new Error(captureError);
          return evaluate('(() => { const a=document.getElementById("visionLocal");'
            + 'const b=document.getElementById("visionFull");return a?.naturalWidth>0 && b?.naturalWidth>0 })()');
        },
        'previewImagesMissing', 30000);
        check(lastCapture, 'captureDidNotComplete');
        check(overlay.isVisible() && card.isVisible(), 'windowsNotRestored');
        check(await evaluate('document.getElementById("visionPrivacy").textContent') === words.vision.privacy,
          'privacyLabelMissing');
        const markers = await evaluate('({ local: {x:document.getElementById("visionLocalMarker").style.left,'
          + 'y:document.getElementById("visionLocalMarker").style.top}, full: {'
          + 'x:document.getElementById("visionFullMarker").style.left,'
          + 'y:document.getElementById("visionFullMarker").style.top} })');
        for (const [name, marker] of [['local', lastCapture.marker], ['full', lastCapture.fullMarker]]) {
          check(Math.abs(parseFloat(markers[name].x) - marker.x * 100) < 0.01
            && Math.abs(parseFloat(markers[name].y) - marker.y * 100) < 0.01, 'rendererMarkerMismatch');
        }
        let expectedFailure = false;
        try {
          await withCaptureWindowsHidden(async () => { throw new Error('syntheticFailure'); },
            { windows: () => [overlay, card] });
        } catch (error) {
          expectedFailure = error.message === 'syntheticFailure';
        }
        check(expectedFailure && overlay.isVisible() && card.isVisible(), 'failureRestoreBroken');
        await evaluate('document.getElementById("previewClose").click()');
        await waitUntil(() => evaluate('!document.getElementById("visionLocal").hasAttribute("src")'
          + ' && !document.getElementById("visionFull").hasAttribute("src")'), 'previewImagesRetained');

        const next = { ...target, x: Math.min(bounds.width - 1, target.x + 20) };
        openExplainWindow({ x: bounds.x + next.x, y: bounds.y + next.y }, words, next);
        const nextState = await evaluate('window.explainApi.state()');
        check(nextState.visionSessionId !== state.visionSessionId, 'newPingReusedSession');
        const stale = await evaluate(`window.explainApi.capture(${state.visionSessionId})`);
        check(stale === null || (stale.result && !stale.result.ok && stale.result.code === 'stale'),
          'staleSessionCaptured');
        await evaluate('document.getElementById("question").value="synthetic smoke";'
          + 'document.getElementById("ask").requestSubmit()');
        await waitUntil(() => pendingAnswer && evaluate('!document.getElementById("send").disabled'), 'textAskMissing');
        pendingAnswer.sink({ kind: 'delta', id: pendingAnswer.id, text: 'Synthetic ' });
        pendingAnswer.sink({ kind: 'delta', id: pendingAnswer.id, text: 'answer' });
        pendingAnswer.sink({ kind: 'done', id: pendingAnswer.id });
        await waitUntil(() => evaluate('document.getElementById("body").textContent === "Synthetic answer"'
          + ' && !document.getElementById("copy").disabled'), 'textStreamingBroken');
        pendingAnswer = null;
        const cancelsBefore = cancels;
        await evaluate('document.getElementById("ask").requestSubmit()');
        await waitUntil(() => pendingAnswer && evaluate('!document.getElementById("stop").hidden'), 'stopButtonMissing');
        await evaluate('document.getElementById("stop").click()');
        await waitUntil(() => cancels > cancelsBefore && evaluate('document.getElementById("stop").hidden'),
          'stopDidNotCancel');
        await evaluate('window.explainApi.openSettings()');
        await waitUntil(() => settingsOpened > 0, 'settingsActionBroken');
        results.push({ ...lastCapture, scaleFactor: display.scaleFactor, movedCursor,
          sandboxPreloads: 'PASS', syntheticWheelAndPing: 'PASS', exclusionAndRestore: 'PASS',
          imageRelease: 'PASS', textStreamAndStop: 'PASS' });
        card.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Escape' });
        await waitUntil(() => card.isDestroyed(), 'escapeDidNotClose');
        overlay.destroy();
        targetWindow.destroy();
        overlay = null;
        targetWindow = null;
        restoreCursor();
        restoreCursor = () => {};
      }
      check(failures.length === 0, failures[0] ?? 'rendererFailure');
      check(externalRequests === 0 && fetchCalls === 0 && clipboardWrites === 0 && fileWrites === 0,
        'capturePrivacyRegression');
      console.log(JSON.stringify({ status: 'PASS', mode: 'synthetic Windows desktop; physical gesture not exercised by this tool',
        displays: results, captures, externalRequests, fetchCalls, clipboardWrites, fileWrites }));
      exitCode = 0;
    } catch (error) {
      // Exception messages from OS capture APIs can contain screen titles; print only our fixed diagnostic codes.
      const code = /^[a-zA-Z][a-zA-Z0-9]{0,60}$/.test(error.message) ? error.message : 'unexpectedSmokeFailure';
      console.error(JSON.stringify({ status: 'FAIL', code, rendererErrors: failures }));
    } finally {
      restoreCursor();
      closeExplainWindow();
      for (const window of BrowserWindow.getAllWindows()) if (!window.isDestroyed()) window.destroy();
      app.exit(exitCode);
    }
  });
}
