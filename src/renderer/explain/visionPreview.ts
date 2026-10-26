import type { ExplainApi } from '../../shared/ipc';
import type { VisionAsk, VisionErrorCode, VisionImage, VisionSendState, VisionSnapshotInfo, VisionText } from '../../shared/vision';
import { MAX_QUESTION } from '../../shared/explain';
import { submitOnEnter } from './submitKey';

export interface VisionElements {
  open: HTMLButtonElement;
  close: HTMLButtonElement;
  text: HTMLElement;
  preview: HTMLElement;
  privacy: HTMLElement;
  timing: HTMLElement;
  status: HTMLElement;
  images: HTMLElement;
  local: HTMLImageElement;
  full: HTMLImageElement;
  localCaption: HTMLElement;
  fullCaption: HTMLElement;
  localMarker: HTMLElement;
  fullMarker: HTMLElement;
  includeFull?: HTMLInputElement;
  includeFullLabel?: HTMLElement;
  selection?: HTMLElement;
  destination?: HTMLElement;
  uploadPrivacy?: HTMLElement;
  question?: HTMLInputElement;
  send?: HTMLButtonElement;
}

/** Keeps image ownership separate from the text stream and invalidates every late capture on close or reentry. */
export class VisionPreview {
  private words: VisionText | null = null;
  private sessionId = 0;
  private requestId = 0;
  private available = false;
  private opened = false;
  private loading = false;
  private disposed = false;
  private configured = false;
  private busy = false;
  private questionComposing = false;
  private captureError: VisionErrorCode | null = null;
  private localFailed = false;
  private fullFailed = false;
  private snapshot: VisionSnapshotInfo | null = null;
  private expiryTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly selectionListener = (): void => this.updateButtons();
  private readonly loadListener = (event: Event): void => {
    if (event.currentTarget === this.elements.local) this.localFailed = event.type === 'error';
    if (event.currentTarget === this.elements.full) this.fullFailed = event.type === 'error';
    this.updateButtons();
  };
  private readonly sendListener = (): void => this.submit();
  private readonly questionKeyListener = (event: KeyboardEvent): void => {
    if (!this.questionComposing) submitOnEnter(event, () => this.submit());
  };
  private readonly compositionStartListener = (): void => { this.questionComposing = true; };
  private readonly compositionEndListener = (): void => { this.questionComposing = false; };
  private readonly openListener = (): void => { void this.open(); };
  private readonly closeListener = (): void => this.close();

  constructor(
    private readonly api: Pick<ExplainApi, 'capture' | 'closePreview'>,
    private readonly elements: VisionElements,
    private readonly onSend?: (request: VisionAsk) => void,
  ) {
    elements.open.addEventListener('click', this.openListener);
    elements.close.addEventListener('click', this.closeListener);
    elements.includeFull?.addEventListener('change', this.selectionListener);
    elements.local.addEventListener('load', this.loadListener);
    elements.full.addEventListener('load', this.loadListener);
    elements.local.addEventListener('error', this.loadListener);
    elements.full.addEventListener('error', this.loadListener);
    elements.send?.addEventListener('click', this.sendListener);
    elements.question?.addEventListener('keydown', this.questionKeyListener);
    elements.question?.addEventListener('compositionstart', this.compositionStartListener);
    elements.question?.addEventListener('compositionend', this.compositionEndListener);
    this.reset();
  }

  setWords(words: VisionText): void {
    this.words = words;
    const e = this.elements;
    e.open.textContent = words.open;
    e.close.textContent = words.close;
    e.privacy.textContent = words.privacy;
    e.timing.textContent = words.timing;
    e.local.alt = words.local;
    e.full.alt = words.full;
    if (e.includeFullLabel) e.includeFullLabel.textContent = words.includeFull;
    if (e.uploadPrivacy) e.uploadPrivacy.textContent = words.uploadPrivacy;
    if (e.question) { e.question.placeholder = words.question; e.question.setAttribute('aria-label', words.question); }
    if (e.send) e.send.textContent = words.send;
    for (const marker of [e.localMarker, e.fullMarker]) {
      marker.setAttribute('aria-label', words.marker);
      marker.setAttribute('title', words.marker);
    }
    this.updateButtons();
  }

