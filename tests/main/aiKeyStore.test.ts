import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { encrypted } = vi.hoisted(() => ({ encrypted: new Map<string, Buffer>() }));

vi.mock('electron', () => ({
  safeStorage: {
    isEncryptionAvailable: () => available(),
    encryptString: (plain: string) => {
      // Stand-in for DPAPI: observably not the plaintext on disk, and reversible.
      const buf = Buffer.from(`enc:${Buffer.from(plain, 'utf8').toString('base64')}`, 'utf8');
      encrypted.set(plain, buf);
      return buf;
    },
    decryptString: (blob: Buffer) => {
      const text = blob.toString('utf8');
      if (!text.startsWith('enc:')) throw new Error('invalid');
      return Buffer.from(text.slice(4), 'base64').toString('utf8');
    },
  },
}));

let ok = true;
const available = (): boolean => ok;

type Store = typeof import('../../src/main/aiKeyStore').AiKeyStore;
let Ctor: Store;
let dir: string;

beforeEach(async () => {
  ok = true;
  encrypted.clear();
  vi.resetModules();
  ({ AiKeyStore: Ctor } = await import('../../src/main/aiKeyStore'));
  dir = await mkdtemp(join(tmpdir(), 'ai-key-'));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe('AiKeyStore', () => {
  it('round-trips a key through the encrypted store and back', async () => {
    const store = new Ctor(dir);
    expect(await store.set('sk-test-123')).toEqual({ ok: true });
    expect(await store.has()).toBe(true);
    expect(await store.get()).toBe('sk-test-123');
  });

  it('never writes the plaintext key to disk', async () => {
    const store = new Ctor(dir);
    await store.set('sk-plaintext-must-not-appear');
    const onDisk = (await readdir(dir)).map(async (f) => (await readFile(join(dir, f))).toString('utf8'));
    for (const content of await Promise.all(onDisk)) {
      expect(content).not.toContain('sk-plaintext-must-not-appear');
    }
  });

  it('refuses to persist when system encryption is unavailable, and keeps nothing', async () => {
    ok = false;
    const store = new Ctor(dir);
    expect(await store.set('sk-good-key')).toEqual({ ok: false, code: 'noEncryption' });
    expect(await store.has()).toBe(false);
    expect(await readdir(dir)).toEqual([]);
  });

  it('rejects a key of the wrong shape', async () => {
    const store = new Ctor(dir);
    expect(await store.set('')).toEqual({ ok: false, code: 'badKey' });
    expect(await store.set(null)).toEqual({ ok: false, code: 'badKey' });
    expect(await store.set('bad\u0007key')).toEqual({ ok: false, code: 'badKey' });
    expect(await store.set('x'.repeat(4097))).toEqual({ ok: false, code: 'badKey' });
  });

  it('clear forgets the key and is safe to repeat', async () => {
    const store = new Ctor(dir);
    await store.set('sk-temp');
    await store.clear();
    expect(await store.has()).toBe(false);
    expect(await store.get()).toBeNull();
    await store.clear();
  });

  it('treats a damaged or foreign blob as no key at all, never throwing', async () => {
    const store = new Ctor(dir);
    await store.set('sk-real');
    const { writeFile } = await import('node:fs/promises');
    await writeFile(join(dir, 'ai-key.bin'), Buffer.from('garbage-from-another-machine'));
    expect(await store.get()).toBeNull();
  });
});
