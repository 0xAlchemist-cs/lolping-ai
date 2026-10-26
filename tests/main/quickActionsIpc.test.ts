import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { BrowserWindow } from 'electron';
import { registerQuickActionsIpc } from '../../src/main/quickActionsIpc';
import { SettingsStore } from '../../src/main/settingsStore';
import { SETTINGS_CH } from '../../src/shared/settingsChannels';
import type { QuickActionBinding } from '../../src/shared/quickActions';
import type { ProgramVerification } from '../../src/main/quickActionProgram';

const h = vi.hoisted(() => ({ handlers: new Map<string, (event: unknown, ...args: unknown[]) => unknown>() }));
vi.mock('electron', () => ({
  ipcMain: { handle: (channel: string, fn: (event: unknown, ...args: unknown[]) => unknown) => h.handlers.set(channel, fn) },
}));

const frame = {};
const owner = { webContents: { mainFrame: frame }, isDestroyed: () => false };
const ownEvent = () => ({ sender: owner.webContents, senderFrame: frame });
let store: SettingsStore;
let dir: string;
let now: number;
let clear: () => void;
let chosen: string | null;
let ownerPresent: boolean;
let executions: QuickActionBinding[];
let picker: () => Promise<string | null>;
let verifier: (path: string) => Promise<ProgramVerification>;

const call = async (channel: string, ...args: unknown[]) => invoke(channel, ownEvent(), ...args);
async function invoke(channel: string, event: unknown, ...args: unknown[]): Promise<unknown> {
  const handler = h.handlers.get(channel);
  if (!handler) throw new Error(`unregistered channel: ${channel}`);
  return handler(event, ...args);
}

beforeEach(async () => {
  h.handlers.clear();
  dir = await mkdtemp(join(tmpdir(), 'lolping-quick-ipc-'));
  store = new SettingsStore(dir, 60000);
  store.load();
  now = 0;
  chosen = 'C:\\Apps\\Example.exe';
  ownerPresent = true;
  executions = [];
  picker = async () => chosen;
  verifier = async (exePath) => ({ ok: true, exePath });
  clear = registerQuickActionsIpc({
    platform: 'win', store,
    window: () => ownerPresent ? owner as unknown as BrowserWindow : null,
    pickProgram: () => picker(),
    verifyProgram: (path) => verifier(path),
    execute: async (binding, allowed) => {
      if (!allowed()) return { ok: false, code: 'disabled' };
      executions.push(binding);
      return { ok: true, status: 'opened' };
    },
    now: () => now,
    makeToken: () => 'selected-program-token',
  });
});
afterEach(async () => {
  clear();
  await store.flush();
  await rm(dir, { recursive: true, force: true });
});

