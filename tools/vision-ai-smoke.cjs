/*
 * Run with Node after installing dependencies: node tools/vision-ai-smoke.cjs
 * MOCK integration only: production snapshots and client, generated JPEG fixtures, injected byte streams.
 * No desktop capture, real service, configuration, key store, or image file is accessed.
 */
const { mkdirSync } = require('node:fs');
const { join, resolve } = require('node:path');
const { spawnSync } = require('node:child_process');

if (process.argv[2] !== '--mock-worker') {
  const root = resolve(__dirname, '..');
  const output = join(root, 'out', 'vision-ai-smoke', 'main.cjs');
  try {
    mkdirSync(join(root, 'out', 'vision-ai-smoke'), { recursive: true });
    require('esbuild').buildSync({
      entryPoints: [__filename], outfile: output, bundle: true, platform: 'node', format: 'cjs',
      target: 'node22', external: ['esbuild'], logLevel: 'silent',
    });
    const child = spawnSync(process.execPath, [output, '--mock-worker'], {
      cwd: root, encoding: 'utf8', windowsHide: true, timeout: 15000,
    });
    if (child.status === 0 && child.stdout) process.stdout.write(child.stdout);
    else process.stdout.write('FAIL {"ok":false,"mock":true}\n');
    process.exit(child.status === 0 ? 0 : 1);
  } catch {
    process.stdout.write('FAIL {"ok":false,"mock":true}\n');
    process.exit(1);
  }
} else {
  runMock().catch(() => {
    process.stdout.write('FAIL {"ok":false,"mock":true}\n');
    process.exitCode = 1;
  });
}

