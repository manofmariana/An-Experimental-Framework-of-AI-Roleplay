/**
 * web/protocol.js 的类型声明（供 TS 契约测试 import；权威运行时行为见 protocol.js）。
 * 形状与 src/contracts/protocol.ts ClientCommand 保持一致（契约测试对拍保证）。
 */
export interface PauseOptionsPayload {
  everyStep: boolean;
  beforeGm: boolean;
  afterGm: boolean;
  afterProse: boolean;
}
export type ClientCommandPayload =
  | { type: "player_input"; text: string }
  | { type: "directive"; mode: "god" | "writing"; text: string }
  | { type: "continue" }
  | { type: "rollback"; targetSeq: number }
  | { type: "rollback_and_continue"; targetSeq: number }
  | { type: "edit_result"; text: string }
  | { type: "new_session"; worldSetId?: string }
  | { type: "load_session"; runId: string }
  | { type: "pause_options"; options: PauseOptionsPayload }
  | { type: "stop" }
  | { type: "query"; query: "snapshot" | "stats" };
export function buildCommand(type: string, fields?: Record<string, unknown>): { type: string } & Record<string, unknown>;
export function serialize(cmd: unknown): string;

// ---------------------------------------------------------------------------
// D4：createProtocol 工厂（transport × store × onStreaming 装配；权威行为见 protocol.js）
// ---------------------------------------------------------------------------

export interface ProtocolStoreLike {
  getState(): {
    runId: string | null;
    revision: number;
    streaming: { activationId: string } | null;
    needsResync: boolean;
  };
  dispatch(msg: unknown): void;
}

export interface ProtocolDeps {
  transport: { send(text: string): boolean };
  store: ProtocolStoreLike;
  onStreaming?: (msg: Record<string, unknown>) => void;
  onUncorrelated?: (msg: Record<string, unknown>) => void;
}

export interface ProtocolInstance {
  /** 在途请求（requestId → 应答三元组；测试可断言互不消费） */
  pending: Map<string, { resolve: (msg: unknown) => void; reject: (err: Error) => void; command: string }>;
  /** 发送命令（自动附加 requestId/runId/baseRevision；未连接立即 reject） */
  sendCommand(type: string, fields?: Record<string, unknown>): Promise<Record<string, unknown>>;
  /** 下行消息唯一入口 */
  handleMessage(msg: unknown): void;
}

export function createProtocol(deps: ProtocolDeps): ProtocolInstance;
