/**
 * OpenAI 兼容协议 ChatPort adapter（默认 DeepSeek）。
 * 只负责 SDK 交互；recent/cacheStats 落盘在 CallLogChatPort（callLog.ts）。
 * model/jsonMode/reasoningEffort 是构造配置，不进 ChatRequest。
 * 中止：signal 由调用方按 activation 传入，abort 后抛 LLMAbortedError（含部分文本）；
 * 无 abort() 方法与共享 current——AbortController 属于单次 activation。
 * updateConfig：设置页保存后热更新（重建底层 OpenAI 实例；在途调用已持有旧请求，不受影响）。
 */
import OpenAI from "openai";
import type { LLMConfig } from "../config.js";
import { LLMAbortedError, type ChatMessage, type ChatPort, type ChatRequest, type ChatResult } from "./chatPort.js";

type UsageWithCache =
  | (OpenAI.CompletionUsage & {
      prompt_cache_hit_tokens?: number;
      prompt_cache_miss_tokens?: number;
    })
  | undefined;

function extractUsage(u: UsageWithCache): ChatResult["usage"] {
  return {
    hit: u?.prompt_cache_hit_tokens ?? 0,
    miss: u?.prompt_cache_miss_tokens ?? u?.prompt_tokens ?? 0,
    output: u?.completion_tokens ?? 0,
  };
}

/**
 * 从 delta / message 对象安全读取 reasoning_content。
 * openai SDK 类型里没有这个字段（DeepSeek 推理模型扩展），故走 unknown 收窄；
 * 纯函数，可单测。非推理模型不返回该字段，恒得空串。
 */
export function extractReasoningContent(obj: unknown): string {
  if (typeof obj === "object" && obj !== null && "reasoning_content" in obj) {
    const value = (obj as { reasoning_content?: unknown }).reasoning_content;
    return typeof value === "string" ? value : "";
  }
  return "";
}

/**
 * chat.completions 请求参数形状。
 * reasoning_effort：SDK 类型锁了枚举（'low'|'medium'|'high'），
 * 但 DeepSeek 场景要求原样透传（含未来扩展值），故此处用 string，边界处一次性收窄。
 */
export interface ChatRequestParams {
  model: string;
  messages: ChatMessage[];
  temperature: number;
  /** jsonMode 时注入：response_format: { type: "json_object" } */
  response_format?: { type: "json_object" };
  /** reasoningEffort 有值时原样透传 */
  reasoning_effort?: string;
  stream?: boolean;
  stream_options?: { include_usage: boolean };
}

/**
 * 组装 chat.completions 请求参数（纯函数，可单测）：
 * jsonMode → response_format json_object；reasoningEffort → reasoning_effort；stream → 流式 + include_usage。
 */
export function buildRequestParams(
  config: Pick<LLMConfig, "model" | "jsonMode" | "reasoningEffort">,
  messages: ChatMessage[],
  stream: boolean,
): ChatRequestParams {
  const params: ChatRequestParams = { model: config.model, messages, temperature: 0.7 };
  if (config.jsonMode) params.response_format = { type: "json_object" };
  if (config.reasoningEffort !== undefined) params.reasoning_effort = config.reasoningEffort;
  if (stream) {
    params.stream = true;
    params.stream_options = { include_usage: true };
  }
  return params;
}

/** 收窄到 SDK 非流式参数类型（reasoning_effort 透传的唯一断言点）。 */
function asNonStreaming(params: ChatRequestParams): OpenAI.ChatCompletionCreateParamsNonStreaming {
  return params as OpenAI.ChatCompletionCreateParamsNonStreaming;
}

/** 收窄到 SDK 流式参数类型（reasoning_effort 透传的唯一断言点）。 */
function asStreaming(params: ChatRequestParams): OpenAI.ChatCompletionCreateParamsStreaming {
  return params as OpenAI.ChatCompletionCreateParamsStreaming;
}

export class OpenAIChatAdapter implements ChatPort {
  private openai: OpenAI;
  private config: LLMConfig;

  constructor(config: LLMConfig) {
    this.config = config;
    this.openai = new OpenAI({ apiKey: config.apiKey, baseURL: config.baseURL });
  }

  /** 热更新配置（设置页保存即生效）：原地换 key/baseURL/model/jsonMode/reasoningEffort。 */
  updateConfig(config: LLMConfig): void {
    this.config = config;
    this.openai = new OpenAI({ apiKey: config.apiKey, baseURL: config.baseURL });
  }

  /**
   * 一次对话调用。request.onDelta 存在时走流式（逐 token 回调），否则一次性返回。
   * 流式的 usage 在最后一个 chunk（stream_options.include_usage），口径与非流式一致。
   */
  async chat(request: ChatRequest, signal: AbortSignal): Promise<ChatResult> {
    return request.onDelta !== undefined
      ? this.chatStreaming(request.messages, signal, request.onDelta, request.onReasoningDelta)
      : this.chatOnce(request.messages, signal);
  }

  private async chatOnce(messages: ChatMessage[], signal: AbortSignal): Promise<ChatResult> {
    try {
      const resp = await this.openai.chat.completions.create(
        asNonStreaming(buildRequestParams(this.config, messages, false)),
        { signal },
      );
      const message = resp.choices[0]?.message;
      return {
        text: message?.content ?? "",
        reasoning: extractReasoningContent(message),
        usage: extractUsage(resp.usage as UsageWithCache),
      };
    } catch (err) {
      if (signal.aborted) throw new LLMAbortedError("", "");
      throw err;
    }
  }

  private async chatStreaming(
    messages: ChatMessage[],
    signal: AbortSignal,
    onDelta: (delta: string) => void,
    onReasoningDelta?: (delta: string) => void,
  ): Promise<ChatResult> {
    const stream = await this.openai.chat.completions.create(
      asStreaming(buildRequestParams(this.config, messages, true)),
      { signal },
    );

    let text = "";
    let reasoning = "";
    let usage: ChatResult["usage"] = { hit: 0, miss: 0, output: 0 };
    try {
      for await (const chunk of stream) {
        const deltaObj = chunk.choices[0]?.delta;
        const reasoningDelta = extractReasoningContent(deltaObj);
        if (reasoningDelta) {
          reasoning += reasoningDelta;
          onReasoningDelta?.(reasoningDelta);
        }
        const delta = deltaObj?.content ?? "";
        if (delta) {
          text += delta;
          onDelta(delta);
        }
        // usage 只在最后一个 chunk 出现
        if (chunk.usage) {
          usage = extractUsage(chunk.usage as UsageWithCache);
        }
      }
    } catch (err) {
      if (signal.aborted) throw new LLMAbortedError(text, reasoning);
      throw err;
    }
    // abort 不保证从流里抛错（SDK 时序：流可能"正常结束"）——
    // 必须显式检查，否则部分文本会被当成成功返回，下游误判为解析失败并重试
    if (signal.aborted) throw new LLMAbortedError(text, reasoning);
    return { text, reasoning, usage };
  }
}
