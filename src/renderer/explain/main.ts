import { MAX_QUESTION } from '../../shared/explain';
import type { AiErrorCode } from '../../shared/aiConfig';
import type { ExplainEvent, ExplainText } from '../../shared/ipc';
import type { VisionAsk } from '../../shared/vision';
import { VisionPreview } from './visionPreview';

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const title = $('title');
const closeBtn = $('close');
const form = $('ask') as HTMLFormElement;
const question = $('question') as HTMLInputElement;
const send = $('send') as HTMLButtonElement;
const stopBtn = $('stop') as HTMLButtonElement;
const hint = $('hint');
const setup = $('setup');
const setupTitle = $('setupTitle');
const setupHint = $('setupHint');
const openSettingsBtn = $('openSettings') as HTMLButtonElement;
const answer = $('answer');
const body = $('body');
const failure = $('failure');
const failureTitle = $('failureTitle');
const failureText = $('failureText');
const retry = $('retry') as HTMLButtonElement;
const copy = $('copy') as HTMLButtonElement;
const copied = $('copied');
const emptyState = $('emptyState');
const vision = new VisionPreview(window.explainApi, {
  open: $<HTMLButtonElement>('previewOpen'), close: $<HTMLButtonElement>('previewClose'),
  text: $('textView'), preview: $('visionView'), privacy: $('visionPrivacy'), timing: $('visionTiming'),
  status: $('visionStatus'), images: $('visionImages'),
  local: $<HTMLImageElement>('visionLocal'), full: $<HTMLImageElement>('visionFull'),
  localCaption: $('visionLocalCaption'), fullCaption: $('visionFullCaption'),
  localMarker: $('visionLocalMarker'), fullMarker: $('visionFullMarker'),
  includeFull: $<HTMLInputElement>('visionIncludeFull'), includeFullLabel: $('visionIncludeFullLabel'),
  selection: $('visionSelection'), destination: $('visionDestination'), uploadPrivacy: $('visionUploadPrivacy'),
  question: $<HTMLInputElement>('visionQuestion'), send: $<HTMLButtonElement>('visionSend'),
}, (request) => { void askRequest(request.question, request); });
const stopVisionSession = window.explainApi.onVisionSession(setSession);
window.addEventListener('beforeunload', () => {
  closed = true;
  closeAfterCopy = false;
  invalidate();
  stopVisionSession();
  vision.destroy();
});

let words: ExplainText | null = null;
let lastId: number | null = null;
let latestAnswer = '';
let lastQuestion = '';
let lastMode: 'text' | 'vision' = 'text';
let sessionId = 0;
let epoch = 0;
let awaitingId = false;
let copying = false;
let closed = false;
let closeAfterCopy = false;
type Terminal = Extract<ExplainEvent, { kind: 'done' | 'error' }>;
const early = new Map<number, { text: string; terminal: Terminal | null }>();

/** The states the card can be in; every transition goes through setState so the buttons stay consistent. */
type State = 'idle' | 'unconfigured' | 'generating' | 'done' | 'error';
let state: State = 'idle';

/** A code point is one letter, one Chinese character or one emoji, however many UTF-16 units it takes. */
function clamp(): void {
  const points = [...question.value];
  if (points.length > MAX_QUESTION) question.value = points.slice(0, MAX_QUESTION).join('');
}

function showHint(message: string, warn: boolean): void {
  hint.textContent = message;
  hint.classList.toggle('warn', warn);
}

function setState(next: State): void {
  state = next;
  send.disabled = next === 'generating';
  vision.setBusy(next === 'generating');
  stopBtn.hidden = next !== 'generating';
  setup.hidden = next !== 'unconfigured';
  failure.hidden = next !== 'error';
  emptyState.hidden = next !== 'idle' || latestAnswer.length > 0;
  updateCopy();
  updateModeLabel();
}

function updateCopy(): void {
  copy.disabled = closed || copying || latestAnswer.length === 0 || state === 'generating';
}

function updateModeLabel(): void {
  $('textModeLabel').textContent = !words ? ''
    : lastMode === 'vision'
      ? words.visionModeLabel : words.textModeLabel;
}

/** Failure text in the page's own words; the code alone when a translation is missing. */
function errorText(code: AiErrorCode): string {
  return words?.errors[code] ?? code;
}

async function ask(): Promise<void> {
  if (closed || !words || state === 'generating') return;
  const q = question.value.trim();
  if (!q) {
    showHint(words.empty, true);
    return;
  }
  await askRequest(q);
}

function invalidate(): void {
  epoch += 1;
  lastId = null;
  awaitingId = false;
  early.clear();
}

function setSession(next: number): void {
  if (!Number.isSafeInteger(next) || next <= sessionId) return;
  sessionId = next;
  vision.setSession(next);
  if (lastMode === 'vision') {
    invalidate();
    lastMode = 'text';
    latestAnswer = '';
    body.textContent = '';
    answer.hidden = true;
    copy.disabled = true;
    showHint('', false);
    setState('idle');
  }
}

function fail(code: AiErrorCode): void {
  lastId = null;
  awaitingId = false;
  early.clear();
  if (code === 'outputLimit' && latestAnswer.length > 0) {
    showHint(errorText(code), true);
    setState('done');
    return;
  }
  showHint('', false);
  failureTitle.textContent = words?.errorTitle ?? '';
  failureText.textContent = errorText(code);
  setState('error');
}

