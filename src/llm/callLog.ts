/**
 * 调用记录 decorator：
 * chat 成功后把 {seq, messages, reasoning} 滚入 llm-recent/{agent}.json（最近 5 轮窗口），
 * 并把 prompt_cache_hit/miss 埋点追加到 save/{runId}/cache-stats.jsonl。
 * 失败不记录；写盘失败只告警（console.warn），不改模型调用的成功语义。
 * runId 在构造时绑定（会话级不变），agent 取自每次 request（同一端口可服务多个角色 agent）。
 */
import { recordCacheStat } from "./cacheStats.js";
import { recordRecent } from "./recent.js";
import type { ChatPort, ChatRequest, ChatResult } from "./chatPort.js";

export class CallLogChatPort implements ChatPort {
  constructor(
    private inner: ChatPort,
    private runId: string,
  ) {}

  async chat(request: ChatRequest, signal: AbortSignal): Promise<ChatResult> {
    const result = await this.inner.chat(request, signal);
    try {
      recordRecent(this.runId, request.agent, {
        seq: request.seq,
        messages: request.messages as unknown[],
        reasoning: result.reasoning,
      });
      recordCacheStat(this.runId, { agent: request.agent, turn: request.seq, ...result.usage });
    } catch (err) {
      console.warn(`[CallLogChatPort] 旁路日志写盘失败（不影响调用结果）: ${(err as Error).message}`);
    }
    return result;
  }
}
