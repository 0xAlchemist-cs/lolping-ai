import { MAX_QUESTION } from '../../shared/explain';
import type { ExplainText } from '../../shared/ipc';

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const title = $('title');
const closeBtn = $('close');
const form = $('ask') as HTMLFormElement;
const question = $('question') as HTMLInputElement;
const send = $('send') as HTMLButtonElement;
const hint = $('hint');
const answer = $('answer');
const badge = $('badge');
const body = $('body');
const copy = $('copy') as HTMLButtonElement;
const copied = $('copied');

let words: ExplainText | null = null;
let latestAnswer = '';

/** A code point is one letter, one Chinese character or one emoji, however many UTF-16 units it takes. */
function clamp(): void {
  const points = [...question.value];
  if (points.length > MAX_QUESTION) question.value = points.slice(0, MAX_QUESTION).join('');
}

function showHint(message: string, warn: boolean): void {
  hint.textContent = message;
  hint.classList.toggle('warn', warn);
}

async function ask(): Promise<void> {
  if (!words) return;
  const q = question.value.trim();
  if (!q) {
    showHint(words.empty, true);
    return;
  }
  send.disabled = true;
  const answerText = await window.explainApi.ask(q);
  send.disabled = false;
  if (answerText === null) return; // the main process rejected the question; its hint already says why
  latestAnswer = answerText;
  badge.textContent = words.simulatedLabel;
  body.textContent = answerText;
  answer.hidden = false;
  copy.disabled = false;
  copied.textContent = '';
  showHint(words.hint, false);
}

form.addEventListener('submit', (event) => {
  event.preventDefault();
  void ask();
});
question.addEventListener('input', clamp);
closeBtn.addEventListener('click', () => window.explainApi.close());
copy.addEventListener('click', () => {
  if (!latestAnswer || !words) return;
  void navigator.clipboard.writeText(latestAnswer).then(() => {
    copied.textContent = words ? words.copied : '';
  });
});
document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape') {
    event.preventDefault();
    window.explainApi.close();
  }
});

void window.explainApi.strings().then((t) => {
  if (!t) return;
  words = t;
  document.title = t.title;
  title.textContent = t.title;
  question.placeholder = t.placeholder;
  send.textContent = t.ask;
  copy.textContent = t.copy;
  closeBtn.setAttribute('aria-label', t.close);
  showHint(t.hint, false);
});
requestAnimationFrame(() => question.focus());