  setAvailable(available: boolean): void {
    this.available = available;
    this.updateButtons();
  }

  setConfigured(configured: boolean): void {
    this.configured = configured;
    this.updateButtons();
  }

  setBusy(busy: boolean): void {
    this.busy = busy;
    this.updateButtons();
  }

  setSession(sessionId: number): void {
    // A queued state() reply can predate the latest main-process session push.
    if (!Number.isSafeInteger(sessionId) || sessionId <= this.sessionId) return;
    this.sessionId = sessionId;
    this.reset();
  }

  async open(): Promise<void> {
    if (!this.words || !this.available || this.sessionId === 0 || this.loading || this.disposed) return;
    this.clearImages();
    this.captureError = null;
    if (this.elements.includeFull) this.elements.includeFull.checked = false;
    this.opened = true;
    this.loading = true;
    const requestId = ++this.requestId;
    const sessionId = this.sessionId;
    const e = this.elements;
    e.text.hidden = true;
    e.preview.hidden = false;
    e.status.classList.remove('warn');
    e.status.textContent = this.words.loading;
    this.updateButtons();
    try {
      const reply = await this.api.capture(sessionId);
      if (!this.isCurrent(sessionId, requestId)) return;
      if (!reply || reply.sessionId !== sessionId) {
        this.fail('stale');
      } else if (!reply.result.ok) {
        this.fail(reply.result.code);
      } else {
        this.snapshot = reply.snapshot ?? null;
        if (this.snapshot) {
          // Fresh main-owned approval supersedes the card's one-time configuration query.
          this.configured = true;
          this.expiryTimer = setTimeout(() => this.updateButtons(), Math.max(0, this.snapshot.expiresAt - Date.now()));
        }
        const { local, full } = reply.result.preview;
        this.drawImage(e.local, e.localMarker, e.localCaption, this.words.local, local);
        this.drawImage(e.full, e.fullMarker, e.fullCaption, this.words.full, full);
        e.images.hidden = false;
        e.status.textContent = '';
      }
    } catch {
      if (this.isCurrent(sessionId, requestId)) this.fail('captureFailed');
    } finally {
      if (this.isCurrent(sessionId, requestId)) {
        this.loading = false;
        this.updateButtons();
      }
    }
  }

  close(): void {
    if (this.opened) this.api.closePreview(this.sessionId);
    this.reset();
  }

  destroy(): void {
    this.disposed = true;
    this.reset();
    this.elements.open.removeEventListener('click', this.openListener);
    this.elements.close.removeEventListener('click', this.closeListener);
    this.elements.includeFull?.removeEventListener('change', this.selectionListener);
    this.elements.send?.removeEventListener('click', this.sendListener);
    this.elements.question?.removeEventListener('keydown', this.questionKeyListener);
    this.elements.question?.removeEventListener('compositionstart', this.compositionStartListener);
    this.elements.question?.removeEventListener('compositionend', this.compositionEndListener);
    for (const image of [this.elements.local, this.elements.full]) {
      image.removeEventListener('load', this.loadListener);
      image.removeEventListener('error', this.loadListener);
    }
  }

  private isCurrent(sessionId: number, requestId: number): boolean {
    return !this.disposed && this.opened && this.sessionId === sessionId && this.requestId === requestId;
  }

  private drawImage(
    image: HTMLImageElement, marker: HTMLElement, caption: HTMLElement, label: string, data: VisionImage,
  ): void {
    image.src = data.dataUrl;
    image.width = data.width;
    image.height = data.height;
    marker.style.left = `${data.marker.x * 100}%`;
    marker.style.top = `${data.marker.y * 100}%`;
    caption.textContent = `${label} · ${data.width} × ${data.height}`;
  }

  private fail(code: VisionErrorCode): void {
    this.clearImages();
    this.captureError = code;
    this.elements.status.textContent = this.words?.errors[code] ?? '';
    this.elements.status.classList.add('warn');
  }

  private clearImages(): void {
    if (this.expiryTimer !== null) clearTimeout(this.expiryTimer);
    this.expiryTimer = null;
    this.snapshot = null;
    this.localFailed = false;
    this.fullFailed = false;
    const e = this.elements;
    e.images.hidden = true;
    for (const image of [e.local, e.full]) {
      image.removeAttribute('src');
      image.removeAttribute('width');
      image.removeAttribute('height');
    }
    e.localCaption.textContent = '';
    e.fullCaption.textContent = '';
  }

