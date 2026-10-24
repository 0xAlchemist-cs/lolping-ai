import { describe, expect, it, vi } from 'vitest';
import { AiError, deltaOf, SseParser, streamChat, type FetchResponse } from '../../src/main/aiClient';

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
    const out = p.push(`${line.slice(mid)}\n`);
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
    expect(p.push(`: ping\nevent: x\nid: 7\ndata: {"a":1}\n`)).toEqual(['{"a":1}']);
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
    for (const [status, code] of [[401, 'auth'], [403, 'auth'], [429, 'rate'], [500, 'server'], [503, 'server'], [302, 'http']] as const) {
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
