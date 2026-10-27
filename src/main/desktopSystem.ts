import { DesktopBridge } from './desktopBridge';
import { desktopHelperExePath } from './paths';

export type DesktopSystemTask = { type: 'flushComposition' } | { type: 'styleWindow'; hwnd: string; ownerPid: string };

const activeTasks = new Set<DesktopBridge>();
let closed = false;

export function closeDesktopSystemTasks(): void {
  closed = true;
  for (const bridge of activeTasks) bridge.close();
  activeTasks.clear();
}

/** Fixed bundled-native operations replace environment-selected system command executables. */
export async function runDesktopSystemTask(request: DesktopSystemTask): Promise<boolean> {
  if (closed) return false;
  const bridge = new DesktopBridge({ command: desktopHelperExePath(), timeoutMs: 5000 });
  activeTasks.add(bridge);
  try {
    const reply = await bridge.run(request);
    const expected = request.type === 'flushComposition' ? 'compositionFlushed' : 'frameStyled';
    return reply.type === 'result' && reply.status === expected;
  } catch { return false; }
  finally {
    activeTasks.delete(bridge);
    bridge.close();
  }
}
