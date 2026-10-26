import { spawn } from 'node:child_process';

export type DesktopCommand = { type: 'activate'; exePath: string } | { type: 'toggleDesktop' };
export type DesktopReply =
  | { type: 'result'; status: 'activated' | 'launchRequired' | 'activationDenied' | 'desktopToggled' }
  | { type: 'result'; status: 'error'; code: 'invalidRequest' | 'invalidPath' | 'osError'; win32?: number }
  | { type: 'bridgeError'; code: 'helperUnavailable' | 'helperTimeout' };

interface DesktopBridgeOptions {
  command: string;
  args?: string[];
  timeoutMs?: number;
}

function parseReply(text: string, exitCode: number | null): DesktopReply | null {
  try {
    const raw: unknown = JSON.parse(text);
    if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return null;
    const o = raw as Record<string, unknown>;
    if (o.type !== 'result') return null;
    switch (o.status) {
      case 'activated': case 'launchRequired': case 'activationDenied': case 'desktopToggled':
        return exitCode === 0 ? { type: 'result', status: o.status } : null;
      case 'error': {
        if (exitCode !== 1 || !['invalidRequest', 'invalidPath', 'osError'].includes(String(o.code))) return null;
        if (o.win32 !== undefined && !(typeof o.win32 === 'number' && Number.isSafeInteger(o.win32) && o.win32 >= 0)) return null;
        return {
          type: 'result', status: 'error', code: o.code as 'invalidRequest' | 'invalidPath' | 'osError',
          ...(typeof o.win32 === 'number' ? { win32: o.win32 } : {}),
        };
      }
      default: return null;
    }
  } catch {
    return null;
  }
}

/** Runs only the bundled, short-lived desktop child, independently of the input helper. */
export class DesktopBridge {
  private closed = false;
  private readonly aborts = new Set<() => void>();

  constructor(private readonly options: DesktopBridgeOptions) {}

  run(request: DesktopCommand): Promise<DesktopReply> {
    if (this.closed) return Promise.resolve({ type: 'bridgeError', code: 'helperUnavailable' });
    const input = JSON.stringify(request) + '\n';
    if (Buffer.byteLength(input, 'utf8') > 64 * 1024) {
      return Promise.resolve({ type: 'bridgeError', code: 'helperUnavailable' });
    }
    return new Promise((resolve) => {
      let child: ReturnType<typeof spawn>;
      try {
        child = spawn(this.options.command, this.options.args ?? [], {
          stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true, shell: false,
        });
      } catch {
        resolve({ type: 'bridgeError', code: 'helperUnavailable' });
        return;
      }
      let settled = false;
      let stdout = '';
      let bytes = 0;
      const unavailable: DesktopReply = { type: 'bridgeError', code: 'helperUnavailable' };
      const finish = (reply: DesktopReply, kill = false): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        this.aborts.delete(abort);
        if (kill) child.kill();
        resolve(reply);
      };
      const abort = (): void => finish(unavailable, true);
      const timer = setTimeout(() => finish({ type: 'bridgeError', code: 'helperTimeout' }, true), this.options.timeoutMs ?? 3000);
      this.aborts.add(abort);
      child.on('error', () => finish(unavailable, true));
      child.stdout?.setEncoding('utf8');
      child.stdout?.on('data', (chunk: string) => {
        bytes += Buffer.byteLength(chunk, 'utf8');
        if (bytes > 4096) finish(unavailable, true);
        else stdout += chunk;
      });
      // Drain diagnostics without retaining executable paths or unbounded child output.
      child.stderr?.resume();
      child.on('close', (code) => finish(parseReply(stdout.trim(), code) ?? unavailable));
      child.stdin?.on('error', () => finish(unavailable, true));
      child.stdin?.end(input);
    });
  }

  close(): void {
    this.closed = true;
    for (const abort of [...this.aborts]) abort();
  }
}
