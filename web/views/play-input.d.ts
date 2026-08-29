/**
 * web/views/play-input.js 的类型声明（供 TS 测试 import；权威运行时行为见 play-input.js）。
 */
export interface PlayInputDeps {
  el: (tag: string, className?: string | null, text?: string) => any;
  api: (path: string) => Promise<any>;
  getCharsIdentity: () => { runId: string | null; worldSetId: string };
  onInputChange: () => void;
  onEnter: () => void;
  onDirective: (mode: "god" | "writing", text: string, key: string) => void;
  onPauseChanged: () => void;
}

export interface PlayInputView {
  mount: () => any;
  getMode: () => "main" | "god";
  slotValue: (key: string) => string;
  buildPayload: () => string | null;
  resetTransient: () => void;
  clearAfterSend: () => void;
  clearDirective: (key: string) => void;
  refreshCids: () => Promise<void>;
  setEnabled: (can: boolean) => void;
  pauseOptionsPayload: () => { everyStep: boolean; beforeGm: boolean; afterGm: boolean; afterProse: boolean };
}

export function createPlayInput(deps: PlayInputDeps): PlayInputView;
