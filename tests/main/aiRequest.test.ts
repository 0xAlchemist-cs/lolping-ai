import { afterEach, describe, expect, it, vi } from 'vitest';
import { AiRequests, type PreparedAi } from '../../src/main/aiRequest';
import { TEST_JPEG_DATA_URL } from './fixtures/visionJpeg';

const recipient = { baseUrl: 'https://mock.invalid/v1', model: 'mock-vision' };
const ready: PreparedAi = { ok: true, ...recipient, key: 'synthetic-fixture' };
function deferred<T>() {
  let resolve: (value: T) => void = () => undefined;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}
function setup() {
  const pending = deferred<PreparedAi>();
  const fetchImpl = vi.fn(async () => ({ ok: true, status: 200, body: (async function* () {
    yield new TextEncoder().encode('data: {"choices":[{"delta":{"content":"mock answer"}}]}\n\ndata: [DONE]\n\n');
  })() }));
  let current: typeof recipient | null = { ...recipient };
  let valid = true;
  const requests = new AiRequests({ prepare: () => pending.promise, recipient: () => current,
    fetchImpl, now: Date.now });
  const upload = { recipient, images: [{ dataUrl: TEST_JPEG_DATA_URL, width: 2, height: 1,
    marker: { x: 0.5, y: 0.5 } }], expiresAt: Date.now() + 120_000, isCurrent: () => valid };
  return { requests, pending, fetchImpl, upload, change: () => { current = { ...recipient, model: 'changed' }; },
    remove: () => { current = null; }, invalidate: () => { valid = false; } };
}
afterEach(() => vi.useRealTimers());

describe('AiRequests', () => {
  it.each(['cancel', 'config', 'disabled', 'expired', 'snapshot'] as const)(
    'does not start a client request when %s occurs during asynchronous key/DNS preparation', async (action) => {
      vi.useFakeTimers();
      const t = setup();
      const pending = t.requests.run('mock question', 32, () => undefined, t.upload);
      if (action === 'cancel') t.requests.cancel();
      if (action === 'config') t.change();
      if (action === 'disabled') t.remove();
      if (action === 'expired') vi.advanceTimersByTime(120_000);
      if (action === 'snapshot') t.invalidate();
      t.pending.resolve(ready);
      expect(await pending).toEqual({ ok: false, code: action === 'cancel' ? 'aborted'
        : action === 'expired' ? 'snapshotExpired' : action === 'snapshot' ? 'snapshotStale' : 'configChanged' });
      expect(t.fetchImpl).not.toHaveBeenCalled();
    });

  it('allows one approved image request through the actual client and emits only answer content', async () => {
    const t = setup();
    const seen: string[] = [];
    const pending = t.requests.run('mock question', 32, (text) => seen.push(text), t.upload);
    t.pending.resolve(ready);
    expect(await pending).toEqual({ ok: true });
    expect(t.fetchImpl).toHaveBeenCalledTimes(1);
    expect(seen).toEqual(['mock answer']);
  });
});
