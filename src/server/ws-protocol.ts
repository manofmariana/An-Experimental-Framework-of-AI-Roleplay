/**
 * WebSocket 协议（前后端共享的 TS 类型；前端 web/ 拷贝一份 JSDoc 注释版）。
 * Display 接口即协议层：每个回调一一对应一条下行消息。
 */
import type { HistoryPayload } from "../loop.js";
import type { AdjudicationPackage, DecisionPackage } from "../types.js";

// ---------------------------------------------------------------------------
// 下行（server → client）
// ---------------------------------------------------------------------------

export type ServerMessage =
  /** agent 开始一次 LLM 调用（分段小标题；turn 为真实轮次） */
  | { type: "agent_start"; agent: string; title: string; turn: number }
  /** 流式增量（逐 token） */
  | { type: "delta"; agent: string; text: string }
  /** 思维链流式增量（推理模型） */
  | { type: "reasoning"; agent: string; text: string }
  /** 一次调用的流式输出结束 */
  | { type: "agent_end"; agent: string }
  /** 解析成功后的结构化摘要 */
  | { type: "summary"; agent: string; text: string }
  /** 结构化解析失败、即将重试 */
  | { type: "retry"; agent: string; attempt: number; reason: string }
  /** 角色决策包解析成功（结构化卡片） */
  | { type: "decision"; agent: string; pkg: DecisionPackage; turn: number }
  /** GM 裁决包解析成功（结构化卡片） */
  | { type: "adjudication"; agent: string; pkg: AdjudicationPackage; turn: number }
  /** 一轮玩家输入处理完成 */
  | { type: "turn_done"; turn: number }
  /** 流水线状态（输入权限/继续按钮/暂停态/当前步 kind；每次状态变化后广播） */
  | { type: "pipeline"; seq: number; phase: string; interrupted: boolean; kind: string | null }
  /** 当前步编辑成功（携带 seq+kind+解析后结果；前端按 data 属性寻址原地重渲该卡） */
  | { type: "edit_done"; kind: string; seq: number; result: unknown }
  /** 查询响应：变量库状态 */
  | { type: "state"; data: unknown }
  /** 查询响应：事件日志 */
  | { type: "events"; data: unknown }
  /** 查询响应：缓存埋点 */
  | { type: "stats"; data: unknown }
  /** 新会话已建立 */
  | { type: "session_started"; runId: string }
  /** 载入存档后的历史回显数据（replace=true 时前端先清流区——回溯/重 roll） */
  | { type: "history"; history: HistoryPayload; replace?: boolean }
  /** 错误（会话不可用、解析失败等） */
  | { type: "error"; message: string };

// ---------------------------------------------------------------------------
// 上行（client → server）
// ---------------------------------------------------------------------------

export type ClientMessage =
  /** 玩家意图 */
  | { type: "input"; text: string }
  /** 查询当前会话的 state/events/stats */
  | { type: "command"; command: "state" | "events" | "stats" }
  /** 重建会话（资源修改在新会话生效；world_set 可选，省略 = 缺省世界设定集） */
  | { type: "new_session"; world_set?: string }
  /** 读取历史存档继续游玩 */
  | { type: "load_session"; runId: string }
  /** 回溯：回到第 seq 步刚完成的位置（丢弃其后内容） */
  | { type: "rollback"; seq: number }
  /** 原子重 roll：丢弃第 seq 步及之后内容，并在同一串行任务内续跑 */
  | { type: "reroll"; seq: number }
  /** 继续：按 pipeline.phase 自动接着跑 */
  | { type: "continue" }
  /** 停止：中止在途 LLM 调用，冻结为 interrupted */
  | { type: "stop" }
  /** 暂停选项（内存态；自动继续 = 全 false；互斥由前端保证，服务端按位生效） */
  | { type: "pause_options"; every_step: boolean; before_gm: boolean; after_gm: boolean; after_prose: boolean }
  /** 编辑当前步原始返回（决策包/裁决包须合法 JSON；正文纯文本） */
  | { type: "edit_result"; text: string };

export function parseClientMessage(raw: string): ClientMessage {
  const msg = JSON.parse(raw) as ClientMessage;
  if (
    (msg.type === "input" && typeof msg.text === "string") ||
    (msg.type === "command" && ["state", "events", "stats"].includes(msg.command)) ||
    (msg.type === "new_session" &&
      (msg.world_set === undefined || typeof msg.world_set === "string")) ||
    (msg.type === "load_session" && typeof msg.runId === "string") ||
    (msg.type === "rollback" && Number.isInteger(msg.seq)) ||
    (msg.type === "reroll" && Number.isInteger(msg.seq) && msg.seq > 1) ||
    msg.type === "continue" ||
    msg.type === "stop" ||
    (msg.type === "pause_options" &&
      typeof msg.every_step === "boolean" &&
      typeof msg.before_gm === "boolean" &&
      typeof msg.after_gm === "boolean" &&
      typeof msg.after_prose === "boolean") ||
    (msg.type === "edit_result" && typeof msg.text === "string")
  ) {
    return msg;
  }
  throw new Error(`无法识别的客户端消息: ${raw.slice(0, 120)}`);
}
