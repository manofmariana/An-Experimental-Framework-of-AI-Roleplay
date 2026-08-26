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
  /** 取消确认（有未保存修改时；返回值 = 用户是否确认放弃） */
  confirm: (msg: string) => boolean;
}

export function openStateEditor(deps: StateEditorDeps): void;
