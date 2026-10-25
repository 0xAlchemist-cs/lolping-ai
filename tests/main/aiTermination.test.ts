import { afterEach, describe, expect, it, vi } from 'vitest';
import { AiError, streamChat, type AiFetch, type StreamArgs, type StreamDiagnostic } from '../../src/main/aiClient';

const encode = new TextEncoder();
const event = (delta: Record<string, string>, finish_reason?: string): string =>
  `data: ${JSON.stringify({ choices: [{ delta, ...(finish_reason ? { finish_reason } : {}) }] })}\r\n\r\n`;
const content = event({ content: 'prefix' });
const done = 'data: [DONE]\r\n\r\n';
const stop = event({}, 'stop');
const length = event({}, 'length');
const reasoning = 'data: {"choices":\r\ndata: [{"delta":{"reasoning_content":"hidden sentinel"}}]}\r\n\r\n';
const cases = [
  { name: 'body + DONE without finish reason stays compatible', frames: [content, done], want: null,
    visible: 'prefix', reason: null, done: true },
  { name: 'normal stop + DONE', frames: [content, stop, done], want: null, visible: 'prefix', reason: 'stop', done: true },
  { name: 'length + DONE', frames: [content, length, done], want: 'outputLimit', visible: 'prefix', reason: 'length', done: true },
  { name: 'length without DONE', frames: [content, length], want: 'badResponse', visible: 'prefix', reason: 'length', done: false },
  { name: 'body EOF without DONE', frames: [content], want: 'badResponse', visible: 'prefix', reason: null, done: false },
  { name: 'network failure after content', frames: [content], fault: true, want: 'network', visible: 'prefix', reason: null, done: false },
  { name: 'only reasoning', frames: [reasoning, stop, done], want: 'badResponse', visible: '', reason: 'stop', done: true },
  { name: 'no content', frames: [done], want: 'badResponse', visible: '', reason: null, done: true },
  { name: 'local character cap', frames: [content, event({ content: 'over cap' }), done], maxChars: 6,
    want: 'tooLong', visible: 'prefix', reason: null, done: false },
  { name: 'streamed provider error after content', frames: [content, 'data: {"error":{"code":"1230","message":"private echo"}}\n\n', done],
    want: 'server', visible: 'prefix', reason: null, done: false },
  { name: 'malformed event after content', frames: [content, 'data: {broken}\n\n', done],
    want: 'badResponse', visible: 'prefix', reason: null, done: false },
  { name: 'single-byte Unicode/multiline/CRLF/DONE', frames: [reasoning, event({ content: '中🙂\n**ok**' }), stop, done],
    bytes: true, want: null, visible: '中🙂\n**ok**', reason: 'stop', done: true },
  { name: 'duplicate termination', frames: [content, stop, done + done + event({ content: 'late' })],
    want: null, visible: 'prefix', reason: 'stop', done: true },
  { name: 'unknown finish reason is redacted', frames: [content, event({}, 'provider secret'), done],
    want: 'badResponse', visible: 'prefix', reason: 'other', done: true },
  { name: 'later stop cannot erase an unsupported finish reason', frames: [content, event({}, 'provider secret'), stop, done],
    want: 'badResponse', visible: 'prefix', reason: 'other', done: true },
] as const;

afterEach(() => vi.useRealTimers());

