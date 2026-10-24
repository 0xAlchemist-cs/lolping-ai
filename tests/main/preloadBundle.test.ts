import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { runInNewContext } from 'node:vm';
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
const builtDir = resolve(__dirname, '../../out/preload');
const expectedPreloads = ['explain', 'overlay', 'panel', 'settings', 'text'];

/** Executes the build with the sandbox's restricted require, rather than trusting a chunk directory name. */
function loadSandboxBundle(name: string): {
  exposed: Record<string, Record<string, unknown>>;
  calls: Array<{ method: string; channel: string; args: unknown[] }>;
} {
  const exposed: Record<string, Record<string, unknown>> = {};
  const calls: Array<{ method: string; channel: string; args: unknown[] }> = [];
  const ipcRenderer = Object.fromEntries(['send', 'invoke', 'on', 'removeListener'].map((method) => [
    method,
    (channel: string, ...args: unknown[]) => {
      calls.push({ method, channel, args });
      return method === 'invoke' ? Promise.resolve(null) : undefined;
    },
  ]));
  const electron = {
    contextBridge: { exposeInMainWorld: (key: string, api: Record<string, unknown>) => { exposed[key] = api; } },
    ipcRenderer,
  };
  runInNewContext(readFileSync(join(builtDir, `${name}.js`), 'utf8'), {
    require: (id: string) => {
      if (id !== 'electron') throw new Error(`Sandbox preload attempted unsupported require: ${id}`);
      return electron;
    },
    process: { platform: 'win32' },
    exports: {},
    module: { exports: {} },
  }, { filename: `${name}.js`, timeout: 1000 });
  return { exposed, calls };
}

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
      expect(m?.[1], `explain.ts local EXPLAIN_CH.${key}`).toMatch(new RegExp(`${key}\\s*:\\s*'${channel}'`));
    }
  });

  it('never splits the preload bundle into chunks (skipped when no build output exists)', () => {
    const outChunks = resolve(__dirname, '../../out/preload/chunks');
    // rollup only creates chunks/ when it split shared code between preload entries; a sandboxed
    // preload cannot require those files, so its mere presence is the outage's fingerprint.
    expect(existsSync(outChunks), 'out/preload/chunks must not exist after a build').toBe(false);
  });

  it.skipIf(!existsSync(builtDir))('contains exactly the independent production preload entries', () => {
    expect(readdirSync(builtDir).filter((file) => file.endsWith('.js')).sort())
      .toEqual(expectedPreloads.map((name) => `${name}.js`));
  });

  it.skipIf(!existsSync(builtDir)).each(expectedPreloads)('loads %s alone with only Electron available', (name) => {
    const { exposed } = loadSandboxBundle(name);
    const expectedName = name === 'overlay' ? name : `${name}Api`;
    expect(Object.keys(exposed)).toEqual([expectedName]);
    expect(Object.values(exposed[expectedName]).some((value) => typeof value === 'function')).toBe(true);
  });

  it.skipIf(!existsSync(builtDir))('exposes bounded vision commands through the standalone explain bridge', async () => {
    const { exposed, calls } = loadSandboxBundle('explain');
    const api = exposed.explainApi as {
      capture: (sessionId: number) => Promise<unknown>;
      closePreview: (sessionId: number) => void;
      onVisionSession: (cb: (id: number) => void) => () => void;
    };
    await api.capture(7);
    api.closePreview(7);
    const unsubscribe = api.onVisionSession(() => undefined);
    unsubscribe();
    expect(calls.map(({ method, channel }) => [method, channel])).toEqual([
      ['invoke', EXPLAIN_CH.capture],
      ['send', EXPLAIN_CH.closePreview],
      ['on', EXPLAIN_CH.visionSession],
      ['removeListener', EXPLAIN_CH.visionSession],
    ]);
    expect(calls[0].args).toEqual([7]);
    expect(calls[1].args).toEqual([7]);
    expect(calls[2].args[0]).toBe(calls[3].args[0]);
  });
});
