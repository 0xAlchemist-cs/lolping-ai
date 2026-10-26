import { describe, expect, it } from 'vitest';
import { QuickActionExecutor } from '../../src/main/quickActionExecutor';
import type { QuickActionBinding } from '../../src/shared/quickActions';

const web: QuickActionBinding = { name: 'Web', enabled: true, target: { kind: 'web', url: 'https://example.com' } };
const app: QuickActionBinding = { name: 'App', enabled: true, target: { kind: 'app', exePath: 'C:\\Apps\\Example.exe' } };

function setup(outcome: 'activated' | 'launchRequired' | 'activationDenied' = 'activated') {
  const effects: string[] = [];
  let block: Promise<void> = Promise.resolve();
  const executor = new QuickActionExecutor({
    platform: 'win',
    desktop: { run: async (request) => {
      effects.push(request.type);
      return { type: 'result', status: request.type === 'toggleDesktop' ? 'desktopToggled' : outcome };
    } },
    verifyProgram: async (path) => ({ ok: true, exePath: path }),
    openUrl: async (url) => { effects.push(url); await block; },
    launchProgram: async (path) => { effects.push(`launch:${path}`); },
  });
  return { executor, effects, block: (p: Promise<void>) => { block = p; } };
}

describe('QuickActionExecutor', () => {
  it('opens a canonical HTTPS destination and rejects unsafe or disabled bindings', async () => {
    const { executor, effects } = setup();
    expect(await executor.execute(web)).toEqual({ ok: true, status: 'opened' });
    expect(effects).toEqual(['https://example.com/']);
    expect(await executor.execute({ ...web, enabled: false })).toEqual({ ok: false, code: 'disabled' });
    expect(await executor.execute({ ...web, target: { kind: 'web', url: 'file:///C:/a' } })).toMatchObject({ ok: false });
    expect(effects).toHaveLength(1);
  });

  it('activates an existing app without starting another instance', async () => {
    const { executor, effects } = setup();
    expect(await executor.execute(app)).toEqual({ ok: true, status: 'activated' });
    expect(effects).toEqual(['activate']);
  });

  it('launches only when no eligible window exists, including tray-only apps', async () => {
    const { executor, effects } = setup('launchRequired');
    expect(await executor.execute(app)).toEqual({ ok: true, status: 'launchSubmitted' });
    expect(effects).toEqual(['activate', 'launch:C:\\Apps\\Example.exe']);
  });

  it('stops after foreground denial and does not restart the app', async () => {
    const { executor, effects } = setup('activationDenied');
    expect(await executor.execute(app)).toEqual({ ok: false, code: 'activationDenied' });
    expect(effects).toEqual(['activate']);
  });

  it('does not replay repeated targets while a request is in progress', async () => {
    const { executor, effects, block } = setup();
    let release = () => undefined as void;
    block(new Promise<void>((resolve) => { release = resolve; }));
    const pending = executor.execute(web);
    expect(await executor.execute(web)).toEqual({ ok: false, code: 'busy' });
    release();
    expect(await pending).toEqual({ ok: true, status: 'opened' });
    expect(effects).toEqual(['https://example.com/']);
  });

  it('rechecks authorization before opening or launching a target', async () => {
    const { executor, effects } = setup('launchRequired');
    expect(await executor.execute(app, () => false)).toEqual({ ok: false, code: 'disabled' });
    expect(effects).toEqual([]);
    executor.close();
    expect(await executor.execute(web)).toEqual({ ok: false, code: 'disabled' });
  });

  it('toggles the desktop through the fixed native command', async () => {
    const { executor, effects } = setup();
    expect(await executor.execute({ name: 'Desktop', enabled: true, target: { kind: 'toggleDesktop' } }))
      .toEqual({ ok: true, status: 'desktopToggled' });
    expect(effects).toEqual(['toggleDesktop']);
  });
});
