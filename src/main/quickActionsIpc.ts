import { ipcMain, type BrowserWindow, type IpcMainInvokeEvent, type WebFrameMain } from 'electron';
import { randomBytes } from 'node:crypto';
import { win32 } from 'node:path';
import type { Platform } from '../shared/platform';
import {
  isActionPingId, normalizeQuickActionBinding, normalizeQuickActionUrl,
  type QuickActionBinding, type QuickActionError, type QuickActionMutationResult, type QuickActionProgramSelection,
  type QuickActionResult, type QuickActionTarget,
} from '../shared/quickActions';
import { SETTINGS_CH } from '../shared/settingsChannels';
import type { ProgramVerification } from './quickActionProgram';
import type { SettingsStore } from './settingsStore';

interface QuickActionsIpcDeps {
  platform: Platform;
  store: SettingsStore;
  window(): BrowserWindow | null;
  pickProgram(owner: BrowserWindow): Promise<string | null>;
  verifyProgram(path: string): Promise<ProgramVerification>;
  execute(binding: QuickActionBinding, allowed: () => boolean): Promise<QuickActionResult>;
  onError?(code: QuickActionError): void;
  now?: () => number;
  makeToken?: () => string;
}

const isObj = (raw: unknown): raw is Record<string, unknown> =>
  typeof raw === 'object' && raw !== null && !Array.isArray(raw);

