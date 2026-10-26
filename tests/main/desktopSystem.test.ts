import { beforeEach, describe, expect, it, vi } from 'vitest';
const h = vi.hoisted(() => ({ jobs: [] as { closed: boolean; finish?: (value: unknown) => void }[] }));
vi.mock('../../src/main/paths', () => ({ desktopHelperExePath: () => 'C:\\bundle\\desktop-helper.exe' }));
vi.mock('../../src/main/desktopBridge', () => ({ DesktopBridge: class {
  job: { closed: boolean; finish?: (value: unknown) => void };
  constructor() { this.job = { closed: false }; h.jobs.push(this.job); }
  run() { return new Promise((resolve) => { this.job.finish = resolve; }); }
  close() { this.job.closed = true; this.job.finish?.({ type: 'bridgeError', code: 'helperUnavailable' }); }
} }));

beforeEach(() => { h.jobs = []; vi.resetModules(); });
describe('desktop system task lifecycle', () => {
  it('cancels every owned native job before app exit and rejects later jobs', async () => {
    const { runDesktopSystemTask, closeDesktopSystemTasks } = await import('../../src/main/desktopSystem');
    const first = runDesktopSystemTask({ type: 'flushComposition' });
    const second = runDesktopSystemTask({ type: 'styleWindow', hwnd: '42', ownerPid: '123' });
    closeDesktopSystemTasks();
    expect(h.jobs.every((job) => job.closed)).toBe(true);
    await expect(first).resolves.toBe(false);
    await expect(second).resolves.toBe(false);
    await expect(runDesktopSystemTask({ type: 'flushComposition' })).resolves.toBe(false);
    expect(h.jobs).toHaveLength(2);
  });

  it('accepts only the matching operation result and releases the child on completion', async () => {
    const { runDesktopSystemTask } = await import('../../src/main/desktopSystem');
    const good = runDesktopSystemTask({ type: 'flushComposition' });
    h.jobs[0].finish?.({ type: 'result', status: 'compositionFlushed' });
    await expect(good).resolves.toBe(true);
    expect(h.jobs[0].closed).toBe(true);
    const wrong = runDesktopSystemTask({ type: 'styleWindow', hwnd: '42', ownerPid: '123' });
    h.jobs[1].finish?.({ type: 'result', status: 'desktopShown' });
    await expect(wrong).resolves.toBe(false);
    expect(h.jobs[1].closed).toBe(true);
  });
});
