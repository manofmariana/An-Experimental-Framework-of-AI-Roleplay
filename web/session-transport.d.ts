/**
 * web/session-transport.js 的类型声明（供 TS 测试 import；权威运行时行为见 session-transport.js）。
 */
export interface SocketLike {
  readyState: number;
  send(text: string): void;
  close(): void;
  onopen: ((ev?: unknown) => void) | null;
  onmessage: ((ev: unknown) => void) | null;
  onclose: ((ev?: unknown) => void) | null;
  onerror: ((ev?: unknown) => void) | null;
}

export interface SessionTransportOptions {
  /** WebSocket 构造器（浏览器全局或测试 fake） */
  WebSocketImpl: new (url: string) => SocketLike;
  /** 连接地址（每次 connect 现取） */
  url(): string;
  onMessage(text: string): void;
  /** 连接状态上报："connecting" | "open" | "closed" */
  onStatus(status: string): void;
  /** 重连退避（默认 1s 起翻倍，封顶 10s） */
  backoff?: { initial: number; max: number };
  /** 测试注入假时钟 */
  setTimeoutFn?: (fn: () => void, ms: number) => unknown;
  clearTimeoutFn?: (handle: unknown) => void;
}

export function createSessionTransport(opts: SessionTransportOptions): {
  connect(): void;
  reconnect(): void;
  /** 未连接返回 false（不静默丢弃） */
  send(text: string): boolean;
  dispose(): void;
  getState(): { status: string; generation: number };
};
