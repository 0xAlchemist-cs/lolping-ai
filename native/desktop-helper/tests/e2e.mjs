// End-to-end tests through the real desktop-helper.exe: malformed input, invalid paths, size
// bounds and result serialization, plus controlled GUI fixture scenarios and repeated one-way desktop
// clearing. Run: node native/desktop-helper/run.mjs test
import { spawn } from 'node:child_process';
import { copyFileSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = dirname(here);
const helperExe = join(root, 'build', 'desktop-helper.exe');
const fixtureExe = join(root, 'build', 'fixture_app.exe');

let passed = 0;
let failed = 0;
let skipped = 0;
const ok = (name) => { ++passed; console.log(`pass  ${name}`); };
const bad = (name, detail) => { ++failed; console.log(`fail  ${name}: ${detail}`); };
const skip = (name, why) => { ++skipped; console.log(`skip  ${name}: ${why}`); };

const ERR = (code, win32) =>
  `{"type":"result","status":"error","code":"${code}"${win32 === undefined ? '' : `,"win32":${win32}`}}`;

/** Spawns the helper, writes input (string or raw Buffer) + closes stdin, collects one stdout line and the exit code. */
function runHelper(input, timeoutMs = 10000) {
  return new Promise((resolve) => {
    const child = spawn(helperExe, [], { stdio: ['pipe', 'pipe', 'pipe'] });
    let out = '';
    let err = '';
    const done = (r) => { clearTimeout(timer); resolve(r); };
    const timer = setTimeout(() => { child.kill(); done({ out, err, code: 'timeout' }); }, timeoutMs);
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { err += d; });
    child.stdin.on('error', () => {});  // the helper may exit while we are still writing
    child.on('error', (e) => done({ out, err, code: 'spawn-error', error: e.message }));
    child.on('close', (code) => done({ out, err, code }));
    if (input !== null) child.stdin.write(input);
    child.stdin.end();
  });
}

/** Sends exactly `line` (LF included by the caller), then closes stdin. */
async function expectResult(name, line, expectedLine, expectedCode, timeoutMs) {
  const r = await runHelper(line, timeoutMs);
  if (r.out !== expectedLine + '\n') {
    bad(name, `stdout=${JSON.stringify(r.out)} expected ${JSON.stringify(expectedLine)}`);
    return;
  }
  if (r.code !== expectedCode) {
    bad(name, `exit=${r.code} expected ${expectedCode} stderr=${r.err.trim()}`);
    return;
  }
  ok(name);
}

/** Spawns the fixture in a mode and returns a line reader plus cleanup. */
function runFixture(exe, mode) {
  const child = spawn(exe, [mode], { stdio: ['pipe', 'pipe', 'pipe'] });
  const lines = [];
  const waiters = [];
  let readIdx = 0;  // watermark: lines are consumed in order, one waiter at a time
  let ended = false;
  let buf = '';
  child.stdout.on('data', (d) => {
    buf += d;
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i).trim();
      buf = buf.slice(i + 1);
      if (!line) continue;
      lines.push(line);
      const w = waiters.shift();
      if (w && w.pred(line)) {
        readIdx = lines.length;
        w.resolve(line);
      } else if (w) {
        waiters.unshift(w);  // keep waiting for its line
      }
    }
  });
  child.on('error', () => { ended = true; });
  child.on('close', () => { ended = true; });
  return {
    child,
    ended: () => ended,
    /** Resolves with the next unconsumed line matching pred, or null after timeoutMs. */
    next(pred, timeoutMs) {
      for (let i = readIdx; i < lines.length; ++i) {
        if (pred(lines[i])) {
          readIdx = i + 1;
          return Promise.resolve(lines[i]);
        }
      }
      if (ended) return Promise.resolve(null);
      return new Promise((resolve) => {
        const w = { pred, resolve: (line) => { readIdx = lines.length; resolve(line); } };
        waiters.push(w);
        setTimeout(() => {
          const i = waiters.indexOf(w);
          if (i >= 0) { waiters.splice(i, 1); resolve(null); }
        }, timeoutMs);
      });
    },
    kill() { child.kill(); },
    /** Sends one stdin command line to the fixture's diagnostic channel. */
    write(s) { child.stdin.write(s + '\n'); },
    /** Kills and resolves once the process is really gone (its exe may still be locked otherwise). */
    async killAndWait(timeoutMs = 3000) {
      child.kill();
      await Promise.race([
        new Promise((resolve) => child.on('close', resolve)),
        new Promise((resolve) => setTimeout(resolve, timeoutMs)),
      ]);
    },
  };
}

