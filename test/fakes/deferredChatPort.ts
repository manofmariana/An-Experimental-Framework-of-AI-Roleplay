/**
 * 测试 fake：挂起可控的 ChatPort（集成测试基建）。
 * chat() 返回的 Promise 由测试手动 resolve/reject，或经 AbortSignal 中止（reject
 * LLMAbortedError，模拟 SDK 中止语义）——用于"延迟 LLM 期间强制切换会话"
 * "stop 定向中止""挂起中一致 query"等时序场景。
 * auto 非空时走脚本化快速路径（立即应答），挂起只针对测试显式关闭 auto 的窗口。
 */
import {
  LLMAbortedError,
  type ChatPort,
  type ChatRequest,
  type ChatResult,
} from "../../src/llm/chatPort.js";

const ZERO_USAGE = { hit: 0, miss: 0, output: 0 };

/** 便捷构造：纯文本结果。 */
export function textResult(text: string): ChatResult {
  return { text, reasoning: "", usage: ZERO_USAGE };
}

interface PendingCall {
  request: ChatRequest;
  resolve: (result: ChatResult) => void;
  reject: (err: unknown) => void;
}

export class DeferredChatPort implements ChatPort {
  readonly calls: ChatRequest[] = [];
  /** 自动应答（null = 挂起模式：chat() 挂起直到 resolveNext/rejectNext 或 abort）。 */
  auto: ((request: ChatRequest) => ChatResult) | null = null;
  private pending: PendingCall[] = [];

  chat(request: ChatRequest, signal: AbortSignal): Promise<ChatResult> {
    this.calls.push(request);
    if (this.auto !== null) return Promise.resolve(this.auto(request));
    return new Promise<ChatResult>((resolve, reject) => {
      const entry: PendingCall = { request, resolve, reject };
      this.pending.push(entry);
      const onAbort = (): void => {
        this.pending = this.pending.filter((p) => p !== entry);
        reject(new LLMAbortedError("", ""));
      };
      if (signal.aborted) {
        onAbort();
        return;
      }
      signal.addEventListener("abort", onAbort, { once: true });
    });
  }

  /** 当前挂起调用数。 */
  get pendingCount(): number {
    return this.pending.length;
  }

  /** 手动完成最早一个挂起调用（无挂起即抛错——暴露时序误判）。 */
  resolveNext(result: ChatResult): void {
    const entry = this.pending.shift();
    if (entry === undefined) throw new Error("无挂起中的 LLM 调用");
    entry.resolve(result);
  }

  /** 手动失败最早一个挂起调用。 */
  rejectNext(err: unknown): void {
    const entry = this.pending.shift();
    if (entry === undefined) throw new Error("无挂起中的 LLM 调用");
    entry.reject(err);
  }
}
