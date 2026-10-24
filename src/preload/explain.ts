import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron';
import { EXPLAIN_CH, type ExplainApi, type ExplainEvent } from '../shared/ipc';

const api: ExplainApi = {
  // Inlined: a sandboxed preload can require electron, but not a generated sibling chunk.
  ask: (question) => ipcRenderer.invoke(EXPLAIN_CH.ask, question),
  stop: () => ipcRenderer.send(EXPLAIN_CH.stop),
  strings: () => ipcRenderer.invoke(EXPLAIN_CH.strings),
  state: () => ipcRenderer.invoke(EXPLAIN_CH.state),
  close: () => ipcRenderer.send(EXPLAIN_CH.close),
  openSettings: () => ipcRenderer.send(EXPLAIN_CH.openSettings),
  on: (cb) => {
    const handler = (_e: IpcRendererEvent, ev: ExplainEvent) => cb(ev);
    ipcRenderer.on(EXPLAIN_CH.event, handler);
    return () => ipcRenderer.removeListener(EXPLAIN_CH.event, handler);
  },
};

contextBridge.exposeInMainWorld('explainApi', api);
