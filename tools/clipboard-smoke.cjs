/* Production sandbox renderer, synthetic answers and a controlled external clipboard writer. No real config or API. */
const { join, resolve } = require('node:path');
const { mkdirSync } = require('node:fs');
const { spawnSync, spawn } = require('node:child_process');

if (!process.versions.electron) {
  const root = resolve(__dirname, '..');
  const out = join(root, 'out/clipboard-smoke');
  mkdirSync(out, { recursive: true });
  require('esbuild').buildSync({ entryPoints: [__filename], outfile: join(out, 'main.cjs'), bundle: true,
    platform: 'node', format: 'cjs', external: ['electron', 'esbuild'], logLevel: 'silent' });
  const env = { ...process.env, LOLPING_CLIPBOARD_SMOKE_ROOT: root };
  delete env.ELECTRON_RUN_AS_NODE; delete env.ELECTRON_RENDERER_URL;
  const child = spawnSync(require('electron'), [join(out, 'main.cjs'), `--user-data-dir=${join(out, `profile-${Date.now()}`)}`],
    { cwd: root, env, encoding: 'utf8', windowsHide: true, timeout: 120000 });
  if (child.stdout) process.stdout.write(child.stdout);
  if (child.stderr) process.stderr.write(child.stderr);
  if (child.error) console.error(child.error.code || 'launchFailed');
  process.exitCode = child.status ?? 1;
} else {
  run();
}

