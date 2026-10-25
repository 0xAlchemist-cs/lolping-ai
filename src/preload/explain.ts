import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron';
import type { ExplainApi, ExplainEvent } from '../shared/ipc';

// Inlined rather than imported: importing EXPLAIN_CH by value from ../shared/ipc makes a second
// preload entry consume that module (overlay.ts is the first), so rollup emits a shared chunk —
// and a sandboxed preload cannot require a generated sibling chunk. Kept in sync by test.
const EXPLAIN_CH = {
  ask: 'explain:ask', stop: 'explain:stop', strings: 'explain:strings', close: 'explain:close', openSettings: 'explain:openSettings',
  event: 'explain:event', state: 'explain:state',
  capture: 'explain:capture', closePreview: 'explain:closePreview', visionSession: 'explain:visionSession',
  askVision: 'explain:askVision',
} as const;

const api: ExplainApi = {
  // Inlined: a sandboxed preload can require electron, but not a generated sibling chunk.
  ask: (question) => ipcRenderer.invoke(EXPLAIN_CH.ask, question),
  askVision: (request) => ipcRenderer.invoke(EXPLAIN_CH.askVision, request),
  stop: () => ipcRenderer.send(EXPLAIN_CH.stop),
  strings: () => ipcRenderer.invoke(EXPLAIN_CH.strings),
  state: () => ipcRenderer.invoke(EXPLAIN_CH.state),
  close: () => ipcRenderer.send(EXPLAIN_CH.close),
  openSettings: () => ipcRenderer.send(EXPLAIN_CH.openSettings),
  capture: (sessionId) => ipcRenderer.invoke(EXPLAIN_CH.capture, sessionId),
  closePreview: (sessionId) => ipcRenderer.send(EXPLAIN_CH.closePreview, sessionId),
  onVisionSession: (cb) => {
    const handler = (_e: IpcRendererEvent, sessionId: number) => cb(sessionId);
    ipcRenderer.on(EXPLAIN_CH.visionSession, handler);
    return () => ipcRenderer.removeListener(EXPLAIN_CH.visionSession, handler);
  },
  on: (cb) => {
    const handler = (_e: IpcRendererEvent, ev: ExplainEvent) => cb(ev);
    ipcRenderer.on(EXPLAIN_CH.event, handler);
    return () => ipcRenderer.removeListener(EXPLAIN_CH.event, handler);
  },
};

contextBridge.exposeInMainWorld('explainApi', api);
