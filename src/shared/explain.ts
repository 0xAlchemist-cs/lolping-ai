/** The question box's limit, in code points, kept in step with the room text limit's spirit. */
export const MAX_QUESTION = 200;

/** Anything that is not a printable character has no business in a question we send to a service. */
const stripControls = (s: string): string => [...s].filter((ch) => {
  const cp = ch.codePointAt(0) ?? 0;
  return cp === 0x20 || (cp > 0x1f && cp !== 0x7f);
}).join('');

/** A question we are willing to send: trimmed, control-free and cut to MAX_QUESTION code points. Null when empty. */
export function parseQuestion(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const cut = [...stripControls(raw)].slice(0, MAX_QUESTION).join('');
  const q = cut.trim();
  return q.length > 0 ? q : null;
}
