import type { AiErrorCode } from '../shared/aiConfig';
import type { VisionImage } from '../shared/vision';
import { validateVisionImages, VisionSnapshotError } from './visionSnapshot';

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

const MAX_SSE_EVENT_CHARS = 256 * 1024;
const MAX_ERROR_BYTES = 16 * 1024;

/** Incremental, bounded SSE events; multiline data fields dispatch only at the empty event separator. */
export class SseParser {
  private buffer = '';
  private data: string[] = [];
  private eventChars = 0;
  private done = false;

  /** Feed one decoded chunk; returns the data payloads it completed, or the string '[DONE]' when the stream ends. */
  push(chunk: string): string[] {
    if (this.done) return [];
    const out: string[] = [];
    // Consume each chunk incrementally so a peer cannot grow the retained partial line without a bound.
    let start = 0;
    while (start < chunk.length) {
      const nl = chunk.indexOf('\n', start);
      const end = nl < 0 ? chunk.length : nl;
      if (this.buffer.length + end - start + this.eventChars > MAX_SSE_EVENT_CHARS) {
        throw new AiError('badResponse');
      }
      this.buffer += chunk.slice(start, end);
      if (nl < 0) break;
      const line = this.buffer.replace(/\r$/, '');
      this.buffer = '';
      start = nl + 1;
      if (line === '') {
        const data = this.data.join('\n');
        this.data = [];
        this.eventChars = 0;
        if (data === '') continue;
        out.push(data);
        if (data === '[DONE]') {
          this.done = true;
          return out;
        }
      } else {
        this.eventChars += line.length + 1;
        if (line === 'data' || line.startsWith('data:')) this.data.push(line.slice(5).replace(/^ /, ''));
      }
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
  if (status === 401) return 'auth';
  if (status === 403) return 'permission';
  if (status === 404) return 'notFound';
  if (status === 413) return 'imageTooLarge';
  if (status === 429) return 'rate';
  if (status >= 500 && status <= 599) return 'server';
  return 'http';
}

export interface StreamArgs extends StreamDeps {
  baseUrl: string;
  model: string;
  key: string;
  question: string;
  images?: readonly VisionImage[];
  signal: AbortSignal;
  onDelta: (text: string) => void;
}

/**
 * One streamed chat completion against an OpenAI-compatible `/chat/completions`. Resolves when the answer is
 * complete; rejects with AiError. Redirects are refused outright, so a relocated endpoint can never receive the
 * Authorization header. The watchdogs abort with `timeout`/`tooLong` codes of their own.
 */
export async function streamChat(args: StreamArgs): Promise<void> {
  await runStream(args, false);
}

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null ? value as Record<string, unknown> : null;
}

/** Provider details stay private; only documented numeric codes and explicit image types become UI codes. */
function providerError(payload: unknown, fallback: AiErrorCode = 'http'): AiErrorCode | null {
  const error = record(payload)?.error;
  if (error === undefined || error === null) return null;
  const fields = record(error);
  const code = fields?.code;
  const numeric = typeof code === 'number' && Number.isInteger(code) ? String(code)
    : typeof code === 'string' ? code : '';
  if (['1000', '1001', '1003', '1005'].includes(numeric)) return 'auth';
  if (numeric === '1220') return 'permission';
  if (['1211', '1221', '1222'].includes(numeric)) return 'notFound';
  if (['1113', '1309', '1311', '1314', '1315'].includes(numeric)) return 'plan';
  if (['1302', '1305', '1308', '1310', '1313', '1316', '1317', '1318', '1319', '1320', '1321'].includes(numeric)) {
    return 'rate';
  }
  if (['1200', '1230', '1234'].includes(numeric)) return 'server';
  // Do not infer image support from remote error messages, which may echo keys or screenshots.
  if ([code, fields?.type].some((value) => value === 'unsupported_image' || value === 'image_not_supported')) {
    return 'imageUnsupported';
  }
  return fallback;
}

function bodyIterator(body: unknown): AsyncIterator<Uint8Array> | null {
  if (body === null || typeof body !== 'object') return null;
  const iterable = body as { [Symbol.asyncIterator]?: unknown };
  if (typeof iterable[Symbol.asyncIterator] !== 'function') return null;
  return (body as AsyncIterable<Uint8Array>)[Symbol.asyncIterator]();
}

type ChatContentPart = { type: 'text'; text: string } | { type: 'image_url'; image_url: { url: string } };

function chatContent(question: string, images?: readonly VisionImage[]): string | ChatContentPart[] {
  if (!images?.length) return question;
  // The preview marker is CSS, so its trusted coordinates must accompany the unchanged JPEG bytes.
  const context = images.map((image, index) => `Image ${index + 1} is the ${index === 0 ? 'local crop' : 'full monitor'}. `
    + `Original ping position (normalized from the top-left): x=${image.marker.x}, y=${image.marker.y}.`).join('\n');
  return [
    { type: 'text', text: `${question}\n\n${context}` },
    ...images.map((image): ChatContentPart => ({ type: 'image_url', image_url: { url: image.dataUrl } })),
  ];
}

async function runStream(args: StreamArgs, allowEmpty: boolean): Promise<void> {
  if (args.signal.aborted) throw new AiError('aborted');
  if (args.images?.length) {
    try {
      validateVisionImages(args.images);
    } catch (error) {
      throw new AiError(error instanceof VisionSnapshotError ? error.code : 'imageInvalid');
    }
  }
  const { idleTimeoutMs, totalTimeoutMs, maxChars, maxTokens } = { ...DEFAULTS, ...args };
  const url = `${args.baseUrl.replace(/\/+$/, '')}/chat/completions`;
  let received = 0;
  let watchCode: AiErrorCode | null = null;

  // The watchdogs abort a controller of their own; the caller's signal is the user's stop button.
  const controller = new AbortController();
  let rejectAbort: (error: AiError) => void = () => undefined;
  const aborted = new Promise<never>((_, reject) => { rejectAbort = reject; });
  const abort = (code: AiErrorCode): void => {
    watchCode = watchCode ?? code;
    controller.abort();
    rejectAbort(new AiError(watchCode));
  };
  const wait = <T>(pending: PromiseLike<T>): Promise<T> => Promise.race([pending, aborted]);
  const fireIdle = (): void => {
    abort('timeout');
  };
  const idleMs = idleTimeoutMs;
  let idleTimer: ReturnType<typeof setTimeout> = setTimeout(fireIdle, idleMs);
  const armIdle = (): void => {
    clearTimeout(idleTimer);
    idleTimer = setTimeout(fireIdle, idleMs);
  };
  const totalTimer: ReturnType<typeof setTimeout> = setTimeout(() => {
    abort('timeout');
  }, totalTimeoutMs);
  const onAbort = (): void => {
    abort('aborted');
  };
  if (args.signal.aborted) onAbort();
  args.signal.addEventListener('abort', onAbort, { once: true });

  let iterator: AsyncIterator<Uint8Array> | null = null;
  try {
    const content = chatContent(args.question, args.images);
    const res = await wait(args.fetchImpl(url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${args.key}`,
        accept: 'text/event-stream',
      },
      body: JSON.stringify({
        model: args.model,
        messages: [{ role: 'user', content }],
        stream: true,
        max_tokens: maxTokens,
      }),
      signal: controller.signal,
      redirect: 'error',
    }));
    iterator = bodyIterator(res.body);
    if (!res.ok) {
      let code = statusToCode(res.status);
      if (iterator) {
        const decoder = new TextDecoder();
        let errorText = '';
        let bytes = 0;
        while (true) {
          const next = await wait(iterator.next());
          if (next.done) {
            errorText += decoder.decode();
            try { code = providerError(JSON.parse(errorText), code) ?? code; } catch { /* Keep the HTTP category. */ }
            break;
          }
          if (!(next.value instanceof Uint8Array)) break;
          bytes += next.value.byteLength;
          if (bytes > MAX_ERROR_BYTES) break;
          armIdle();
          errorText += decoder.decode(next.value, { stream: true });
        }
      }
      throw new AiError(code);
    }
    if (!iterator) throw new AiError('badResponse');
    const decoder = new TextDecoder('utf-8');
    const parser = new SseParser();
    while (true) {
      const next = await wait(iterator.next());
      if (watchCode) throw new AiError(watchCode);
      if (next.done) break;
      const chunk = next.value;
      if (!(chunk instanceof Uint8Array)) throw new AiError('badResponse');
      armIdle();
      for (const data of parser.push(decoder.decode(chunk, { stream: true }))) {
        if (watchCode) throw new AiError(watchCode);
        if (data === '[DONE]') {
          if (received === 0 && !allowEmpty) throw new AiError('badResponse');
          return;
        }
        let payload: unknown;
        try {
          payload = JSON.parse(data);
        } catch {
          continue; // one malformed frame in a long stream is survivable
        }
        const error = providerError(payload);
        if (error) throw new AiError(error);
        const text = deltaOf(payload);
        if (text.length > 0) {
          received += text.length;
          if (received > maxChars) {
            throw new AiError('tooLong');
          }
          args.onDelta(text);
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
    controller.abort();
    // Some injected streams ignore AbortSignal. Never wait for their pending next()/return() after cancellation.
    try {
      if (iterator?.return) void Promise.resolve(iterator.return()).catch(() => undefined);
    } catch { /* Cleanup must not replace the request's result. */ }
  }
}

/** A one-token probe for the settings page's Test connection button; the same security as a real question. */
export async function pingEndpoint(args: Omit<StreamArgs, 'question' | 'onDelta'>): Promise<void> {
  await runStream({ ...args, images: undefined, question: 'ping', onDelta: () => undefined, maxTokens: 1 }, true);
}

/** Runs the main-process completion, with a null delta handler reserved for the settings connection probe. */
export async function runChat(args: Omit<StreamArgs, 'onDelta'> & {
  onDelta: ((text: string) => void) | null;
}): Promise<void> {
  if (args.onDelta === null) await pingEndpoint(args);
  else await streamChat({ ...args, onDelta: args.onDelta });
}
