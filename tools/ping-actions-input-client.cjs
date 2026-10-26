/* Shared test-only client for the guarded Windows input driver. No production import. */
const { join } = require('node:path');
const { mkdirSync, readFileSync } = require('node:fs');
const { createHash } = require('node:crypto');
const { spawn } = require('node:child_process');
const { createInterface } = require('node:readline');

exports.injectOwnedGesture = async ({ root, window, scaleFactor, trigger, mode, wait,
  onHeld, onArmed = async () => {}, onReleased = async () => {} }) => {
  const script = join(root, 'tools/ping-actions-hook-input.ps1');
  const hash = createHash('sha256').update(readFileSync(script)).digest('hex').slice(0, 16);
  const cache = join(root, 'out/ping-actions-input-cache');
  mkdirSync(cache, { recursive: true });
  window.setAlwaysOnTop(true, 'pop-up-menu');
  window.moveTop(); window.focus();
  await wait(() => window.isFocused(), 'ownedFixtureNotFocused');
  const handle = window.getNativeWindowHandle().readBigUInt64LE().toString();
  return new Promise((done, reject) => {
    const child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-WindowStyle', 'Hidden',
      '-File', script, '-DriverAssembly', join(cache, `input-${hash}.dll`), '-WindowHandle', handle,
      '-OwnerPid', String(process.pid), '-Trigger', trigger, '-Mode', mode,
      '-Distance', String(Math.round(160 * scaleFactor))], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    let error = '', failed = false, released = false, restored = false, activationClick = false;
    let routing = Promise.resolve();
    let killTimer;
    const guards = [];
    const release = () => { if (!released) { released = true; child.stdin.write('release\n'); } };
    const restore = () => { if (!restored) { restored = true; child.stdin.end('restore\n'); } };
    const fail = reason => { failed = true; error = reason.message; release(); };
    const timeout = setTimeout(() => {
      failed = true; error = 'inputDriverTimeout'; release();
      killTimer = setTimeout(() => child.kill(), 6000);
    }, 15000);
    child.stdin.on('error', () => { failed = true; error = 'driverInputPipeClosed'; });
    child.stderr.on('data', part => { error = (error + part.toString()).slice(-1200); });
    child.on('error', reject);
    createInterface({ input: child.stdout }).on('line', line => {
      let report;
      try { report = JSON.parse(line); } catch { return; }
      if (report.stage === 'ready') {
        routing = Promise.resolve().then(async () => {
          window.moveTop(); window.focus();
          await wait(() => !window.isMinimized() && window.isFocused(), 'fixtureFocusUnavailable');
          child.stdin.write('start\n');
        }).catch(fail);
      } else if (report.stage === 'armed') {
        activationClick = report.activationClick === true;
        routing = Promise.resolve().then(() => onArmed(activationClick))
          .then(() => child.stdin.write('press\n')).catch(fail);
      } else if (report.stage === 'held') {
        routing = Promise.resolve().then(onHeld).then(release).catch(fail);
      } else if (report.stage === 'released') {
        routing = Promise.resolve().then(() => failed ? undefined : onReleased()).then(restore)
          .catch(reason => { failed = true; error = reason.message; restore(); });
      } else if (report.stage === 'error') {
        failed = true; error = String(report.code);
      } else if (report.stage === 'surfaceGuard' || report.stage === 'windowGuard') guards.push(report);
    });
    child.on('close', async status => {
      clearTimeout(timeout); clearTimeout(killTimer);
      await routing;
      if (status !== 0 || failed) reject(new Error(`driverFailed:${JSON.stringify(guards)}${error}`));
      else done({ activationClick });
    });
  });
};
