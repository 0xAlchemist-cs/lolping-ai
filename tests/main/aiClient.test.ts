import { describe, expect, it, vi } from 'vitest';
import { AiError, deltaOf, pingEndpoint, runChat, SseParser, streamChat, type FetchResponse, type StreamArgs } from '../../src/main/aiClient';
import type { VisionImage } from '../../src/shared/vision';
import { TEST_JPEG_DATA_URL } from './fixtures/visionJpeg';

const encoder = new TextEncoder();
const sse = (frames: string[]): AsyncIterable<Uint8Array> =>
  (async function* () {
    for (const f of frames) yield encoder.encode(f);
  })();
const chunk = (delta: string): string =>
  `data: ${JSON.stringify({ choices: [{ delta: { content: delta } }] })}\n\n`;

describe('SseParser', () => {
  it('reassembles a data line split across pushes', () => {
    const p = new SseParser();
    const line = `data: ${JSON.stringify({ choices: [{ delta: { content: 'A B' } }] })}`;
    const mid = Math.floor(line.length / 2);
    expect(p.push(line.slice(0, mid))).toEqual([]);
    const out = p.push(`${line.slice(mid)}\n\n`);
    expect(JSON.parse(out[0])).toEqual({ choices: [{ delta: { content: 'A B' } }] });
  });

  it('handles several frames in one chunk, with CRLF ends', () => {
    const p = new SseParser();
    const two = chunk('一') + '\r\n' + chunk('二') + '\r\n';
    const out = p.push(two);
    expect(out.map((d) => deltaOf(JSON.parse(d)))).toEqual(['一', '二']);
  });

  it('stops at [DONE] and ignores everything after it', () => {
    const p = new SseParser();
    expect(p.push(`data: [DONE]\n\ndata: more\n`)).toEqual(['[DONE]']);
    expect(p.push('data: late\n')).toEqual([]);
  });

  it('skips comments and non-data fields', () => {
    const p = new SseParser();
    expect(p.push(`: ping\nevent: x\nid: 7\ndata: {"a":1}\n\n`)).toEqual(['{"a":1}']);
  });

  it('dispatches complete multiline events and bounds unfinished frames', () => {
    const p = new SseParser();
    expect(p.push('data: {"choices":\r\n')).toEqual([]);
    expect(p.push('data: []}\r\n\r\n')).toEqual(['{"choices":\n[]}']);
    expect(() => p.push('x'.repeat(300_000))).toThrow(AiError);
  });
});

describe('deltaOf', () => {
  it('pulls the content out of a well-formed frame and nothing out of anything else', () => {
    expect(deltaOf({ choices: [{ delta: { content: 'hi' } }] })).toBe('hi');
    expect(deltaOf({ choices: [{ delta: {} }] })).toBe('');
    expect(deltaOf({ choices: [] })).toBe('');
    expect(deltaOf(null)).toBe('');
    expect(deltaOf('x')).toBe('');
    expect(deltaOf({ choices: [{ delta: { content: 7 } }] })).toBe('');
  });
});

/** A fetch double the tests shape per case; production passes Electron's global fetch. */
const fakeFetch = vi.fn<() => Promise<FetchResponse>>();
const now = () => 0;

const request = (overrides: Partial<StreamArgs> = {}): StreamArgs => ({
  baseUrl: 'https://api.example.com/v1', model: 'm', key: 'synthetic-test-key', question: 'explain',
  signal: new AbortController().signal, fetchImpl: fakeFetch as never, now, onDelta: () => undefined, ...overrides,
});
const image = (): VisionImage => ({
  dataUrl: TEST_JPEG_DATA_URL, width: 2, height: 1, marker: { x: 0.5, y: 0.5 },
});

const okHeaders = { 'content-type': 'application/json', authorization: 'Bearer sk-test', accept: 'text/event-stream' };