async function askRequest(q: string, screenshot?: VisionAsk): Promise<void> {
  if (closed || !words || state === 'generating') return;
  invalidate();
  const requestEpoch = epoch;
  lastQuestion = q;
  lastMode = screenshot ? 'vision' : 'text';
  latestAnswer = '';
  body.textContent = '';
  answer.hidden = false; // the answer area is the stream's stage from the first token on
  copy.disabled = true;
  copied.textContent = '';
  copied.classList.remove('warn');
  setState('generating');
  showHint(words.generating, false);
  awaitingId = true;
  try {
    const reply = screenshot ? await window.explainApi.askVision(screenshot) : await window.explainApi.ask(q);
    if (epoch !== requestEpoch) return;
    awaitingId = false;
    if (reply === null) { fail('badResponse'); return; }
    if (typeof reply !== 'number' && !reply.ok) { fail(reply.code); return; }
    const id = typeof reply === 'number' ? reply : reply.id;
    lastId = id;
    const buffered = early.get(id);
    early.clear();
    if (buffered?.text) receive({ kind: 'delta', id, text: buffered.text });
    if (buffered?.terminal) receive(buffered.terminal);
  } catch {
    if (epoch === requestEpoch) fail('network');
  }
}

form.addEventListener('submit', (event) => {
  event.preventDefault();
  if (state !== 'generating') void ask();
});
question.addEventListener('input', clamp);
stopBtn.addEventListener('click', () => {
  window.explainApi.stop();
  invalidate();
  showHint('', false);
  setState(latestAnswer.length > 0 ? 'done' : 'idle');
});
function close(): void {
  if (closed) {
    // A second close is an explicit escape hatch if the platform clipboard operation never settles.
    if (closeAfterCopy) { closeAfterCopy = false; window.explainApi.close(); }
    return;
  }
  closed = true;
  invalidate();
  vision.destroy();
  send.disabled = true;
  if (copying) {
    closeAfterCopy = true;
    window.explainApi.stop();
  } else window.explainApi.close();
}
closeBtn.addEventListener('click', close);
openSettingsBtn.addEventListener('click', () => window.explainApi.openSettings());
retry.addEventListener('click', () => {
  if (state === 'generating') return;
  if (lastMode === 'vision') {
    invalidate();
    vision.close();
    setState('idle');
    showHint(words?.vision.reviewAgain ?? '', false);
    return;
  }
  question.value = lastQuestion;
  void ask();
});
async function copyAnswer(): Promise<void> {
  if (closed || copying || !latestAnswer || !words || state === 'generating') return;
  const w = words;
  const text = latestAnswer;
  const copyEpoch = epoch;
  const current = (): boolean => !closed && epoch === copyEpoch && latestAnswer === text;
  copying = true;
  copied.textContent = '';
  copied.classList.remove('warn');
  updateCopy();
  try {
    await navigator.clipboard.writeText(text);
    if (current()) {
      copied.textContent = w.copied;
      copied.classList.remove('warn');
    }
  } catch {
    if (current()) {
      copied.textContent = w.copyFailed;
      copied.classList.add('warn');
    }
  } finally {
    copying = false;
    if (closeAfterCopy) { closeAfterCopy = false; window.explainApi.close(); }
    else if (!closed) updateCopy();
  }
}
copy.addEventListener('click', () => { void copyAnswer(); });
document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape') {
    event.preventDefault();
    close();
  }
});

/** Model output is untrusted text: it arrives only through textContent and never as markup. */
function receive(ev: ExplainEvent): void {
  if (awaitingId) {
    // Main may push before invoke resolves. Bound both candidate IDs and answer text while awaiting that ID.
    let buffered = early.get(ev.id);
    if (!buffered && early.size < 8) {
      buffered = { text: '', terminal: null };
      early.set(ev.id, buffered);
    }
    if (buffered && !buffered.terminal) {
      if (ev.kind === 'delta') buffered.text = (buffered.text + ev.text).slice(0, 20_000);
      else buffered.terminal = ev;
    }
    return;
  }
  if (lastId === null || ev.id !== lastId) return; // stale: a replaced, stopped or dead request
  if (ev.kind === 'delta') {
    latestAnswer += ev.text;
    body.textContent = latestAnswer;
    answer.scrollTop = answer.scrollHeight;
  } else if (ev.kind === 'done') {
    lastId = null;
    showHint('', false);
    if (latestAnswer.length > 0) {
      setState('done');
    } else {
      fail('badResponse');
    }
  } else {
    fail(ev.code);
  }
}
window.explainApi.on(receive);

void window.explainApi.strings().then((t) => {
  if (!t) return;
  words = t;
  document.title = t.title;
  title.textContent = t.title;
  $('subtitle').textContent = t.subtitle;
  updateModeLabel();
  $('emptyTitle').textContent = t.emptyTitle;
  $('emptyHint').textContent = t.emptyHint;
  $('resizeHint').textContent = t.resizeHint;
  question.placeholder = t.placeholder;
  send.textContent = t.ask;
  stopBtn.textContent = t.stop;
  retry.textContent = t.retry;
  copy.textContent = t.copy;
  closeBtn.setAttribute('aria-label', t.close);
  openSettingsBtn.textContent = t.openSettings;
  setupTitle.textContent = t.unconfigured;
  setupHint.textContent = t.unconfiguredHint;
  vision.setWords(t.vision);
});
void window.explainApi.state().then((s) => {
  if (!s) return;
  if (!s.configured) setState('unconfigured');
  vision.setConfigured(s.configured);
  setSession(s.visionSessionId);
  vision.setAvailable(s.captureAvailable);
});
requestAnimationFrame(() => question.focus());
