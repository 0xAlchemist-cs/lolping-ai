import type { ExplainApi } from '../../shared/ipc';
import type { VisionErrorCode, VisionImage, VisionText } from '../../shared/vision';

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
  private readonly openListener = (): void => { void this.open(); };
  private readonly closeListener = (): void => this.close();

  constructor(
    private readonly api: Pick<ExplainApi, 'capture' | 'closePreview'>,
    private readonly elements: VisionElements,
  ) {
    elements.open.addEventListener('click', this.openListener);
    elements.close.addEventListener('click', this.closeListener);
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

  setSession(sessionId: number): void {
    // A queued state() reply can predate the latest main-process session push.
    if (!Number.isSafeInteger(sessionId) || sessionId <= this.sessionId) return;
    this.sessionId = sessionId;
    this.reset();
  }

  async open(): Promise<void> {
    if (!this.words || !this.available || this.sessionId === 0 || this.loading || this.disposed) return;
    this.clearImages();
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
    this.elements.status.textContent = this.words?.errors[code] ?? '';
    this.elements.status.classList.add('warn');
  }

  private clearImages(): void {
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
    this.requestId += 1;
    this.opened = false;
    this.loading = false;
    this.clearImages();
    this.elements.preview.hidden = true;
    this.elements.text.hidden = false;
    this.elements.status.textContent = '';
    this.elements.status.classList.remove('warn');
    this.updateButtons();
  }

  private updateButtons(): void {
    const e = this.elements;
    e.open.hidden = !this.available || this.opened || this.disposed;
    e.open.disabled = !this.words || this.sessionId === 0 || this.loading;
    e.close.hidden = !this.opened || this.disposed;
  }
}
