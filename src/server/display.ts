import type { Display } from "../display.js";
import type { AdjudicationPackage, DecisionPackage } from "../types.js";
import type { ServerMessage } from "./ws-protocol.js";

/**
 * WebDisplay：Display 接口的 WebSocket 实现。
 * 构造绑定 runId；agentStart 记录当前 activationId（GameSession 经可选第 4 参传入），
 * 每条流式消息盖 {runId, activationId}——前端只接受当前 run/activation 的增量，
 * 旧 run/旧 activation 的晚到消息直接被丢弃。agentEnd 清空当前 activationId。
 * summary 不再产生下行消息（前端已不渲染；CLI display 不受影响）。
 */
export class WebDisplay implements Display {
  /** 当前在途 activation 的 ID（agentStart 记录，agentEnd 清空；无在途为 null）。 */
  private activationId: string | null = null;

  constructor(
    private runId: string,
    private broadcast: (msg: ServerMessage) => void,
  ) {}

  /** 流式消息公共身份（activationId 缺失 = 空串，GameSession 路径恒有值）。 */
  private identity(): { runId: string; activationId: string } {
    return { runId: this.runId, activationId: this.activationId ?? "" };
  }

  agentStart(agent: string, title: string, turn?: number, activationId?: string): void {
    this.activationId = activationId ?? null;
    this.broadcast({ ...this.identity(), type: "agent_start", agent, title, turn: turn ?? 0 });
  }

  delta(agent: string, text: string): void {
    this.broadcast({ ...this.identity(), type: "delta", agent, text });
  }

  reasoningDelta(agent: string, text: string): void {
    this.broadcast({ ...this.identity(), type: "reasoning", agent, text });
  }

  agentEnd(agent: string): void {
    this.broadcast({ ...this.identity(), type: "agent_end", agent });
    this.activationId = null;
  }

  /** 摘要无下行消息（协议无 summary 类型，前端不渲染）。 */
  summary(_agent: string, _text: string): void {}

  retry(agent: string, attempt: number, reason: string): void {
    this.broadcast({ ...this.identity(), type: "retry", agent, attempt, reason });
  }

  decision(agent: string, pkg: DecisionPackage, turn?: number): void {
    this.broadcast({ ...this.identity(), type: "decision", agent, pkg, turn: turn ?? 0 });
  }

  adjudication(agent: string, pkg: AdjudicationPackage, turn?: number): void {
    this.broadcast({ ...this.identity(), type: "adjudication", agent, pkg, turn: turn ?? 0 });
  }
}
