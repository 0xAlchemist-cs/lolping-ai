import type { AiErrorCode } from '../shared/aiConfig';
import { AiError, runChat, type AiFetch } from './aiClient';
import type { VisionUpload } from './explainWindow';

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

  cancel(): void {
    this.controller?.abort();
    this.controller = null;
  }

  async run(question: string, maxTokens: number, onDelta: ((text: string) => void) | null,
    upload?: VisionUpload): Promise<Result> {
    const controller = new AbortController();
    this.cancel();
    this.controller = controller;
    try {
      const ready = await this.deps.prepare();
      if (controller.signal.aborted) return { ok: false, code: 'aborted' };
      if (!ready.ok) return ready;
      if (upload) {
        if (!upload.isCurrent()) return { ok: false, code: 'snapshotStale' };
        if (upload.expiresAt <= this.deps.now()) return { ok: false, code: 'snapshotExpired' };
        const current = this.deps.recipient();
        if (!current || ready.baseUrl !== upload.recipient.baseUrl || ready.model !== upload.recipient.model
          || current.baseUrl !== upload.recipient.baseUrl || current.model !== upload.recipient.model) {
          return { ok: false, code: 'configChanged' };
        }
      }
      await runChat({ baseUrl: ready.baseUrl, model: ready.model, key: ready.key, question, maxTokens, onDelta,
        ...(upload ? { images: upload.images } : {}), signal: controller.signal,
        fetchImpl: this.deps.fetchImpl, now: this.deps.now });
      return { ok: true };
    } catch (error) {
      return { ok: false, code: error instanceof AiError ? error.code : 'network' };
    } finally {
      if (this.controller === controller) this.controller = null;
    }
  }
}
