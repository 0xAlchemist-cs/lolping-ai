// Actual native DWM requests against a hidden owned window: no input or desktop toggling.
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import assert from 'node:assert/strict';

if (process.platform !== 'win32') {
  console.log('SKIP DWM native checks: Windows only');
  process.exit(0);
}
const root = fileURLToPath(new URL('../', import.meta.url));
const fixture = spawn(join(root, 'build/fixture_app.exe'), ['hidden'], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
const lines = [];
const waiters = [];
const reader = createInterface({ input: fixture.stdout });
reader.on('line', (line) => {
  const index = waiters.findIndex((w) => w.test(line));
  if (index < 0) lines.push(line);
  else { const [w] = waiters.splice(index, 1); clearTimeout(w.timer); w.resolve(line); }
});
fixture.stderr.resume();
const next = (test) => {
  const index = lines.findIndex(test);
  if (index >= 0) return Promise.resolve(lines.splice(index, 1)[0]);
  return new Promise((resolve, reject) => {
    const entry = { test, resolve, timer: setTimeout(() => reject(new Error('fixtureReplyTimeout')), 5000) };
    waiters.push(entry);
  });
};
const request = (value) => new Promise((resolve, reject) => {
  const child = spawn(join(root, 'build/desktop-helper.exe'), [], {
    stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true, shell: false,
    env: { ...process.env, SystemRoot: 'Z:\\untrusted', windir: 'Z:\\untrusted' },
  });
  const timer = setTimeout(() => { child.kill(); reject(new Error('nativeRequestTimeout')); }, 5000);
  let output = '';
  child.stdout.on('data', (bytes) => { output += bytes; });
  child.stderr.resume();
  child.on('error', (error) => { clearTimeout(timer); reject(error); });
  child.on('close', (code) => {
    clearTimeout(timer);
    try { resolve({ code, value: JSON.parse(output) }); } catch { reject(new Error('invalidNativeReply')); }
  });
  child.stdin.on('error', () => {});
  child.stdin.end(JSON.stringify(value) + '\n');
});

try {
  const ready = await next((line) => line.startsWith('ready '));
  const hwnd = (await next((line) => line.startsWith('hwnd '))).slice(5);
  const ownerPid = ready.match(/^ready (\d+) /)[1];
  assert.deepEqual(await request({ type: 'styleWindow', hwnd, ownerPid }),
    { code: 0, value: { type: 'result', status: 'frameStyled' } });
  const wrongOwner = await request({ type: 'styleWindow', hwnd, ownerPid: '1' });
  assert.equal(wrongOwner.code, 1);
  assert.equal(wrongOwner.value.code, 'osError');
  assert.equal(wrongOwner.value.win32, 2147942405);
  assert.deepEqual(await request({ type: 'flushComposition' }),
    { code: 0, value: { type: 'result', status: 'compositionFlushed' } });
  fixture.stdin.write('fgown\n');
  assert.match(await next((line) => line.startsWith('fg-own=')), /^fg-own=0 /);
  console.log('PASS 4 native DWM checks: owned window, foreign-PID refusal, composition flush, no foreground; poisoned SystemRoot ignored');
} finally {
  for (const waiter of waiters) clearTimeout(waiter.timer);
  reader.close();
  if (fixture.exitCode === null) {
    const exited = new Promise((resolve) => fixture.once('close', resolve));
    fixture.stdin.write('quit\n');
    const timer = setTimeout(() => fixture.kill(), 2000);
    await exited;
    clearTimeout(timer);
  }
}
