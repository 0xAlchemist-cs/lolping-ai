/* Real Windows hook -> InputBridge -> production overlay/preload -> action executor.
 * Inputs are OS-injected into an owned window; browser/native effects are stubbed. */
const { join, resolve } = require('node:path');
const { mkdirSync, copyFileSync, readFileSync } = require('node:fs');
const { createHash } = require('node:crypto');
const { spawn, spawnSync } = require('node:child_process');

if (!process.versions.electron) {
  if (process.platform !== 'win32') { console.log('SKIP live-hook smoke: Windows only'); process.exit(0); }
  const root = resolve(__dirname, '..');
  const out = join(root, 'out/ping-actions-hook-smoke');
  mkdirSync(out, { recursive: true });
  copyFileSync(join(root, 'native/hook-helper/build/hook-helper.exe'), join(out, 'hook-helper.exe'));
  require('esbuild').buildSync({ entryPoints: [__filename], outfile: join(out, 'main.cjs'), bundle: true,
    platform: 'node', format: 'cjs', external: ['electron', 'esbuild'], logLevel: 'silent' });
  const env = { ...process.env, LOLPING_HOOK_SMOKE_ROOT: root };
  delete env.ELECTRON_RUN_AS_NODE;
  delete env.ELECTRON_RENDERER_URL;
  const child = spawnSync(require('electron'), [join(out, 'main.cjs'), '--user-data-dir=' + join(out, 'profile')],
    { cwd: root, env, windowsHide: true, encoding: 'utf8', timeout: 90000 });
  if (child.stdout) process.stdout.write(child.stdout);
  if (child.stderr) process.stderr.write(child.stderr);
  if (child.error || child.status !== 0 && !child.stdout?.includes('"status":"FAIL"')) {
    console.log(JSON.stringify({ status: 'FAIL', stage: 'launcher', code: child.error?.code ?? 'electronExited',
      exitCode: child.status, signal: child.signal }));
  }
  process.exit(child.status ?? 1);
} else run();

