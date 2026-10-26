/* Production overlay/preload + Main session checks + real native desktop toggles.
 * Helper events are synthetic: this does not claim hardware mouse or live-hook acceptance. */
const { join, resolve } = require('node:path');
const { mkdirSync, copyFileSync } = require('node:fs');
const { spawn, spawnSync, execFile } = require('node:child_process');

if (!process.versions.electron) {
  if (process.platform !== 'win32') {
    console.log('SKIP ping-actions smoke: Windows only');
    process.exit(0);
  }
  const root = resolve(__dirname, '..');
  const out = join(root, 'out/ping-actions-smoke');
  const dispatchOnly = process.argv.includes('--dispatch-only');
  const nativeDir = resolve(process.argv[2] || join(root, 'native/desktop-helper/build'));
  mkdirSync(out, { recursive: true });
  if (!dispatchOnly) {
    copyFileSync(join(nativeDir, 'desktop-helper.exe'), join(out, 'desktop-helper.exe'));
    copyFileSync(join(nativeDir, 'fixture_app.exe'), join(out, 'fixture_app.exe'));
  }
  require('esbuild').buildSync({ entryPoints: [__filename], outfile: join(out, 'main.cjs'), bundle: true,
    platform: 'node', format: 'cjs', external: ['electron', 'esbuild'], logLevel: 'silent' });
  const env = { ...process.env, LOLPING_PING_ACTION_SMOKE_ROOT: root,
    LOLPING_DISPATCH_ONLY: dispatchOnly ? '1' : '0' };
  delete env.ELECTRON_RUN_AS_NODE;
  delete env.ELECTRON_RENDERER_URL;
  const result = spawnSync(require('electron'), [join(out, 'main.cjs'), '--user-data-dir=' + join(out, 'profile')],
    { cwd: root, env, windowsHide: true, encoding: 'utf8', timeout: 60000 });
  if (result.stdout) process.stdout.write(result.stdout);
  if (result.stderr) process.stderr.write(result.stderr);
  process.exit(result.status ?? 1);
} else run();

