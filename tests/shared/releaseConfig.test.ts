import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

describe('release configuration', () => {
  it('ships a fork update feed and project links instead of the upstream application', () => {
    const pkg = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8'));
    expect(pkg.build.publish).toEqual([{ provider: 'github', owner: '0xAlchemist-cs', repo: 'lolping-ai' }]);
    expect(pkg.repository.url).toBe('https://github.com/0xAlchemist-cs/lolping-ai.git');
    expect(pkg.homepage).toBe('https://github.com/0xAlchemist-cs/lolping-ai#readme');
    expect(pkg.bugs).toBe('https://github.com/0xAlchemist-cs/lolping-ai/issues');
  });
});
