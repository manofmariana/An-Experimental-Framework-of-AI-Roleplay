/**
 * web/session-store.js 的类型声明（供 TS 测试 import；权威运行时行为见 session-store.js）。
 * state 形状终稿见 session-store.js 头注。
 */
export interface PipelineViewState {
  seq: number;
  phase: string;
  interrupted: boolean;
  kind: string | null;
}

export interface StreamingSlot {
  activationId: string;
  agent: string;
  turn: number;
  title: string;
}

export interface SessionState {
  runId: string | null;
  revision: number;
  connection: string;
  world: unknown;
  characters: Record<string, unknown>;
  events: Array<{ seq: number } & Record<string, unknown>>;
  history: unknown;
  pipeline: PipelineViewState;
  streaming: StreamingSlot | null;
  needsResync: boolean;
}

export interface DispatchMeta {
  type: string;
  /** 仅 snapshot 换 run 时 true（transient reset 信号） */
  runIdChanged?: boolean;
  /** transition 的 changed 域（订阅者按需重渲） */
  changed?: Record<string, unknown>;
}

export const CONNECTION: { CONNECTING: string; OPEN: string; CLOSED: string };

/** busy 推导：streaming 槽非空 || pipeline.phase !== "await_player"（输入权限唯一数据源）。 */
export function selectBusy(state: SessionState): boolean;

export function createSessionStore(): {
  getState(): SessionState;
  dispatch(msg: unknown): void;
  subscribe(fn: (state: SessionState, meta: DispatchMeta) => void): () => void;
};