function run() {
  const { app, BrowserWindow, screen, session } = require('electron');
  const { createInterface } = require('node:readline');
  const { registerAppScheme, serveAppScheme } = require('../src/main/appProtocol.ts');
  const { OverlayManager } = require('../src/main/overlayManager.ts');
  const { DesktopBridge } = require('../src/main/desktopBridge.ts');
  const { QuickActionExecutor } = require('../src/main/quickActionExecutor.ts');
  const { DEFAULT_SETTINGS, overlaySettings } = require('../src/shared/settings.ts');
  const root = process.env.LOLPING_PING_ACTION_SMOKE_ROOT;
  if (!root) throw new Error('launcherRequired');
  app.setAppPath(root);
  app.commandLine.appendSwitch('disable-background-networking');
  registerAppScheme();
  app.on('window-all-closed', () => {});
  const out = join(root, 'out/ping-actions-smoke');
  const dispatchOnly = process.env.LOLPING_DISPATCH_ONLY === '1';
  let releasedAt = 0;
  const dispatchMs = [];
  const desktop = new DesktopBridge({ command: join(out, 'desktop-helper.exe') });
  let manager;
  let controller;
  let fixture;
  let fixtureReady = false;
  let fixtureForeground = false;
  let fixtureMinimized = false;
  let fixtureTransitions = [];
  const fixtureEvents = [];
  const activationReplies = [];
  let externalRequests = 0;
  let stage = 'setup';
  let exitCode = 1;
  const results = [];
  const legacy = [];
  const check = (condition, code) => { if (!condition) throw new Error(code); };
  const wait = async (condition, code) => {
    const deadline = Date.now() + 8000;
    while (Date.now() < deadline) {
      if (await condition()) return;
      await new Promise(done => setTimeout(done, 20));
    }
    throw new Error(code);
  };
  app.whenReady().then(async () => {
    try {
      session.defaultSession.webRequest.onBeforeRequest({ urls: ['http://*/*', 'https://*/*'] }, (_details, callback) => {
        externalRequests++;
        callback({ cancel: true });
      });
      serveAppScheme({ rendererRoot: join(root, 'out/renderer'), emoteDirs: () => [] });
      controller = new BrowserWindow({ width: 420, height: 260, show: true,
        webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false } });
      await controller.loadURL('data:text/html,<meta charset="utf-8"><title>lolPing P3 test</title><p>Controlled desktop action test window</p>');
      controller.focus();
      manager = new OverlayManager(overlaySettings({ ...DEFAULT_SETTINGS, muted: true, tickSound: false }), () => ({ kind: 'placeholder' }));
      manager.start();
      manager.setQuickActionsEnabled(true);
      const executor = new QuickActionExecutor({
        platform: 'win', desktop: { run: request => {
          if (!dispatchOnly) return desktop.run(request);
          dispatchMs.push(performance.now() - releasedAt);
          return Promise.resolve({ type: 'result', status: 'desktopToggled' });
        } },
        verifyProgram: async () => ({ ok: false, code: 'invalidProgram' }),
        launchProgram: async () => { throw new Error('unexpectedLaunch'); },
        openUrl: async () => { throw new Error('unexpectedUrl'); },
      });
      manager.on('wheelPing', ping => legacy.push(ping.id));
      manager.on('quickAction', id => {
        void executor.execute({ enabled: true, name: 'Desktop', target: { kind: 'toggleDesktop' } })
          .then(result => results.push({ id, ...result }));
      });
      await wait(() => Promise.all(BrowserWindow.getAllWindows().filter(window => window !== controller).map(window =>
        window.webContents.executeJavaScript('typeof window.overlay?.reportQuickAction === "function"').catch(() => false)))
        .then(ready => ready.length > 0 && ready.every(Boolean)), 'overlaysNotReady');
      const display = screen.getPrimaryDisplay();
      const overlay = BrowserWindow.getAllWindows().find(window => window !== controller && Math.abs(window.getBounds().x - display.bounds.x) < 1);
      check(overlay, 'primaryOverlayMissing');
      const paint = () => overlay.webContents.executeJavaScript('new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)))');
      stage = 'sourceGuards';
      await overlay.webContents.executeJavaScript('window.overlay.reportQuickAction(999,"omw")');
      manager.previewPing('omw');
      manager.spawnRemote({ id: 'omw', displayId: display.id, x: 100, y: 100, tag: { name: 'Fixture', color: 0 } });
      await paint();
      check(results.length === 0, 'unreleasedActionExecuted');
      if (dispatchOnly) {
        stage = 'syntheticDispatchBenchmark';
        const origin = { x: display.bounds.x + display.bounds.width / 2, y: display.bounds.y + display.bounds.height / 2 };
        const start = screen.dipToScreenRect(null, { ...origin, width: 1, height: 1 });
        const distance = Math.round(200 * display.scaleFactor);
        for (let sample = 0; sample < 100; sample++) {
          manager.handle({ type: 'wheelOpen', wheel: 'ping', x: start.x, y: start.y });
          await paint();
          manager.handle({ type: 'wheelMove', wheel: 'ping', x: start.x + distance, y: start.y });
          releasedAt = performance.now();
          manager.handle({ type: 'wheelRelease', wheel: 'ping', x: start.x + distance, y: start.y });
          await wait(() => results.length === sample + 1, 'benchmarkActionMissing');
          check(results[sample].ok && results[sample].id === 'omw', 'benchmarkActionFailed');
        }
        const sorted = [...dispatchMs].sort((a, b) => a - b);
        const p95 = sorted[Math.ceil(sorted.length * 0.95) - 1];
        check(p95 <= 100, 'syntheticDispatchOver100ms');
        console.log(JSON.stringify({ status: 'PASS', syntheticHelperEvents: true,
          productionWheelAndPreload: true, nativeExecutorStubbed: true, hardwareMouseVerified: false,
          desktopEffectVerified: false, samples: sorted.length, p50Ms: sorted[49], p95Ms: p95,
          maxMs: sorted[99], externalRequests }));
        executor.close();
        exitCode = 0;
        return;
      }
      fixture = spawn(join(out, 'fixture_app.exe'), ['minimized'], { windowsHide: false, stdio: ['ignore', 'pipe', 'pipe'] });
      fixture.stderr.resume();
      fixture.on('exit', (code) => fixtureEvents.push(`exit:${code}`));
      createInterface({ input: fixture.stdout }).on('line', line => {
        fixtureEvents.push(line.startsWith('ready ') ? 'ready' : line);
        if (line.startsWith('ready ')) fixtureReady = true;
        if (line === 'foreground') fixtureForeground = true;
        if (line === 'minimized' || line === 'restored') {
          fixtureMinimized = line === 'minimized';
          fixtureTransitions.push(line);
        }
      });
      await wait(() => fixtureReady, 'fixtureNotReady');
      await wait(() => fixtureMinimized, 'fixtureDidNotStartMinimized');
      // The fixture announces ready before ShowWindow. Establish a visible foreground window before toggling.
      stage = 'fixtureActivation';
      await wait(async () => {
        if (fixtureForeground) return true;
        const reply = await desktop.run({ type: 'activate', exePath: join(out, 'fixture_app.exe') });
        activationReplies.push(reply);
        return reply.type === 'result' && reply.status === 'activated';
      }, 'fixtureNotActivatable');
      await wait(() => fixtureForeground, 'fixtureForegroundNotObserved');
      await wait(() => !fixtureMinimized, 'fixtureRestoreNotObserved');
      stage = 'userInputContext';
      await new Promise((resolveInput, rejectInput) => execFile('powershell.exe',
        ['-NoProfile', '-NonInteractive', '-WindowStyle', 'Hidden', '-File', join(root, 'tools/ping-actions-input.ps1'),
          '-TargetPid', String(fixture.pid)], { windowsHide: true, timeout: 10000 },
        error => error ? rejectInput(new Error('controlledInputNotAvailable')) : resolveInput()));
      const startDip = { x: display.bounds.x + display.bounds.width / 2, y: display.bounds.y + display.bounds.height / 2 };
      const start = screen.dipToScreenRect(null, { ...startDip, width: 1, height: 1 });
      const distance = Math.round(200 * display.scaleFactor);
      const gesture = async (dx, dy) => {
        manager.handle({ type: 'wheelOpen', wheel: 'ping', x: start.x, y: start.y });
        await paint();
        manager.handle({ type: 'wheelMove', wheel: 'ping', x: start.x + dx, y: start.y + dy });
        manager.handle({ type: 'wheelRelease', wheel: 'ping', x: start.x + dx, y: start.y + dy });
      };
      stage = 'firstDesktopToggle';
      await gesture(distance, 0);
      await wait(() => results.length === 1, 'firstActionMissing');
      check(results[0].ok && results[0].status === 'desktopToggled' && results[0].id === 'omw', 'firstToggleFailed');
      await wait(() => fixtureMinimized, 'fixtureDidNotMinimize');
      stage = 'secondDesktopToggle';
      await gesture(distance, 0);
      await wait(() => results.length === 2, 'secondActionMissing');
      check(results[1].ok && results[1].status === 'desktopToggled', 'secondToggleFailed');
      await wait(() => !fixtureMinimized, 'wheelInterruptedDesktopRestore');
      check(legacy.filter(id => id === 'omw').length === 2, 'legacyPingChanged');
      stage = 'reservedQuestionMark';
      await gesture(-distance, 0);
      await wait(() => legacy.includes('missing'), 'questionMarkLegacyEventLost');
      await paint();
      check(results.length === 2, 'questionMarkExecutedAction');
      check(externalRequests === 0, 'unexpectedNetwork');
      console.log(JSON.stringify({ status: 'PASS', productionWheel: true, productionSandboxPreload: true,
        syntheticHelperEvents: true, osInjectedAlt: true, hardwareMouseVerified: false, nativeDesktop: true,
        actions: results, fixtureTransitions, questionMarkPreserved: true, externalRequests }));
      executor.close();
      exitCode = 0;
    } catch (error) {
      console.log(JSON.stringify({ status: 'FAIL', stage, code: error.message, results, fixtureTransitions, fixtureEvents, activationReplies, externalRequests }));
    } finally {
      // Restore a minimized test fixture if a failed scenario left the system showing the desktop.
      if (fixtureMinimized) await desktop.run({ type: 'toggleDesktop' });
      if (fixture) fixture.kill();
      if (manager) manager.destroy();
      if (controller && !controller.isDestroyed()) controller.destroy();
      desktop.close();
      app.exit(exitCode);
    }
  });
}
