import { contextBridge, ipcRenderer } from 'electron';
import type { ExplainApi } from '../shared/ipc';

const api: ExplainApi = {
  // Inlined: a sandboxed preload can require electron, but not a generated sibling chunk.
  ask: (question) => ipcRenderer.invoke('explain:ask', question),
  strings: () => ipcRenderer.invoke('explain:strings'),
  close: () => ipcRenderer.send('explain:close'),
};

contextBridge.exposeInMainWorld('explainApi', api);
