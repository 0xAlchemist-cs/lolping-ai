// Real hidden fixture only: no showing/minimizing windows, shell calls or injected input.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';

if (process.platform !== 'win32') {
  console.log('SKIP fixture command checks: Windows only');
  process.exit(0);
}
const exe = fileURLToPath(new URL('../build/fixture_app.exe', import.meta.url));
const child = spawn(exe, ['hidden'], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
const lines = [];
let pending, failure, passed = 0, rejected = 0;
const closed = new Promise(resolve => child.once('close', resolve));
child.on('error', error => { failure = error; pending?.reject(error); });
child.stdin.on('error', error => { failure = error; pending?.reject(error); });
child.stderr.resume();
createInterface({ input: child.stdout }).on('line', line => {
  lines.push(line);
  if (pending) { const waiting = pending; pending = null; waiting.resolve(); }
});
async function next(predicate) {
  const deadline = Date.now() + 3000;
  for (;;) {
    const index = lines.findIndex(predicate);
    if (index >= 0) return lines.splice(index, 1)[0];
    if (failure) throw failure;
    if (Date.now() >= deadline) throw new Error('fixtureReplyTimeout');
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => { pending = null; reject(new Error('fixtureReplyTimeout')); }, deadline - Date.now());
      pending = { resolve: () => { clearTimeout(timer); resolve(); }, reject: error => { clearTimeout(timer); reject(error); } };
    });
  }
}
function pass(name) { passed++; console.log(`pass  ${name}`); }
async function probe() {
  child.stdin.write('fgown\n');
  const line = await next(line => line.startsWith('fg-own='));
  assert.equal(line, `fg-own=0 rejected=${rejected}`);
}
async function reject(command, name) {
  rejected++;
  child.stdin.write(Buffer.concat([Buffer.isBuffer(command) ? command : Buffer.from(command), Buffer.from('\nfgown\n')]));
  const line = await next(line => line.startsWith('fg-own='));
  assert.equal(line, `fg-own=0 rejected=${rejected}`, name);
  pass(name);
}
let exitCode = 1;
try {
  const ready = await next(line => line.startsWith('ready ') || line.startsWith('error '));
  if (ready.startsWith('error ')) {
    console.log('SKIP fixture command checks: hidden window unavailable');
    exitCode = process.env.LOLPING_FIXTURE_COMMANDS_STRICT === '1' ? 1 : 0;
  } else {
    await probe(); pass('hidden fixture never foreground');
    child.stdin.write('census\n');
    assert.match(await next(line => line.startsWith('census:')), /ownMinimized=0$/);
    pass('exact census command');
    await reject('windXYZ', 'prefix command rejected');
    await reject('unknown', 'unknown command rejected');
    await reject('a'.repeat(40), '40-byte line counted once');
    await reject('a'.repeat(70), '70-byte line counted once');
    await reject(Buffer.from('census\0suffix'), 'embedded NUL rejected');
    await reject('a'.repeat(63) + 'quit', 'long-line quit suffix cannot execute');
    await reject('a'.repeat(16), '16-byte unknown command rejected');
    await reject('a'.repeat(17), '17-byte line rejected');
    await reject('quitXYZ', 'quit prefix cannot terminate fixture');
    await reject('wind', 'removed Win+D command rejected');
    await reject('alt', 'removed Alt command rejected');
    child.stdin.write('fgown\r\n');
    assert.equal(await next(line => line.startsWith('fg-own=')), `fg-own=0 rejected=${rejected}`);
    pass('CRLF exact command');
    assert.equal(lines.some(line => line.startsWith('inject:') || line === 'minimized'), false);
    child.stdin.end('quit\n');
    let timer;
    try {
      const code = await Promise.race([closed, new Promise((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error('fixtureQuitTimeout')), 3000);
      })]);
      assert.equal(code, 0);
    } finally { clearTimeout(timer); }
    pass('exact quit exits cleanly');
    exitCode = 0;
  }
} catch (error) { console.log(`FAIL fixture command checks: ${error.message}`); }
finally {
  if (child.exitCode === null && child.signalCode === null) child.kill();
  let timer;
  await Promise.race([closed, new Promise(resolve => { timer = setTimeout(resolve, 3000); })]);
  clearTimeout(timer);
}
console.log(`${passed} fixture command checks passed; no desktop actions or input injected`);
process.exitCode = exitCode;
