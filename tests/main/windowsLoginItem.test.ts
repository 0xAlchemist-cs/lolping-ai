import { beforeEach, describe, expect, it } from 'vitest';
import { LOGIN_ITEM_NAME, syncWindowsLoginItem, type LoginItemBackend, type LoginItemOptions,
  type LoginItemState } from '../../src/main/windowsLoginItem';

const EXE = 'C:\\Apps\\lolPing\\lolPing.exe';
let state: LoginItemState;
let writes: LoginItemOptions[];
let reads: { path: string; args: string[] }[];
let backend: LoginItemBackend;
beforeEach(() => {
  state = { openAtLogin: false, launchItems: [] };
  writes = [];
  reads = [];
  backend = {
    read: (options) => { reads.push(options); return state; },
    write: (options) => {
      writes.push(options);
      state = { openAtLogin: options.openAtLogin, launchItems: options.openAtLogin
        ? [{ name: options.name, scope: 'user', enabled: options.enabled }] : [] };
    },
  };
});

describe('Windows login item synchronization', () => {
  it('repairs a saved enabled preference with a missing or obsolete launch path', () => {
    expect(syncWindowsLoginItem(true, EXE, backend)).toBe(true);
    expect(writes).toEqual([{ name: LOGIN_ITEM_NAME, path: EXE, args: ['--hidden'], openAtLogin: true, enabled: true }]);
    expect(reads.every((r) => r.path === EXE && r.args.join() === '--hidden')).toBe(true);
  });

  it('leaves a correct enabled registration alone on startup', () => {
    state = { openAtLogin: true, launchItems: [{ name: LOGIN_ITEM_NAME, scope: 'user', enabled: true }] };
    expect(syncWindowsLoginItem(true, EXE, backend)).toBe(true);
    expect(writes).toEqual([]);
  });

  it('reflects an OS-disabled entry without silently re-enabling it', () => {
    state = { openAtLogin: true, launchItems: [{ name: LOGIN_ITEM_NAME, scope: 'user', enabled: false }] };
    expect(syncWindowsLoginItem(true, EXE, backend)).toBe(false);
    expect(writes).toEqual([]);
  });

  it('lets an explicit user enable restore an OS-disabled entry', () => {
    state = { openAtLogin: true, launchItems: [{ name: LOGIN_ITEM_NAME, scope: 'user', enabled: false }] };
    expect(syncWindowsLoginItem(true, EXE, backend, true)).toBe(true);
    expect(writes).toHaveLength(1);
    expect(writes[0].enabled).toBe(true);
  });

  it('removes only its named registration for a disabled preference', () => {
    state = { openAtLogin: true, launchItems: [{ name: LOGIN_ITEM_NAME, scope: 'user', enabled: true }] };
    expect(syncWindowsLoginItem(false, EXE, backend, true)).toBe(false);
    expect(writes).toEqual([{ name: LOGIN_ITEM_NAME, path: EXE, args: ['--hidden'], openAtLogin: false, enabled: false }]);
  });

  it('does not create startup state when the preference and registration are absent', () => {
    expect(syncWindowsLoginItem(false, EXE, backend)).toBe(false);
    expect(writes).toEqual([]);
  });

  it('reports a system refusal rather than claiming the saved preference was applied', () => {
    backend.write = (options) => { writes.push(options); };
    expect(() => syncWindowsLoginItem(true, EXE, backend, true)).toThrow('loginItemNotApplied');
  });
});
