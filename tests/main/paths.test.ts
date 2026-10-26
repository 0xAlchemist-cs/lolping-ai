import { afterEach, describe, expect, it, vi } from 'vitest';
const h = vi.hoisted(() => ({ packaged: true }));
vi.mock('electron', () => ({
  app: { get isPackaged() { return h.packaged; }, getAppPath: () => 'C:\\app' }, net: {}, protocol: {},
}));
import { pageUrl, rendererRootPath } from '../../src/main/paths';

afterEach(() => { h.packaged = true; vi.unstubAllEnvs(); });
describe('packaged renderer URLs', () => {
  it('ignores a renderer development URL in an installed application', () => {
    vi.stubEnv('ELECTRON_RENDERER_URL', 'https://untrusted.invalid');
    expect(pageUrl('settings')).toBe('lolping://app/settings/index.html');
    expect(pageUrl('explain', 'session')).toBe('lolping://app/explain/index.html#session');
    expect(rendererRootPath()).toMatch(/[\\/]renderer$/);
  });
  it('keeps the local Vite URL available in development', () => {
    h.packaged = false;
    vi.stubEnv('ELECTRON_RENDERER_URL', 'http://127.0.0.1:5173');
    expect(pageUrl('settings')).toBe('http://127.0.0.1:5173/settings/index.html');
    expect(rendererRootPath()).toBeNull();
  });
});
