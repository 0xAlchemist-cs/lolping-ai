import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { safeStorage } from 'electron';

const FILE = 'ai-key.bin';
/** Keys are opaque bearer tokens; anything past this is not a key someone meant to store. */
const MAX_KEY = 4096;

/**
 * The API key store: one encrypted file next to settings.json, written only through safeStorage, so the plaintext
 * key never touches disk or settings.json. A key that cannot be encrypted is refused instead of downgraded: callers
 * surface `noEncryption` and keep nothing.
 */
export class AiKeyStore {
  constructor(private readonly dir: string) {}

  private get file(): string {
    return join(this.dir, FILE);
  }

  /** True when the OS offers a real encryption backend (DPAPI on Windows, Keychain on macOS). */
  encryptionAvailable(): boolean {
    try {
      return safeStorage.isEncryptionAvailable();
    } catch {
      return false;
    }
  }

  /** A key worth storing: 1..4096 characters and no control characters. */
  static validKey(raw: unknown): raw is string {
    if (typeof raw !== 'string') return false;
    if (raw.length === 0 || raw.length > MAX_KEY) return false;
    return ![...raw].some((ch) => {
      const cp = ch.codePointAt(0) ?? 0;
      return cp < 0x20 || cp === 0x7f;
    });
  }

  /** Encrypts and saves. Throws `noEncryption` rather than writing plaintext; `badKey` for a shape it rejects. */
  async set(raw: unknown): Promise<{ ok: true } | { ok: false; code: 'noEncryption' | 'badKey' }> {
    if (!AiKeyStore.validKey(raw)) return { ok: false, code: 'badKey' };
    if (!this.encryptionAvailable()) return { ok: false, code: 'noEncryption' };
    const blob = safeStorage.encryptString(raw);
    await mkdir(this.dir, { recursive: true });
    const tmp = `${this.file}.tmp`;
    await writeFile(tmp, blob);
    await rename(tmp, this.file);
    return { ok: true };
  }

  /** The saved key, or null when none is stored or the blob no longer decrypts (never throws). */
  async get(): Promise<string | null> {
    let blob: Buffer;
    try {
      blob = await readFile(this.file);
    } catch {
      return null;
    }
    try {
      return safeStorage.decryptString(Buffer.from(blob));
    } catch {
      return null; // a key from another machine or a damaged file: treat as absent
    }
  }

  /** True when a key file exists. */
  async has(): Promise<boolean> {
    try {
      await readFile(this.file);
      return true;
    } catch {
      return false;
    }
  }

  /** Forgets the key. Safe to call when nothing is stored. */
  async clear(): Promise<void> {
    await rm(this.file, { force: true });
    await rm(`${this.file}.tmp`, { force: true });
  }
}
