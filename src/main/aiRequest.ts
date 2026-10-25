import type { AiErrorCode } from '../shared/aiConfig';
import { DEFAULT_AI_MAX_TOKENS, normalizeAiMaxTokens } from '../shared/aiConfig';
import { AiError, runChat, cancelSource, type AiFetch, type StreamDiagnostic, type CancelSource } from './aiClient';
import type { VisionUpload } from './explainWindow';
import type { ExplainEvent } from '../shared/ipc';

export type PreparedAi = { ok: true; baseUrl: string; model: string; key: string }
  | { ok: false; code: AiErrorCode };
type Result = { ok: true } | { ok: false; code: AiErrorCode };

/** Owns cancellation across key/DNS awaits as well as the shared streaming client. */
export class AiRequests {
  private controller: AbortController | null = null;

  constructor(private readonly deps: {
    prepare: () => Promise<PreparedAi>;
    recipient: () => { baseUrl: string; model: string } | null;
    fetchImpl: AiFetch;
    now: () => number;
  }) {}

  cancel(source: CancelSource = 'other'): void {
    this.controller?.abort(source);
    this.controller = null;
  }

  async run(question: string, maxTokens: number, onDelta: ((text: string) => void) | null,
    upload?: VisionUpload, onDiagnostic?: (summary: Readonly<StreamDiagnostic>) => void): Promise<Result> {
    const controller = new AbortController();
    this.cancel('replaced');
    this.controller = controller;
    const started = this.deps.now();
    let reported = false;
    let result: Result = { ok: false, code: 'network' };
    const report = (summary: Readonly<StreamDiagnostic>): void => {
      if (reported) return;
      reported = true;
      const elapsed = this.deps.now() - started;
      try { onDiagnostic?.(Object.freeze({ ...summary,
        elapsedMs: Number.isFinite(elapsed) ? Math.max(0, elapsed) : 0 })); } catch { /* Observe only. */ }
    };
    const finish = (value: Result): Result => { result = value; return value; };
    try {
      const ready = await this.deps.prepare();
      if (controller.signal.aborted) return finish({ ok: false, code: 'aborted' });
      if (!ready.ok) return finish(ready);
      if (upload) {
        if (!upload.isCurrent()) return finish({ ok: false, code: 'snapshotStale' });
        if (upload.expiresAt <= this.deps.now()) return finish({ ok: false, code: 'snapshotExpired' });
        const current = this.deps.recipient();
        if (!current || ready.baseUrl !== upload.recipient.baseUrl || ready.model !== upload.recipient.model
          || current.baseUrl !== upload.recipient.baseUrl || current.model !== upload.recipient.model) {
          return finish({ ok: false, code: 'configChanged' });
        }
      }
      await runChat({ baseUrl: ready.baseUrl, model: ready.model, key: ready.key, question, maxTokens, onDelta,
        ...(upload ? { images: upload.images } : {}), signal: controller.signal,
        fetchImpl: this.deps.fetchImpl, now: this.deps.now, onDiagnostic: onDiagnostic ? report : undefined });
      return finish({ ok: true });
    } catch (error) {
      return finish({ ok: false, code: error instanceof AiError ? error.code : 'network' });
    } finally {
      if (onDiagnostic && !reported) report({ mode: onDelta === null ? 'probe' : upload ? 'vision' : 'text',
        stage: 'prepare', httpStatus: null, sseEvents: 0, deltaCount: 0, characters: 0, finishReason: null,
        doneSeen: false, aborted: controller.signal.aborted, errorCode: result.ok ? null : result.code,
        outputLimited: false, elapsedMs: 0, timeoutKind: null, cancelSource: cancelSource(controller.signal) });
      if (this.controller === controller) this.controller = null;
    }
  }
}

/** Shared by the real app entry and integration checks; freeze the selected budget at submission. */
export function createExplainAsk(requests: AiRequests,
  observe?: (id: number, summary: Readonly<StreamDiagnostic>) => void,
  getMaxTokens: () => number = () => DEFAULT_AI_MAX_TOKENS) {
  return (question: string, id: number, sink: (ev: ExplainEvent) => void, upload?: VisionUpload): Promise<Result> => {
    return requests.run(question, normalizeAiMaxTokens(getMaxTokens()), text => sink({ kind: 'delta', id, text }), upload,
      observe ? summary => observe(id, summary) : undefined)
      .then(result => {
        sink(result.ok ? { kind: 'done', id } : { kind: 'error', id, code: result.code });
        return result;
      });
  };
}
