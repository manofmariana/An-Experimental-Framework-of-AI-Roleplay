/**
 * 模型调用最小端口（docs/optimization-review.md §4「调用端口」）。
 * agents 只依赖本文件的端口类型，不 import 任何具体 adapter/decorator 实现；
 * model/jsonMode/reasoningEffort 是 adapter 构造配置，不进 request。
 * AbortController 属于单次 activation：signal 由调用方（loop）按次创建传入，
 * 消除旧 LLMClient 共享 this.current 的隐藏状态。
 */

export interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export interface ChatResult {
  text: string;
  /** 思维链（推理模型如 deepseek-reasoner 返回；非推理模型为空串） */
  reasoning: string;
  usage: {
    hit: number;
    miss: number;
    output: number;
  };
}

export interface ChatRequest {
  /** 调用方 agent 全名（"gm" / "prose" / "character:<cid>"；日志口径与测试路由用） */
  agent: string;
  /** 总轮次（API 调用计数，存档 v2；日志口径） */
  seq: number;
  messages: ChatMessage[];
  /** 传 onDelta 时走流式（逐 token 回调），否则一次性返回 */
  onDelta?: (delta: string) => void;
  /** 思维链增量回调（推理模型；非推理模型永不触发） */
  onReasoningDelta?: (delta: string) => void;
}

export interface ChatPort {
  chat(request: ChatRequest, signal: AbortSignal): Promise<ChatResult>;
}

/** LLM 调用被中止（停止按钮）：携带已收到的部分文本，供流水线冻结时保留。 */
export class LLMAbortedError extends Error {
  constructor(
    readonly partialText: string,
    readonly partialReasoning: string,
  ) {
    super("LLM 调用被中止");
    this.name = "LLMAbortedError";
  }
}
