import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { EXPLAIN_CH } from '../../src/shared/ipc';

/**
 * Regression tests for the P1B signal outage: explain.ts imported EXPLAIN_CH by value from
 * ../shared/ipc, so the preload build had two entries consuming that module (overlay.ts is the
 * other) and rollup emitted a shared chunk. A sandboxed preload cannot require a generated
 * sibling chunk, so overlay.js crashed with "module not found" before contextBridge ran —
 * the overlay renderer lost its event channel and every gesture died silently.
 */

const preloadDir = resolve(__dirname, '../../src/preload');
const explainSource = readFileSync(join(preloadDir, 'explain.ts'), 'utf8');
const preloadSources = readdirSync(preloadDir).filter((f) => f.endsWith('.ts'));

/** True when `source` imports RUNTIME values (not just types) from '../shared/ipc'. Handles multi-line imports. */
const valueImportsSharedIpc = (source: string): boolean => {
  // import braces never nest, so [^}] pins each match to one statement; `import type {...}` is wholly erased.
  const re = /import\s+(type\s+)?\{([^}]*)\}\s*from\s*'\.\.\/shared\/ipc'/g;
  for (const m of source.matchAll(re)) {
    if (m[1]) continue; // `import type {...}`: the whole statement is erased at build time
    // otherwise every specifier must itself be a `type` import for the statement to be type-only
    if (m[2].split(',').some((spec) => spec.trim() !== '' && !/^\s*type\s/.test(spec))) return true;
  }
  return false;
};

describe('preload sandbox bundle safety', () => {
  it('has at most one preload entry value-importing ../shared/ipc (two or more force a shared chunk)', () => {
    const offenders = preloadSources.filter((f) => valueImportsSharedIpc(readFileSync(join(preloadDir, f), 'utf8')));
    // overlay.ts is the one allowed consumer; its import gets inlined because it is alone.
    expect(offenders).toEqual(['overlay.ts']);
  });

  it("keeps explain.ts's inlined channels in sync with shared/ipc.ts's EXPLAIN_CH", () => {
    const m = explainSource.match(/const EXPLAIN_CH = \{([\s\S]*?)\} as const/);
    expect(m, 'explain.ts must keep a local, inlined EXPLAIN_CH constant').not.toBeNull();
    for (const [key, channel] of Object.entries(EXPLAIN_CH)) {
      expect(m![1], `explain.ts local EXPLAIN_CH.${key}`).toMatch(new RegExp(`${key}\\s*:\\s*'${channel}'`));
    }
  });

  it('never splits the preload bundle into chunks (skipped when no build output exists)', () => {
    const outChunks = resolve(__dirname, '../../out/preload/chunks');
    // rollup only creates chunks/ when it split shared code between preload entries; a sandboxed
    // preload cannot require those files, so its mere presence is the outage's fingerprint.
    expect(existsSync(outChunks), 'out/preload/chunks must not exist after a build').toBe(false);
  });
});
