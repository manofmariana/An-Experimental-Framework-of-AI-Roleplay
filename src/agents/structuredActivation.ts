/**
 * 结构化 activation 统一控制流（docs/optimization-review.md §4「调用端口」）：
 * ChatPort 调用（流式回调透传 display）→ parse（extractJson + schema + 语义校验，抛错即失败）
 * → 失败 display.retry 通知并重试一次 → 再失败抛带 failureLabel 的错误。
 * LLMAbortedError（停止按钮）不重试、直接上抛。
 *
 * 重试携带首次错误（§4）：第二次尝试在 messages 尾部追加一条 user 消息
 * （首次校验错误内容 + 重新输出指引）；首次调用发送的 messages 原样不变（不突变入参数组）。
 *
 * 本文件只依赖 chatPort 端口类型与 display 接口，遵守 agents 禁则
 * （不得 import openaiChatAdapter / callLog / openai SDK）。
 */
import type { Display } from "../display.js";
import { LLMAbortedError, type ChatMessage, type ChatPort } from "../llm/chatPort.js";

export async function runStructuredActivation<T>(deps: {
  port: ChatPort;
  agentName: string;
  seq: number;
  messages: ChatMessage[];
  signal: AbortSignal;
  display?: Display;
  /** extractJson + schema 校验 + 语义校验；抛错即视为本次尝试失败 */
  parse: (text: string) => T;
  /** 重试后仍失败的错误前缀（最终错误 = `${failureLabel}（重试后仍失败）。原文：\n${text}`） */
  failureLabel: string;
}): Promise<{ raw: string; pkg: T }> {
  const { port, agentName, seq, messages, signal, display, parse, failureLabel } = deps;
  const onDelta = display ? (delta: string) => display.delta(agentName, delta) : undefined;
  const onReasoningDelta = display ? (delta: string) => display.reasoningDelta(agentName, delta) : undefined;
  let attemptMessages = messages;
  for (let attempt = 0; attempt < 2; attempt++) {
    const { text } = await port.chat(
      {
        agent: agentName, seq, messages: attemptMessages,
        ...(onDelta !== undefined ? { onDelta } : {}),
        ...(onReasoningDelta !== undefined ? { onReasoningDelta } : {}),
      },
      signal,
    );
    try {
      return { raw: text, pkg: parse(text) };
    } catch (error) {
      if (error instanceof LLMAbortedError) throw error;
      if (attempt === 1) throw new Error(`${failureLabel}（重试后仍失败）。原文：\n${text}`, { cause: error });
      display?.retry(agentName, attempt + 1, (error as Error).message);
      // 重试携带首次校验错误（不突变调用方 messages）
      attemptMessages = [
        ...messages,
        {
          role: "user",
          content: `你上一次的输出未通过校验：${(error as Error).message}\n请根据上述错误修正，重新输出完整的结构化结果。`,
        },
      ];
    }
  }
  throw new Error("unreachable");
}