async function runMock() {
  const started = Date.now();
  const { AiError, streamChat } = require('../src/main/aiClient.ts');
  const { VisionSnapshots } = require('../src/main/visionSnapshot.ts');
  const { TEST_JPEG_DATA_URL, TEST_JPEG_BASE64 } = require('../tests/main/fixtures/visionJpeg.ts');
  let externalRequests = 0;
  let fileWrites = 0;
  let requests = 0;
  const denyNetwork = () => { externalRequests++; throw new Error('networkBlocked'); };
  globalThis.fetch = denyNetwork;
  for (const name of ['node:http', 'node:https']) {
    const transport = require(name);
    transport.request = denyNetwork;
    transport.get = denyNetwork;
  }
  const net = require('node:net');
  net.connect = denyNetwork;
  net.createConnection = denyNetwork;
  const denyWrite = () => { fileWrites++; throw new Error('writeBlocked'); };
  const fs = require('node:fs');
  fs.writeFileSync = denyWrite;
  fs.writeFile = denyWrite;
  fs.promises.writeFile = denyWrite;

  const check = (condition) => { if (!condition) throw new Error('smokeAssertion'); };
  const encode = new TextEncoder();
  const delta = (content, reasoning = undefined) => `data: ${JSON.stringify({
    choices: [{ delta: { content, reasoning_content: reasoning } }],
  })}\r\n\r\n`;
  const done = 'data: [DONE]\r\n\r\n';
  const byteStream = (text) => (async function* () {
    const bytes = encode.encode(text);
    // Single-byte chunks exercise UTF-8 and CRLF splits in the actual streaming parser.
    for (const byte of bytes) yield Uint8Array.of(byte);
  })();
  const recipient = { baseUrl: 'https://mock.invalid/v1', model: 'mock-vision' };
  const image = (dataUrl) => ({ dataUrl, width: 2, height: 1, marker: { x: 0.25, y: 0.5 } });
  const jpeg = Buffer.from(TEST_JPEG_BASE64, 'base64');
  // A JPEG comment distinguishes the full image while retaining valid generated pixels.
  const full = `data:image/jpeg;base64,${Buffer.concat([
    jpeg.subarray(0, 2), Buffer.from([0xff, 0xfe, 0, 6, 102, 117, 108, 108]), jpeg.subarray(2),
  ]).toString('base64')}`;
  const preview = {
    displayId: 1, original: { x: 0, y: 0, width: 2, height: 1 },
    crop: { x: 0, y: 0, width: 2, height: 1 },
    local: image(TEST_JPEG_DATA_URL), full: image(full),
  };
  const snapshots = new VisionSnapshots({ now: () => 100 });
  const ref = snapshots.capture(7, preview, recipient);
  // Mutating the source after approval must not change the main-owned snapshot.
  preview.local.dataUrl = 'file:///unapproved';
  preview.full.dataUrl = 'https://mock.invalid/unapproved';
  const request = (extra = {}) => ({
    ...recipient, key: 'synthetic-smoke-key', question: 'synthetic-smoke-question',
    signal: new AbortController().signal, now: () => 100, onDelta: () => undefined, ...extra,
  });
  const goodStream = () => byteStream(delta('', 'hidden synthetic reasoning') + delta('合成回答') + done);
  const expectedBytes = [TEST_JPEG_DATA_URL, full];
  const scopeCounts = [];

  try {
    for (const scope of ['local', 'localAndFull']) {
      const images = snapshots.select(7, ref.snapshotId, scope, recipient);
      const seen = [];
      await streamChat(request({ images, onDelta: (text) => seen.push(text), fetchImpl: async (url, init) => {
        requests++;
        check(url === `${recipient.baseUrl}/chat/completions` && init.redirect === 'error');
        const payload = JSON.parse(init.body);
        const content = payload.messages[0].content;
        const count = scope === 'local' ? 1 : 2;
        check(payload.stream === true && payload.model === recipient.model && content.length === count + 1);
        const expectedText = 'synthetic-smoke-question\n\n'
          + 'Image 1 is the local crop. Original ping position (normalized from the top-left): x=0.25, y=0.5.'
          + (count === 2 ? '\nImage 2 is the full monitor. Original ping position '
            + '(normalized from the top-left): x=0.25, y=0.5.' : '');
        check(content[0].type === 'text' && content[0].text === expectedText);
        for (let i = 0; i < count; i++) {
          check(content[i + 1].type === 'image_url' && content[i + 1].image_url.url === expectedBytes[i]);
          check(Object.keys(content[i + 1].image_url).length === 1);
        }
        scopeCounts.push(count);
        return { ok: true, status: 200, body: goodStream() };
      } }));
      check(seen.join('') === '合成回答');
    }

    let textString = false;
    await streamChat(request({ fetchImpl: async (_url, init) => {
      requests++;
      textString = JSON.parse(init.body).messages[0].content === 'synthetic-smoke-question';
      check(textString);
      return { ok: true, status: 200, body: goodStream() };
    } }));

    const user = new AbortController();
    const stopped = [];
    let requestSignal;
    let aborted = false;
    try {
      await streamChat(request({ signal: user.signal, onDelta: (text) => { stopped.push(text); user.abort(); },
        fetchImpl: async (_url, init) => {
          requests++;
          requestSignal = init.signal;
          // A late frame already buffered in the same chunk must not escape after Stop.
          return { ok: true, status: 200, body: (async function* () {
            yield encode.encode(delta('first') + delta('late') + done);
          })() };
        },
      }));
    } catch (error) { aborted = error instanceof AiError && error.code === 'aborted'; }
    check(aborted && requestSignal?.aborted && stopped.length === 1 && stopped[0] === 'first');

    let safePlan = false;
    try {
      await streamChat(request({ fetchImpl: async () => {
        requests++;
        return { ok: false, status: 429,
          body: byteStream(JSON.stringify({ error: { code: '1314', message: 'private synthetic server echo' } })) };
      } }));
    } catch (error) {
      safePlan = error instanceof AiError && error.code === 'plan' && error.message === 'plan';
    }
    let doneRequired = false;
    try {
      await streamChat(request({ fetchImpl: async () => {
        requests++;
        return { ok: true, status: 200, body: byteStream(delta('incomplete')) };
      } }));
    } catch (error) { doneRequired = error instanceof AiError && error.code === 'badResponse'; }
    check(safePlan && doneRequired && externalRequests === 0 && fileWrites === 0);
    process.stdout.write(`PASS ${JSON.stringify({
      ok: true, mock: true, requests, localImages: scopeCounts[0], fullScopeImages: scopeCounts[1],
      exactApprovedBytes: true, markerContext: true, fullExcludedByDefault: scopeCounts[0] === 1, textString,
      reasoningHidden: true, doneRequired, stopAborted: aborted, lateFrameIgnored: stopped.length === 1,
      safePlan, externalRequests, imageFileWrites: fileWrites, elapsedMs: Date.now() - started,
    })}\n`);
  } finally {
    snapshots.clear();
  }
}
