import type { ExplainApi } from '../../shared/ipc';

declare global {
  interface Window {
    explainApi: ExplainApi;
  }
}

export {};
