// End-to-end tests through the real desktop-helper.exe: malformed input, invalid paths, size
// bounds and result serialization, plus controlled GUI fixture scenarios and two real desktop
// toggles. Run: node native/desktop-helper/run.mjs test
import { spawn } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
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
await expectResult('truncated object', '{"type":"toggleDesktop"\n', ERR('invalidRequest'), 1);
await expectResult('complete object but no LF', '{"type":"toggleDesktop"}', ERR('invalidRequest'), 1);
await expectResult('two requests', '{"type":"toggleDesktop"}\n{"type":"toggleDesktop"}\n', ERR('invalidRequest'), 1);
await expectResult('trailing garbage', '{"type":"toggleDesktop"}x\n', ERR('invalidRequest'), 1);
await expectResult('nested value', '{"type":{"x":"y"}}\n', ERR('invalidRequest'), 1);
await expectResult('non-string value', '{"type":5}\n', ERR('invalidRequest'), 1);
await expectResult('unknown type', '{"type":"explode"}\n', ERR('invalidRequest'), 1);
await expectResult('activate without path', '{"type":"activate"}\n', ERR('invalidRequest'), 1);
await expectResult('extra field', '{"type":"toggleDesktop","x":"y"}\n', ERR('invalidRequest'), 1);await expectResult('crlf line ending', '{"type":"activate","exePath":"Z:\\\\no-such-app.exe"}\r\n',
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

// --- two real desktop toggles (disruptive: run last) ---------------------------------------
// Default: both requests must answer desktopToggled with exit 0; the fixture window adds an
// opportunistic effect observation, and a missing effect stays a visible skip, never a pass.
// LOLPING_DESKTOP_EFFECT_STRICT=1: acceptance mode - the pair must actually move the window
// both ways (one minimize and one restore, order depends on the desktop's start state) or
// the run fails. A reply-only success never passes strict mode.
// LOLPING_DESKTOP_DIAG=1: after the pair, labeled NON-INPUT comparisons (agreed idle window
// only): fixture observer self-test, aggregate censuses, the same shell API from PowerShell,
// and a foreground-state comparison against a uniquely-pathed fixture copy with side-effect-
// free foreground rechecks. Input-injection commands were removed from the fixture;
// historical injected-input observations live in the report.
const strictEffect = process.env.LOLPING_DESKTOP_EFFECT_STRICT === '1';
const diagMode = process.env.LOLPING_DESKTOP_DIAG === '1';
{
  const fixture = runFixture(fixtureExe, 'normal');
  const t0 = Date.now();
  const at = () => `t+${Date.now() - t0}ms`;
  const observe = (ms) => fixture.next((l) => l === 'minimized' || l === 'restored', ms);
  /** Aggregate desktop census (counts only) around an operation, for the diag log. */
  const census = async (tag) => {
    fixture.write('census');
    const c = await fixture.next((l) => l.startsWith('census:'), 3000);
    console.log(`diag  ${at()} census ${tag}: ${c ?? 'unavailable'}`);
  };
  const toggleOnce = async () => {
    const r = await runHelper('{"type":"toggleDesktop"}\n');
    return { reply: r.out.trim(), code: r.code };
  };
  /** Two toggle requests with a long observation window (slow delivery cannot hide). */
  const togglePairObs = async (obs, label, beforeEach = async () => {}) => {
    await beforeEach(1);
    const a = await toggleOnce();
    const first = await obs(10000);
    await beforeEach(2);
    const b = await toggleOnce();
    const second = await obs(10000);
    const bothWays = first && second && first !== second;
    console.log(`diag  ${at()} ${label}: replies ${a.reply} / ${b.reply} (exit ${a.code}/${b.code}), ` +
      `effect ${bothWays ? `${first} -> ${second}` : 'none'} (saw ${first ?? 'nothing'} then ${second ?? 'nothing'})`);
    return {
      okReplies: a.reply === '{"type":"result","status":"desktopToggled"}' && b.reply === '{"type":"result","status":"desktopToggled"}' && a.code === 0 && b.code === 0,
      bothWays,
    };
  };
  const togglePair = async (label) => {
    if (diagMode) await census('before pair');
    const r = await togglePairObs(observe, label);
    if (diagMode) await census('after pair');
    return r;
  };
  try {
    const ready = await fixture.next((l) => l.startsWith('ready ') || l.startsWith('error '), 12000);
    if (!ready || !ready.startsWith('ready ')) {
      if (strictEffect) bad('strict desktop effect', `fixture unavailable: ${ready ?? 'never ready'}`);
      else skip('toggleDesktop x2 (window observation)', `fixture unavailable: ${ready ?? 'never ready'}`);
      const r1 = await toggleOnce();
      const r2 = await toggleOnce();
      if (r1.reply !== '{"type":"result","status":"desktopToggled"}' || r1.code !== 0) bad('toggleDesktop #1', `stdout=${r1.reply} exit=${r1.code}`);
      else if (r2.reply !== '{"type":"result","status":"desktopToggled"}' || r2.code !== 0) bad('toggleDesktop #2', `stdout=${r2.reply} exit=${r2.code}`);
      else ok('toggleDesktop x2 (desktopToggled, exit 0)');
    } else {
      if (diagMode) {
        // C1: does the observer see real window changes driven without the shell?
        fixture.write('minimize');
        const selfMin = await fixture.next((l) => l === 'minimized', 3000);
        const exePath = ready.match(/^ready (\d+) (.+)$/)[2];
        const act = await runHelper(`{"type":"activate","exePath":"${escapeJson(exePath)}"}\n`);
        const selfRestore = await fixture.next((l) => l === 'restored', 5000);
        console.log(`diag  ${at()} observer self-test: self-minimize ${selfMin ? 'seen' : 'MISSED'}, ` +
          `helper-activate ${act.out.trim()}, restore ${selfRestore ? 'seen' : 'MISSED'}`);
        if (!selfMin || !selfRestore) bad('diag observer self-test', 'fixture observer misses real window changes');
        // Side-effect-free foreground sample (the canary probe is NOT used here: it spawns
        // and activates another window, which would change the condition being measured).
        fixture.write('fgown');
        const fgOwn = await fixture.next((l) => l.startsWith('fg-own='), 3000);
        console.log(`diag  ${at()} foreground sample before pair: ${fgOwn ?? 'unavailable'}`);
      }

      const helperPair = await togglePair('helper toggle pair');

      if (diagMode && !helperPair.bothWays) {
        // C3: same shell API from a different COM host with the same harness ancestry.
        const ps = (await import('node:child_process')).spawnSync('powershell.exe',
          ['-NoProfile', '-Command', '(New-Object -ComObject Shell.Application).ToggleDesktop(); Start-Sleep -Milliseconds 300; (New-Object -ComObject Shell.Application).ToggleDesktop()'],
          { timeout: 30000 });
        const p1 = await observe(6000);
        const p2 = p1 ? await observe(6000) : null;
        console.log(`diag  ${at()} powershell ToggleDesktop x2: exit=${ps.status} ` +
          `err=${(ps.stderr || '').toString().trim().slice(0, 120)}, effect ${p1 && p2 && p1 !== p2 ? `${p1} -> ${p2}` : 'none'}`);
        // No automated Win+D/Alt comparison: see the mode comment above and the diagnosis
        // report - the historical injected-input observations are recorded there instead.
      }

      if (diagMode) {
        // Controlled foreground state, WITHOUT the previous confounds: the fixture runs from
        // a unique temporary path, so an activate-by-path request can only select this
        // instance (earlier fixtures with the same exe path are not candidates), and the
        // foreground condition is RE-CHECKED with the side-effect-free fg-own probe right
        // before each comparison instead of trusting a one-time event.
        const dir = mkdtempSync(join(tmpdir(), 'lolping-fg-probe-'));
        let fg = null;
        try {
          const exe = join(dir, 'fixture_app.exe');
          copyFileSync(fixtureExe, exe);
          fg = runFixture(exe, 'normal');
          const fgReady = await fg.next((l) => l.startsWith('ready '), 8000);
          if (!fgReady) {
            console.log(`diag  ${at()} foreground-state comparison: fixture copy never ready`);
          } else {
            const fgExe = fgReady.match(/^ready (\d+) (.+)$/)[2];
            const act = await runHelper(`{"type":"activate","exePath":"${escapeJson(fgExe)}"}\n`);
            const sawFg = await fg.next((l) => l === 'foreground', 5000);
            fg.write('fgown');
            const recheck = await fg.next((l) => l.startsWith('fg-own='), 3000);
            console.log(`diag  ${at()} foreground-state comparison: activate ${act.out.trim()}, ` +
              `one-time event ${sawFg ? 'seen' : 'not seen'}, recheck ${recheck ?? 'unavailable'}`);
            const obsFg = (ms) => fg.next((l) => l === 'minimized' || l === 'restored', ms);
            if (!recheck?.startsWith('fg-own=1 ')) {
              console.log(`diag  ${at()} foreground-state comparison skipped: current foreground not confirmed`);
            } else {
              await togglePairObs(obsFg, 'helper pair, unique fixture with foreground samples', async (ordinal) => {
                fg.write('fgown');
                const before = await fg.next((l) => l.startsWith('fg-own='), 3000);
                console.log(`diag  ${at()} foreground sample before toggle #${ordinal}: ${before ?? 'unavailable'}`);
              });
            }
          }
        } finally {
          if (fg) await fg.killAndWait();
          if (dirname(resolve(dir)) !== resolve(tmpdir()) || !basename(dir).startsWith('lolping-fg-probe-')) {
            throw new Error('Unexpected foreground fixture cleanup path');
          }
          try {
            rmSync(dir, { recursive: true, force: true });
          } catch {
            await new Promise((resolve) => setTimeout(resolve, 500));  // exe lock release can lag exit
            try {
              rmSync(dir, { recursive: true, force: true });
            } catch {
              console.log(`note  foreground-probe temp dir left behind (locked): ${dir}`);
            }
          }
        }
      }

      if (!helperPair.okReplies) {
        bad('toggleDesktop x2', 'a toggle reply was not desktopToggled with exit 0 (see diag lines)');
      } else if (strictEffect) {
        if (helperPair.bothWays) ok('strict desktop effect: replies desktopToggled x2 AND window moved both ways');
        else bad('strict desktop effect', 'desktopToggled answered but the owned window never moved both ways; effect unverified');
      } else {
        ok('toggleDesktop x2 (desktopToggled, exit 0)');
        if (helperPair.bothWays) ok('toggleDesktop window effect observed both ways');
        else skip('toggleDesktop window effect', 'desktopToggled answered but the owned window did not move both ways in this session');
      }
    }
  } finally {
    fixture.kill();
  }
}

console.log(`\n${passed} passed, ${failed} failed, ${skipped} skipped`);
process.exit(failed === 0 ? 0 : 1);
