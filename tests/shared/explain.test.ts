import { describe, expect, it } from 'vitest';
import { MAX_QUESTION, parseQuestion } from '../../src/shared/explain';

describe('parseQuestion', () => {
  it('accepts a plain question and trims it', () => {
    expect(parseQuestion('  what is this? ')).toBe('what is this?');
  });

  it('rejects anything that is not a string', () => {
    expect(parseQuestion(null)).toBeNull();
    expect(parseQuestion(42)).toBeNull();
    expect(parseQuestion({ q: 'hi' })).toBeNull();
  });

  it('rejects a question that is empty after cleaning', () => {
    expect(parseQuestion('')).toBeNull();
    expect(parseQuestion('   ')).toBeNull();
    expect(parseQuestion('\n\t\r')).toBeNull();
  });

  it('strips control characters, so nothing echoed back can reshape the card', () => {
    expect(parseQuestion('a\u0000b\u0007c\nd\te')).toBe('abcde');
  });

  it('cuts to the limit in code points, not UTF-16 units', () => {
    const long = '🧿'.repeat(MAX_QUESTION + 10);
    const q = parseQuestion(long) ?? '';
    expect([...q]).toHaveLength(MAX_QUESTION);
    expect([...q].every((ch) => ch === '🧿')).toBe(true);
  });
});
