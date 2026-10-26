import { isPingId, type PingId } from './pings';
import type { Settings } from './settings';

export type ActionPingId = Exclude<PingId, 'missing'>;

export const isActionPingId = (raw: unknown): raw is ActionPingId => isPingId(raw) && raw !== 'missing';

export type QuickActionTarget =
  | { kind: 'web'; url: string }
  | { kind: 'app'; exePath: string }
  | { kind: 'toggleDesktop' };

export interface QuickActionBinding {
  enabled: boolean;
  name: string;
  target: QuickActionTarget;
}

export interface QuickActionsSettings {
  version: 1;
  bindings: Partial<Record<ActionPingId, QuickActionBinding>>;
}

export type QuickActionError =
  | 'unsupported' | 'invalidBinding' | 'invalidUrl' | 'invalidProgram' | 'programSelectionExpired'
  | 'notFound' | 'disabled' | 'busy' | 'activationDenied' | 'launchFailed' | 'desktopFailed'
  | 'helperUnavailable' | 'helperTimeout' | 'unauthorized';

export type QuickActionResult =
  | { ok: true; status: 'opened' | 'activated' | 'launchSubmitted' | 'desktopToggled' }
  | { ok: false; code: QuickActionError };

export interface QuickActionDraft {
  enabled: boolean;
  name: string;
  target:
    | { kind: 'web'; url: string }
    | { kind: 'app'; programToken?: string }
    | { kind: 'toggleDesktop' };
}

export interface QuickActionProgramSelection {
  token: string;
  exePath: string;
  name: string;
}

export type QuickActionMutationResult =
  | { ok: true; settings: Settings }
  | { ok: false; code: QuickActionError };

const isObj = (raw: unknown): raw is Record<string, unknown> =>
  typeof raw === 'object' && raw !== null && !Array.isArray(raw);
const CONTROLS = /[\x00-\x1f\x7f]/;
const NON_PRINTABLE_NAME = /[\p{Cc}\p{Cf}\p{Cs}\p{Zl}\p{Zp}]/u;

/** Browser destinations need HTTPS and a host, but do not make network requests during validation. */
export function normalizeQuickActionUrl(raw: unknown): string | null {
  if (typeof raw !== 'string' || CONTROLS.test(raw)) return null;
  try {
    const url = new URL(raw.trim());
    if (url.protocol !== 'https:' || !url.hostname || url.username || url.password || url.href.length > 2081) return null;
    return url.href;
  } catch {
    return null;
  }
}

/** Checks path shape only; Main verifies the selected file before accepting or executing a binding. */
export function isLocalExePath(raw: unknown): raw is string {
  return typeof raw === 'string' && raw.length <= 32767 && /^[a-z]:[\\/]/i.test(raw)
    && /\.exe$/i.test(raw) && !CONTROLS.test(raw) && !/[<>:"|?*]/.test(raw.slice(2));
}

export function normalizeQuickActionBinding(raw: unknown): QuickActionBinding | null {
  if (!isObj(raw) || typeof raw.enabled !== 'boolean' || typeof raw.name !== 'string'
    || NON_PRINTABLE_NAME.test(raw.name) || !isObj(raw.target)) return null;
  const name = raw.name.trim();
  if (!name || Array.from(name).length > 64) return null;
  const target = raw.target;
  switch (target.kind) {
    case 'web': {
      const url = normalizeQuickActionUrl(target.url);
      return url === null ? null : { enabled: raw.enabled, name, target: { kind: 'web', url } };
    }
    case 'app':
      return isLocalExePath(target.exePath)
        ? { enabled: raw.enabled, name, target: { kind: 'app', exePath: target.exePath } } : null;
    case 'toggleDesktop':
      return { enabled: raw.enabled, name, target: { kind: 'toggleDesktop' } };
    default:
      return null;
  }
}

export function normalizeQuickActions(raw: unknown): QuickActionsSettings {
  const out: QuickActionsSettings = { version: 1, bindings: {} };
  // Unknown versions must never turn new action semantics into executable bindings in an older app.
  if (!isObj(raw) || raw.version !== 1 || !isObj(raw.bindings)) return out;
  for (const [id, value] of Object.entries(raw.bindings)) {
    if (!isActionPingId(id)) continue;
    const binding = normalizeQuickActionBinding(value);
    if (binding !== null) out.bindings[id] = binding;
  }
  return out;
}
