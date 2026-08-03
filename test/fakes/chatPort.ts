/**
 * 测试 fake：ChatPort 脚本端口（替代旧 LLMClient.prototype.chat monkey-patch）。
 * ScriptedChatPort = 通用最小实现（handler 逐次出结果，记录全部请求供断言）；
 * FakeChatScript = 会话级脚本（gm 队列 / character 分 agent 队列 / prose 回显 / abortAt 中止），
 * 字段全部可变，测试在步间直接改写（与旧 patch 闭包变量同用法）。
 * 经 SessionOptions.chatPorts 注入，不碰任何 prototype。
 */
import type { AgentKind } from "../../src/config.js";
import {
  LLMAbortedError,
  type ChatMessage,
  type ChatPort,
  type ChatRequest,
  type ChatResult,
} from "../../src/llm/chatPort.js";

export interface RecordedCall {
  agent: string;
  seq: number;
  messages: ChatMessage[];
}

export type ChatHandler = (request: ChatRequest) => ChatResult | Promise<ChatResult>;

/** 通用脚本端口：每次 chat 记录请求后交 handler 出结果（或抛错）。 */
export class ScriptedChatPort implements ChatPort {
  readonly calls: RecordedCall[] = [];
  constructor(private handler: ChatHandler) {}
  async chat(request: ChatRequest, _signal: AbortSignal): Promise<ChatResult> {
    this.calls.push({ agent: request.agent, seq: request.seq, messages: request.messages.map((m) => ({ ...m })) });
    return this.handler(request);
  }
}

const ZERO_USAGE = { hit: 0, miss: 0, output: 0 };

/**
 * 会话级脚本 fake：一个实例服务全部三种 agent kind（按 request.agent 路由）。
 * - gm：gmQueue 依次弹出（JSON 化）；耗尽抛错；
 * - prose：proseText(seq)（默认 `正文#seq`）；
 * - character：characterQueues[agent] 依次弹出，缺省回 defaultDecision；
 * - abortAt 命中（agent+seq）抛 LLMAbortedError（partial 文本）。
 */
export class FakeChatScript {
  gmQueue: Record<string, unknown>[] = [];
  characterQueues: Record<string, Record<string, unknown>[]> = {};
  abortAt: { agent: string; seq: number; partial: string } | null = null;
  /** prose 文本生成（默认回显轮次） */
  proseText: (seq: number) => string = (seq) => `正文#${seq}`;
  /** character 缺省决策（该 agent 队列耗尽/未配置时） */
  defaultDecision: (agent: string, seq: number) => Record<string, unknown> = (agent, seq) => ({
    action: `行动#${seq}`,
    inner: `内心#${seq}`,
    dialogue: `台词@${agent}#${seq}`,
  });

  readonly port: ScriptedChatPort;
  /** SessionOptions.chatPorts 直接喂入（三 kind 共享同一脚本与调用记录）。 */
  readonly ports: Record<AgentKind, ChatPort>;

  constructor() {
    this.port = new ScriptedChatPort((request) => this.respond(request));
    this.ports = { character: this.port, gm: this.port, prose: this.port };
  }

  /** 全部已记录调用（含被 abort 的调用，与旧 patch 口径一致：先记录后判定）。 */
  get calls(): readonly RecordedCall[] {
    return this.port.calls;
  }

  private respond(request: ChatRequest): ChatResult {
    if (this.abortAt?.agent === request.agent && this.abortAt.seq === request.seq) {
      throw new LLMAbortedError(this.abortAt.partial, "");
    }
    if (request.agent === "gm") {
      const pkg = this.gmQueue.shift();
      if (pkg === undefined) throw new Error(`GM 脚本耗尽（seq ${request.seq}）`);
      return { text: JSON.stringify(pkg), reasoning: "", usage: ZERO_USAGE };
    }
    if (request.agent === "prose") {
      return { text: this.proseText(request.seq), reasoning: "", usage: ZERO_USAGE };
    }
    const scripted = this.characterQueues[request.agent]?.shift();
    return {
      text: JSON.stringify(scripted ?? this.defaultDecision(request.agent, request.seq)),
      reasoning: "",
      usage: ZERO_USAGE,
    };
  }
}
