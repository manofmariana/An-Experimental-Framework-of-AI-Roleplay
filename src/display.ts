import type { AdjudicationPackage, DecisionPackage } from "./types.js";

/**
 * 显示层接口：让"所有活动可见"（每个 agent 的调用、流式输出、重试、摘要）。
 * 由 CLI / WebDisplay 实现；GameSession/agents 只面向接口，headless 场景传 undefined 即可。
 */
export interface Display {
  /** agent 开始一次 LLM 调用（打印分段小标题；turn 为真实轮次；
   *  activationId = 消息身份（D2，`${runId}:act:${n}`），CLI 等不感知身份的实现可忽略） */
  agentStart(agent: string, title: string, turn?: number, activationId?: string): void;
  /** 流式增量（逐 token） */
  delta(agent: string, text: string): void;
  /** 思维链流式增量（推理模型；非推理模型不触发） */
  reasoningDelta(agent: string, text: string): void;
  /** 一次调用的流式输出结束（收尾换行等） */
  agentEnd(agent: string): void;
  /** 解析成功后的结构化摘要 */
  summary(agent: string, text: string): void;
  /** 结构化解析失败、即将重试 */
  retry(agent: string, attempt: number, reason: string): void;
  /** 角色决策包解析成功（结构化展示用；CLI 可不实现） */
  decision?(agent: string, pkg: DecisionPackage, turn?: number): void;
  /** GM 裁决包解析成功（结构化展示用；CLI 可不实现） */
  adjudication?(agent: string, pkg: AdjudicationPackage, turn?: number): void;
}
