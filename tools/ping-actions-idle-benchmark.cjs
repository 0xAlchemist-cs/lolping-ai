/* Same-machine, actual built Main comparison; no production instrumentation or dependency install. */
const { join, resolve, basename } = require('node:path');
const { mkdirSync, mkdtempSync, readFileSync, writeFileSync } = require('node:fs');
const { spawnSync } = require('node:child_process');
const median = values => {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return (sorted[Math.floor((sorted.length - 1) / 2)] + sorted[Math.floor(sorted.length / 2)]) / 2;
};

if (!process.versions.electron) {
  if (process.platform !== 'win32') { console.log('SKIP idle benchmark: Windows only'); process.exit(0); }
  const root = resolve(__dirname, '..');
  const enabledOnly = process.argv.includes('--enabled-only');
  const baseline = enabledOnly ? root : resolve(process.argv[2] || '');
  if ((!enabledOnly && !process.argv[2]) || !require('node:fs').existsSync(join(baseline, 'out/main/index.js'))) {
    throw new Error('Pass a built baseline export, or --enabled-only for a configured-current idle check');
  }
  const out = join(root, 'out/p3-performance');
  mkdirSync(out, { recursive: true });
  const batch = mkdtempSync(join(out, 'idle-'));
  const entry = join(out, 'idle-main.cjs');
  require('esbuild').buildSync({ entryPoints: [__filename], outfile: entry, bundle: true,
    platform: 'node', format: 'cjs', external: ['electron', 'esbuild'], logLevel: 'silent' });
  const reports = [];
  const variants = enabledOnly ? ['current-enabled'] : ['baseline', 'current', 'current', 'baseline'];
  for (const [index, variant] of variants.entries()) {
    const runDir = join(batch, `${index + 1}-${variant}`);
    mkdirSync(runDir);
    const env = { ...process.env };
    for (const key of Object.keys(env)) if (key.startsWith('LOLPING_')) delete env[key];
    delete env.ELECTRON_RUN_AS_NODE; delete env.ELECTRON_RENDERER_URL;
    env.LOLPING_IDLE_ROOT = variant === 'baseline' ? baseline : root;
    env.LOLPING_IDLE_TOOLS = root;
    env.LOLPING_IDLE_RUN = runDir;
    env.LOLPING_IDLE_ENABLED = variant === 'current-enabled' ? '1' : '0';
    const child = spawnSync(require('electron'), [entry, '--hidden', '--user-data-dir=' + join(runDir, 'profile')],
      { env, cwd: env.LOLPING_IDLE_ROOT, windowsHide: true, encoding: 'utf8', timeout: 45000 });
    if (child.stdout) process.stdout.write(child.stdout);
    if (child.stderr) process.stderr.write(child.stderr);
    const report = JSON.parse(readFileSync(join(runDir, 'report.json'), 'utf8'));
    if (child.status !== 0 || report.status !== 'PASS' || !report.inputExited) throw new Error('idleRunFailed');
    reports.push({ variant, ...report });
  }
  const summary = [...new Set(variants)].map(variant => {
    const runs = reports.filter(report => report.variant === variant);
    const samples = runs.flatMap(report => report.samples);
    const idle = samples.filter(sample => sample.noInput && sample.stableProcesses);
    return { variant, intervals: samples.length, acceptedIdleIntervals: idle.length,
      medianCpuOneCorePercent: median(idle.map(sample => sample.cpuOneCorePercent)),
      meanCpuOneCorePercent: idle.length ? idle.reduce((total, sample) => total + sample.cpuOneCorePercent, 0) / idle.length : null,
      medianWorkingSetMiB: median(idle.map(sample => sample.workingSetMiB)),
      medianPrivateCommitMiB: median(idle.map(sample => sample.privateCommitMiB)),
      logicalProcessors: runs[0].logicalProcessors, inputHelpers: runs.map(run => run.inputHelpers),
      desktopHelpers: runs.map(run => run.desktopHelpers) };
  });
  const status = summary.every(row => row.acceptedIdleIntervals >= 10) ? 'PASS' : 'INCOMPLETE';
  writeFileSync(join(batch, 'summary.json'), JSON.stringify({ status, order: enabledOnly ? 'current-enabled' : 'ABBA', reports, summary }, null, 2));
  console.log(JSON.stringify({ status, report: join(batch, 'summary.json'), summary }));
  if (status !== 'PASS') process.exitCode = 1;
} else {
  process.on('uncaughtException', fail);
  process.on('unhandledRejection', fail);
  void run();
}

