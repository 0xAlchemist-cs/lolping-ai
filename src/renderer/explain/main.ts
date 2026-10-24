import { MAX_QUESTION } from '../../shared/explain';
import type { AiErrorCode } from '../../shared/aiConfig';
import type { ExplainText } from '../../shared/ipc';

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

let words: ExplainText | null = null;
let lastId: number | null = null;
let latestAnswer = '';
let lastQuestion = '';

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
  stopBtn.hidden = next !== 'generating';
  setup.hidden = next !== 'unconfigured';
  failure.hidden = next !== 'error';
}

/** Failure text in the page's own words; the code alone when a translation is missing. */
function errorText(code: AiErrorCode): string {
  return words?.errors[code] ?? code;
}

async function ask(): Promise<void> {
  if (!words) return;
  const q = question.value.trim();
  if (!q) {
    showHint(words.empty, true);
    return;
  }
  lastQuestion = q;
  latestAnswer = '';
  body.textContent = '';
  answer.hidden = false; // the answer area is the stream's stage from the first token on
  copy.disabled = true;
  copied.textContent = '';
  copied.classList.remove('warn');
  setState('generating');
  showHint(words.generating, false);
  let id: number | null = null;
  try {
    id = await window.explainApi.ask(q);
  } finally {
    // P1A left the button stuck when the call threw; whatever happened, the card must stay usable.
    send.disabled = false;
  }
  if (id === null) {
    setState('idle');
    showHint(words.empty, true);
    return;
  }
  lastId = id;
}

form.addEventListener('submit', (event) => {
  event.preventDefault();
  if (state !== 'generating') void ask();
});
question.addEventListener('input', clamp);
stopBtn.addEventListener('click', () => {
  window.explainApi.stop();
  lastId = null;
  setState(latestAnswer.length > 0 ? 'done' : 'idle');
  copy.disabled = latestAnswer.length === 0;
});
closeBtn.addEventListener('click', () => window.explainApi.close());
openSettingsBtn.addEventListener('click', () => window.explainApi.openSettings());
retry.addEventListener('click', () => {
  question.value = lastQuestion;
  void ask();
});
copy.addEventListener('click', () => {
  if (!latestAnswer || !words) return;
  const w = words;
  void navigator.clipboard.writeText(latestAnswer).then(
    () => {
      copied.textContent = w.copied;
      copied.classList.remove('warn');
    },
    () => {
      // P1A swallowed this failure; now the user knows why nothing landed in the clipboard.
      copied.textContent = w.copyFailed;
      copied.classList.add('warn');
    },
  );
});
document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape') {
    event.preventDefault();
    window.explainApi.close();
  }
});

/** Model output is untrusted text: it arrives only through textContent and never as markup. */
window.explainApi.on((ev) => {
  if (lastId === null || ev.id !== lastId) return; // stale: a replaced, stopped or dead request
  if (ev.kind === 'delta') {
    latestAnswer += ev.text;
    body.textContent = latestAnswer;
    answer.scrollTop = answer.scrollHeight;
  } else if (ev.kind === 'done') {
    lastId = null;
    if (latestAnswer.length > 0) {
      setState('done');
      copy.disabled = false;
    } else {
      failureTitle.textContent = words?.errorTitle ?? '';
      failureText.textContent = errorText('badResponse');
      setState('error');
    }
  } else {
    lastId = null;
    failureTitle.textContent = words?.errorTitle ?? '';
    failureText.textContent = errorText(ev.code);
    setState('error');
  }
});

void window.explainApi.strings().then((t) => {
  if (!t) return;
  words = t;
  document.title = t.title;
  title.textContent = t.title;
  question.placeholder = t.placeholder;
  send.textContent = t.ask;
  stopBtn.textContent = t.stop;
  retry.textContent = t.retry;
  copy.textContent = t.copy;
  closeBtn.setAttribute('aria-label', t.close);
  openSettingsBtn.textContent = t.openSettings;
  setupTitle.textContent = t.unconfigured;
  setupHint.textContent = t.unconfiguredHint;
});
void window.explainApi.state().then((s) => {
  if (s && !s.configured) setState('unconfigured');
});
requestAnimationFrame(() => question.focus());