  private reset(): void {
    this.questionComposing = false;
    this.requestId += 1;
    this.opened = false;
    this.loading = false;
    this.captureError = null;
    if (this.elements.includeFull) this.elements.includeFull.checked = false;
    if (this.elements.question) this.elements.question.value = '';
    this.clearImages();
    this.elements.preview.hidden = true;
    this.elements.text.hidden = false;
    this.elements.status.textContent = '';
    this.elements.status.classList.remove('warn');
    this.updateButtons();
  }

  private updateButtons(): void {
    const e = this.elements;
    const reason = this.sendState();
    const recapture = this.opened && ['expired', 'captureFailed', 'noSnapshot', 'imageFailed', 'unconfigured'].includes(reason);
    e.open.hidden = !this.available || (this.opened && !recapture) || this.disposed;
    e.open.disabled = !this.words || this.sessionId === 0 || this.loading;
    e.open.textContent = (recapture ? this.words?.recapture : this.words?.open) ?? '';
    e.close.hidden = !this.opened || this.disposed;
    const full = e.includeFull?.checked ?? false;
    if (e.selection) e.selection.textContent = (full ? this.words?.selectedBoth : this.words?.selectedLocal) ?? '';
    if (e.destination) e.destination.textContent = this.snapshot
      ? `${this.words?.destination ?? ''} ${this.snapshot.recipient.domain} / ${this.snapshot.recipient.model}`
      : this.words?.notConfigured ?? '';
    if (this.opened && !this.loading && !this.captureError) {
      const status = reason === 'expired' ? this.words?.expired
        : reason === 'unconfigured' ? this.words?.notConfigured
        : reason === 'noSnapshot' ? this.words?.snapshotUnavailable
        : reason === 'imageFailed' ? this.words?.imageLoadFailed
        : reason === 'localPending' || reason === 'fullPending' ? this.words?.loadingImages
        : reason === 'busy' ? this.words?.waitForAnswer : '';
      e.status.textContent = status ?? '';
      if (['expired', 'unconfigured', 'noSnapshot', 'imageFailed'].includes(reason)) e.status.classList.add('warn');
      else e.status.classList.remove('warn');
    }
    if (e.send) {
      e.send.disabled = reason !== 'ready';
      e.send.setAttribute('data-block-reason', reason);
    }
  }

  private sendState(): VisionSendState {
    const e = this.elements;
    const loaded = (image: HTMLImageElement): boolean => image.complete && image.naturalWidth > 0;
    if (this.disposed) return 'disposed';
    if (!this.onSend || !this.words || !this.available) return 'unavailable';
    if (this.sessionId === 0) return 'noSession';
    if (!this.opened) return 'closed';
    if (this.loading) return 'capturing';
    if (this.captureError) return 'captureFailed';
    if (!this.configured) return 'unconfigured';
    if (!this.snapshot || !this.snapshot.recipient.domain || !this.snapshot.recipient.model) return 'noSnapshot';
    if (this.snapshot.expiresAt <= Date.now()) return 'expired';
    if (this.busy) return 'busy';
    if (this.localFailed || (e.includeFull?.checked && this.fullFailed)) return 'imageFailed';
    if (!loaded(e.local)) return 'localPending';
    if (e.includeFull?.checked && !loaded(e.full)) return 'fullPending';
    return 'ready';
  }

  private submit(): void {
    this.updateButtons();
    if (this.sendState() !== 'ready' || !this.snapshot || !this.words) return;
    const question = [...(this.elements.question?.value.trim() || this.words.defaultQuestion)]
      .slice(0, MAX_QUESTION).join('');
    const request: VisionAsk = {
      sessionId: this.sessionId, snapshotId: this.snapshot.snapshotId,
      scope: this.elements.includeFull?.checked ? 'localAndFull' : 'local', question, confirmed: true,
    };
    // Sending consumes the snapshot. Restore text locally; a user close would cancel main's request.
    this.reset();
    this.onSend?.(request);
  }
}
