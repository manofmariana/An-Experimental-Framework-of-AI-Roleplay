import type { Display } from "../display.js";
import type { AdjudicationPackage, DecisionPackage } from "../types.js";
import type { ServerMessage } from "./ws-protocol.js";

/**
 * WebDisplay：Display 接口的 WebSocket 实现。
 * 每个回调翻译成一条下行消息广播给所有连接的客户端——
 * GameSession 不需要知道浏览器存在。
 */
export class WebDisplay implements Display {
  constructor(private broadcast: (msg: ServerMessage) => void) {}

  agentStart(agent: string, title: string, turn?: number): void {
    this.broadcast({ type: "agent_start", agent, title, turn: turn ?? 0 });
  }

  delta(agent: string, text: string): void {
    this.broadcast({ type: "delta", agent, text });
  }

  reasoningDelta(agent: string, text: string): void {
    this.broadcast({ type: "reasoning", agent, text });
  }

  agentEnd(agent: string): void {
    this.broadcast({ type: "agent_end", agent });
  }

  summary(agent: string, text: string): void {
    this.broadcast({ type: "summary", agent, text });
  }

  retry(agent: string, attempt: number, reason: string): void {
    this.broadcast({ type: "retry", agent, attempt, reason });
  }

  decision(agent: string, pkg: DecisionPackage, turn?: number): void {
    this.broadcast({ type: "decision", agent, pkg, turn: turn ?? 0 });
  }

  adjudication(agent: string, pkg: AdjudicationPackage, turn?: number): void {
    this.broadcast({ type: "adjudication", agent, pkg, turn: turn ?? 0 });
  }
}