function fail(error) {
  console.log(JSON.stringify({ status: 'FAIL', reason: error?.message ?? String(error) }));
  require('electron').app.exit(1);
}

async function run() {
  const { app, BrowserWindow, session, shell } = require('electron');
  const cp = require('node:child_process');
  const { createInterface } = require('node:readline');
  const { DEFAULT_SETTINGS } = require('../src/shared/settings.ts');
  const root = process.env.LOLPING_IDLE_ROOT;
  const toolsRoot = process.env.LOLPING_IDLE_TOOLS;
  const runDir = process.env.LOLPING_IDLE_RUN;
  if (!root || !toolsRoot || !runDir) throw new Error('launcherRequired');
  const settingsDir = join(runDir, 'appData/lolPing');
  const quickActionsEnabled = process.env.LOLPING_IDLE_ENABLED === '1';
  mkdirSync(settingsDir, { recursive: true });
  mkdirSync(join(runDir, 'profile'), { recursive: true });
  writeFileSync(join(settingsDir, 'settings.json'), JSON.stringify({ ...DEFAULT_SETTINGS,
    language: 'en', muted: true, tickSound: false, allowInternet: false, rejoinRoom: false,
    lastRoomCode: '', launchAtStartup: false, autoUpdateCheck: false,
    ...(quickActionsEnabled ? { features: { ...DEFAULT_SETTINGS.features, quickActions: true },
      quickActions: { version: 1, bindings: { omw: { enabled: true, name: 'Idle fixture',
        target: { kind: 'web', url: 'https://fixture.invalid/' } } } } } : {}) }));
  app.setAppPath(root);
  app.setPath('appData', join(runDir, 'appData'));
  app.setPath('userData', join(runDir, 'profile'));
  app.commandLine.appendSwitch('disable-background-networking');
  const realSpawn = cp.spawn;
  const inputChildren = [];
  let helperReady = false, externalRequests = 0, desktopHelpers = 0;
  const denied = async () => { externalRequests++; throw new Error('unexpectedExternalRequest'); };
  globalThis.fetch = denied;
  shell.openExternal = denied;
  if (shell.openExternal !== denied) throw new Error('browserBoundaryNotControlled');
  cp.spawn = (command, args, options) => {
    if (basename(command).toLowerCase() !== 'hook-helper.exe') {
      if (basename(command).toLowerCase() === 'desktop-helper.exe') desktopHelpers++;
      throw new Error('unexpectedIdleChild');
    }
    const child = realSpawn(command, args, options);
    inputChildren.push(child);
    createInterface({ input: child.stdout }).on('line', line => {
      try { if (JSON.parse(line).type === 'ready') helperReady = true; } catch {}
    });
    return child;
  };
  const report = { status: 'FAIL', samples: [], snapshots: [], inputExited: false,
    environment: { node: process.versions.node, electron: process.versions.electron,
      windows: require('node:os').release(), arch: process.arch, cpuModel: require('node:os').cpus()[0]?.model } };
  const save = () => writeFileSync(join(runDir, 'report.json'), JSON.stringify(report));
  app.on('before-quit', () => {
    for (const child of inputChildren) child.once('exit', () => {
      report.inputExited = inputChildren.every(input => input.exitCode !== null || input.signalCode !== null);
      save();
    });
  });
  require(join(root, 'out/main/index.js'));
  let sampler;
  try {
    await app.whenReady();
    session.defaultSession.webRequest.onBeforeRequest({ urls: ['http://*/*', 'https://*/*'] }, (_details, callback) => {
      externalRequests++; callback({ cancel: true });
    });
    const waitUntil = async condition => {
      const until = performance.now() + 8000;
      while (!condition()) {
        if (performance.now() > until) throw new Error('startupNotReady');
        await new Promise(done => setTimeout(done, 20));
      }
    };
    await waitUntil(() => helperReady && BrowserWindow.getAllWindows().length > 0
      && BrowserWindow.getAllWindows().every(window => !window.webContents.isLoading()));
    if (BrowserWindow.getAllWindows().some(window => window.webContents.getURL().includes('/settings/'))) {
      throw new Error('settingsMustRemainClosed');
    }
    sampler = realSpawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-WindowStyle', 'Hidden', '-File',
      join(toolsRoot, 'tools/ping-actions-idle-sampler.ps1')], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    let receiver;
    let samplerError = '';
    sampler.stderr.on('data', part => { samplerError = (samplerError + part).slice(-1000); });
    sampler.on('error', error => { if (receiver) receiver.reject(error); });
    sampler.on('exit', code => { if (receiver) receiver.reject(new Error(`samplerExit:${code}:${samplerError}`)); });
    createInterface({ input: sampler.stdout }).on('line', line => {
      if (receiver) { const pending = receiver; receiver = null; try { pending.resolve(JSON.parse(line)); } catch (error) { pending.reject(error); } }
    });
    const sample = () => new Promise((resolveSample, reject) => {
      const timer = setTimeout(() => { receiver = null; reject(new Error('samplerTimeout')); }, 8000);
      receiver = { resolve: value => { clearTimeout(timer); resolveSample(value); },
        reject: error => { clearTimeout(timer); reject(error); } };
      sampler.stdin.write(JSON.stringify({ pids: [...new Set([...app.getAppMetrics().map(metric => metric.pid),
        ...inputChildren.map(child => child.pid)])] }) + '\n');
    });
    await sample();
    await new Promise(done => setTimeout(done, 5000));
    let previous = await sample();
    report.snapshots.push(previous);
    report.logicalProcessors = previous.logicalProcessors;
    for (let index = 0; index < 10; index++) {
      await new Promise(done => setTimeout(done, 1000));
      const next = await sample();
      report.snapshots.push(next);
      const prior = new Map(previous.processes.map(row => [row.pid, row]));
      const stableProcesses = next.processes.length === prior.size
        && next.processes.every(row => prior.get(row.pid)?.started === row.started);
      const cpuMs = stableProcesses ? next.processes.reduce((total, row) => total + row.cpuMs - prior.get(row.pid).cpuMs, 0) : 0;
      report.samples.push({ noInput: next.lastInputTick === previous.lastInputTick && previous.inputAgeMs >= 5000, stableProcesses,
        lastInputTickBefore: previous.lastInputTick, lastInputTickAfter: next.lastInputTick,
        intervalMs: next.elapsedMs - previous.elapsedMs, cpuOneCorePercent: cpuMs / (next.elapsedMs - previous.elapsedMs) * 100,
        workingSetMiB: next.processes.reduce((total, row) => total + row.workingBytes, 0) / 1048576,
        privateCommitMiB: next.processes.reduce((total, row) => total + row.privateBytes, 0) / 1048576,
        processCount: next.processes.length });
      previous = next;
    }
    if (inputChildren.length !== 1 || desktopHelpers !== 0 || externalRequests !== 0) throw new Error('idleInvariantFailed');
    Object.assign(report, { status: 'PASS', quickActionsEnabled, inputHelpers: inputChildren.length, desktopHelpers,
      externalRequests, warmupSeconds: 5, samplingSeconds: 10, processScope: 'Electron getAppMetrics PIDs plus real input helper' });
    console.log(JSON.stringify({ progress: 'idleRunComplete', root, acceptedIdleIntervals: report.samples.filter(row => row.noInput && row.stableProcesses).length }));
  } catch (error) { report.reason = error.message; }
  finally { if (sampler) sampler.stdin.end(); save(); app.quit(); }
}
