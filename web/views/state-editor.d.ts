/**
 * web/views/state-editor.js 的类型声明（供 TS 测试 import；权威运行时行为见 state-editor.js）。
 */
export const DIRECT_EDIT_WARNING: string;

export interface StateEditorState {
  runId: string | null;
  revision: number;
  world: unknown;
  characters: unknown;
  events: unknown;
}

export interface StateEditorDeps {
  el: (tag: string, className?: string | null, text?: string) => any;
  api: (path: string, method?: string, body?: unknown) => Promise<unknown>;
  getState: () => StateEditorState;
  trackModal: (overlay: any) => () => void;
  mountModal: (overlay: any) => void;
  notifyError: (text: string) => void;
}

export function openStateEditor(deps: StateEditorDeps): void;
