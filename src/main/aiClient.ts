import type { AiErrorCode } from '../shared/aiConfig';

/** Everything that can go wrong reaches the caller as one typed error; `code` is all the UI ever needs. */
export class AiError extends Error {
  constructor(readonly code: AiErrorCode) {
    super(code);
  }
}

/** Minimal Response stand-in so tests drive the client without Node's fetch. */
export interface FetchResponse {
  ok: boolean;
  status: number;
  body: unknown; // AsyncIterable<Uint8Array> in production
}

export type AiFetch = (url: string, init: {
  method: 'POST';
  headers: Record<string, string>;
  body: string;
  signal: AbortSignal;
  redirect: 'error';
}) => Promise<FetchResponse>;

export interface StreamDeps {
  fetchImpl: AiFetch;
  /** Injectable clock for the watchdogs. */
  now: () => number;
  /** Idle watchdog: no bytes for this long aborts with `timeout`. */
  idleTimeoutMs?: number;
  /** Hard cap on the whole request. */
  totalTimeoutMs?: number;
  /** Defensive cap on accumulated answer characters. */
  maxChars?: number;
  /** Cap sent to the service as max_tokens. */
  maxTokens?: number;
}

const DEFAULTS = { idleTimeoutMs: 30_000, totalTimeoutMs: 180_000, maxChars: 20_000, maxTokens: 1024 };

/**
 * Incremental SSE line parser: feed it decoded text chunks, get back `data:` payloads. It buffers a partial last
 * line across chunks, so a `data:` field split mid-line (or mid-multibyte, which the TextDecoder handles before this)
 * is reassembled, and it knows the `[DONE]` sentinel.
 */
export class SseParser {
  private buffer = '';
  private done = false;

  /** Feed one decoded chunk; returns the data payloads it completed, or the string '[DONE]' when the stream ends. */
  push(chunk: string): string[] {
    if (this.done) return [];
    this.buffer += chunk;
    const out: string[] = [];
    let nl: number;
    while ((nl = this.buffer.indexOf('\n')) >= 0) {
      const line = this.buffer.slice(0, nl).replace(/\r$/, '');
      this.buffer = this.buffer.slice(nl + 1);
      if (line.startsWith(':')) continue; // a comment / keep-alive
      if (line.startsWith('data:')) {
        const data = line.slice(5).replace(/^ /, '');
        if (data === '[DONE]') {
          this.done = true;
          out.push('[DONE]');
          return out;
        }
        if (data.length > 0) out.push(data);
      }
      // Anything else (event:, id:, retry:) is not part of an OpenAI-compatible content stream; skip it.
    }
    return out;
  }
}

/** Pulls the delta text out of one completion chunk; every field is untrusted and checked. */
export function deltaOf(payload: unknown): string {
  if (typeof payload !== 'object' || payload === null) return '';
  const choices = (payload as Record<string, unknown>).choices;
  if (!Array.isArray(choices) || choices.length === 0) return '';
  const first = choices[0];
  if (typeof first !== 'object' || first === null) return '';
  const delta = (first as Record<string, unknown>).delta;
  if (typeof delta !== 'object' || delta === null) return '';
  const content = (delta as Record<string, unknown>).content;
  return typeof content === 'string' ? content : '';
}

function statusToCode(status: number): AiErrorCode {
  if (status === 401 || status === 403) return 'auth';
  if (status === 429) return 'rate';
  if (status >= 500) return 'server';
  return 'http';
}

export interface StreamArgs extends StreamDeps {
  baseUrl: string;
  model: string;
  key: string;
  question: string;
  signal: AbortSignal;
  onDelta: (text: string) => void;
}

/**
 * One streamed chat completion against an OpenAI-compatible `/chat/completions`. Resolves when the answer is
 * complete; rejects with AiError. Redirects are refused outright, so a relocated endpoint can never receive the
 * Authorization header. The watchdogs abort with `timeout`/`tooLong` codes of their own.
 */
export async function streamChat(args: StreamArgs): Promise<void> {
  const { idleTimeoutMs, totalTimeoutMs, maxChars, maxTokens } = { ...DEFAULTS, ...args };
  const url = `${args.baseUrl.replace(/\/+$/, '')}/chat/completions`;
  let received = 0;
  let watchCode: AiErrorCode | null = null;

  // The watchdogs abort a controller of their own; the caller's signal is the user's stop button.
  const controller = new AbortController();
  const fireIdle = (): void => {
    watchCode = 'timeout';
    controller.abort();
  };
  const idleMs = idleTimeoutMs;
  let idleTimer: ReturnType<typeof setTimeout> = setTimeout(fireIdle, idleMs);
  const armIdle = (): void => {
    clearTimeout(idleTimer);
    idleTimer = setTimeout(fireIdle, idleMs);
  };
  const totalTimer: ReturnType<typeof setTimeout> = setTimeout(() => {
    watchCode = 'timeout';
    controller.abort();
  }, totalTimeoutMs);
  const onAbort = (): void => {
    watchCode = watchCode ?? 'aborted';
    controller.abort();
  };
  if (args.signal.aborted) onAbort();
  args.signal.addEventListener('abort', onAbort, { once: true });

  try {
    const res = await args.fetchImpl(url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${args.key}`,
        accept: 'text/event-stream',
      },
      body: JSON.stringify({
        model: args.model,
        messages: [{ role: 'user', content: args.question }],
        stream: true,
        max_tokens: maxTokens,
      }),
      signal: controller.signal,
      redirect: 'error',
    });
    if (!res.ok) throw new AiError(statusToCode(res.status));
    const body = res.body as AsyncIterable<Uint8Array> | null;
    if (!body) throw new AiError('badResponse');
    const iterator = (body as { [Symbol.asyncIterator]?: unknown })[Symbol.asyncIterator];
    if (typeof iterator !== 'function') throw new AiError('badResponse');
    const decoder = new TextDecoder('utf-8');
    const parser = new SseParser();
    for await (const chunk of body) {
      if (args.signal.aborted) throw new AiError('aborted');
      armIdle();
      for (const data of parser.push(decoder.decode(chunk, { stream: true }))) {
        if (data === '[DONE]') return;
        let payload: unknown;
        try {
          payload = JSON.parse(data);
        } catch {
          continue; // one malformed frame in a long stream is survivable
        }
        const text = deltaOf(payload);
        if (text.length > 0) {
          received += text.length;
          args.onDelta(text);
          if (received > maxChars) {
            watchCode = 'tooLong';
            controller.abort();
            throw new AiError('tooLong');
          }
        }
      }
    }
    throw new AiError('badResponse'); // a healthy stream always ends with [DONE]
  } catch (err) {
    if (err instanceof AiError) throw err;
    if (watchCode) throw new AiError(watchCode);
    if (args.signal.aborted) throw new AiError('aborted');
    // fetch throws TypeError on network failure; AbortError when the controller fired (watchCode covered above)
    throw new AiError(err instanceof Error && err.name === 'AbortError' ? 'aborted' : 'network');
  } finally {
    clearTimeout(idleTimer);
    clearTimeout(totalTimer);
    args.signal.removeEventListener('abort', onAbort);
  }
}

/** A one-token probe for the settings page's Test connection button; the same security as a real question. */
export async function pingEndpoint(args: Omit<StreamArgs, 'question' | 'onDelta'>): Promise<void> {
  await streamChat({ ...args, question: 'ping', onDelta: () => undefined, maxTokens: 1 });
}
