/* Real sandbox card/preload/IPC and app ask entry; only preparation and HTTP are synthetic. No clipboard or API. */
const { join, resolve } = require('node:path');
const { mkdirSync } = require('node:fs');
const { spawnSync } = require('node:child_process');

if (!process.versions.electron) {
  const root = resolve(__dirname, '..');
  const out = join(root, 'out/ai-diagnostics-smoke');
  mkdirSync(out, { recursive: true });
  require('esbuild').buildSync({ entryPoints: [__filename], outfile: join(out, 'main.cjs'), bundle: true,
    platform: 'node', format: 'cjs', external: ['electron', 'esbuild'], logLevel: 'silent' });
  const env = { ...process.env, LOLPING_DIAGNOSTIC_SMOKE_ROOT: root };
  delete env.ELECTRON_RUN_AS_NODE; delete env.ELECTRON_RENDERER_URL;
  const child = spawnSync(require('electron'), [join(out, 'main.cjs'), `--user-data-dir=${join(out, `profile-${Date.now()}`)}`],
    { cwd: root, env, encoding: 'utf8', windowsHide: true, timeout: 90000 });
  if (child.stdout) process.stdout.write(child.stdout);
  if (child.stderr) process.stderr.write(child.stderr);
  process.exitCode = child.status ?? 1;
} else {
  run();
}

