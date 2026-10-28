/* Complete built Main entry point, real IPC/store/UI/hook, isolated appData and userData.
 * OS input targets an owned fixture; URL/dialog/native-job boundaries are explicitly controlled. */
const { join, resolve, basename } = require('node:path');
const { mkdirSync, mkdtempSync, readFileSync, writeFileSync } = require('node:fs');
const { spawnSync } = require('node:child_process');

if (!process.versions.electron) {
  if (process.platform !== 'win32') { console.log('SKIP full-app smoke: Windows only'); process.exit(0); }
  const root = resolve(__dirname, '..');
  const out = join(root, 'out/ping-actions-app-smoke');
  mkdirSync(out, { recursive: true });
  const runDir = mkdtempSync(join(out, 'run-'));
  require('esbuild').buildSync({ entryPoints: [__filename], outfile: join(out, 'main.cjs'), bundle: true,
    platform: 'node', format: 'cjs', external: ['electron', 'esbuild'], logLevel: 'silent' });
  const env = { ...process.env };
  for (const key of Object.keys(env)) if (key.startsWith('LOLPING_')) delete env[key];
  delete env.ELECTRON_RUN_AS_NODE;
  delete env.ELECTRON_RENDERER_URL;
  env.LOLPING_APP_SMOKE_ROOT = root;
  env.LOLPING_APP_SMOKE_RUN = runDir;
  if (process.argv.includes('--latency')) env.LOLPING_APP_SMOKE_LATENCY = '1';
  const child = spawnSync(require('electron'), [join(out, 'main.cjs'), '--user-data-dir=' + join(runDir, 'profile')],
    { cwd: root, env, windowsHide: true, encoding: 'utf8', timeout: process.argv.includes('--latency') ? 240000 : 120000,
      stdio: process.argv.includes('--latency') ? ['ignore', 'inherit', 'inherit'] : 'pipe' });
  if (child.stdout) process.stdout.write(child.stdout);
  if (child.stderr) process.stderr.write(child.stderr);
  let report;
  try { report = JSON.parse(readFileSync(join(runDir, 'report.json'), 'utf8')); } catch { /* launcher reports below */ }
  const pass = child.status === 0 && report?.status === 'PASS' && report.inputExited === true;
  if (pass) {
    const saved = JSON.parse(readFileSync(join(runDir, 'appData/lolPing/settings.json'), 'utf8'));
    if (saved.quickActions?.bindings?.omw?.name !== 'Final saved website' || saved.quickActions.bindings.missing) {
      console.log(JSON.stringify({ status: 'FAIL', stage: 'persistedSettings' })); process.exit(1);
    }
    if (process.argv.includes('--latency')) {
      const { releaseToUrlRequestMs, ...summary } = report;
      console.log(JSON.stringify({ ...summary, samples: releaseToUrlRequestMs.length,
        report: join(runDir, 'report.json'), settingsPersistedAfterQuit: true }));
    } else console.log(JSON.stringify({ ...report, settingsPersistedAfterQuit: true }));
  } else console.log(JSON.stringify({ status: 'FAIL', stage: report?.stage ?? 'launcher',
    code: child.error?.code ?? report?.reason ?? 'entryPointFailed', inputExited: report?.inputExited,
    exitCode: child.status }));
  process.exit(pass ? 0 : 1);
} else {
  const abort = error => {
    console.log(JSON.stringify({ status: 'FAIL', stage: 'unhandled', reason: error?.message ?? String(error) }));
    require('electron').app.exit(1);
  };
  process.on('uncaughtException', abort);
  process.on('unhandledRejection', abort);
  run();
}

