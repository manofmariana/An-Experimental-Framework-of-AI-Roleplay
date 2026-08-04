/**
 * web/session-transport.js 单元测试（unit 层，优化阶段 D4「SessionTransport」）：
 * fake WebSocket + 假时钟注入，验证连接生命周期守卫——
 * 任意时刻至多一个有效 socket、一个 reconnect timer；旧 generation 回调一律丢弃；
 * 指数退避 1→2→4 封顶；dispose 后无重连；send 未连接返回 false。
 * 零 IO 零真实时钟。
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  createSessionTransport,
  type SocketLike,
} from "../web/session-transport.js";

/** fake WebSocket：实例全录，测试手动触发服务端侧事件。 */
class FakeWS implements SocketLike {
  static instances: FakeWS[] = [];
  static reset() {
    FakeWS.instances = [];
  }
  readyState = 0;
  readonly sent: string[] = [];
  onopen: ((ev?: unknown) => void) | null = null;
  onmessage: ((ev: unknown) => void) | null = null;
  onclose: ((ev?: unknown) => void) | null = null;
  onerror: ((ev?: unknown) => void) | null = null;
  constructor(readonly url: string) {
    FakeWS.instances.push(this);
  }
  send(text: string) {
    this.sent.push(text);
  }
  close() {
    if (this.readyState === 3) return;
    this.readyState = 3;
    this.onclose?.();
  }
  /** 测试辅助：服务端侧事件 */
  serverOpen() {
    this.readyState = 1;
    this.onopen?.();
  }
  serverMessage(text: string) {
    this.onmessage?.({ data: text });
  }
  serverClose() {
    this.readyState = 3;
    this.onclose?.();
  }
}

/** 假时钟：timer 全录（至多一个由测试断言），手动触发。 */
class FakeClock {
  private next = 1;
  private readonly timers = new Map<number, { fn: () => void; ms: number }>();
  readonly setTimeoutFn = (fn: () => void, ms: number): unknown => {
    const id = this.next++;
    this.timers.set(id, { fn, ms });
    return id;
  };
  readonly clearTimeoutFn = (handle: unknown): void => {
    this.timers.delete(handle as number);
  };
  get count() {
    return this.timers.size;
  }
  get delays() {
    return [...this.timers.values()].map((t) => t.ms);
  }
  /** 触发当前唯一 timer（断言至多一个的调用点先用 count 校验）。 */
  fireAll() {
    for (const [, t] of [...this.timers]) t.fn();
    this.timers.clear();
  }
}

function harness(backoff = { initial: 1000, max: 10000 }) {
  FakeWS.reset();
  const clock = new FakeClock();
  const messages: string[] = [];
  const statuses: string[] = [];
  const transport = createSessionTransport({
    WebSocketImpl: FakeWS,
    url: () => "ws://test/ws",
    onMessage: (t) => messages.push(t),
    onStatus: (s) => statuses.push(s),
    backoff,
    setTimeoutFn: clock.setTimeoutFn,
    clearTimeoutFn: clock.clearTimeoutFn,
  });
  return { transport, clock, messages, statuses };
}

describe("session-transport：连接与发送", () => {
  it("connect → connecting → open；open 后 send 成功，消息经 onMessage 上交", () => {
    const { transport, messages, statuses } = harness();
    transport.connect();
    assert.deepEqual(statuses, ["connecting"]);
    assert.equal(transport.send("x"), false); // 未连接返回 false

    const ws = FakeWS.instances[0]!;
    ws.serverOpen();
    assert.deepEqual(statuses, ["connecting", "open"]);
    assert.equal(transport.send("hello"), true);
    assert.deepEqual(ws.sent, ["hello"]);

    ws.serverMessage("down");
    assert.deepEqual(messages, ["down"]);
  });

  it("send 在 close 后返回 false", () => {
    const { transport } = harness();
    transport.connect();
    FakeWS.instances[0]!.serverOpen();
    FakeWS.instances[0]!.serverClose();
    assert.equal(transport.send("x"), false);
  });
});