function run() {
  const { app, BrowserWindow, clipboard, session } = require('electron');
  const { registerAppScheme, serveAppScheme } = require('../src/main/appProtocol.ts');
  const { openExplainWindow, registerExplainWindow } = require('../src/main/explainWindow.ts');
  const { strings } = require('../src/shared/i18n.ts');
  const root = process.env.LOLPING_CLIPBOARD_SMOKE_ROOT;
  if (!root) throw new Error('launcherRequired');
  app.setAppPath(root); app.commandLine.appendSwitch('disable-background-networking');
  registerAppScheme(); app.on('window-all-closed', () => {});
  let card = null; let dummy = null; let active = null; let competitor = null;
  let externalRequests = 0; let answers = 0; let exitCode = 1;
  const results = [];
  const words = { ...strings('en').explainWindow, errors: strings('en').aiError };
  const check = (ok, code) => { if (!ok) throw new Error(code); };
  const evaluate = script => card.webContents.executeJavaScript(script);
  const waitUntil = async (condition, code) => {
    const deadline = Date.now() + 15000;
    while (Date.now() < deadline) {
      if (await condition()) return;
      await new Promise(resolveWait => setTimeout(resolveWait, 10));
    }
    throw new Error(code);
  };
  const instrument = `(() => {
    const original = navigator.clipboard.writeText.bind(navigator.clipboard);
    window.__copySequence = 0;
    navigator.clipboard.writeText = text => {
      const d = window.__copyDiagnostic = { sequence: ++window.__copySequence, characters: text.length,
        started: performance.now(), settled: false, resolved: false, focusAtStart: document.hasFocus(),
        sourceMatches: text === window.__expectedCopyText };
      const write = () => original(text).then(() => {
        d.settled = true; d.resolved = true; d.elapsedMs = performance.now() - d.started;
        d.focusAtFinish = document.hasFocus();
      }, error => {
        d.settled = true; d.resolved = false; d.elapsedMs = performance.now() - d.started;
        d.focusAtFinish = document.hasFocus(); d.permissionFailure = error.name === 'NotAllowedError'; throw error;
      });
      if (!window.__holdCopy) return write();
      return new Promise(resolveGate => { window.__releaseCopy = resolveGate; }).then(write);
    };
  })()`;
  async function open() {
    openExplainWindow({ x: 80, y: 80 }, words);
    card = BrowserWindow.getAllWindows().find(window => window !== dummy);
    check(card, 'cardMissing');
    await waitUntil(() => card.isVisible(), 'cardHidden');
    await waitUntil(() => evaluate('!!window.explainApi && !!document.getElementById("copy")'), 'rendererMissing');
    await evaluate(instrument);
  }
  async function answer(text, stopped = false, waitForCopy = true) {
    card.show(); card.focus(); active = null;
    await evaluate('document.getElementById("question").value="Synthetic clipboard fixture";'
      + 'document.getElementById("ask").requestSubmit()');
    await waitUntil(() => active, 'askMissing');
    active.sink({ kind: 'delta', id: active.id, text });
    if (stopped) await evaluate('document.getElementById("stop").click()');
    else active.sink({ kind: 'done', id: active.id });
    await waitUntil(() => evaluate('!document.getElementById("send").disabled'), 'answerNotFinished');
    if (waitForCopy) await waitUntil(() => evaluate('!document.getElementById("copy").disabled'), 'copyNotEnabled');
    await evaluate(`window.__expectedCopyText=${JSON.stringify(text)}`);
  }
  async function switchFocus() {
    dummy.setAlwaysOnTop(true, 'screen-saver'); dummy.show(); dummy.focus();
    await waitUntil(() => dummy.isFocused() && !card.isFocused(), 'focusDidNotSwitch');
    await waitUntil(() => evaluate('!document.hasFocus()'), 'rendererFocusNotUpdated');
  }
  async function settled(sequence) {
    await waitUntil(() => evaluate(`window.__copyDiagnostic?.sequence === ${sequence} && window.__copyDiagnostic.settled`
      + ` && [${JSON.stringify(words.copied)},${JSON.stringify(words.copyFailed)}].includes(document.getElementById("copied").textContent)`),
    'copyNotSettled');
    return evaluate('({...window.__copyDiagnostic, started: undefined, uiSuccess: '
      + `document.getElementById("copied").textContent === ${JSON.stringify(words.copied)}, focused: document.hasFocus()})`);
  }
  async function copyCase(name, text, options = {}) {
    await answer(text, options.stopped);
    const seed = 'Synthetic clipboard seed';
    await clipboard.writeText(seed); // Never read or retain the user's previous clipboard.
    if (options.unfocused) await switchFocus();
    const sequence = await evaluate('window.__copySequence + 1');
    await evaluate('document.getElementById("copy").click()');
    if (options.switchFocus) await switchFocus();
    const diagnostic = await settled(sequence);
    const actual = await clipboard.readText();
    // W3C writeText requires CRLF on Windows. Keep a strict native comparison and a separate exact source check.
    const nativeExpected = text.replace(/\r?\n/g, '\r\n');
    const matches = actual === nativeExpected;
    const failureShown = !diagnostic.resolved && !diagnostic.uiSuccess && actual === seed;
    results.push({ name, ...diagnostic, actualLength: actual.length, matches,
      lineEndingsOnly: actual !== text && actual.replaceAll('\r\n', '\n') === text.replaceAll('\r\n', '\n'),
      status: diagnostic.sourceMatches && (matches && diagnostic.uiSuccess || options.unfocused && failureShown) ? 'PASS' : 'FAIL' });
  }
  async function writer() {
    const command = 'Add-Type -AssemblyName System.Windows.Forms; [Console]::WriteLine("ready"); '
      + '$null = [Console]::ReadLine(); [System.Windows.Forms.Clipboard]::SetText("Synthetic competitor overwrite"); '
      + '[Console]::WriteLine("written")';
    competitor = spawn(join(process.env.SystemRoot, 'System32/WindowsPowerShell/v1.0/powershell.exe'),
      ['-NoProfile', '-NonInteractive', '-STA', '-WindowStyle', 'Hidden', '-Command', command],
      { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    let output = ''; let failed = false;
    competitor.stdout.on('data', bytes => { output += bytes.toString(); });
    competitor.on('error', () => { failed = true; });
    await waitUntil(() => { check(!failed, 'competitorFailed'); return output.includes('ready'); }, 'competitorNotReady');
    return async () => {
      competitor.stdin.end('\n');
      await waitUntil(() => output.includes('written'), 'competitorDidNotWrite');
    };
  }
  app.whenReady().then(async () => {
    try {
      check(process.platform === 'win32', 'windowsRequired');
      session.defaultSession.webRequest.onBeforeRequest((details, callback) => {
        const external = /^(https?|wss?):/.test(details.url);
        if (external) externalRequests++;
        callback({ cancel: external });
      });
      serveAppScheme({ rendererRoot: join(root, 'out/renderer'), emoteDirs: () => [] });
      registerExplainWindow({ configured: () => true, cancel: () => {}, openSettings: () => {},
        ask: (_q, id, sink) => { answers++; active = { id, sink }; } });
      dummy = new BrowserWindow({ width: 200, height: 100, show: false, backgroundColor: '#203010',
        webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false } });
      await dummy.loadURL('data:text/html,<title>Synthetic clipboard focus target</title>'); dummy.show();
      await open();
      const samples = [ ['ascii', 'Synthetic answer'], ['chineseEmoji', '中文🙂🚀，标点。'],
        ['multiline', '第一行\nSecond line\n🙂'], ['crlf', 'A\r\nB\r\nC'], ['markdown', '# heading\n**plain** [link](fixture)'],
        ['long', '中🙂abc\n'.repeat(2000)] ];
      for (let round = 0; round < 3; round++) {
        for (const [name, text] of samples) await copyCase(`${name}-${round}`, text);
      }
      for (let i = 0; i < 3; i++) await copyCase(`stop-partial-${i}`, `Stopped partial 中🙂 ${i}`, { stopped: true });
      await copyCase('focus-switch', 'Copy then switch focus', { switchFocus: true });
      await copyCase('unfocused', 'Unfocused synthetic text', { unfocused: true });
      await answer('Rapid copy synthetic text');
      const before = await evaluate('window.__copySequence');
      await evaluate('for(let i=0;i<10;i++)document.getElementById("copy").click()');
      const rapid = await settled(before + 1);
      const rapidValue = await clipboard.readText();
      results.push({ name: 'rapid-copy', ...rapid, matches: rapidValue === 'Rapid copy synthetic text',
        status: rapidValue === 'Rapid copy synthetic text' && await evaluate('window.__copySequence') === before + 1 ? 'PASS' : 'FAIL' });
      for (let i = 0; i < 3; i++) {
        await clipboard.writeText('Synthetic sequential copy seed');
        const sequence = await evaluate('window.__copySequence + 1');
        await evaluate('window.__holdCopy=true;document.getElementById("copy").click()');
        const noStaleSuccess = await evaluate('document.getElementById("copied").textContent === "" && document.getElementById("copy").disabled');
        const premature = await clipboard.readText();
        await evaluate('window.__releaseCopy()');
        const diagnostic = await settled(sequence);
        const actual = await clipboard.readText();
        results.push({ name: `serial-copy-${i}`, ...diagnostic, noStaleSuccess,
          prematureMatches: premature === 'Rapid copy synthetic text', matches: actual === 'Rapid copy synthetic text',
          status: noStaleSuccess && premature === 'Synthetic sequential copy seed' && actual === 'Rapid copy synthetic text' ? 'PASS' : 'FAIL' });
        await evaluate('window.__holdCopy=false');
      }
      const overwrite = await writer(); await overwrite();
      const competing = await clipboard.readText();
      results.push({ name: 'external-after-copy', ownMatches: competing === 'Rapid copy synthetic text',
        competitorMatches: competing === 'Synthetic competitor overwrite', status: competing === 'Synthetic competitor overwrite' ? 'PASS' : 'FAIL' });
      await answer('Own write after competitor');
      await evaluate('window.__holdCopy=true;document.getElementById("copy").click()');
      const overwriteFirst = await writer(); await overwriteFirst();
      await evaluate('window.__releaseCopy()');
      const afterCompetitor = await settled(await evaluate('window.__copySequence'));
      const ownLast = await clipboard.readText();
      results.push({ name: 'external-before-copy-commit', ...afterCompetitor, matches: ownLast === 'Own write after competitor',
        status: ownLast === 'Own write after competitor' ? 'PASS' : 'FAIL' });
      await evaluate('window.__holdCopy=false');
      await answer('Old gated answer');
      const oldSequence = await evaluate('window.__copySequence + 1');
      await evaluate('window.__holdCopy=true;document.getElementById("copy").click()');
      await answer('Replacement synthetic answer', false, false);
      const blockedWhileOldPending = await evaluate('document.getElementById("copy").disabled');
      await evaluate('document.getElementById("copy").click();window.__releaseCopy()');
      await waitUntil(() => evaluate('window.__copyDiagnostic.settled && !document.getElementById("copy").disabled'), 'oldCopyNotSettled');
      const noOldLabel = await evaluate('document.getElementById("copied").textContent === ""');
      const onlyOneWrite = await evaluate(`window.__copySequence === ${oldSequence}`);
      await evaluate('window.__holdCopy=false;document.getElementById("copy").click()');
      const replacement = await settled(oldSequence + 1);
      const replacedValue = await clipboard.readText();
      results.push({ name: 'replacement-during-copy', ...replacement, blockedWhileOldPending, noOldLabel, onlyOneWrite,
        matches: replacedValue === 'Replacement synthetic answer', status: blockedWhileOldPending && noOldLabel && onlyOneWrite
          && replacedValue === 'Replacement synthetic answer' ? 'PASS' : 'FAIL' });
      for (let i = 0; i < 3; i++) {
        await answer('Copy immediately before close');
        await clipboard.writeText('Synthetic close seed');
        const oldCard = card;
        await evaluate('document.getElementById("copy").click();document.getElementById("close").click()').catch(() => {});
        await waitUntil(() => oldCard.isDestroyed(), 'closeDidNotFinish');
        const closedCopy = await clipboard.readText();
        results.push({ name: `immediate-close-${i}`, matches: closedCopy === 'Copy immediately before close',
          actualLength: closedCopy.length, status: closedCopy === 'Copy immediately before close' ? 'PASS' : 'FAIL' });
        if (i !== 2) await open();
      }
      check(results.every(result => result.status === 'PASS'), 'clipboardMatrixFailed');
      check(externalRequests === 0, 'unexpectedExternalRequest');
      exitCode = 0;
      console.log(JSON.stringify({ status: 'PASS', syntheticOnly: true, pid: process.pid, answers, externalRequests, results }));
    } catch (error) {
      const code = /^[a-zA-Z][a-zA-Z0-9]{0,60}$/.test(error.message) ? error.message : 'unexpectedClipboardFailure';
      console.log(JSON.stringify({ status: 'FAIL', code, pid: process.pid, answers, externalRequests, results }));
    } finally {
      if (competitor && competitor.exitCode === null) competitor.kill();
      for (const window of BrowserWindow.getAllWindows()) if (!window.isDestroyed()) window.destroy();
      app.exit(exitCode);
    }
  }).catch(() => { console.log('{"status":"FAIL","code":"setupFailed"}'); app.exit(1); });
}