function run() {
  const { app, BrowserWindow, ipcMain, session, shell, dialog } = require('electron');
  const cp = require('node:child_process');
  const { createInterface } = require('node:readline');
  const { injectOwnedGesture } = require('./ping-actions-input-client.cjs');
  const { DEFAULT_SETTINGS } = require('../src/shared/settings.ts');
  const { ALL_PINGS } = require('../src/shared/pings.ts');
  const { OVERLAY_PINGED, OVERLAY_QUICK_ACTION } = require('../src/shared/ipc.ts');
  const root = process.env.LOLPING_APP_SMOKE_ROOT;
  const runDir = process.env.LOLPING_APP_SMOKE_RUN;
  if (!root || !runDir) throw new Error('launcherRequired');
  const appData = join(runDir, 'appData');
  const settingsDir = join(appData, 'lolPing');
  mkdirSync(settingsDir, { recursive: true });
  mkdirSync(join(runDir, 'profile'), { recursive: true });
  writeFileSync(join(settingsDir, 'settings.json'), JSON.stringify({ ...DEFAULT_SETTINGS,
    displayName: 'App fixture', language: 'en', muted: true, tickSound: false,
    allowInternet: false, rejoinRoom: false, lastRoomCode: '', launchAtStartup: false }));
  app.setAppPath(root);
  app.setPath('appData', appData);
  app.setPath('userData', join(runDir, 'profile'));
  app.commandLine.appendSwitch('disable-background-networking');
  const realSpawn = cp.spawn;
  const urls = [], hookEvents = [], wheelPings = [], nativeJobs = [], systemJobs = [], inputChildren = [], scenarios = [], cancellationMs = [];
  let unexpectedNativeJobs = 0;
  const releaseToUrlRequestMs = [];
  let latencySummary = null;
  let measuringLatency = false, releasedAt = null, releaseConsumed = true;
  let externalRequests = 0, mainFetches = 0, programLaunches = 0, activationClicks = 0, dialogCalls = 0;
  let syntheticAiFetches = 0, syntheticAiAborts = 0, allowSyntheticAi = false;
  let settingsWindow, controller;
  let stage = 'startup';
  let outcome = 'FAIL';
  let reason = 'unfinished';
  let shuttingDown = false;
  const check = (condition, why) => { if (!condition) throw new Error(why); };
  const report = () => writeFileSync(join(runDir, 'report.json'), JSON.stringify({ status: outcome, stage, reason,
    fullBuiltMain: true, realSettingsPreloadAndIpc: true, realSettingsStore: true, realInputHelper: true,
    syntheticHelperEvents: false, osInjectedInput: true, hardwareMouseVerified: false,
    browserOpenStubbed: true, pickerDialogStubbed: true, nativeActivationChildStubbed: true,
    desktopEffectsVerified: false, inputExited: inputChildren.length === 1 && inputChildren.every(child => child.exitCode !== null || child.signalCode !== null),
    scenarios, wheelPings: wheelPings.length, recordedUrls: urls.length, nativeJobs: nativeJobs.length,
    nativeSystemJobs: systemJobs.length, nativeSystemBoundaryStubbed: true, unexpectedNativeJobs,
    programLaunches, cancellationMs, releaseToUrlRequestMs, latencySummary, fixtureActivationClicks: activationClicks,
    syntheticAiFetches, syntheticAiAborts, mainFetches, externalRequests }));
  const wait = async (condition, why) => {
    const deadline = Date.now() + 8000;
    while (Date.now() < deadline) {
      let timer;
      try {
        const ready = await Promise.race([
          Promise.resolve().then(condition),
          new Promise((_done, reject) => { timer = setTimeout(() => reject(new Error(why)), Math.max(1, deadline - Date.now())); }),
        ]);
        if (ready) return;
      } finally { clearTimeout(timer); }
      await new Promise(done => setTimeout(done, 20));
    }
    throw new Error(why);
  };
  const checkpoint = step => writeFileSync(join(runDir, 'checkpoint.json'), JSON.stringify({ step, stage,
    dialogCalls, nativeJobs: nativeJobs.length, nativeWaiting: nativeJobs.at(-1)?.waiting }));
  const pass = name => { scenarios.push(name); report(); checkpoint(name); console.log(JSON.stringify({ progress: name })); };
  const recordOpen = async url => {
    if (measuringLatency) {
      check(releasedAt !== null && !releaseConsumed, 'latencyRequestWithoutNewRelease');
      releaseToUrlRequestMs.push(performance.now() - releasedAt);
      releaseConsumed = true;
    }
    urls.push(url);
  };
  shell.openExternal = recordOpen;
  check(shell.openExternal === recordOpen, 'browserBoundaryNotControlled');
  process.env.LOLPING_AI_ALLOW_LOCALHOST = '1';
  globalThis.fetch = async (url, init) => {
    if (!allowSyntheticAi || url !== 'http://127.0.0.1:43123/v1/chat/completions') {
      mainFetches++; throw new Error('unexpectedMainFetch');
    }
    check(init?.signal && new Headers(init.headers).get('authorization') === 'Bearer fixture-only-not-a-real-key', 'syntheticAiBoundaryInvalid');
    syntheticAiFetches++;
    return new Response(new ReadableStream({ start(stream) {
      stream.enqueue(new TextEncoder().encode('data: {"choices":[{"delta":{"content":"Synthetic stream"}}]}\n\n'));
      init.signal.addEventListener('abort', () => {
        syntheticAiAborts++;
        stream.error(new DOMException('Synthetic cancellation', 'AbortError'));
      }, { once: true });
    } }), { headers: { 'Content-Type': 'text/event-stream' } });
  };
  const selectFixture = async () => { dialogCalls++; checkpoint('pickerReturned'); return { canceled: false, filePaths: [process.execPath] }; };
  dialog.showOpenDialog = selectFixture;
  check(dialog.showOpenDialog === selectFixture, 'pickerBoundaryNotControlled');
  const fakeNative = join(runDir, 'native-job.cjs');
  writeFileSync(fakeNative, `let text='';process.stdin.on('data',part=>text+=part);process.stdin.on('end',()=>{
const request=JSON.parse(text);
if(request.type==='activate'){process.send({waiting:true});return;}
const validFlush=request.type==='flushComposition'&&Object.keys(request).length===1;
const validStyle=request.type==='styleWindow'&&Object.keys(request).length===3
&&/^[1-9][0-9]*$/.test(request.hwnd)&&request.ownerPid===String(process.ppid);
if(!validFlush&&!validStyle)process.exit(1);
process.send({system:request.type});process.stdout.write(JSON.stringify({type:'result',status:validFlush?'compositionFlushed':'frameStyled'})+'\\n');
process.disconnect();});
process.on('message',message=>{if(message==='probe')process.send({probed:true});});`);
  cp.spawn = (command, args, options) => {
    const file = basename(command).toLowerCase();
    if (file === 'hook-helper.exe') {
      const child = realSpawn(command, args, options);
      inputChildren.push(child);
      // Registered before InputBridge's reader, so the timestamp precedes Main's release handling.
      createInterface({ input: child.stdout }).on('line', line => {
        const receivedAt = performance.now();
        try {
          const event = JSON.parse(line);
          if (event.type === 'wheelRelease') { releasedAt = receivedAt; releaseConsumed = false; }
          hookEvents.push(event);
        } catch {}
      });
      child.on('exit', () => { if (shuttingDown) report(); });
      return child;
    }
    if (file === 'desktop-helper.exe') {
      const child = realSpawn(process.execPath, [fakeNative], { ...options,
        env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }, stdio: ['pipe', 'pipe', 'pipe', 'ipc'] });
      const job = { child, started: performance.now(), waiting: false, ended: false };
      child.on('message', message => {
        if (message?.waiting) { job.waiting = true; nativeJobs.push(job); checkpoint('nativeWaiting'); }
        if (message?.system) { job.system = true; systemJobs.push(job); }
        if (message?.probed) job.probed = true;
      });
      child.on('close', () => {
        job.ended = true;
        if (!job.waiting && !job.system) unexpectedNativeJobs++;
        checkpoint('nativeEnded');
      });
      return child;
    }
    programLaunches++;
    throw new Error('unexpectedProgramLaunch');
  };
  ipcMain.on(OVERLAY_PINGED, (event, ping) => {
    if (event.sender.getURL().includes('/overlay/index.html')) wheelPings.push(ping.id);
  });
  app.on('before-quit', () => { shuttingDown = true; report(); });
  require(join(root, 'out/main/index.js'));

  app.whenReady().then(async () => {
    try {
      session.defaultSession.webRequest.onBeforeRequest({ urls: ['http://*/*', 'https://*/*'] }, (_details, callback) => {
        externalRequests++; callback({ cancel: true });
      });
      const findSettings = async () => {
        await wait(() => {
          settingsWindow = BrowserWindow.getAllWindows().find(win => win.webContents.getURL().includes('/settings/index.html'));
          return Boolean(settingsWindow);
        }, 'settingsWindowMissing');
        settingsWindow.webContents.setBackgroundThrottling(false);
        await wait(() => settingsWindow.webContents.executeJavaScript('typeof window.settingsApi?.getStatus === "function"').catch(() => false), 'settingsPreloadMissing');
        await wait(() => settingsWindow.webContents.executeJavaScript('window.settingsApi.getStatus().then(s=>s.helper==="running")'), 'inputHelperNotRunning');
      };
      await findSettings();
      const invoke = (method, ...args) => {
        const target = settingsWindow.webContents;
        let timer;
        return Promise.race([
          Promise.resolve().then(() => target.executeJavaScript(`window.settingsApi[${JSON.stringify(method)}](...${JSON.stringify(args)})`)),
          new Promise((_done, reject) => { timer = setTimeout(() => reject(new Error(`settingsApiTimeout:${method}`)), 8000); }),
        ]).finally(() => clearTimeout(timer));
      };
      const current = () => invoke('getSettings');
      const set = async patch => { const result = await invoke('setSettings', patch); check(result.ok, 'settingsPatchRejected'); return result.settings; };
      const saveWeb = async (name, url = 'https://fixture.invalid/') => {
        const result = await invoke('saveQuickAction', 'omw', { enabled: true, name, target: { kind: 'web', url } });
        check(result.ok, 'webSaveRejected');
      };
      const reopen = async () => { app.emit('second-instance'); await findSettings(); };
      const closeSettings = async () => {
        const closing = settingsWindow;
        checkpoint('settingsCloseRequested');
        closing.close();
        await wait(() => closing.isDestroyed(), 'settingsCloseDidNotFinish');
        checkpoint('settingsClosed');
      };
      const initial = await current();
      check(!initial.features.quickActions && Object.keys(initial.quickActions.bindings).length === 0, 'defaultsNotOptIn');
      check(app.getPath('appData') === appData && urls.length === 0, 'isolationOrDefaultFailure');
      check(nativeJobs.length === 0, 'idleDesktopHelperSpawned');
      pass('fullEntryPointStartupAndOptIn');

      stage = 'actualSettingsSecurity';
      const draft = { enabled: true, name: 'Invalid', target: { kind: 'web', url: 'https://fixture.invalid/' } };
      check((await invoke('saveQuickAction', 'missing', draft)).code === 'invalidBinding', 'questionMarkAccepted');
      check((await invoke('saveQuickAction', 'omw', { ...draft, target: { kind: 'app', exePath: process.execPath } })).code === 'invalidProgram', 'rawPathAccepted');
      check((await invoke('saveQuickAction', 'omw', { ...draft, target: { kind: 'app', programToken: 'forged' } })).code === 'programSelectionExpired', 'forgedTokenAccepted');
      await set({ quickActions: { version: 1, bindings: { omw: draft } } });
      check(!(await current()).quickActions.bindings.omw, 'genericPatchChangedBindings');
      pass('realIpcRejectsReservedPathAndTokenWrites');

      stage = 'actualFluentSave';
      const index = ALL_PINGS.findIndex(ping => ping.id === 'omw');
      await settingsWindow.webContents.executeJavaScript(`document.querySelectorAll('.qaTile')[${index}].click()`);
      await wait(() => settingsWindow.webContents.executeJavaScript('!!document.querySelector("[data-quick-action=omw]")'), 'fluentEditorMissing');
      const fill = async (index, value) => {
        await settingsWindow.webContents.executeJavaScript(`(()=>{const input=document.querySelectorAll('.qaEditor input:not([type="checkbox"])')[${index}];input.focus();input.select()})()`);
        await settingsWindow.webContents.insertText(value);
      };
      await fill(0, 'Saved through Fluent');
      await fill(1, 'https://fixture.invalid/');
      await settingsWindow.webContents.executeJavaScript(`document.querySelector('.qaButtons button').click()`);
      await wait(async () => (await current()).quickActions.bindings.omw?.name === 'Saved through Fluent', 'fluentSaveDidNotReachStore');
      check((await invoke('testQuickAction', 'omw')).ok && urls.length === 1, 'explicitGlobalOffTestFailed');
      pass('fluentSaveAndExplicitSavedTest');

      const preload = join(runDir, 'probe.cjs');
      writeFileSync(preload, `const{contextBridge,ipcRenderer}=require('electron');contextBridge.exposeInMainWorld('probe',{
save:(id,draft)=>ipcRenderer.invoke('quickAction:save',id,draft),test:id=>ipcRenderer.invoke('quickAction:test',id),
report:()=>ipcRenderer.send(${JSON.stringify(OVERLAY_QUICK_ACTION)},{sessionId:999,id:'omw'})});`);
      const display = require('electron').screen.getPrimaryDisplay();
      controller = new BrowserWindow({ x: display.workArea.x + 40, y: display.workArea.y + 40, width: 820, height: 480,
        webPreferences: { preload, sandbox: true, contextIsolation: true, nodeIntegration: false, backgroundThrottling: false } });
      controller.removeMenu();
      await controller.loadURL('data:text/html,<title>lolPing isolated full-app fixture</title><p>Controlled input area</p>'
        + '<script>window.counts={down:0,up:0};onmousedown=e=>{e.preventDefault();counts.down++};'
        + 'onmouseup=e=>{e.preventDefault();counts.up++};ondragstart=oncontextmenu=e=>e.preventDefault()</script>');
      check((await controller.webContents.executeJavaScript(`window.probe.save('omw',${JSON.stringify(draft)})`)).code === 'unauthorized', 'foreignSaveAccepted');
      check((await controller.webContents.executeJavaScript('window.probe.test("omw")')).code === 'unauthorized', 'foreignTestAccepted');
      await controller.webContents.executeJavaScript('window.probe.report()');
      pass('foreignWindowCannotSaveTestOrReport');
      const pointer = () => controller.webContents.executeJavaScript('({...window.counts})');
      const gesture = async (name, mode, expectedPing, urlDelta, passThrough = false, record = true) => {
        stage = name;
        const before = { urls: urls.length, pings: wheelPings.length, events: hookEvents.length, pointer: await pointer() };
        const result = await injectOwnedGesture({ root, window: controller, scaleFactor: display.scaleFactor,
          trigger: 'alt', mode, wait,
          onArmed: async activationClick => {
            if (activationClick) await wait(async () => { const p = await pointer(); return p.down > before.pointer.down && p.up > before.pointer.up; }, 'activationClickNotObserved');
            before.pointer = await pointer();
          },
          onHeld: () => passThrough
            ? wait(async () => (await pointer()).down > before.pointer.down, 'passThroughDownMissing')
            : wait(() => hookEvents.slice(before.events).some(event => event.type === 'wheelOpen'), 'realHookDidNotOpen'),
          onReleased: () => passThrough
            ? wait(async () => (await pointer()).up > before.pointer.up, 'passThroughUpMissing')
            : wait(() => hookEvents.slice(before.events).some(event => event.type === 'wheelRelease'), 'realHookDidNotRelease'),
        });
        if (result.activationClick) activationClicks++;
        if (expectedPing) await wait(() => wheelPings.length > before.pings, 'originalWheelPingMissing');
        if (urlDelta) await wait(() => urls.length >= before.urls + urlDelta, 'mainDidNotDispatch');
        if (passThrough) await wait(async () => (await pointer()).up > before.pointer.up, 'passThroughUpMissing');
        check(wheelPings.length === before.pings + (expectedPing ? 1 : 0) && urls.length === before.urls + urlDelta, 'unexpectedPingOrAction');
        if (expectedPing) check(wheelPings.at(-1) === expectedPing, `wrongIconSelected:${wheelPings.at(-1)}`);
        if (record) pass(name);
      };
      await gesture('featureOffPreservesPing', 'right', 'omw', 0);
      await set({ features: { ...(await current()).features, quickActions: true } });
      await gesture('fullMainRealHookDispatch', 'right', 'omw', 1);
      if (process.env.LOLPING_APP_SMOKE_LATENCY === '1') {
        measuringLatency = true;
        for (let index = 0; index < 100; index++) {
          await gesture(`latencySample${index + 1}`, 'right', 'omw', 1, false, false);
          check(releaseToUrlRequestMs.length === index + 1, 'latencySampleMissing');
          if ((index + 1) % 20 === 0) {
            report(); checkpoint(`latencySamples${index + 1}`);
            console.log(JSON.stringify({ progress: 'latencySamples', count: index + 1 }));
          }
        }
        measuringLatency = false;
        check(mainFetches === 0 && externalRequests === 0 && nativeJobs.length === 0 && programLaunches === 0, 'latencyExternalEffects');
        await saveWeb('Final saved website');
        const sorted = [...releaseToUrlRequestMs].sort((a, b) => a - b);
        latencySummary = { samples: sorted.length,
          p50Ms: sorted[49], p95Ms: sorted[94], maxMs: sorted[99],
          percentileMethod: 'nearest rank',
          scope: 'real hook stdout receipt in Main to controlled shell.openExternal request' };
        console.log(JSON.stringify({ progress: 'latencyComplete', ...latencySummary }));
        pass('hundredRealHookReleaseToUrlRequests');
        outcome = 'PASS'; reason = null; stage = 'gracefulQuit';
        return;
      }
      const wheel = [...(await current()).wheel];
      [wheel[2], wheel[6]] = [wheel[6], wheel[2]];
      await set({ wheel });
      await gesture('savedActionFollowsIcon', 'left', 'omw', 1);
      await gesture('questionMarkWithAiOff', 'right', 'missing', 0);
      check(!BrowserWindow.getAllWindows().some(win => win.webContents.getURL().includes('/explain/')), 'aiOffOpenedCard');
      await set({ features: { ...(await current()).features, aiExplain: true } });
      await gesture('questionMarkWithAiOn', 'right', 'missing', 0);
      await wait(() => BrowserWindow.getAllWindows().some(win => win.webContents.getURL().includes('/explain/')), 'originalAiCardMissing');
      await set({ aiBaseUrl: 'http://127.0.0.1:43123/v1', aiModel: 'fixture-model' });
      check((await invoke('setAiKey', 'fixture-only-not-a-real-key')).ok, 'syntheticKeySetupFailed');
      const questionWindow = BrowserWindow.getAllWindows().find(win => win.webContents.getURL().includes('/explain/'));
      await wait(() => questionWindow.webContents.executeJavaScript('typeof window.explainApi?.ask === "function"'), 'explainPreloadMissing');
      check((await invoke('getAiStatus')).configured, 'syntheticAiNotConfigured');
      await questionWindow.webContents.executeJavaScript('window.__masterTestEvents=[];window.explainApi.on(e=>window.__masterTestEvents.push({kind:e.kind,code:e.code}));true');
      allowSyntheticAi = true;
      const pendingQuestion = questionWindow.webContents.executeJavaScript('window.explainApi.ask("Fixture stream")').catch(() => null);
      await wait(async () => {
        const errors = await questionWindow.webContents.executeJavaScript('window.__masterTestEvents.filter(e=>e.kind==="error")');
        check(!errors.length, `syntheticStreamRejected:${errors[0]?.code}`);
        return syntheticAiFetches === 1;
      }, 'syntheticStreamDidNotStart');
      stage = 'masterOffClosesAiCard';
      await set({ features: { ...(await current()).features, quickActions: false } });
      await wait(() => !BrowserWindow.getAllWindows().some(win => win.webContents.getURL().includes('/explain/')), 'masterOffKeptAiCard');
      check((await current()).features.aiExplain === true, 'masterOffChangedAiPreference');
      await wait(() => syntheticAiAborts === 1, 'masterOffDidNotCancelAiStream');
      await pendingQuestion;
      allowSyntheticAi = false;
      check((await current()).aiBaseUrl === 'http://127.0.0.1:43123/v1'
        && (await current()).aiModel === 'fixture-model' && (await invoke('getAiStatus')).hasKey, 'masterOffLostAiConfiguration');
      check(!(await invoke('getAiStatus')).configured, 'masterOffStillAllowsAiRequests');
      pass('masterOffClosesAiCard');
      await gesture('questionMarkWithMasterOff', 'right', 'missing', 0);
      check(!BrowserWindow.getAllWindows().some(win => win.webContents.getURL().includes('/explain/')), 'masterOffOpenedAiCard');
      await set({ features: { ...(await current()).features, quickActions: true } });
      await gesture('questionMarkAfterMasterReenabled', 'right', 'missing', 0);
      await wait(() => BrowserWindow.getAllWindows().some(win => win.webContents.getURL().includes('/explain/')), 'masterOnDidNotRestoreAi');
      check((await invoke('getAiStatus')).configured, 'masterOnDidNotRestoreAiConfiguration');
      await set({ features: { ...(await current()).features, aiExplain: false }, wheel: DEFAULT_SETTINGS.wheel });
      await wait(() => !BrowserWindow.getAllWindows().some(win => win.webContents.getURL().includes('/explain/')), 'aiSwitchOffKeptCard');
      pass('aiSwitchStillClosesCard');
      await invoke('setEnabled', false);
      await gesture('actualPausePassThrough', 'right', null, 0, true);
      await invoke('setEnabled', true);
      await gesture('pauseRecovery', 'right', 'omw', 1);
      await invoke('setCapturing', true);
      await gesture('actualCapturePassThrough', 'right', null, 0, true);
      await closeSettings();
      await reopen();
      await gesture('settingsCloseClearsCapture', 'right', 'omw', 1);

      const saveApp = async () => {
        checkpoint('pickerInvoked');
        const selection = await invoke('pickQuickActionProgram');
        checkpoint('pickerCompleted');
        check(selection?.token, 'realPickerCredentialMissing');
        const result = await invoke('saveQuickAction', 'omw', { enabled: true, name: 'Controlled app', target: { kind: 'app', programToken: selection.token } });
        check(result.ok, 'approvedProgramSaveFailed');
        checkpoint('appBindingSaved');
      };
      const pendingNative = async () => {
        const count = nativeJobs.length;
        let replied = false;
        let earlyReply;
        const pending = invoke('testQuickAction', 'omw').catch(() => null);
        void pending.then(reply => { replied = true; earlyReply = reply; });
        await wait(() => replied || nativeJobs.length === count + 1 && nativeJobs.at(-1).waiting, 'nativeJobDidNotStart');
        check(nativeJobs.length === count + 1 && nativeJobs.at(-1).waiting,
          `nativeJobStoppedEarly:${earlyReply?.code ?? 'noRendererReply'}`);
        const job = nativeJobs.at(-1);
        check(performance.now() - job.started < 1200, 'nativeFixtureTooSlowForCancelAssertion');
        return { pending, job };
      };
      stage = 'settingsCloseCancelsNative';
      check(nativeJobs.length === 0 && unexpectedNativeJobs === 0, 'nonAppActionSpawnedNativeActivation');
      await saveApp();
      let active = await pendingNative();
      await invoke('setCapturing', false);
      try { active.job.child.send('probe', error => { if (error) active.job.probeError = true; }); }
      catch { active.job.probeError = true; }
      await wait(() => active.job.ended || active.job.probed || active.job.probeError, 'nativeProbeMissing');
      check(active.job.probed && !active.job.ended && !active.job.probeError, 'duplicateCaptureNotificationCanceledAction');
      pass('duplicateCaptureFalseKeepsNativeJob');
      let canceledAt = performance.now();
      await closeSettings();
      await wait(() => active.job.ended, 'closedSettingsLeftNativeRunning');
      check(performance.now() - canceledAt < 1200, 'closeDidNotCancelBeforeNativeTimeout');
      cancellationMs.push({ source: 'settingsClose', ms: Math.round((performance.now() - canceledAt) * 10) / 10 });
      // The renderer was destroyed; its executeJavaScript result need not settle. Observe Main's child instead.
      await reopen();
      pass(stage);
      stage = 'pauseCancelsNative';
      active = await pendingNative();
      canceledAt = performance.now();
      await invoke('setEnabled', false);
      await wait(() => active.job.ended, 'pauseLeftNativeRunning');
      check(performance.now() - canceledAt < 1200 && (await active.pending)?.code === 'disabled', 'pauseCancellationFailed');
      cancellationMs.push({ source: 'pause', ms: Math.round((performance.now() - canceledAt) * 10) / 10 });
      await invoke('setEnabled', true);
      pass(stage);
      stage = 'settingsChangeCancelsNative';
      active = await pendingNative();
      canceledAt = performance.now();
      await saveWeb('Final saved website');
      await wait(() => active.job.ended, 'settingsChangeLeftNativeRunning');
      check(performance.now() - canceledAt < 1200 && (await active.pending)?.code === 'disabled', 'settingsCancellationFailed');
      cancellationMs.push({ source: 'settingsChange', ms: Math.round((performance.now() - canceledAt) * 10) / 10 });
      check(programLaunches === 0 && inputChildren.length === 1 && nativeJobs.length === 3
        && nativeJobs.every(job => job.ended), 'cancellationRestartedProgramOrInput');
      pass(stage);
      await gesture('inputSurvivesNativeCancellation', 'right', 'omw', 1);
      check(mainFetches === 0 && externalRequests === 0, 'unexpectedExternalRequest');
      outcome = 'PASS'; reason = null; stage = 'gracefulQuit';
    } catch (error) {
      outcome = 'FAIL'; reason = error.message;
      console.log(JSON.stringify({ status: 'FAIL', stage, reason }));
    } finally {
      report();
      app.quit();
    }
  });
}
