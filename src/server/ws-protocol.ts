/**
 * WebSocket 协议——下行（server → client）类型唯一出口（优化阶段 D2 重写，
 * docs/optimization-review.md §5「消息身份」「Snapshot 与增量 Transition」「一致快照 query」）。
 * 上行（client → server）唯一权威 = src/contracts/protocol.ts（ClientCommandSchema）。
 *
 * 三类下行：
 * 1. 定向回复（只发发起 socket）：command_result / command_error（requestId 关联）；
 * 2. 状态同步（广播/单播）：transition（每次提交一条）/ snapshot（重连单播、会话切换广播、
 *    跳号恢复应答）——载荷类型由 application/transitionProjection.ts 持有（application 层
 *    不得依赖 server，故 Snapshot/Transition 数据形状定义在 application，本文件只加信封）；
 * 3. 流式（广播）：全部携带 runId + activationId 消息身份（前端只接受当前 run/activation）。
 *
 * 已删除的旧下行类型（D2 起不再发送）：turn_done / state / events / stats / pipeline /
 * edit_done / session_started / history / error / summary。
 */
import type {
  SessionSnapshotData,
  SessionTransition,
} from "../application/transitionProjection.js";
import type { AdjudicationPackage, DecisionPackage } from "../types.js";

/** command_error 的稳定错误码。 */
export type ProtocolErrorCode =
  /** 入站解析失败（非法 JSON / 未知命令 / 字段不合法） */
  | "PROTOCOL_ERROR"
  /** baseRevision 与当前 revision 不符（附 details.baseRevision/currentRevision） */
  | "REVISION_CONFLICT"
  /** 目标操作要求空闲但 LLM 在途（如直编；WS mutation 串行排队通常不触发） */
  | "SESSION_BUSY"
  /** 命令携带的 runId ≠ 当前活跃会话（含旧会话晚到） */
  | "SESSION_SWITCHED"
  /** 载荷校验失败（决策包/裁决包解析、schema 校验等） */
  | "VALIDATION_ERROR"
  /** 目标不存在（存档不存在等） */
  | "NOT_FOUND"
  /** 其余未分类服务端错误 */
  | "INTERNAL_ERROR";

// ---------------------------------------------------------------------------
// 定向回复（只发发起 socket）
// ---------------------------------------------------------------------------

/** 命令成功应答（requestId 与入站命令原样关联；runId/revision = 应答时刻身份）。 */
export interface CommandResultMessage {
  type: "command_result";
  requestId: string;
  command: string;
  runId: string | null;
  revision: number | null;
  /** 命令附带数据（query stats 等；多数命令无） */
  data?: unknown;
}

/** 命令失败应答（REVISION_CONFLICT 附 details 双值供客户端比对）。 */
export interface CommandErrorMessage {
  type: "command_error";
  requestId: string;
  command: string;
  code: ProtocolErrorCode;
  message: string;
  runId?: string | null;
  revision?: number | null;
  details?: { baseRevision: number; currentRevision: number };
}

// ---------------------------------------------------------------------------
// 状态同步
// ---------------------------------------------------------------------------

/** 完整快照（重连单播 / 会话切换广播 / 跳号恢复应答；requestId 仅 query 应答携带）。 */
export type SnapshotMessage = SessionSnapshotData & { type: "snapshot"; requestId?: string };

/** 增量 Transition（每次提交一条，广播；rollback_and_continue 只发合并一条）。 */
export type { SessionTransition } from "../application/transitionProjection.js";
export type TransitionMessage = SessionTransition;

// ---------------------------------------------------------------------------
// 流式（广播，全部带 runId + activationId 消息身份）
// ---------------------------------------------------------------------------

/** 流式消息公共身份字段。 */
interface StreamIdentity {
  runId: string;
  activationId: string;
  agent: string;
}

export type ServerMessage =
  | CommandResultMessage
  | CommandErrorMessage
  | SnapshotMessage
  | TransitionMessage
  /** agent 开始一次 LLM 调用（分段小标题；turn 为真实轮次） */
  | (StreamIdentity & { type: "agent_start"; title: string; turn: number })
  /** 流式增量（逐 token） */
  | (StreamIdentity & { type: "delta"; text: string })
  /** 思维链流式增量（推理模型） */
  | (StreamIdentity & { type: "reasoning"; text: string })
  /** 一次调用的流式输出结束 */
  | (StreamIdentity & { type: "agent_end" })
  /** 结构化解析失败、即将重试 */
  | (StreamIdentity & { type: "retry"; attempt: number; reason: string })
  /** 角色决策包解析成功（结构化卡片） */
  | (StreamIdentity & { type: "decision"; pkg: DecisionPackage; turn: number })
  /** GM 裁决包解析成功（结构化卡片） */
  | (StreamIdentity & { type: "adjudication"; pkg: AdjudicationPackage; turn: number });
