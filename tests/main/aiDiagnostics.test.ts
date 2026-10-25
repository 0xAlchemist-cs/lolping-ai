import { describe, expect, it } from 'vitest';
import { createAiDiagnostics } from '../../src/main/aiDiagnostics';
import type { StreamDiagnostic } from '../../src/main/aiClient';

const summary: StreamDiagnostic = { mode: 'text', stage: 'sse', httpStatus: 200, sseEvents: 3,
  deltaCount: 1, characters: 6, finishReason: 'stop', doneSeen: true, aborted: false,
  outputLimited: false, errorCode: null, elapsedMs: 10, timeoutKind: null, cancelSource: null };

describe('development AI diagnostics', () => {
  it.each([[true, '1'], [false, undefined], [false, '0']] as const)(
    'emits nothing for packaged=%s and requested=%s', (packaged, requested) => {
      const lines: string[] = [];
      const d = createAiDiagnostics(packaged, requested, line => lines.push(line));
      d.stream(1, summary);
      d.renderer({ id: 1, phase: 'terminal', state: 'done', characters: 6, sendDisabled: false, stopVisible: false });
      expect(d.enabled).toBe(false); expect(lines).toEqual([]);
    });
  it('projects fixed metadata and refuses raw or unbounded renderer payloads', () => {
    const lines: string[] = [];
    const d = createAiDiagnostics(false, '1', line => lines.push(line));
    d.stream(7, { ...summary, privateText: 'synthetic secret' } as StreamDiagnostic);
    const report = { id: 7, phase: 'terminal', state: 'done', characters: 6, sendDisabled: false, stopVisible: false };
    d.renderer({ ...report, text: 'synthetic secret' });
    d.renderer({ ...report, characters: 999999 });
    d.renderer({ ...report, state: 'synthetic secret' });
    d.renderer(report);
    expect(lines).toHaveLength(2);
    expect(lines.join('')).not.toContain('synthetic secret');
    expect(JSON.parse(lines[0])).toMatchObject({ source: 'stream', id: 7, sseEvents: 3 });
    expect(JSON.parse(lines[1])).toMatchObject({ source: 'renderer', id: 7, state: 'done' });
  });
});