/** Registers only saved-binding operations; picking a program grants a short-lived permission to its settings frame. */
export function registerQuickActionsIpc(d: QuickActionsIpcDeps): () => void {
  const now = d.now ?? Date.now;
  const token = d.makeToken ?? (() => randomBytes(24).toString('hex'));
  const selections = new Map<string, { owner: BrowserWindow; frame: WebFrameMain | null; exePath: string; expires: number }>();
  let generation = 0;
  let mutations: Promise<unknown> = Promise.resolve();
  const serial = <T>(run: () => Promise<T>): Promise<T> => {
    const next = mutations.then(run);
    mutations = next.catch(() => undefined);
    return next;
  };
  const ownerOf = (event: IpcMainInvokeEvent): BrowserWindow | null => {
    try {
      const owner = d.window();
      return owner && !owner.isDestroyed() && event.sender === owner.webContents
        && event.senderFrame !== null && event.senderFrame !== undefined
        && event.senderFrame === owner.webContents.mainFrame ? owner : null;
    } catch {
      return null;
    }
  };

  ipcMain.handle(SETTINGS_CH.quickActionPick, async (event): Promise<QuickActionProgramSelection | null> => {
    const owner = ownerOf(event);
    if (!owner || d.platform !== 'win') return null;
    const version = generation;
    try {
      const selected = await d.pickProgram(owner);
      if (!selected || generation !== version || ownerOf(event) !== owner) return null;
      const verified = await d.verifyProgram(selected);
      if (generation !== version || ownerOf(event) !== owner) return null;
      if (!verified.ok) {
        d.onError?.(verified.code);
        return null;
      }
      // A forgotten editor or repeated picks must not accumulate unlimited capabilities.
      while (selections.size >= 16) {
        const oldest = selections.keys().next().value;
        if (oldest !== undefined) selections.delete(oldest);
      }
      const id = token();
      selections.set(id, { owner, frame: event.senderFrame, exePath: verified.exePath, expires: now() + 600000 });
      const name = Array.from(win32.basename(verified.exePath).replace(/\.exe$/i, '')).slice(0, 64).join('');
      return { token: id, exePath: verified.exePath, name };
    } catch {
      if (generation === version && ownerOf(event) === owner) d.onError?.('invalidProgram');
      return null;
    }
  });

  ipcMain.handle(SETTINGS_CH.quickActionSave, (event, id: unknown, raw: unknown): Promise<QuickActionMutationResult> => serial(async () => {
    const owner = ownerOf(event);
    if (!owner) return { ok: false, code: 'unauthorized' };
    if (d.platform !== 'win') return { ok: false, code: 'unsupported' };
    if (!isActionPingId(id) || !isObj(raw) || !isObj(raw.target)) return { ok: false, code: 'invalidBinding' };
    const target = raw.target;
    let resolved: QuickActionTarget;
    let selectedToken: string | undefined;
    const version = generation;
    if (target.kind === 'app') {
      // A renderer's path is display-only. Only a picker capability or this icon's saved target can select a program.
      if ('exePath' in target) return { ok: false, code: 'invalidProgram' };
      let path: string;
      if (target.programToken !== undefined) {
        if (typeof target.programToken !== 'string') return { ok: false, code: 'programSelectionExpired' };
        const permission = selections.get(target.programToken);
        if (!permission || permission.expires <= now() || permission.owner !== owner || permission.frame !== event.senderFrame) {
          if (permission && permission.expires <= now()) selections.delete(target.programToken);
          return { ok: false, code: 'programSelectionExpired' };
        }
        selectedToken = target.programToken;
        path = permission.exePath;
      } else {
        const existing = d.store.get().quickActions.bindings[id];
        if (existing?.target.kind !== 'app') return { ok: false, code: 'invalidProgram' };
        path = existing.target.exePath;
      }
      const verified = await d.verifyProgram(path);
      if (version !== generation || ownerOf(event) !== owner) return { ok: false, code: 'unauthorized' };
      if (!verified.ok) return verified;
      if (selectedToken !== undefined) {
        const permission = selections.get(selectedToken);
        if (!permission || permission.expires <= now()) return { ok: false, code: 'programSelectionExpired' };
      }
      if (verified.exePath !== path) return { ok: false, code: 'invalidProgram' };
      resolved = { kind: 'app', exePath: verified.exePath };
    } else if (target.kind === 'web') {
      const url = normalizeQuickActionUrl(target.url);
      if (url === null) return { ok: false, code: 'invalidUrl' };
      resolved = { kind: 'web', url };
    } else if (target.kind === 'toggleDesktop') resolved = { kind: 'toggleDesktop' };
    else return { ok: false, code: 'invalidBinding' };
    const binding = normalizeQuickActionBinding({ enabled: raw.enabled, name: raw.name, target: resolved });
    if (!binding) return { ok: false, code: 'invalidBinding' };
    if (version !== generation || ownerOf(event) !== owner) return { ok: false, code: 'unauthorized' };
    const bindings = { ...d.store.get().quickActions.bindings, [id]: binding };
    const settings = d.store.update({ quickActions: { version: 1, bindings } });
    if (selectedToken !== undefined) selections.delete(selectedToken);
    return { ok: true, settings };
  }));

  ipcMain.handle(SETTINGS_CH.quickActionRemove, (event, id: unknown): Promise<QuickActionMutationResult> => serial(async () => {
    if (!ownerOf(event)) return { ok: false, code: 'unauthorized' };
    if (d.platform !== 'win') return { ok: false, code: 'unsupported' };
    if (!isActionPingId(id)) return { ok: false, code: 'invalidBinding' };
    const bindings = { ...d.store.get().quickActions.bindings };
    delete bindings[id];
    return { ok: true, settings: d.store.update({ quickActions: { version: 1, bindings } }) };
  }));

  ipcMain.handle(SETTINGS_CH.quickActionTest, async (event, id: unknown): Promise<QuickActionResult> => {
    const owner = ownerOf(event);
    if (!owner) return { ok: false, code: 'unauthorized' };
    if (d.platform !== 'win') return { ok: false, code: 'unsupported' };
    if (!isActionPingId(id)) return { ok: false, code: 'invalidBinding' };
    const snapshot = d.store.get();
    const binding = snapshot.quickActions.bindings[id];
    if (!binding?.enabled) return { ok: false, code: 'disabled' };
    const version = generation;
    return d.execute(binding, () => version === generation && ownerOf(event) === owner && d.store.get() === snapshot);
  });

  return () => {
    generation++;
    selections.clear();
  };
}
