import { afterEach, describe, expect, it, vi } from 'vitest';
import { strings } from '../../src/shared/i18n';
import type { ExplainApi, ExplainEvent } from '../../src/shared/ipc';
import type { VisionReply } from '../../src/shared/vision';

class Element extends EventTarget {
  hidden = false;
  disabled = false;
  checked = false;
  value = '';
  textContent = '';
  placeholder = '';
  alt = '';
  scrollTop = 0;
  scrollHeight = 0;
  complete = false;
  naturalWidth = 0;
  readonly style: Record<string, string> = {};
  readonly attrs = new Map<string, string>();
  readonly classes = new Set<string>();
  readonly classList = {
    add: (name: string) => this.classes.add(name), remove: (name: string) => this.classes.delete(name),
    toggle: (name: string, on: boolean) => on ? this.classes.add(name) : this.classes.delete(name),
  };
  set src(value: string) { this.attrs.set('src', value); }
  get src(): string { return this.attrs.get('src') ?? ''; }
  setAttribute(name: string, value: string): void { this.attrs.set(name, value); }
  removeAttribute(name: string): void { this.attrs.delete(name); }
  focus(): void { /* No browser focus in this fixture. */ }
  click(): void { if (!this.disabled) this.dispatchEvent(new Event('click')); }
  loaded(): void { this.complete = true; this.naturalWidth = 640; this.dispatchEvent(new Event('load')); }
}

const screenshot = (): VisionReply => ({
  sessionId: 1, snapshot: { snapshotId: 8, expiresAt: Date.now() + 30_000,
    recipient: { domain: 'vision.example.com', model: 'vision-model' } },
  result: { ok: true, preview: { displayId: 1, original: { x: 0, y: 0, width: 800, height: 600 },
    crop: { x: 0, y: 0, width: 640, height: 480 },
    local: { dataUrl: 'data:image/jpeg;base64,local', width: 640, height: 480, marker: { x: 0.5, y: 0.5 } },
    full: { dataUrl: 'data:image/jpeg;base64,full', width: 800, height: 600, marker: { x: 0.4, y: 0.4 } } } },
});

function deferred<T>() {
  let resolve: (value: T) => void = () => undefined;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

async function setup() {
  vi.resetModules();
  const elements = new Map<string, Element>();
  const get = (id: string): Element => {
    let element = elements.get(id);
    if (!element) { element = new Element(); elements.set(id, element); }
    return element;
  };
  const document = Object.assign(new EventTarget(), { getElementById: get, title: '' });
  let receive: (event: ExplainEvent) => void = () => undefined;
  let session: (id: number) => void = () => undefined;
  const pending = deferred<number | null>();
  const api: ExplainApi = {
    ask: vi.fn(() => pending.promise), askVision: vi.fn(async () => ({ ok: true as const, id: 42 })),
    stop: vi.fn(), close: vi.fn(), openSettings: vi.fn(), closePreview: vi.fn(),
    strings: async () => ({ ...strings('en').explainWindow, errors: strings('en').aiError }),
    state: async () => ({ configured: true, visionSessionId: 1, captureAvailable: true }),
    capture: vi.fn(async () => screenshot()),
    on: (cb) => { receive = cb; return () => undefined; },
    onVisionSession: (cb) => { session = cb; return () => undefined; },
  };
  const writeText = vi.fn(async () => undefined);
  vi.stubGlobal('document', document);
  vi.stubGlobal('window', Object.assign(new EventTarget(), { explainApi: api }));
  vi.stubGlobal('navigator', { clipboard: { writeText } });
  vi.stubGlobal('requestAnimationFrame', (cb: () => void) => cb());
  await import('../../src/renderer/explain/main');
  await Promise.resolve();
  const submit = () => get('ask').dispatchEvent(new Event('submit', { cancelable: true }));
  return { get, api, pending, receive: (event: ExplainEvent) => receive(event), session: (id: number) => session(id),
    submit, writeText };
}

afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); });

