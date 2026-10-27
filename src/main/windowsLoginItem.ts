export interface LoginItemState {
  openAtLogin: boolean;
  launchItems: { name: string; scope: string; enabled: boolean }[];
}

export interface LoginItemOptions {
  name: string;
  path: string;
  args: string[];
  openAtLogin: boolean;
  enabled: boolean;
}

export interface LoginItemBackend {
  read(options: { path: string; args: string[] }): LoginItemState;
  write(options: LoginItemOptions): void;
}

export const LOGIN_ITEM_NAME = 'com.lolping.app';

export function syncWindowsLoginItem(enabled: boolean, exePath: string, backend: LoginItemBackend,
  explicit = false): boolean {
  const query = { path: exePath, args: ['--hidden'] };
  const state = backend.read(query);
  const ownItem = state.launchItems.find((item) => item.name === LOGIN_ITEM_NAME && item.scope === 'user');
  // A Task Manager disable is a user decision; only an explicit in-app enable may reverse it.
  if (!explicit && enabled && ownItem?.enabled === false) return false;
  if (!explicit && state.openAtLogin === enabled && (enabled || !ownItem)) return enabled;
  backend.write({ ...query, name: LOGIN_ITEM_NAME, openAtLogin: enabled, enabled });
  const applied = backend.read(query);
  const blocked = applied.launchItems.some((item) => item.name === LOGIN_ITEM_NAME && item.scope === 'user' && !item.enabled);
  if (applied.openAtLogin !== enabled || enabled && blocked) throw new Error('loginItemNotApplied');
  return enabled;
}
