import { spawn } from 'node:child_process';
import { realpath, stat } from 'node:fs/promises';
import { dirname } from 'node:path';
import { isLocalExePath } from '../shared/quickActions';

export type ProgramVerification = { ok: true; exePath: string } | { ok: false; code: 'notFound' | 'invalidProgram' };

/** Resolve again at save and execution time: a selected link must not become a nonlocal or non-exe target. */
export async function verifyQuickActionProgram(path: string): Promise<ProgramVerification> {
  if (!isLocalExePath(path)) return { ok: false, code: 'invalidProgram' };
  try {
    const canonical = await realpath(path);
    if (!isLocalExePath(canonical) || !(await stat(canonical)).isFile()) return { ok: false, code: 'invalidProgram' };
    return { ok: true, exePath: canonical };
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    return { ok: false, code: code === 'ENOENT' || code === 'ENOTDIR' ? 'notFound' : 'invalidProgram' };
  }
}

/** Success means Windows accepted the process creation, not that the target has finished loading. */
export function launchQuickActionProgram(path: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(path, [], {
      cwd: dirname(path), shell: false, detached: true, stdio: 'ignore', windowsHide: false,
    });
    child.once('error', reject);
    child.once('spawn', () => { child.unref(); resolve(); });
  });
}