const escapeJson = (s) => s.replace(/\\/g, '\\\\').replace(/"/g, '\\"');

/**
 * Windows restricts foreground activation based on foreground/input context. Holding a
 * lolPing wheel key does not focus its click-through overlay or automatically grant its
 * separate desktop child foreground permission. This harness's node process may
 * have lost that right (the terminal lost focus). A canary activation tells us which state
 * we are in, and "denied" still proves the window was MATCHED: a match failure would answer
 * launchRequired instead.
 */
async function probeActivationPermission() {
  const fixture = runFixture(fixtureExe, 'normal');
  try {
    const ready = await fixture.next((l) => l.startsWith('ready '), 8000);
    if (!ready) return 'unavailable';
    const exePath = ready.match(/^ready (\d+) (.+)$/)[2];
    const r = await runHelper(`{"type":"activate","exePath":"${escapeJson(exePath)}"}\n`);
    const line = r.out.trim();
    if (line === '{"type":"result","status":"activated"}') return 'granted';
    if (line === '{"type":"result","status":"activationDenied"}') return 'denied';
    return 'unavailable';
  } finally {
    fixture.kill();
  }
}

/** The status a steal-activation scenario may assert in the current permission state. */
function expectableStatus(permission) {
  return permission === 'denied' ? 'activationDenied' : 'activated';
}

/** One fixture scenario: start the fixture, wait for its pre-state, activate, check status + evidence. */
async function fixtureScenario(name, mode, expectedStatus, evidence, waitFor = [], helperTimeoutMs = 10000) {
  const fixture = runFixture(fixtureExe, mode);
  try {
    const ready = await fixture.next((l) => l.startsWith('ready '), 8000);
    if (!ready) return bad(name, 'fixture never became ready');
    const m = ready.match(/^ready (\d+) (.+)$/);
    if (!m) return bad(name, `bad ready line: ${ready}`);
    for (const w of waitFor) {  // e.g. let a window minimize itself before activating
      const seen = await fixture.next((l) => l === w, 5000);
      if (!seen) return bad(name, `fixture never reached "${w}"`);
    }
    const exePath = m[2];
    const request = `{"type":"activate","exePath":"${escapeJson(exePath)}"}`;
    const r = await runHelper(request + '\n', helperTimeoutMs);
    const expectedLine = expectedStatus instanceof Array
      ? expectedStatus.map((s) => `{"type":"result","status":"${s}"}`)
      : [`{"type":"result","status":"${expectedStatus}"}`];
    if (!expectedLine.includes(r.out.trim())) {
      return bad(name, `stdout=${JSON.stringify(r.out)} expected one of ${JSON.stringify(expectedLine)}`);
    }
    if (r.code !== 0) return bad(name, `exit=${r.code} stderr=${r.err.trim()}`);
    for (const e of evidence) {
      const seen = await fixture.next((l) => l === e, 5000);
      if (!seen) return bad(name, `fixture never reported "${e}"`);
    }
    ok(`${name} (${r.out.trim()})`);
  } finally {
    fixture.kill();
  }
}

// --- protocol: malformed input, through the real executable -------------------------------
await expectResult('empty stdin', '', ERR('invalidRequest'), 1);
await expectResult('garbage', 'garbage\n', ERR('invalidRequest'), 1);
await expectResult('truncated object', '{"type":"showDesktop"\n', ERR('invalidRequest'), 1);
await expectResult('complete object but no LF', '{"type":"showDesktop"}', ERR('invalidRequest'), 1);
await expectResult('two requests', '{"type":"showDesktop"}\n{"type":"showDesktop"}\n', ERR('invalidRequest'), 1);
await expectResult('trailing garbage', '{"type":"showDesktop"}x\n', ERR('invalidRequest'), 1);
await expectResult('nested value', '{"type":{"x":"y"}}\n', ERR('invalidRequest'), 1);
await expectResult('non-string value', '{"type":5}\n', ERR('invalidRequest'), 1);
await expectResult('unknown type', '{"type":"explode"}\n', ERR('invalidRequest'), 1);
await expectResult('activate without path', '{"type":"activate"}\n', ERR('invalidRequest'), 1);
await expectResult('extra field', '{"type":"showDesktop","x":"y"}\n', ERR('invalidRequest'), 1);await expectResult('crlf line ending', '{"type":"activate","exePath":"Z:\\\\no-such-app.exe"}\r\n',
  '{"type":"result","status":"launchRequired"}', 0);
{
  // exactly 64 KiB: accepted as a request, rejected as a path over the length limit
  const prefix = '{"type":"activate","exePath":"C:\\\\';
  const line = prefix + 'a'.repeat(65536 - prefix.length - 6) + '.exe"}';
  if (line.length !== 65536) throw new Error(`boundary line is ${line.length} bytes, wanted 65536`);
  await expectResult('request at 64 KiB boundary', line + '\n', ERR('invalidPath'), 1);
  await expectResult('request over 64 KiB', prefix + 'a'.repeat(70000) + '.exe"}\n', ERR('invalidRequest'), 1);
}

// --- invalid paths through the real executable --------------------------------------------
await expectResult('relative path', '{"type":"activate","exePath":"app.exe"}\n', ERR('invalidPath'), 1);
await expectResult('unc path', '{"type":"activate","exePath":"\\\\\\\\server\\\\share\\\\app.exe"}\n', ERR('invalidPath'), 1);
await expectResult('ads path', '{"type":"activate","exePath":"C:\\\\x\\\\app.exe:stream"}\n', ERR('invalidPath'), 1);
await expectResult('not an exe', '{"type":"activate","exePath":"C:\\\\Windows\\\\notepad.dll"}\n', ERR('invalidPath'), 1);

// --- raw-byte UTF-8 through the real executable ---------------------------------------------
// Buffer + latin1 keeps every byte exactly; a JS string would replace invalid sequences.
const rawBytes = (s) => Buffer.from(s + '\n', 'latin1');
await expectResult('utf-8 over U+10FFFF (F4 90 80 80) raw bytes',
  rawBytes('{"type":"activate","exePath":"C:\\\\\xf4\x90\x80\x80\\\\app.exe"}'), ERR('invalidRequest'), 1);
await expectResult('utf-8 lead F5 raw bytes',
  rawBytes('{"type":"activate","exePath":"C:\\\\\xf5\x80\x80\x80\\\\app.exe"}'), ERR('invalidRequest'), 1);
await expectResult('utf-8 U+10FFFF boundary raw bytes',
  rawBytes('{"type":"activate","exePath":"C:\\\\\xf4\x8f\xbf\xbf\\\\app.exe"}'),
  '{"type":"result","status":"launchRequired"}', 0);

// --- expected results ----------------------------------------------------------------------
await expectResult('no matching window -> launchRequired',
  '{"type":"activate","exePath":"C:\\\\__lolping_no_such_app__.exe"}\n',
  '{"type":"result","status":"launchRequired"}', 0);

// --- controlled GUI fixture scenarios (need an interactive desktop) ------------------------
const probe = runFixture(fixtureExe, 'normal');
const probeReady = await probe.next((l) => l.startsWith('ready ') || l.startsWith('error '), 8000);
probe.kill();
if (!probeReady || probeReady.startsWith('error ')) {
  skip('fixture scenarios', 'no interactive desktop session for real-window tests (probe: ' +
    (probeReady ?? 'fixture never ready') + ')');
} else {
  const permission = await probeActivationPermission();
  if (permission !== 'granted') {
    skip('activation permission probe', `Windows denies foreground to this session's helper children; ` +
      `steal scenarios assert the denial path (matched window, refused activation); the overlay does not acquire focus.`);
  }
  const stealStatus = expectableStatus(permission);
  await fixtureScenario('activate normal window', 'normal', stealStatus, permission === 'granted' ? ['foreground'] : []);
  // Restoring an iconic window follows a different rule and works without the permission.
  await fixtureScenario('activate minimized window', 'minimized', 'activated', ['restored', 'foreground'],
    ['minimized']);
  await fixtureScenario('activate picks a window among several', 'multi', stealStatus, permission === 'granted' ? ['foreground'] : []);
  await fixtureScenario('hidden tray-like process -> launchRequired', 'hidden', 'launchRequired', []);
  await fixtureScenario('no-activate window -> launchRequired', 'noactivate', 'launchRequired', []);
  {
    const t0 = Date.now();
    await fixtureScenario('helper returns even when the window is hung', 'hung',
      ['activated', 'activationDenied'], [], [], 12000);
    const ms = Date.now() - t0;
    if (ms < 12000) ok(`hung window helper duration ${ms}ms < 12s`);
    else bad('hung window helper duration', `${ms}ms, helper blocked too long`);
  }
  {
    // The window destroys itself the moment the helper activates it. The identity guard must
    // notice the dead handle quickly (well under the 1.5 s bounded timeout) and answer
    // activationDenied, never launchRequired, because a match was already selected.
    const fixture = runFixture(fixtureExe, 'vanish');
    try {
      const ready = await fixture.next((l) => l.startsWith('ready '), 8000);
      if (!ready) {
        bad('destroyed-on-activation guard', 'fixture never ready');
      } else {
        const exePath = ready.match(/^ready (\d+) (.+)$/)[2];
        const t0 = Date.now();
        const r = await runHelper(`{"type":"activate","exePath":"${escapeJson(exePath)}"}\n`);
        const ms = Date.now() - t0;
        const gone = await fixture.next((l) => l === 'gone', 3000);
        if (r.out !== '{"type":"result","status":"activationDenied"}\n') {
          bad('destroyed-on-activation guard', `stdout=${JSON.stringify(r.out)} exit=${r.code}`);
        } else if (r.code !== 0) {
          bad('destroyed-on-activation guard', `exit=${r.code}`);
        } else if (ms > 1000) {
          bad('destroyed-on-activation guard', `${ms}ms: looks like the timeout walk, not the guard`);
        } else if (!gone) {
          bad('destroyed-on-activation guard', 'fixture never reported its window destroyed');
        } else {
          ok(`destroyed-on-activation guard (${ms}ms, activationDenied)`);
        }
      }
    } finally {
      fixture.kill();
    }
  }
  {
    // A copy of the fixture runs from a temporary directory with non-ASCII letters; the
    // request spells the directory in different case and must still activate the window.
    const pairs = { '\u0394': '\u03b4', '\u0419': '\u0439', '\u0414': '\u0434', '\u03a9': '\u03c9' };
    const upperName = 'p3\u0394\u0419\u0414\u03a9';
    const lowerName = [...upperName].map((c) => pairs[c] ?? c).join('');
    const dir = join(tmpdir(), `${upperName}-${Date.now()}`);
    let fixture = null;
    try {
      mkdirSync(dir, { recursive: true });
      const exe = join(dir, 'fixture_app.exe');
      copyFileSync(fixtureExe, exe);
      fixture = runFixture(exe, 'normal');
      const ready = await fixture.next((l) => l.startsWith('ready '), 8000);
      if (!ready) {
        bad('unicode path, case variant', 'fixture never ready');
      } else {
        const exePath = ready.match(/^ready (\d+) (.+)$/)[2];
        const variant = exePath.split(upperName).join(lowerName);
        if (variant === exePath) {
          bad('unicode path, case variant', 'real exe path did not contain the unicode directory name');
        } else {
          const r = await runHelper(`{"type":"activate","exePath":"${escapeJson(variant)}"}\n`);
          // Whichever way the OS answers, launchRequired would mean the Unicode
          // case-insensitive match failed - that is the assertion under test.
          const want = `{"type":"result","status":"${stealStatus}"}`;
          if (r.out.trim() !== want || r.code !== 0) {
            bad('unicode path, case variant', `stdout=${JSON.stringify(r.out)} exit=${r.code} expected ${want}`);
          } else if (permission === 'granted') {
            const fg = await fixture.next((l) => l === 'foreground', 5000);
            if (!fg) bad('unicode path, case variant', 'fixture never confirmed foreground');
            else ok('unicode path, case variant (activated)');
          } else {
            ok('unicode path, case variant (matched; activation denied by OS policy)');
          }
        }
      }
    } finally {
      if (fixture) await fixture.killAndWait();
      try {
        rmSync(dir, { recursive: true, force: true });
      } catch {
        await new Promise((resolve) => setTimeout(resolve, 500));  // exe lock release can lag the exit event
        try {
          rmSync(dir, { recursive: true, force: true });
        } catch {
          console.log(`note  unicode fixture temp dir left behind (locked): ${dir}`);
        }
      }
    }
  }
}

// --- one-way desktop clearing (disruptive: run last) -------------------------------------
// Strict mode requires real window effects, not just shell acceptance. The second request
// must keep the window minimized. After explicitly restoring OUR fixture, a third must clear
// it again. Production exposes no restore operation and these tests inject no keyboard input.
const strictEffect = process.env.LOLPING_DESKTOP_EFFECT_STRICT === '1';
const fixture = runFixture(fixtureExe, 'normal');
try {
  const ready = await fixture.next((l) => l.startsWith('ready '), 8000);
  const reply = '{"type":"result","status":"desktopShown"}';
  const clear = () => runHelper('{"type":"showDesktop"}\n');
  const effectMissing = (name, why) => strictEffect ? bad(name, why) : skip(name, why);
  const census = async () => {
    fixture.write('census');
    return fixture.next((l) => l.startsWith('census:'), 3000);
  };
  if (!ready) {
    effectMissing('clear screen effects', 'fixture unavailable in this desktop session');
  } else {
    const exePath = ready.match(/^ready (\d+) (.+)$/)[2];
    const first = await clear();
    if (first.out.trim() !== reply || first.code !== 0) bad('clear #1 reply', JSON.stringify(first));
    else ok('clear #1 reply');
    const minimized = await fixture.next((l) => l === 'minimized', 10000);
    if (!minimized) effectMissing('clear #1 effect', 'shell accepted request but the owned window did not minimize');
    else {
      ok('clear #1 minimized the owned window');
      const second = await clear();
      if (second.out.trim() !== reply || second.code !== 0) bad('clear #2 reply', JSON.stringify(second));
      else ok('clear #2 reply');
      const state = await census();
      if (!state?.includes('ownMinimized=1')) bad('clear #2 remains minimized', state ?? 'census unavailable');
      else ok('clear #2 did not restore the window');
      // Restore only our controlled window, using the existing activation operation.
      const activation = await runHelper(JSON.stringify({ type: 'activate', exePath }) + '\n');
      const restored = await fixture.next((l) => l === 'restored', 5000);
      if (!restored) effectMissing('clear #3 setup', 'controlled fixture could not be restored: ' + activation.out.trim());
      else {
        const third = await clear();
        if (third.out.trim() !== reply || third.code !== 0) bad('clear #3 reply', JSON.stringify(third));
        else ok('clear #3 reply');
        const again = await fixture.next((l) => l === 'minimized', 10000);
        if (!again) effectMissing('clear #3 effect', 'newly restored window did not minimize again');
        else ok('clear #3 minimized the reopened window again');
      }
    }
    if (process.env.LOLPING_DESKTOP_DIAG === '1') console.log('diag  final owned-window state: ' + await census());
  }
} finally {
  await fixture.killAndWait();
}

console.log(`\n${passed} passed, ${failed} failed, ${skipped} skipped`);
process.exit(failed === 0 ? 0 : 1);