function run() {
  const { app, BrowserWindow, screen, session } = require('electron');
  const { registerAppScheme, serveAppScheme } = require('../src/main/appProtocol.ts');
  const { registerExplainWindow, openExplainWindow } = require('../src/main/explainWindow.ts');
  const { AiRequests, createExplainAsk } = require('../src/main/aiRequest.ts');
  const { createAiDiagnostics } = require('../src/main/aiDiagnostics.ts');
  const { strings } = require('../src/shared/i18n.ts');
  const { TEST_JPEG_DATA_URL } = require('../tests/main/fixtures/visionJpeg.ts');
  const root = process.env.LOLPING_DIAGNOSTIC_SMOKE_ROOT;
  if (!root) throw new Error('launcherRequired');
  app.setAppPath(root); app.commandLine.appendSwitch('disable-background-networking');
  registerAppScheme(); app.on('window-all-closed', () => {});
  const rows = []; const results = []; const lifecycle = []; const keyboardResults = [];
  let card; let scenario; let stage = 'setup'; let externalRequests = 0; let requests = 0; let release;
  let exitCode = 1;
  const check = (ok, code) => { if (!ok) throw new Error(code); };
  const waitUntil = async (condition, code) => {
    const deadline = Date.now() + 15000;
    while (Date.now() < deadline) {
      if (await condition()) return;
      await new Promise(resolveWait => setTimeout(resolveWait, 10));
    }
    throw new Error(code);
  };
  const encode = new TextEncoder();
  const frame = value => encode.encode(`data: ${value}\n\n`);
  const diagnostics = createAiDiagnostics(app.isPackaged, '1', line => rows.push(JSON.parse(line)));
  const client = new AiRequests({
    prepare: async () => ({ ok: true, baseUrl: 'https://synthetic.invalid', model: 'synthetic', key: 'synthetic' }),
    recipient: () => ({ baseUrl: 'https://synthetic.invalid', model: 'synthetic' }), now: Date.now,
    fetchImpl: async (_url, init) => {
      requests++;
      const payload = JSON.parse(init.body);
      check(payload.max_tokens === 8192, 'budgetChanged');
      const parts = payload.messages[0].content;
      if (scenario === 'vision-keyboard') {
        const images = Array.isArray(parts) && parts.filter(p => p.type === 'image_url');
        check(images && images.length === 1 && images[0].image_url.url === TEST_JPEG_DATA_URL, 'wrongApprovedImage');
      } else check(typeof parts === 'string', 'textAttachedImage');
      const name = scenario;
      return { ok: true, status: 200, body: (async function* () {
        yield frame('{"choices":[{"delta":{"content":"Synthetic private answer"}}]}');
        if (name === 'stop' || name === 'close') await new Promise(done => { release = done; });
        if (name === 'network') throw new TypeError('synthetic private fault');
        if (name === 'eof') return;
        if (name === 'malformed') yield frame('{broken}');
        if (name === 'normal' || name === 'length' || name === 'vision-keyboard' || name === 'ime-button') {
          yield frame(JSON.stringify({ choices: [{ delta: {}, finish_reason: name === 'length' ? 'length' : 'stop' }] }));
        }
        yield frame('[DONE]');
      })() };
    },
  });
  app.on('web-contents-created', (_event, contents) => {
    contents.on('preload-error', () => lifecycle.push('preloadError'));
    contents.on('did-fail-load', (_event, code) => lifecycle.push(`loadFailure:${Number.isInteger(code) ? code : 0}`));
    contents.on('render-process-gone', () => lifecycle.push('rendererGone'));
  });
  app.whenReady().then(async () => {
    serveAppScheme({ rendererRoot: join(root, 'out/renderer'), emoteDirs: () => [] });
    session.defaultSession.webRequest.onBeforeRequest((details, callback) => {
      if (/^https?:/i.test(details.url)) { externalRequests++; callback({ cancel: true }); }
      else callback({});
    });
    registerExplainWindow({ ask: createExplainAsk(client, diagnostics.stream), diagnostics,
      cancel: source => client.cancel(source), configured: () => true, openSettings: () => {},
      recipient: () => ({ baseUrl: 'https://synthetic.invalid', model: 'synthetic' }),
      capture: async target => {
        const image = { dataUrl: TEST_JPEG_DATA_URL, width: 2, height: 1, marker: { x: .5, y: .5 } };
        return { ok: true, preview: { displayId: target.displayId, original: { x: target.x, y: target.y, width: 2, height: 1 },
          crop: { x: 0, y: 0, width: 2, height: 1 }, local: image, full: image } };
      } });
    const words = { ...strings('en').explainWindow, errors: strings('en').aiError };
    try {
      for (const name of ['normal', 'vision-keyboard', 'ime-button', 'length', 'compatible', 'eof', 'network', 'malformed', 'stop', 'close']) {
        scenario = name; release = undefined; rows.length = 0;
        stage = 'open';
        if (!card) {
          const display = screen.getPrimaryDisplay();
          openExplainWindow({ x: 100, y: 100 }, words, { displayId: display.id, x: 20, y: 20,
            bounds: { ...display.bounds }, scaleFactor: display.scaleFactor });
          card = BrowserWindow.getAllWindows().find(w => !w.isDestroyed());
          card?.on('closed', () => lifecycle.push('cardClosed'));
          card?.on('blur', () => lifecycle.push('cardBlur'));
        }
        check(!!card, 'cardMissing');
        const evaluate = async script => {
          let timer;
          try {
            return await Promise.race([card.webContents.executeJavaScript(script),
              new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('rendererEvaluationTimeout')), 5000); })]);
          } finally { clearTimeout(timer); }
        };
        await waitUntil(() => evaluate('!!document.getElementById("send")?.textContent'), 'cardNotReady');
        card.show(); card.focus();
        // In-process transport on this synthetic window only: no remote debugging port or Network domain.
        if (!card.webContents.debugger.isAttached()) card.webContents.debugger.attach('1.3');
        const enter = async (autoRepeat = false) => {
          await card.webContents.debugger.sendCommand('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Enter',
            code: 'Enter', windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13, text: '\r', unmodifiedText: '\r', autoRepeat });
          await card.webContents.debugger.sendCommand('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter',
            code: 'Enter', windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13 });
        };
        const paint = () => evaluate('new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)))');
        stage = 'send';
        if (name === 'vision-keyboard') {
          await evaluate('document.getElementById("previewOpen").click()');
          await waitUntil(() => evaluate('!document.getElementById("visionSend").disabled'), 'previewNotReady');
        }
        const questionId = name === 'vision-keyboard' ? 'visionQuestion' : 'question';
        if (name === 'normal' || name === 'vision-keyboard' || name === 'ime-button') {
          stage = 'composition';
          const before = requests;
          await evaluate(`(()=>{const e=document.getElementById("${questionId}");e.value="";e.focus();
            const a=window.__imeAudit={started:0,ended:0,composingEnter:0,trustedEnter:0,formSubmits:0};
            e.addEventListener('compositionstart',()=>a.started++);e.addEventListener('compositionend',()=>a.ended++);
            e.addEventListener('keydown',v=>{if(v.key==='Enter'){if(v.isComposing)a.composingEnter++;if(v.isTrusted)a.trustedEnter++}});
            document.getElementById('ask').addEventListener('submit',()=>a.formSubmits++);})()`);
          await card.webContents.debugger.sendCommand('Input.imeSetComposition', { text: '测试', selectionStart: 2, selectionEnd: 2 });
          await enter(); await paint();
          keyboardResults.push({ field: questionId, stage: 'candidate', ...await evaluate('window.__imeAudit') });
          check(requests === before, 'imeConfirmationSentRequest');
          if (await evaluate('window.__imeAudit.ended===0')) {
            await card.webContents.debugger.sendCommand('Input.insertText', { text: '测试' });
          }
          await paint();
          const audit = await evaluate('window.__imeAudit');
          check(audit.started > 0 && audit.ended > 0 && audit.composingEnter > 0 && audit.trustedEnter > 0, 'imeNotExercised');
          check(requests === before && (questionId === 'question' ? audit.formSubmits > 0 : audit.formSubmits === 0),
            'imeFormFallbackNotExercised');
          await enter(true); await paint();
          check(requests === before, 'heldEnterSubmitted');
          keyboardResults.push({ field: questionId, ...audit, candidateConfirmationBlocked: true, heldEnterBlocked: true });
          stage = 'send';
        }
        await evaluate(`document.getElementById("${questionId}").value="Synthetic question";document.getElementById("${questionId}").focus()`);
        if (name === 'ime-button') {
          const point = await evaluate('(()=>{const r=document.getElementById("send").getBoundingClientRect();return {x:Math.round(r.x+r.width/2),y:Math.round(r.y+r.height/2)}})()');
          card.webContents.sendInputEvent({ type: 'mouseDown', ...point, button: 'left', clickCount: 1 });
          card.webContents.sendInputEvent({ type: 'mouseUp', ...point, button: 'left', clickCount: 1 });
        } else await enter();
        await waitUntil(() => rows.some(r => r.source === 'renderer' && r.phase === 'started'), 'startAckMissing');
        stage = 'termination';
        if (name === 'stop' || name === 'close') {
          await waitUntil(() => !!release, 'streamNotHeld');
          await waitUntil(() => evaluate('document.getElementById("body").textContent.length === 24'), 'partialMissing');
          const before = requests;
          await enter(); await enter(true); await paint();
          check(requests === before, 'generatingEnterSubmitted');
          await evaluate(`document.getElementById("${name === 'stop' ? 'stop' : 'close'}").click()`);
        }
        await waitUntil(() => rows.some(r => r.source === 'stream'), 'streamSummaryMissing');
        release?.(); // Only now deliver the server's late DONE; it must not revive the terminated request.
        const phase = name === 'stop' ? 'stop' : name === 'close' ? 'close' : 'terminal';
        await waitUntil(() => rows.some(r => r.source === 'renderer' && r.phase === phase), 'finalUiMissing');
        const stream = rows.find(r => r.source === 'stream');
        const ui = rows.find(r => r.source === 'renderer' && r.phase === phase);
        const expectedError = { length: 'outputLimit', eof: 'badResponse', malformed: 'badResponse', network: 'network',
          stop: 'aborted', close: 'aborted' }[name] ?? null;
        const expectedState = name === 'close' ? 'closed' : ['eof', 'network', 'malformed'].includes(name) ? 'error' : 'done';
        check(rows.filter(r => r.source === 'stream').length === 1, 'duplicateSummary');
        check(stream.httpStatus === 200 && stream.errorCode === expectedError && stream.characters === 24, 'wrongStreamSummary');
        check(stream.finishReason === (['normal', 'vision-keyboard', 'ime-button'].includes(name) ? 'stop' : name === 'length' ? 'length' : null), 'wrongFinishReason');
        check(stream.mode === (name === 'vision-keyboard' ? 'vision' : 'text'), 'wrongMode');
        check(stream.doneSeen === ['normal', 'vision-keyboard', 'ime-button', 'length', 'compatible'].includes(name), 'wrongDone');
        check(ui.id === stream.id && ui.state === expectedState && (name === 'close' || !ui.sendDisabled && !ui.stopVisible), 'wrongUiState');
        if (name === 'stop' || name === 'close') check(stream.cancelSource === (name === 'stop' ? 'user' : 'window'), 'wrongCancelSource');
        if (name === 'length') check(await evaluate(`document.getElementById("hint").textContent===${JSON.stringify(words.errors.outputLimit)}
          && document.getElementById("hint").classList.contains("warn") && !document.getElementById("copy").disabled`), 'outputLimitWarningMissing');
        check(!JSON.stringify(rows).includes('Synthetic private'), 'diagnosticLeak');
        results.push({ scenario: name, stream, renderer: ui, status: 'PASS' });
      }
      check(requests === 10 && externalRequests === 0, 'unexpectedRequestCount');
      exitCode = 0;
      console.log(JSON.stringify({ status: 'PASS', syntheticOnly: true, requests, externalRequests, keyboardResults, results }));
    } catch (error) {
      const code = /^[a-zA-Z][a-zA-Z0-9]{0,50}$/.test(error.message) ? error.message : 'diagnosticSmokeFailed';
      console.log(JSON.stringify({ status: 'FAIL', code, scenario, stage, requests, externalRequests, lifecycle, keyboardResults, results }));
    } finally {
      release?.();
      for (const window of BrowserWindow.getAllWindows()) if (!window.isDestroyed()) window.destroy();
      app.exit(exitCode);
    }
  }).catch(() => { console.log('{"status":"FAIL","code":"setupFailed"}'); app.exit(1); });
}
