import type { ExplainUiDiagnostic } from '../shared/ipc';
import type { StreamDiagnostic } from './aiClient';

/** Validate renderer metadata before it reaches even a development console. */
export function parseUiDiagnostic(raw: unknown): ExplainUiDiagnostic | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const r = raw as Record<string, unknown>;
  if (Object.keys(r).length !== 6 || !Number.isSafeInteger(r.id) || (r.id as number) <= 0
    || typeof r.phase !== 'string' || !['started', 'terminal', 'stop', 'close'].includes(r.phase)
    || typeof r.state !== 'string' || !['idle', 'unconfigured', 'generating', 'done', 'error', 'closed'].includes(r.state)
    || !Number.isInteger(r.characters) || (r.characters as number) < 0 || (r.characters as number) > 20_000
    || typeof r.sendDisabled !== 'boolean' || typeof r.stopVisible !== 'boolean') return null;
  return { id: r.id as number, phase: r.phase as ExplainUiDiagnostic['phase'],
    state: r.state as ExplainUiDiagnostic['state'], characters: r.characters as number,
    sendDisabled: r.sendDisabled, stopVisible: r.stopVisible };
}

/** No files or network. The host terminal may retain these bounded metadata lines. */
export function createAiDiagnostics(packaged: boolean, requested: string | undefined, write: (line: string) => void) {
  const enabled = !packaged && requested === '1';
  const emit = (value: object): void => {
    if (enabled) try { write(JSON.stringify(value)); } catch { /* Observation cannot affect the UI or request. */ }
  };
  return {
    enabled,
    stream(id: number, d: Readonly<StreamDiagnostic>): void {
      emit({ source: 'stream', id, mode: d.mode, stage: d.stage, httpStatus: d.httpStatus,
        sseEvents: d.sseEvents, deltaCount: d.deltaCount, characters: d.characters, finishReason: d.finishReason,
        doneSeen: d.doneSeen, outputLimited: d.outputLimited, aborted: d.aborted, cancelSource: d.cancelSource,
        timeoutKind: d.timeoutKind, errorCode: d.errorCode, elapsedMs: d.elapsedMs });
    },
    renderer(raw: unknown): void {
      if (!enabled) return;
      const report = parseUiDiagnostic(raw);
      if (report) emit({ source: 'renderer', ...report });
    },
  };
}