describe('AI termination diagnostics', () => {
  it('cannot have completion changed by a failing optional observer', async () => {
    const text: string[] = [];
    await streamChat({ baseUrl: 'https://fixture.invalid', model: 'fixture', key: 'synthetic', question: 'synthetic',
      signal: new AbortController().signal, now: () => 0, onDelta: value => text.push(value),
      onDiagnostic: () => { throw new Error('synthetic observer failure'); },
      fetchImpl: async () => ({ ok: true, status: 200, body: (async function* () { yield encode.encode(content + stop + done); })() }),
    });
    expect(text).toEqual(['prefix']);
  });
  it.each(cases)('$name preserves emitted text and reports one bounded private-free terminal summary', async (scenario) => {
    const seen: string[] = [];
    const summaries: StreamDiagnostic[] = [];
    let clock = 100;
    const fetchImpl = vi.fn<AiFetch>(async (_url, init) => {
      expect(JSON.parse(init.body).max_tokens).toBe(1024);
      return { ok: true, status: 200, body: (async function* () {
        for (const frame of scenario.frames) {
          const bytes = encode.encode(frame);
          if ('bytes' in scenario) for (const byte of bytes) yield Uint8Array.of(byte);
          else yield bytes;
        }
        if ('fault' in scenario) throw new TypeError('private network detail');
      })() };
    });
    const args: StreamArgs = { baseUrl: 'https://fixture.invalid/v1', model: 'fixture-model', key: 'synthetic private key',
      question: 'synthetic private question', signal: new AbortController().signal, fetchImpl, now: () => clock,
      onDelta: text => { seen.push(text); clock = 120; }, onDiagnostic: info => summaries.push(info),
      ...('maxChars' in scenario ? { maxChars: scenario.maxChars } : {}),
    };
    let code = null;
    try { await streamChat(args); } catch (error) {
      expect(error).toBeInstanceOf(AiError); code = (error as AiError).code;
    }
    expect(code).toBe(scenario.want);
    expect(seen.join('')).toBe(scenario.visible);
    expect(fetchImpl).toHaveBeenCalledOnce();
    expect(summaries).toHaveLength(1);
    expect(summaries[0]).toMatchObject({ mode: 'text', httpStatus: 200, deltaCount: seen.length,
      characters: scenario.visible.length, finishReason: scenario.reason, doneSeen: scenario.done,
      aborted: false, errorCode: scenario.want, outputLimited: scenario.reason === 'length',
      elapsedMs: scenario.visible ? 20 : 0, stage: 'sse', timeoutKind: null, cancelSource: null });
    expect(summaries[0].sseEvents).toBeGreaterThan(0);
    const serialized = JSON.stringify(summaries);
    for (const secret of ['synthetic private', 'hidden sentinel', 'private echo', 'private network', 'provider secret', 'prefix']) {
      expect(serialized).not.toContain(secret);
    }
    expect(Object.isFrozen(summaries[0])).toBe(true);
  });

  it.each(['idle', 'total'] as const)('classifies the %s watchdog rather than a fabricated DONE', async kind => {
    vi.useFakeTimers();
    const summaries: StreamDiagnostic[] = [];
    const args: StreamArgs = { baseUrl: 'https://fixture.invalid', model: 'fixture', key: 'synthetic', question: 'synthetic',
      signal: new AbortController().signal, now: Date.now, idleTimeoutMs: kind === 'idle' ? 50 : 100,
      totalTimeoutMs: kind === 'total' ? 50 : 100,
      fetchImpl: async () => ({ ok: true, status: 200, body: (async function* () { await new Promise(() => {}); })() }),
      onDelta: () => { throw new Error('unexpectedDelta'); }, onDiagnostic: info => summaries.push(info) };
    const pending = expect(streamChat(args)).rejects.toMatchObject({ code: 'timeout' });
    await vi.advanceTimersByTimeAsync(50); await pending;
    expect(summaries).toHaveLength(1);
    expect(summaries[0]).toMatchObject({ deltaCount: 0, characters: 0, doneSeen: false, aborted: true,
      errorCode: 'timeout', elapsedMs: 50, timeoutKind: kind, cancelSource: null });
  });

  it('reports explicit Stop once and drops content even when the server continues returning', async () => {
    const user = new AbortController(); const summaries: StreamDiagnostic[] = []; const seen: string[] = [];
    await expect(streamChat({ baseUrl: 'https://fixture.invalid', model: 'fixture', key: 'synthetic', question: 'synthetic',
      signal: user.signal, now: () => 0, onDelta: text => { seen.push(text); user.abort(); }, onDiagnostic: info => summaries.push(info),
      fetchImpl: async () => ({ ok: true, status: 200, body: (async function* () { yield encode.encode(content + event({ content: 'late' }) + done); })() }),
    })).rejects.toMatchObject({ code: 'aborted' });
    expect(seen).toEqual(['prefix']);
    expect(summaries).toHaveLength(1);
    expect(summaries[0]).toMatchObject({ deltaCount: 1, characters: 6, doneSeen: false, aborted: true, errorCode: 'aborted' });
  });
});