function run() {
  const { app, BrowserWindow, screen, session } = require('electron');
  const { createInterface } = require('node:readline');
  const { registerAppScheme, serveAppScheme } = require('../src/main/appProtocol.ts');
  const { InputBridge } = require('../src/main/inputBridge.ts');
  const { OverlayManager } = require('../src/main/overlayManager.ts');
  const { QuickActionExecutor } = require('../src/main/quickActionExecutor.ts');
  const { DEFAULT_SETTINGS, normalizeSettings, overlaySettings } = require('../src/shared/settings.ts');
  const { configCommand } = require('../src/shared/protocol.ts');
  const root = process.env.LOLPING_HOOK_SMOKE_ROOT;
  if (!root) throw new Error('launcherRequired');
  app.setAppPath(root);
  app.commandLine.appendSwitch('disable-background-networking');
  registerAppScheme();
  app.on('window-all-closed', () => {});
  const driverPath = join(root, 'tools/ping-actions-hook-input.ps1');
  const driverHash = createHash('sha256').update(readFileSync(driverPath)).digest('hex').slice(0, 16);
  const driverAssembly = join(root, 'out/ping-actions-hook-smoke', `input-${driverHash}.dll`);
  let controller, manager, bridge, executor;
  let enabled = true;
  let suspended = false;
  let helperError = false;
  const binding = { enabled: true, name: 'Fixture', target: { kind: 'web', url: 'https://fixture.invalid/' } };
  let settings = { ...DEFAULT_SETTINGS, muted: true, tickSound: false,
    features: { ...DEFAULT_SETTINGS.features, quickActions: true },
    quickActions: { version: 1, bindings: { omw: binding, danger: { ...binding, target: { kind: 'web', url: 'https://fixture.invalid/danger' } } } } };
  let externalRequests = 0;
  let activationClicks = 0;
  let stage = 'setup';
  let code = 1;
  let routing = Promise.resolve();
  const events = [], legacy = [], shared = [], actions = [], urls = [], scenarios = [];
  const check = (condition, reason) => { if (!condition) throw new Error(reason); };
  const wait = async (condition, reason) => {
    const end = Date.now() + 7000;
    while (Date.now() < end) {
      if (helperError) throw new Error('inputHelperReportedError');
      if (await condition()) return;
      await new Promise(done => setTimeout(done, 20));
    }
    throw new Error(reason);
  };
  const available = () => enabled && !suspended && !helperError && settings.features.quickActions && bridge?.status === 'running';
  const sync = () => manager.setQuickActionsEnabled(available());
  const trace = name => {
    if (process.env.LOLPING_HOOK_SMOKE_DIAGNOSTICS === '1') console.log(JSON.stringify({ progress: name,
      events: events.length, actions: actions.length }));
  };
  trace('appCreated');
  app.whenReady().then(async () => {
    try {
      trace('appReady');
      session.defaultSession.webRequest.onBeforeRequest({ urls: ['http://*/*', 'https://*/*'] }, (_details, callback) => {
        externalRequests++; callback({ cancel: true });
      });
      serveAppScheme({ rendererRoot: join(root, 'out/renderer'), emoteDirs: () => [] });
      const display = screen.getPrimaryDisplay();
      controller = new BrowserWindow({ x: display.workArea.x + 40, y: display.workArea.y + 40,
        width: 820, height: 480, show: true,
        webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, backgroundThrottling: false } });
      await controller.loadURL('data:text/html,<title>lolPing owned input fixture</title><p>Controlled input target</p>'
        + '<script>window.counts={down:0,up:0};onmousedown=()=>counts.down++;onmouseup=()=>counts.up++;oncontextmenu=e=>e.preventDefault()</script>');
      manager = new OverlayManager(overlaySettings(settings), () => ({ kind: 'placeholder' }));
      manager.start();
      executor = new QuickActionExecutor({ platform: 'win',
        desktop: { run: async () => { throw new Error('unexpectedDesktopRequest'); } },
        verifyProgram: async () => ({ ok: false, code: 'invalidProgram' }),
        launchProgram: async () => { throw new Error('unexpectedProgramLaunch'); },
        openUrl: async url => { urls.push(url); },
      });
      manager.on('wheelPing', ping => legacy.push(ping.id));
      manager.on('shared', ping => shared.push(ping.id));
      manager.on('quickAction', id => {
        const snapshot = settings;
        const saved = snapshot.quickActions.bindings[id];
        if (!available() || !saved?.enabled) return;
        void executor.execute(saved, () => available() && settings === snapshot)
          .then(result => actions.push({ id, ...result }));
      });
      bridge = new InputBridge({ command: join(root, 'out/ping-actions-hook-smoke/hook-helper.exe') });
      bridge.on('status', sync);
      bridge.on('event', event => {
        events.push(event);
        if (event.type === 'error') { helperError = true; sync(); return; }
        if (event.type === 'toggled') { enabled = event.enabled; sync(); }
        else manager.handle(event);
      });
      bridge.send(configCommand(settings, enabled));
      bridge.start();
      await wait(() => bridge.status === 'running', 'inputHelperNotReady');
      await wait(async () => {
        const overlays = BrowserWindow.getAllWindows().filter(win => win !== controller);
        return overlays.length > 0 && (await Promise.all(overlays.map(win => win.webContents
          .executeJavaScript('typeof window.overlay?.reportQuickAction === "function"').catch(() => false)))).every(Boolean);
      }, 'productionOverlayNotReady');
      const paint = async () => {
        let timer;
        try {
          await Promise.race([
            controller.webContents.executeJavaScript('new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)))'),
            new Promise((_done, reject) => { timer = setTimeout(() => reject(new Error('fixturePaintTimeout')), 3000); }),
          ]);
        } finally { clearTimeout(timer); }
      };
      const pointer = () => controller.webContents.executeJavaScript('({...window.counts})');
      const configure = async (trigger, on = true) => {
        settings = normalizeSettings({ ...settings, trigger }, 'win');
        enabled = on;
        manager.updateSettings(overlaySettings(settings));
        sync();
        bridge.send(configCommand(settings, enabled));
        await paint();
      };
      const inject = async (trigger, mode, held, armed = async () => {}) => {
        // Another always-on-top desktop app may cover our foreground fixture.
        controller.setAlwaysOnTop(true, 'pop-up-menu');
        controller.moveTop();
        controller.focus();
        await wait(() => controller.isFocused(), 'ownedFixtureNotFocused');
        const handle = controller.getNativeWindowHandle().readBigUInt64LE().toString();
        await new Promise((done, reject) => {
          const child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-WindowStyle', 'Hidden',
            '-File', driverPath, '-DriverAssembly', driverAssembly, '-WindowHandle', handle,
            '-OwnerPid', String(process.pid), '-Trigger', trigger, '-Mode', mode,
            '-Distance', String(Math.round(160 * display.scaleFactor))], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
          let error = '', driverFailed = false;
          const surfaces = [];
          let released = false;
          let killTimer;
          const release = () => { if (!released) { released = true; child.stdin.end('release\n'); } };
          const timeout = setTimeout(() => {
            driverFailed = true; error = 'inputDriverTimeout'; release();
            killTimer = setTimeout(() => child.kill(), 6000);
          }, 15000);
          child.stdin.on('error', () => { driverFailed = true; error = 'driverInputPipeClosed'; });
          child.stderr.on('data', part => { error = (error + part.toString()).slice(-1200); });
          child.on('error', reject);
          createInterface({ input: child.stdout }).on('line', line => {
            if (line.includes('"stage":"ready"')) {
              routing = Promise.resolve().then(async () => {
                controller.moveTop(); controller.focus();
                await wait(() => !controller.isMinimized() && controller.isFocused(), 'fixtureFocusUnavailable');
                child.stdin.write('start\n');
              }).catch(reason => { driverFailed = true; error = reason.message; release(); });
            }
            if (line.includes('"stage":"error"')) { driverFailed = true; error = JSON.parse(line).code; }
            if (line.includes('"stage":"surfaceGuard"') || line.includes('"stage":"windowGuard"')) {
              const report = JSON.parse(line);
              const known = BrowserWindow.getAllWindows().map(win => ({
                handle: Number(win.getNativeWindowHandle().readBigUInt64LE()), isController: win === controller, bounds: win.getBounds(),
              }));
              surfaces.push({ ...report, known });
            }
            if (line.includes('"stage":"held"')) {
              routing = Promise.resolve().then(held).then(release).catch(reason => {
                driverFailed = true; error = reason.message; release();
              });
            }
            if (line.includes('"stage":"armed"')) {
              const report = JSON.parse(line);
              if (report.activationClick) activationClicks++;
              routing = Promise.resolve().then(() => armed(report.activationClick)).then(() => {
                child.stdin.write('press\n');
              }).catch(reason => { driverFailed = true; error = reason.message; release(); });
            }
          });
          child.on('close', async status => {
            clearTimeout(timeout); clearTimeout(killTimer);
            await routing;
            if (status !== 0 || driverFailed) reject(new Error('driverFailed:' + JSON.stringify(surfaces) + error)); else done();
          });
        });
      };
      const scenario = async (name, trigger, mode, expected, on = true, expectedAction = Boolean(expected && expected !== 'missing')) => {
        stage = name;
        trace(name);
        await configure(trigger === 'none' ? 'alt' : trigger, on);
        const before = { actions: actions.length, pings: legacy.length, events: events.length, pointer: await pointer() };
        const gesture = mode !== 'click' && trigger !== 'none' && on && !suspended;
        await inject(trigger, mode, async () => {
          if (gesture) {
            const heldPointer = await pointer();
            await wait(() => events.slice(before.events).some(event => event.type === 'wheelOpen'),
              'hookDidNotOpenWheel:' + JSON.stringify({ before: before.pointer, held: heldPointer }));
          }
          else await wait(async () => (await pointer()).down > before.pointer.down, 'ordinaryPressNotPassedThrough');
        }, async activationClick => {
          if (activationClick) await wait(async () => {
            const current = await pointer();
            return current.down > before.pointer.down && current.up > before.pointer.up;
          }, 'fixtureActivationClickMissing');
          before.pointer = await pointer();
        });
        if (expected) await wait(() => legacy.length > before.pings, 'legacyPingMissing');
        else if (gesture) await wait(() => events.slice(before.events).some(event => event.type === (mode === 'center' ? 'wheelRelease' : 'cancel')), 'cancelMissing');
        else await wait(async () => (await pointer()).up > before.pointer.up, 'ordinaryReleaseNotPassedThrough');
        await paint();
        check(legacy.length === before.pings + (expected ? 1 : 0), 'unexpectedLegacyPingCount');
        check(actions.length === before.actions + (expectedAction ? 1 : 0), 'unexpectedActionCount');
        if (expectedAction) check(actions.at(-1).ok && actions.at(-1).id === expected, 'wrongActionIcon');
        if (expected) check(legacy.at(-1) === expected, 'wrongLegacyIcon');
        scenarios.push({ name, pass: true });
      };
      await scenario('ordinaryClickPassThrough', 'none', 'click', null);
      await scenario('altWheel', 'alt', 'right', 'omw');
      await scenario('ctrlWheel', 'ctrl', 'right', 'omw');
      await scenario('shiftWheel', 'shift', 'right', 'omw');
      await scenario('sideButton4', 'mouse4', 'right', 'omw');
      await scenario('sideButton5', 'mouse5', 'right', 'omw');
      await scenario('reservedQuestionMark', 'alt', 'left', 'missing');
      await scenario('centerCancellation', 'alt', 'center', null);
      await scenario('escapeCancellation', 'alt', 'escape', null);
      await scenario('rightButtonCancellation', 'alt', 'rightCancel', null);
      stage = 'singleClickPingOnly';
      settings = { ...settings, clickPing: true };
      await configure('alt');
      const clickBefore = { shared: shared.length, actions: actions.length, legacy: legacy.length };
      await inject('alt', 'click', paint);
      await wait(() => shared.length > clickBefore.shared, 'singleClickPingMissing');
      check(shared.length === clickBefore.shared + 1 && legacy.length === clickBefore.legacy
        && actions.length === clickBefore.actions, 'singleClickRanAction');
      scenarios.push({ name: stage, pass: true });
      settings = { ...settings, clickPing: false };
      suspended = true;
      bridge.send({ type: 'suspend', on: true });
      await scenario('settingsCapturePassThrough', 'alt', 'right', null);
      suspended = false;
      bridge.send({ type: 'suspend', on: false });
      await scenario('captureRecovery', 'alt', 'right', 'omw');
      settings = { ...settings, features: { ...settings.features, quickActions: false } };
      await scenario('featureOffKeepsPing', 'alt', 'right', 'omw', true, false);
      settings = { ...settings, features: { ...settings.features, quickActions: true },
        quickActions: { ...settings.quickActions, bindings: { ...settings.quickActions.bindings, omw: { ...binding, enabled: false } } } };
      await scenario('disabledBindingKeepsPing', 'alt', 'right', 'omw', true, false);
      const wheel = [...settings.wheel];
      [wheel[0], wheel[2]] = [wheel[2], wheel[0]];
      settings = { ...settings, wheel,
        quickActions: { ...settings.quickActions, bindings: { ...settings.quickActions.bindings, omw: binding } } };
      await scenario('bindingFollowsMovedIcon', 'alt', 'right', 'danger');
      await scenario('pausePassThrough', 'alt', 'right', null, false);
      check(externalRequests === 0 && urls.length === 7 && urls.at(-1) === 'https://fixture.invalid/danger', 'unexpectedExternalEffect');
      console.log(JSON.stringify({ status: 'PASS', realInputHelper: true, syntheticHelperEvents: false,
        osInjectedInput: true, hardwareMouseVerified: false, productionOverlayAndPreload: true,
        mainAvailabilityHarnessed: true, executorOpenStubbed: true, desktopEffectsVerified: false,
        fixtureActivationClicks: activationClicks,
        scenarios, helperReleases: events.filter(event => event.type === 'wheelRelease').length,
        actions: actions.length, originalWheelPings: legacy.length, originalSharedPings: shared.length, externalRequests }));
      code = 0;
    } catch (error) {
      console.log(JSON.stringify({ status: 'FAIL', stage, reason: error.message, scenarios,
        events: events.map(event => event.type), actions, legacy, externalRequests }));
    } finally {
      executor?.close();
      if (bridge) await bridge.stop();
      manager?.destroy();
      if (controller && !controller.isDestroyed()) controller.destroy();
      app.exit(code);
    }
  });
}
