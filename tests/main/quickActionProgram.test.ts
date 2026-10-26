import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { copyFile, mkdir, mkdtemp, realpath, rm, symlink, unlink, writeFile } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { launchQuickActionProgram, verifyQuickActionProgram } from '../../src/main/quickActionProgram';

describe.skipIf(process.platform !== 'win32')('quick action program filesystem boundaries', () => {
  let root = '';
  let program = '';

  beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), 'lolping-action-program-'));
    program = join(root, "App's & 空格.exe");
    await copyFile(process.execPath, program);
  });

  afterAll(async () => {
    // Only the directory created by this suite is recursively removed.
    if (!root) return;
    const resolved = await realpath(root);
    if (dirname(resolved) !== await realpath(tmpdir()) || !basename(resolved).startsWith('lolping-action-program-')) {
      throw new Error('Refusing cleanup outside the owned temporary directory');
    }
    await rm(resolved, { recursive: true, force: true });
  });

  it.each([
    'app.exe', 'C:app.exe', '..\\app.exe', '\\\\server\\share\\app.exe',
    '\\\\?\\C:\\app.exe', 'https://example.com/app.exe', 'C:\\app.exe:payload.exe',
    'C:\\app.exe\u0000', 'C:\\app.lnk', 'C:\\app.cmd',
  ])('rejects an unsupported path before execution: %s', async (path) => {
    expect(await verifyQuickActionProgram(path)).toEqual({ ok: false, code: 'invalidProgram' });
  });

  it('accepts a real executable with spaces, punctuation and Unicode in its selected path', async () => {
    expect(await verifyQuickActionProgram(program)).toEqual({ ok: true, exePath: await realpath(program) });
  });

  it('rejects a missing program and a path traversing a regular file', async () => {
    expect(await verifyQuickActionProgram(join(root, 'missing.exe'))).toEqual({ ok: false, code: 'notFound' });
    expect(await verifyQuickActionProgram(join(program, 'child.exe'))).toEqual({ ok: false, code: 'notFound' });
  });

  it('rejects a directory named exe and an existing ordinary file without the exe extension', async () => {
    const directory = join(root, 'directory.exe');
    const text = join(root, 'ordinary.txt');
    await mkdir(directory);
    await writeFile(text, 'not a program');
    expect(await verifyQuickActionProgram(directory)).toEqual({ ok: false, code: 'invalidProgram' });
    expect(await verifyQuickActionProgram(text)).toEqual({ ok: false, code: 'invalidProgram' });
  });

  it('returns the actual canonical target of a directory junction', async () => {
    const alias = join(root, 'alias');
    const actual = join(root, 'actual');
    await mkdir(actual);
    const target = join(actual, 'selected.exe');
    await copyFile(program, target);
    await symlink(actual, alias, 'junction');
    const selected = join(alias, 'selected.exe');
    const result = await verifyQuickActionProgram(selected);
    expect(result).toEqual({ ok: true, exePath: await realpath(target) });
    expect(result).not.toEqual({ ok: true, exePath: selected });
  });

  it('reports a removed saved program instead of substituting a different file', async () => {
    const removed = join(root, 'removed.exe');
    await copyFile(program, removed);
    expect(await verifyQuickActionProgram(removed)).toMatchObject({ ok: true });
    await unlink(removed);
    expect(await verifyQuickActionProgram(removed)).toEqual({ ok: false, code: 'notFound' });
  });

  it('rejects a failed OS launch instead of reporting launch submission', async () => {
    await expect(launchQuickActionProgram(join(root, 'not-present.exe'))).rejects.toMatchObject({ code: 'ENOENT' });
  });
});
