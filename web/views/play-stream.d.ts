/**
 * web/views/play-stream.js 的类型声明（供 TS 测试 import；权威运行时行为见 play-stream.js）。
 */
export interface PlayStreamDeps {
  el: (tag: string, className?: string | null, text?: string) => any;
  api: (path: string) => Promise<any>;
  getState: () => any;
  sendCmd: (type: string, fields?: object) => void;
  sendCommand: (type: string, fields?: object) => Promise<any>;
  trackModal: (overlay: any) => () => void;
  confirm: (msg: string) => boolean;
}

export interface PlayStreamView {
  mount: () => any;
  isMounted: () => boolean;
  appendLine: (className: string, text: string) => any;
  appendSelfCard: (text: string) => void;
  clearStream: () => void;
  pinScroll: () => void;
  scrollToBottom: (force?: boolean) => void;
  /** 重 roll 乐观清卡：移除 data-seq ≥ seq 的卡片（复合命令合并 Transition 到达前防双卡并存）。 */
  dropCardsFrom: (seq: number) => void;
  playerCard: (text: string, seq?: number) => any;
  renderHistory: (history: any) => void;
  onStreaming: (msg: any) => void;
  onEditedResult: (edited: any) => void;
}

export function createPlayStream(deps: PlayStreamDeps): PlayStreamView;
