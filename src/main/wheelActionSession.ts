import { pickSlice, WHEEL } from '../shared/geometry';
import type { PingId } from '../shared/pings';
import { isActionPingId, type ActionPingId } from '../shared/quickActions';

interface WheelSnapshot {
  displayId: number;
  x: number;
  y: number;
  wheel: readonly PingId[];
  wheelSizePx: number;
}

/** Only a Main-observed release can authorize one matching renderer confirmation. */
export class WheelActionSession {
  private sequence = 0;
  private active: (WheelSnapshot & { sessionId: number }) | null = null;
  private pending: { sessionId: number; displayId: number; id: ActionPingId; expires: number } | null = null;

  constructor(private readonly now: () => number = Date.now) {}

  begin(snapshot: WheelSnapshot): void {
    this.cancel();
    this.active = { ...snapshot, wheel: [...snapshot.wheel], sessionId: ++this.sequence };
  }

  release(displayId: number, x: number, y: number): number | null {
    const active = this.active;
    this.active = null;
    this.pending = null;
    if (!active || active.displayId !== displayId) return null;
    const slot = pickSlice(x - active.x, y - active.y, WHEEL.innerR * active.wheelSizePx / WHEEL.size);
    const id = active.wheel[slot];
    if (!isActionPingId(id)) return null;
    this.pending = { sessionId: active.sessionId, displayId, id, expires: this.now() + 2000 };
    return active.sessionId;
  }

  consume(displayId: number, raw: unknown): ActionPingId | null {
    const pending = this.pending;
    if (!pending) return null;
    if (this.now() >= pending.expires) {
      this.pending = null;
      return null;
    }
    if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return null;
    const report = raw as Record<string, unknown>;
    if (displayId !== pending.displayId || report.sessionId !== pending.sessionId || report.id !== pending.id) return null;
    this.pending = null;
    return pending.id;
  }

  cancel(): void {
    this.active = null;
    this.pending = null;
  }
}