describe("session-transport：重连守卫（单一 socket / 单一 timer / generation）", () => {
  it("close → 恰好一个重连 timer，指数退避 1s→2s→4s 封顶 10s", () => {
    const { transport, clock } = harness();
    transport.connect();
    const ws = FakeWS.instances[0]!;
    ws.serverOpen();
    ws.serverClose();
    assert.equal(clock.count, 1);
    assert.deepEqual(clock.delays, [1000]);

    clock.fireAll(); // 重连 → 新 socket
    assert.equal(FakeWS.instances.length, 2);
    FakeWS.instances[1]!.serverClose();
    assert.equal(clock.count, 1);
    assert.deepEqual(clock.delays, [2000]);

    clock.fireAll();
    FakeWS.instances[2]!.serverClose();
    assert.deepEqual(clock.delays, [4000]);

    // 连续多次未 open：8s → 10s 封顶
    clock.fireAll();
    FakeWS.instances[3]!.serverClose();
    assert.deepEqual(clock.delays, [8000]);
    clock.fireAll();
    FakeWS.instances[4]!.serverClose();
    assert.deepEqual(clock.delays, [10000]);
    clock.fireAll();
    FakeWS.instances[5]!.serverClose();
    assert.deepEqual(clock.delays, [10000]); // 封顶
  });

  it("open 后退避复位；连续 close 不叠加 timer", () => {
    const { transport, clock } = harness();
    transport.connect();
    FakeWS.instances[0]!.serverClose();
    assert.deepEqual(clock.delays, [1000]);
    clock.fireAll();
    const ws2 = FakeWS.instances[1]!;
    ws2.serverOpen(); // 连上 → 退避复位
    ws2.serverClose();
    assert.equal(clock.count, 1);
    assert.deepEqual(clock.delays, [1000]);
    // 同一 gen 的重复 close 回调（浏览器可能多发）：先清后挂，仍只有一个 timer
    ws2.onclose?.();
    assert.equal(clock.count, 1);
  });

  it("reconnect/connect 后旧 generation 回调一律丢弃（一个有效连接一个 timer）", () => {
    const { transport, clock, messages } = harness();
    transport.connect();
    const old = FakeWS.instances[0]!;
    // 捕获旧 gen 回调引用（dropSocket 会置空实例字段，但晚到事件可能已持有旧引用）
    const staleOpen = old.onopen!;
    const staleMessage = old.onmessage!;
    const staleClose = old.onclose!;

    transport.reconnect(); // 新世代
    assert.equal(FakeWS.instances.length, 2);
    assert.equal(transport.getState().generation, 2);

    staleOpen();
    staleMessage({ data: "stale" });
    staleClose();
    assert.deepEqual(messages, []); // 旧 gen 消息丢弃
    assert.equal(clock.count, 0); // 旧 gen close 不挂重连 timer
    assert.equal(transport.getState().status, "connecting"); // 旧 gen open 不生效

    const current = FakeWS.instances[1]!;
    current.serverOpen();
    assert.equal(transport.getState().status, "open");
    current.serverMessage("fresh");
    assert.deepEqual(messages, ["fresh"]);
  });

  it("dispose：断连停重连，timer 触发不再 connect，之后再 connect 无效", () => {
    const { transport, clock, statuses } = harness();
    transport.connect();
    FakeWS.instances[0]!.serverClose();
    assert.equal(clock.count, 1);

    transport.dispose();
    assert.equal(clock.count, 0); // timer 已清
    assert.equal(transport.getState().status, "closed");

    clock.fireAll(); // 兜底：即使残留也不应新建连接
    transport.connect(); // disposed 后无效
    assert.equal(FakeWS.instances.length, 1);
    assert.deepEqual(statuses.at(-1), "closed");
  });

  it("dispose 断开在途连接且其晚到 close 不再触发重连", () => {
    const { transport, clock } = harness();
    transport.connect();
    const ws = FakeWS.instances[0]!;
    ws.serverOpen();
    transport.dispose();
    ws.serverClose(); // 晚到 close（handlers 已置空 + generation 已递增，双保险）
    assert.equal(clock.count, 0);
  });
});
