import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { DesktopBridge } from '../../src/main/desktopBridge';

const fixture = fileURLToPath(new URL('./fixtures/fake-desktop-helper.mjs', import.meta.url));
const bridges: DesktopBridge[] = [];
const make = (mode = '', timeoutMs = 3000) => {
  const bridge = new DesktopBridge({ command: process.execPath, args: [fixture, mode], timeoutMs });
  bridges.push(bridge);
  return bridge;
};
afterEach(() => { for (const bridge of bridges.splice(0)) bridge.close(); });

describe('DesktopBridge', () => {
  it('runs a one-shot child and returns the validated command result', async () => {
    expect(await make().run({ type: 'activate', exePath: 'C:\\Apps\\Example.exe' }))
      .toEqual({ type: 'result', status: 'launchRequired' });
    expect(await make().run({ type: 'toggleDesktop' })).toEqual({ type: 'result', status: 'desktopToggled' });
  });

  it('accepts a structured native error with its expected nonzero exit', async () => {
    expect(await make('fail').run({ type: 'toggleDesktop' }))
      .toEqual({ type: 'result', status: 'error', code: 'osError', win32: 5 });
  });

  it('refuses unknown or oversized native output', async () => {
    for (const mode of ['invalid', 'large']) {
      expect(await make(mode).run({ type: 'toggleDesktop' }))
        .toEqual({ type: 'bridgeError', code: 'helperUnavailable' });
    }
  });

  it('times out and stops its own hung child', async () => {
    expect(await make('hang', 50).run({ type: 'toggleDesktop' }))
      .toEqual({ type: 'bridgeError', code: 'helperTimeout' });
  });

  it('settles an in-flight operation and refuses new operations when closed', async () => {
    const bridge = make('hang');
    const pending = bridge.run({ type: 'toggleDesktop' });
    bridge.close();
    expect(await pending).toEqual({ type: 'bridgeError', code: 'helperUnavailable' });
    expect(await bridge.run({ type: 'toggleDesktop' })).toEqual({ type: 'bridgeError', code: 'helperUnavailable' });
  });

  it('aborts one child without closing the bridge for later operations', async () => {
    const bridge = make();
    const controller = new AbortController();
    const pending = bridge.run({ type: 'toggleDesktop' }, controller.signal);
    controller.abort();
    expect(await pending).toEqual({ type: 'bridgeError', code: 'helperUnavailable' });
    expect(await bridge.run({ type: 'toggleDesktop' })).toEqual({ type: 'result', status: 'desktopToggled' });
  });
});