describe('quick action IPC', () => {
  it('authorizes only the current settings main frame for every operation', async () => {
    const forged = [{ sender: {}, senderFrame: frame }, { sender: owner.webContents, senderFrame: {} },
      { sender: owner.webContents, senderFrame: null }];
    for (const event of forged) {
      expect(await invoke(SETTINGS_CH.quickActionPick, event)).toBeNull();
      for (const channel of [SETTINGS_CH.quickActionSave, SETTINGS_CH.quickActionRemove, SETTINGS_CH.quickActionTest]) {
        expect(await invoke(channel, event, 'danger', {})).toEqual({ ok: false, code: 'unauthorized' });
      }
    }
    expect(store.get().quickActions.bindings).toEqual({});
  });

  it('saves a valid web binding atomically and tests it while the global feature is off', async () => {
    expect(await call(SETTINGS_CH.quickActionSave, 'danger', {
      enabled: true, name: 'GitHub', target: { kind: 'web', url: 'https://github.com' },
    })).toMatchObject({ ok: true });
    expect(store.get().features.quickActions).toBe(false);
    expect(store.get().quickActions.bindings.danger).toEqual({
      enabled: true, name: 'GitHub', target: { kind: 'web', url: 'https://github.com/' },
    });
    expect(await call(SETTINGS_CH.quickActionTest, 'danger')).toEqual({ ok: true, status: 'opened' });
    expect(executions).toEqual([{ enabled: true, name: 'GitHub', target: { kind: 'web', url: 'https://github.com/' } }]);
  });

  it('requires a picker token for new programs and never accepts a raw renderer path', async () => {
    const forged = { enabled: true, name: 'App', target: { kind: 'app', exePath: 'C:\\Forged.exe' } };
    expect(await call(SETTINGS_CH.quickActionSave, 'danger', forged)).toEqual({ ok: false, code: 'invalidProgram' });
    const selection = await call(SETTINGS_CH.quickActionPick);
    expect(selection).toEqual({ token: 'selected-program-token', exePath: 'C:\\Apps\\Example.exe', name: 'Example' });
    expect(await call(SETTINGS_CH.quickActionSave, 'danger', {
      enabled: true, name: 'App', target: { kind: 'app', programToken: 'selected-program-token' },
    })).toMatchObject({ ok: true });
    expect(store.get().quickActions.bindings.danger?.target).toEqual({ kind: 'app', exePath: 'C:\\Apps\\Example.exe' });
    expect(await call(SETTINGS_CH.quickActionSave, 'push', {
      enabled: true, name: 'App', target: { kind: 'app', programToken: 'selected-program-token' },
    })).toEqual({ ok: false, code: 'programSelectionExpired' });
  });

  it('allows reuse only of that same icon binding saved program', async () => {
    store.update({ quickActions: { version: 1, bindings: {
      danger: { enabled: true, name: 'App', target: { kind: 'app', exePath: 'C:\\Apps\\Example.exe' } },
    } } });
    const draft = { enabled: false, name: 'Renamed', target: { kind: 'app' } };
    expect(await call(SETTINGS_CH.quickActionSave, 'danger', draft)).toMatchObject({ ok: true });
    expect(store.get().quickActions.bindings.danger).toEqual({
      enabled: false, name: 'Renamed', target: { kind: 'app', exePath: 'C:\\Apps\\Example.exe' },
    });
    expect(await call(SETTINGS_CH.quickActionSave, 'push', draft)).toEqual({ ok: false, code: 'invalidProgram' });
    expect(await call(SETTINGS_CH.quickActionTest, 'danger')).toEqual({ ok: false, code: 'disabled' });
  });

  it('expires picker permissions and clears them on settings-window closure', async () => {
    await call(SETTINGS_CH.quickActionPick);
    now = 600000;
    const draft = { enabled: true, name: 'App', target: { kind: 'app', programToken: 'selected-program-token' } };
    expect(await call(SETTINGS_CH.quickActionSave, 'danger', draft)).toEqual({ ok: false, code: 'programSelectionExpired' });
    await call(SETTINGS_CH.quickActionPick);
    clear();
    expect(await call(SETTINGS_CH.quickActionSave, 'danger', draft)).toEqual({ ok: false, code: 'programSelectionExpired' });
  });

  it('reserves missing even through forged IPC and rejects invalid URLs without overwriting a binding', async () => {
    const draft = { enabled: true, name: 'Desktop', target: { kind: 'showDesktop' } };
    for (const channel of [SETTINGS_CH.quickActionSave, SETTINGS_CH.quickActionRemove, SETTINGS_CH.quickActionTest]) {
      expect(await call(channel, 'missing', draft)).toEqual({ ok: false, code: 'invalidBinding' });
    }
    await call(SETTINGS_CH.quickActionSave, 'danger', draft);
    expect(await call(SETTINGS_CH.quickActionSave, 'danger', {
      ...draft, target: { kind: 'web', url: 'javascript:alert(1)' },
    })).toEqual({ ok: false, code: 'invalidUrl' });
    expect(store.get().quickActions.bindings.danger?.target).toEqual({ kind: 'showDesktop' });
    expect(await call(SETTINGS_CH.quickActionRemove, 'danger')).toMatchObject({ ok: true });
    expect(store.get().quickActions.bindings).toEqual({});
  });

  it('refuses operations when the settings owner no longer exists', async () => {
    ownerPresent = false;
    expect(await call(SETTINGS_CH.quickActionPick)).toBeNull();
    expect(await call(SETTINGS_CH.quickActionSave, 'danger', {})).toEqual({ ok: false, code: 'unauthorized' });
  });

  it('discards a picker result that arrives after its settings window has closed', async () => {
    let finish = (_path: string | null) => undefined as void;
    picker = () => new Promise<string | null>((resolve) => { finish = resolve; });
    const pending = call(SETTINGS_CH.quickActionPick);
    ownerPresent = false;
    clear();
    finish('C:\\Apps\\Example.exe');
    expect(await pending).toBeNull();
    ownerPresent = true;
    expect(await call(SETTINGS_CH.quickActionSave, 'danger', {
      enabled: true, name: 'Stale', target: { kind: 'app', programToken: 'selected-program-token' },
    })).toEqual({ ok: false, code: 'programSelectionExpired' });
  });

  it('rejects a picker permission that expires while the file is being verified', async () => {
    await call(SETTINGS_CH.quickActionPick);
    let release = (_value: ProgramVerification) => undefined as void;
    let started = () => undefined as void;
    const verifying = new Promise<void>((resolve) => { started = resolve; });
    verifier = () => new Promise<ProgramVerification>((resolve) => { release = resolve; started(); });
    const pending = call(SETTINGS_CH.quickActionSave, 'danger', {
      enabled: true, name: 'Expired', target: { kind: 'app', programToken: 'selected-program-token' },
    });
    await verifying;
    now = 600000;
    release({ ok: true, exePath: 'C:\\Apps\\Example.exe' });
    expect(await pending).toEqual({ ok: false, code: 'programSelectionExpired' });
    expect(store.get().quickActions.bindings).toEqual({});
  });

  it('does not save a selected path that was redirected to another executable', async () => {
    await call(SETTINGS_CH.quickActionPick);
    verifier = async () => ({ ok: true, exePath: 'C:\\Other.exe' });
    expect(await call(SETTINGS_CH.quickActionSave, 'danger', {
      enabled: true, name: 'Replaced', target: { kind: 'app', programToken: 'selected-program-token' },
    })).toEqual({ ok: false, code: 'invalidProgram' });
    expect(store.get().quickActions.bindings).toEqual({});
  });
});