describe('Explain renderer', () => {
  it.each(['error', 'stop'] as const)('keeps image-request wording after %s before the first answer token', async (action) => {
    const t = await setup();
    t.get('previewOpen').click();
    await vi.waitFor(() => expect(t.get('visionLocal').src).not.toBe(''));
    t.get('visionLocal').loaded();
    t.get('visionSend').click();
    await Promise.resolve();
    if (action === 'error') t.receive({ kind: 'error', id: 42, code: 'permission' });
    else t.get('stop').click();
    expect(t.get('body').textContent).toBe('');
    expect(t.get('textModeLabel').textContent).toBe('Image question · next Ask sends text only');
  });
  it('labels a visual answer accurately and marks the next ordinary ask as text only', async () => {
    const t = await setup();
    t.get('previewOpen').click();
    await vi.waitFor(() => expect(t.get('visionLocal').src).not.toBe(''));
    t.get('visionLocal').loaded();
    t.get('visionSend').click();
    await Promise.resolve();
    expect(t.get('textModeLabel').textContent).toBe('Image question · next Ask sends text only');
    t.receive({ kind: 'delta', id: 42, text: 'Visual answer' });
    t.receive({ kind: 'done', id: 42 });
    expect(t.get('textModeLabel').textContent).toBe('Image question · next Ask sends text only');
    t.get('question').value = 'A new text question';
    t.submit();
    expect(t.get('textModeLabel').textContent).toBe(strings('en').explainWindow.textModeLabel);
  });
  it('leaves generating when main cancels a vision stream after the user closes a reopened preview', async () => {
    const t = await setup();
    t.get('previewOpen').click();
    await vi.waitFor(() => expect(t.get('visionLocal').src).not.toBe(''));
    t.get('visionLocal').loaded();
    t.get('visionSend').click();
    await Promise.resolve();
    expect(t.get('send').disabled).toBe(true);
    t.get('previewOpen').click();
    await vi.waitFor(() => expect(t.get('visionLocal').src).not.toBe(''));
    vi.mocked(t.api.closePreview).mockImplementation(() => {
      t.receive({ kind: 'error', id: 42, code: 'aborted' });
    });
    t.get('previewClose').click();
    expect(t.get('textView').hidden).toBe(false);
    expect(t.get('send').disabled).toBe(false);
    expect(t.get('hint').textContent).toBe('');
    expect(t.get('failureText').textContent).toBe(strings('en').aiError.aborted);
  });

  it('keeps early vision tokens and completion and copies only the visible answer', async () => {
    const t = await setup();
    const pending = deferred<Awaited<ReturnType<ExplainApi['askVision']>>>();
    vi.mocked(t.api.askVision).mockReturnValueOnce(pending.promise);
    t.get('previewOpen').click();
    await vi.waitFor(() => expect(t.get('visionLocal').src).not.toBe(''));
    t.get('visionLocal').loaded();
    t.get('visionSend').click();
    t.receive({ kind: 'delta', id: 42, text: '<b>Visible answer</b>' });
    t.receive({ kind: 'done', id: 42 });
    pending.resolve({ ok: true, id: 42 });
    await vi.waitFor(() => expect(t.get('body').textContent).toBe('<b>Visible answer</b>'));
    expect(t.get('hint').textContent).toBe('');
    t.get('copy').click();
    expect(t.writeText).toHaveBeenCalledExactlyOnceWith('<b>Visible answer</b>');
    expect(t.get('visionLocal').src).toBe('');
    expect(t.api.closePreview).not.toHaveBeenCalled();
  });

  it('shows early errors and IPC rejections without leaving thinking or disabled send behind', async () => {
    const t = await setup();
    t.get('question').value = 'Why?';
    t.submit();
    t.receive({ kind: 'error', id: 9, code: 'permission' });
    t.pending.resolve(9);
    await vi.waitFor(() => expect(t.get('failure').hidden).toBe(false));
    expect(t.get('failureText').textContent).toBe(strings('en').aiError.permission);
    expect(t.get('hint').textContent).toBe('');
    expect(t.get('send').disabled).toBe(false);
    vi.mocked(t.api.ask).mockRejectedValueOnce(new Error('IPC failed'));
    t.get('retry').click();
    await vi.waitFor(() => expect(t.get('failureText').textContent).toBe(strings('en').aiError.network));
    expect(t.get('hint').textContent).toBe('');
    expect(t.get('send').disabled).toBe(false);
  });

  it('keeps send disabled throughout a pending IPC call and its stream and submits text without images', async () => {
    const t = await setup();
    t.get('question').value = 'Text only';
    t.submit();
    t.submit();
    expect(t.api.ask).toHaveBeenCalledExactlyOnceWith('Text only');
    expect(t.api.askVision).not.toHaveBeenCalled();
    expect(t.api.capture).not.toHaveBeenCalled();
    expect(t.get('send').disabled).toBe(true);
    t.pending.resolve(9);
    await Promise.resolve();
    expect(t.get('send').disabled).toBe(true);
    t.receive({ kind: 'delta', id: 9, text: 'Answer' });
    t.receive({ kind: 'done', id: 9 });
    expect(t.get('send').disabled).toBe(false);
    expect(t.get('hint').textContent).toBe('');
  });

  it('invalidates a stopped pending IPC reply and ignores every late event', async () => {
    const t = await setup();
    t.get('question').value = 'Why?';
    t.submit();
    t.receive({ kind: 'delta', id: 9, text: 'early old' });
    t.get('stop').click();
    expect(t.get('hint').textContent).toBe('');
    t.pending.resolve(9);
    await Promise.resolve();
    t.receive({ kind: 'delta', id: 9, text: 'late old' });
    t.receive({ kind: 'done', id: 9 });
    expect(t.get('body').textContent).toBe('');
    expect(t.get('copy').disabled).toBe(true);
    expect(t.get('send').disabled).toBe(false);
  });

  it('retries text with a fresh epoch and drops the old stream while awaiting the new ID', async () => {
    const t = await setup();
    t.get('question').value = 'Why?';
    t.submit();
    t.pending.resolve(9);
    await Promise.resolve();
    t.receive({ kind: 'error', id: 9, code: 'rate' });
    expect(t.get('hint').textContent).toBe('');
    const next = deferred<number | null>();
    vi.mocked(t.api.ask).mockReturnValueOnce(next.promise);
    t.get('retry').click();
    t.receive({ kind: 'delta', id: 9, text: 'old text' });
    t.receive({ kind: 'delta', id: 10, text: 'New answer' });
    t.receive({ kind: 'done', id: 10 });
    next.resolve(10);
    await vi.waitFor(() => expect(t.get('body').textContent).toBe('New answer'));
    expect(t.get('hint').textContent).toBe('');
  });

  it('sends only on explicit screenshot consent and requires a fresh preview for vision retry', async () => {
    const t = await setup();
    expect(t.api.capture).not.toHaveBeenCalled();
    t.get('previewOpen').click();
    await vi.waitFor(() => expect(t.get('visionLocal').src).not.toBe(''));
    expect(t.api.askVision).not.toHaveBeenCalled();
    t.get('visionLocal').loaded();
    t.get('visionSend').click();
    t.get('visionSend').click();
    expect(t.api.askVision).toHaveBeenCalledExactlyOnceWith({ sessionId: 1, snapshotId: 8, scope: 'local',
      question: strings('en').explainWindow.vision.defaultQuestion, confirmed: true });
    expect(t.api.closePreview).not.toHaveBeenCalled();
    expect(t.get('textView').hidden).toBe(false);
    expect(t.get('visionLocal').src).toBe('');
    await Promise.resolve();
    t.receive({ kind: 'error', id: 42, code: 'imageUnsupported' });
    t.get('retry').click();
    expect(t.api.askVision).toHaveBeenCalledTimes(1);
    expect(t.api.capture).toHaveBeenCalledTimes(1);
    expect(t.get('hint').textContent).toBe(strings('en').explainWindow.vision.reviewAgain);
    expect(t.get('previewOpen').hidden).toBe(false);
  });

  it('drops a pending vision request on a new ping while preserving a text stream', async () => {
    const t = await setup();
    const pending = deferred<Awaited<ReturnType<ExplainApi['askVision']>>>();
    vi.mocked(t.api.askVision).mockReturnValueOnce(pending.promise);
    t.get('previewOpen').click();
    await vi.waitFor(() => expect(t.get('visionLocal').src).not.toBe(''));
    t.get('visionLocal').loaded();
    t.get('visionSend').click();
    t.receive({ kind: 'delta', id: 42, text: 'old image answer' });
    t.session(2);
    pending.resolve({ ok: true, id: 42 });
    await Promise.resolve();
    t.receive({ kind: 'done', id: 42 });
    expect(t.get('body').textContent).toBe('');
    expect(t.get('hint').textContent).toBe('');
    t.get('question').value = 'Text';
    t.submit();
    t.pending.resolve(9);
    await Promise.resolve();
    t.receive({ kind: 'delta', id: 9, text: 'Text answer' });
    t.session(3);
    t.receive({ kind: 'done', id: 9 });
    expect(t.get('body').textContent).toBe('Text answer');
    expect(t.get('copy').disabled).toBe(false);
  });

  it('keeps tokens and completion that arrive before the ask IPC reply', async () => {
    const t = await setup();
    t.get('question').value = 'Why?';
    t.submit();
    t.receive({ kind: 'delta', id: 9, text: 'Visible answer' });
    t.receive({ kind: 'done', id: 9 });
    t.pending.resolve(9);
    await vi.waitFor(() => expect(t.get('body').textContent).toBe('Visible answer'));
    expect(t.get('copy').disabled).toBe(false);
    expect(t.get('hint').textContent).toBe('');
    expect(t.get('send').disabled).toBe(false);
    t.get('copy').click();
    expect(t.writeText).toHaveBeenCalledWith('Visible answer');
  });
});