async function expectCode(p: Promise<unknown>, code: string): Promise<void> {
  try {
    await p;
    throw new Error(`expected ${code}, got success`);
  } catch (err) {
    if (err instanceof AiError) expect(err.code).toBe(code);
    else throw err;
  }
}

describe('streamChat', () => {
  it('routes a null handler to an empty one-token text probe without supplied images', async () => {
    const fetchImpl = vi.fn(async () => ({ ok: true, status: 200, body: sse(['data: [DONE]\n\n']) }));
    await runChat({ ...request({ images: [image()], fetchImpl }), onDelta: null });
    const [, init] = fetchImpl.mock.calls[0] as unknown as [string, { body: string }];
    const payload = JSON.parse(init.body);
    expect(payload.messages).toEqual([{ role: 'user', content: 'ping' }]);
    expect(payload.max_tokens).toBe(1);
  });

  it('keeps an ordinary completion empty-response failure and forwards its content handler', async () => {
    await expectCode(runChat(request({ fetchImpl: async () => ({ ok: true, status: 200,
      body: sse(['data: [DONE]\n\n']) }) })), 'badResponse');
    const seen: string[] = [];
    await runChat(request({ onDelta: (text) => seen.push(text),
      fetchImpl: async () => ({ ok: true, status: 200, body: sse([chunk('answer'), 'data: [DONE]\n\n']) }) }));
    expect(seen).toEqual(['answer']);
  });

  it('preserves string text messages and sends the exact one or two supplied JPEGs', async () => {
    for (const images of [undefined, [], [image()], [image(), image()]]) {
      const fetchImpl = vi.fn(async () => ({ ok: true, status: 200, body: sse([chunk('ok'), 'data: [DONE]\n\n']) }));
      await streamChat(request({ images, fetchImpl }));
      const [, init] = fetchImpl.mock.calls[0] as unknown as [string, { body: string }];
      const content = JSON.parse(init.body).messages[0].content;
      expect(content).toEqual(images?.length ? [
        { type: 'text', text: 'explain\n\n'
          + 'Image 1 is the local crop. Original ping position (normalized from the top-left): x=0.5, y=0.5.'
          + (images.length === 2 ? '\nImage 2 is the full monitor. Original ping position (normalized from the top-left): x=0.5, y=0.5.' : '') },
        ...images.map((im) => ({ type: 'image_url', image_url: { url: im.dataUrl } })),
      ] : 'explain');
    }
  });

  it('gives the model each image scope and its actual normalized original ping position', async () => {
    const images = [{ ...image(), marker: { x: 0.123, y: 0.987 } },
      { ...image(), marker: { x: 0.456, y: 0.654 } }];
    const fetchImpl = vi.fn(async () => ({ ok: true, status: 200, body: sse([chunk('ok'), 'data: [DONE]\n\n']) }));
    await streamChat(request({ images, fetchImpl }));
    const [, init] = fetchImpl.mock.calls[0] as unknown as [string, { body: string }];
    const content = JSON.parse(init.body).messages[0].content;
    expect(content[0]).toEqual({ type: 'text', text: 'explain\n\n'
      + 'Image 1 is the local crop. Original ping position (normalized from the top-left): x=0.123, y=0.987.\n'
      + 'Image 2 is the full monitor. Original ping position (normalized from the top-left): x=0.456, y=0.654.' });
    expect(content.slice(1)).toEqual(images.map((im) => ({ type: 'image_url', image_url: { url: im.dataUrl } })));
  });

  it('rejects invalid image sources and payloads before fetching', async () => {
    const fetchImpl = vi.fn();
    for (const dataUrl of ['https://example.com/a.jpg', 'file:///a.jpg', 'data:image/png;base64,/9j/2Q==',
      'data:image/jpeg;base64,???', 'data:image/jpeg;base64,YWJj', image().dataUrl.replace(/=$/, '')]) {
      await expectCode(streamChat(request({ images: [{ ...image(), dataUrl }], fetchImpl })), 'imageInvalid');
    }
    await expectCode(streamChat(request({ images: [image(), image(), image()], fetchImpl })), 'imageInvalid');
    await expectCode(streamChat(request({ images: [{ ...image(), width: 0 }], fetchImpl })), 'imageInvalid');
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('does not fetch an already cancelled request', async () => {
    const user = new AbortController();
    user.abort();
    const fetchImpl = vi.fn();
    await expectCode(streamChat(request({ signal: user.signal, fetchImpl })), 'aborted');
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('ignores reasoning, preserves split UTF-8 and parses multiline event data', async () => {
    const bytes = encoder.encode('data: {"choices":\r\ndata: [{"delta":{"reasoning_content":"hidden"}}]}\r\n\r\n'
      + chunk('世界') + 'data: [DONE]\n\n');
    const seen: string[] = [];
    const fetchImpl = async () => ({ ok: true, status: 200, body: (async function* () {
      for (const byte of bytes) yield Uint8Array.of(byte);
    })() });
    await streamChat(request({ fetchImpl, onDelta: (t) => seen.push(t) }));
    expect(seen).toEqual(['世界']);
  });

  it('requires visible content and DONE even after finish_reason, but allows an empty connection probe', async () => {
    for (const frames of [['data: [DONE]\n\n'], [chunk('answer'), 'data: {"choices":[{"finish_reason":"stop"}]}\n\n'],
      ['data: {"choices":[{"delta":{"reasoning_content":"hidden"}}]}\n\n', 'data: [DONE]\n\n']]) {
      await expectCode(streamChat(request({ fetchImpl: async () => ({ ok: true, status: 200, body: sse(frames) }) })), 'badResponse');
    }
    await pingEndpoint(request({ fetchImpl: async () => ({ ok: true, status: 200, body: sse(['data: [DONE]\n\n']) }) }));
  });

  it('maps only allowed structured errors without exposing remote message data', async () => {
    for (const [providerCode, expected] of [['1314', 'plan'], ['1220', 'permission'], ['unsupported_image', 'imageUnsupported'],
      ['untrusted-secret', 'http']] as const) {
      const payload = JSON.stringify({ error: { code: providerCode, message: 'sensitive server echo' } });
      for (const streamed of [false, true]) {
        const fetchImpl = async () => ({ ok: streamed, status: streamed ? 200 : 400,
          body: sse([streamed ? `data: ${payload}\n\n` : payload]) });
        try {
          await streamChat(request({ fetchImpl }));
          throw new Error('expected failure');
        } catch (err) {
          expect(err).toBeInstanceOf(AiError);
          expect((err as AiError).code).toBe(expected);
          expect((err as Error).message).toBe(expected);
        }
      }
    }
  });

  it('stops before delivering a delta over the output cap', async () => {
    const seen: string[] = [];
    await expectCode(streamChat(request({ maxChars: 3, onDelta: (t) => seen.push(t),
      fetchImpl: async () => ({ ok: true, status: 200, body: sse([chunk('ok'), chunk('oversized')]) }) })), 'tooLong');
    expect(seen).toEqual(['ok']);
  });

  it('identifies HTTP 413 as the service image limit without exposing the response body', async () => {
    await expectCode(streamChat(request({ images: [image(), image()], fetchImpl: async () => ({
      ok: false, status: 413, body: sse(['{"error":{"message":"synthetic private echo"}}']),
    }) })), 'imageTooLarge');
  });

  it('bounds remote error bodies and trusts the status when a body is incomplete', async () => {
    const body = sse(['{"error":{"code":"1314","message":"', 'x'.repeat(20_000)]);
    await expectCode(streamChat(request({ fetchImpl: async () => ({ ok: false, status: 429, body }) })), 'rate');
    await expectCode(streamChat(request({ fetchImpl: async () => ({ ok: false, status: 404, body: {} }) })), 'notFound');
    await expectCode(streamChat(request({ fetchImpl: async () => ({ ok: false, status: 503,
      body: sse(['{"error":{"message":"secret body"}}']) }) })), 'server');
  });

  it('ignores malformed events but rejects an unfinished event at EOF', async () => {
    const seen: string[] = [];
    await streamChat(request({ onDelta: (t) => seen.push(t), fetchImpl: async () => ({ ok: true, status: 200,
      body: sse(['data: invalid json\n\n', chunk('answer'), 'data: [DONE]\n\n']) }) }));
    expect(seen).toEqual(['answer']);
    await expectCode(streamChat(request({ fetchImpl: async () => ({ ok: true, status: 200,
      body: sse([chunk('answer'), 'data: [DONE]\n']) }) })), 'badResponse');
  });

  it('rejects oversized images before a fetch', async () => {
    const fetchImpl = vi.fn();
    await expectCode(streamChat(request({ images: [{ ...image(),
      dataUrl: 'data:image/jpeg;base64,' + 'A'.repeat(8 * 1024 * 1024),
    }], fetchImpl })), 'imageTooLarge');
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('cancels promptly even when a body or fetch ignores AbortSignal', async () => {
    for (const waitingOnBody of [false, true]) {
      const user = new AbortController();
      let release: () => void = () => undefined;
      const started = new Promise<void>((resolve) => { release = resolve; });
      const never = new Promise<never>(() => undefined);
      const fetchImpl = async (): Promise<FetchResponse> => {
        if (!waitingOnBody) { release(); return never; }
        return { ok: true, status: 200, body: (async function* () { release(); await never; })() };
      };
      const pending = streamChat(request({ signal: user.signal, fetchImpl }));
      const assertion = expectCode(pending, 'aborted');
      await started;
      user.abort();
      await assertion;
    }
  });

  it('enforces a total deadline even while keep-alives reset idle time', async () => {
    vi.useFakeTimers();
    try {
      const body = (async function* () {
        while (true) {
          yield encoder.encode(': keep-alive\n\n');
          await new Promise((resolve) => setTimeout(resolve, 10));
        }
      })();
      const pending = streamChat(request({ idleTimeoutMs: 50, totalTimeoutMs: 100,
        fetchImpl: async () => ({ ok: true, status: 200, body }) }));
      const assertion = expectCode(pending, 'timeout');
      await vi.advanceTimersByTimeAsync(100);
      await assertion;
    } finally {
      vi.useRealTimers();
    }
  });
  it('streams deltas in order and completes at [DONE]', async () => {
    fakeFetch.mockResolvedValueOnce({
      ok: true, status: 200, body: sse([chunk('Hel'), chunk('lo '), chunk('世界'), `data: [DONE]\n\n`]),
    });
    const seen: string[] = [];
    await streamChat({
      baseUrl: 'https://api.example.com/v1', model: 'm1', key: 'sk-test', question: 'q',
      signal: new AbortController().signal, fetchImpl: fakeFetch as never, now, onDelta: (t) => seen.push(t),
    });
    expect(seen).toEqual(['Hel', 'lo ', '世界']);
    const [url, init] = fakeFetch.mock.calls[0] as unknown as [string, { body: string; headers: Record<string, string>; redirect: string }];
    expect(url).toBe('https://api.example.com/v1/chat/completions');
    expect(init.redirect).toBe('error');
    expect(init.headers).toEqual(okHeaders);
    expect(JSON.parse(init.body).model).toBe('m1');
  });

  it('maps HTTP statuses to stable codes', async () => {
    for (const [status, code] of [[401, 'auth'], [403, 'permission'], [404, 'notFound'], [429, 'rate'], [500, 'server'], [503, 'server'], [302, 'http']] as const) {
      fakeFetch.mockResolvedValueOnce({ ok: false, status, body: null });
      await expectCode(streamChat({
        baseUrl: 'https://x.example.com', model: 'm', key: 'k', question: 'q',
        signal: new AbortController().signal, fetchImpl: fakeFetch as never, now, onDelta: () => undefined,
      }), code);
    }
  });

  it('a network failure is network; a fetch-level abort is aborted', async () => {
    fakeFetch.mockRejectedValueOnce(new TypeError('fetch failed'));
    await expectCode(streamChat({
      baseUrl: 'https://x.example.com', model: 'm', key: 'k', question: 'q',
      signal: new AbortController().signal, fetchImpl: fakeFetch as never, now, onDelta: () => undefined,
    }), 'network');

    fakeFetch.mockRejectedValueOnce(Object.assign(new Error('aborted'), { name: 'AbortError' }));
    await expectCode(streamChat({
      baseUrl: 'https://x.example.com', model: 'm', key: 'k', question: 'q',
      signal: new AbortController().signal, fetchImpl: fakeFetch as never, now, onDelta: () => undefined,
    }), 'aborted');
  });

  it('the user stop signal aborts mid-stream as aborted', async () => {
    const user = new AbortController();
    fakeFetch.mockResolvedValueOnce({
      ok: true, status: 200,
      body: (async function* () {
        yield encoder.encode(chunk('one'));
        user.abort(); // the stop button lands between chunks
        yield encoder.encode(chunk('two'));
      })(),
    });
    await expectCode(streamChat({
      baseUrl: 'https://x.example.com', model: 'm', key: 'k', question: 'q',
      signal: user.signal, fetchImpl: fakeFetch as never, now, onDelta: () => undefined,
    }), 'aborted');
  });

  it('the idle watchdog fires when the service goes quiet', async () => {
    vi.useFakeTimers();
    try {
      fakeFetch.mockResolvedValueOnce({
        ok: true, status: 200,
        body: (async function* () {
          yield encoder.encode(chunk('first'));
          // Silence — and a promise the fake clock can break, so the loop really ends.
          await new Promise((_, reject) => {
            setTimeout(() => reject(new Error('quiet')), 1000);
          });
        })(),
      });
      const p = streamChat({
        baseUrl: 'https://x.example.com', model: 'm', key: 'k', question: 'q',
        signal: new AbortController().signal, fetchImpl: fakeFetch as never,
        now: Date.now, idleTimeoutMs: 50, onDelta: () => undefined,
      });
      const assertion = expectCode(p, 'timeout');
      await vi.advanceTimersByTimeAsync(2000); // the 50ms watchdog fires before the 1000ms silence ends
      await assertion;
    } finally {
      vi.useRealTimers();
    }
  });

  it('a runaway stream is cut off at the character cap', async () => {
    fakeFetch.mockResolvedValueOnce({
      ok: true, status: 200,
      body: sse([chunk('x'.repeat(30)), chunk('y'.repeat(30)), `data: [DONE]\n\n`]),
    });
    await expectCode(streamChat({
      baseUrl: 'https://x.example.com', model: 'm', key: 'k', question: 'q',
      signal: new AbortController().signal, fetchImpl: fakeFetch as never, now,
      maxChars: 50, onDelta: () => undefined,
    }), 'tooLong');
  });

  it('a body without the async iterator shape is badResponse, and so is a stream that ends without [DONE]', async () => {
    fakeFetch.mockResolvedValueOnce({ ok: true, status: 200, body: {} });
    await expectCode(streamChat({
      baseUrl: 'https://x.example.com', model: 'm', key: 'k', question: 'q',
      signal: new AbortController().signal, fetchImpl: fakeFetch as never, now, onDelta: () => undefined,
    }), 'badResponse');
    fakeFetch.mockResolvedValueOnce({ ok: true, status: 200, body: sse([chunk('partial')]) });
    await expectCode(streamChat({
      baseUrl: 'https://x.example.com', model: 'm', key: 'k', question: 'q',
      signal: new AbortController().signal, fetchImpl: fakeFetch as never, now, onDelta: () => undefined,
    }), 'badResponse');
  });
});
