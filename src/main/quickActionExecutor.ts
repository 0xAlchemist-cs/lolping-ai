import type { Platform } from '../shared/platform';
import { normalizeQuickActionBinding, type QuickActionBinding, type QuickActionResult } from '../shared/quickActions';
import type { DesktopCommand, DesktopReply } from './desktopBridge';
import type { ProgramVerification } from './quickActionProgram';

interface ExecutorOptions {
  platform: Platform;
  desktop: { run(request: DesktopCommand, signal?: AbortSignal): Promise<DesktopReply> };
  verifyProgram(path: string): Promise<ProgramVerification>;
  openUrl(url: string): Promise<void>;
  launchProgram(path: string): Promise<void>;
}

/** Executes saved, validated targets; renderers never supply a process command or execution target here. */
export class QuickActionExecutor {
  private readonly inFlight = new Set<string>();
  private readonly controllers = new Set<AbortController>();
  private closed = false;

  constructor(private readonly options: ExecutorOptions) {}

  async execute(raw: QuickActionBinding, authorized: () => boolean = () => true): Promise<QuickActionResult> {
    if (this.options.platform !== 'win') return { ok: false, code: 'unsupported' };
    const binding = normalizeQuickActionBinding(raw);
    if (!binding) return { ok: false, code: 'invalidBinding' };
    const controller = new AbortController();
    const allowed = (): boolean => !this.closed && !controller.signal.aborted && binding.enabled && authorized();
    if (!allowed()) return { ok: false, code: 'disabled' };
    const target = binding.target;
    const key = target.kind === 'web' ? `web:${target.url}`
      : target.kind === 'app' ? `app:${target.exePath.toLowerCase()}` : 'showDesktop';
    if (this.inFlight.has(key)) return { ok: false, code: 'busy' };
    this.inFlight.add(key);
    this.controllers.add(controller);
    try {
      if (target.kind === 'web') {
        if (!allowed()) return { ok: false, code: 'disabled' };
        await this.options.openUrl(target.url);
        return { ok: true, status: 'opened' };
      }
      if (target.kind === 'app') {
        const verified = await this.options.verifyProgram(target.exePath);
        if (!allowed()) return { ok: false, code: 'disabled' };
        if (!verified.ok) return verified;
        if (verified.exePath !== target.exePath) return { ok: false, code: 'invalidProgram' };
        const reply = await this.options.desktop.run({ type: 'activate', exePath: verified.exePath }, controller.signal);
        if (!allowed()) return { ok: false, code: 'disabled' };
        if (reply.type === 'bridgeError') return { ok: false, code: reply.code };
        if (reply.status === 'activated') return { ok: true, status: 'activated' };
        if (reply.status === 'activationDenied') return { ok: false, code: 'activationDenied' };
        if (reply.status !== 'launchRequired') return { ok: false, code: 'invalidProgram' };
        // The file may have moved while the window lookup was in flight.
        const checked = await this.options.verifyProgram(verified.exePath);
        if (!allowed()) return { ok: false, code: 'disabled' };
        if (!checked.ok) return checked;
        if (checked.exePath !== verified.exePath) return { ok: false, code: 'invalidProgram' };
        await this.options.launchProgram(checked.exePath);
        return { ok: true, status: 'launchSubmitted' };
      }
      if (!allowed()) return { ok: false, code: 'disabled' };
      const reply = await this.options.desktop.run({ type: 'showDesktop' }, controller.signal);
      if (!allowed()) return { ok: false, code: 'disabled' };
      if (reply.type === 'bridgeError') return { ok: false, code: reply.code };
      return reply.status === 'desktopShown' ? { ok: true, status: 'desktopShown' } : { ok: false, code: 'desktopFailed' };
    } catch {
      return { ok: false, code: target.kind === 'showDesktop' ? 'desktopFailed' : 'launchFailed' };
    } finally {
      this.inFlight.delete(key);
      this.controllers.delete(controller);
    }
  }

  close(): void {
    this.closed = true;
    this.cancelPending();
  }

  /** Settings, pause, lock and window-close paths stop only our still-running action children. */
  cancelPending(): void {
    for (const controller of this.controllers) controller.abort();
  }
}
