/**
 * web/protocol.js createProtocol 单元测试（unit 层，优化阶段 D4）：
 * requestId 定向应答关联（并发互不消费、command_error 带 code reject）、
 * sendCommand 从 store 读 runId/revision 自动补身份（豁免口径）、未连接立即 reject、
 * snapshot/transition → store（needsResync 自动补 snapshot query）、流式身份校验后直通。
 * 零 IO：fake transport + 真实 session-store。
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createProtocol } from "../web/protocol.js";
import { createSessionStore } from "../web/session-store.js";

class FakeTransport {
  connected = true;
  readonly sent: string[] = [];
  send(text: string): boolean {
    this.sent.push(text);
    return this.connected;
  }
  /** 最后一条发送帧（JSON 解析后）。 */
  last(): Record<string, unknown> {
    return JSON.parse(this.sent.at(-1)!) as Record<string, unknown>;
  }
}

const PIPELINE = { seq: 1, phase: "await_player", interrupted: false, kind: null };

function harness() {
  const transport = new FakeTransport();
  const store = createSessionStore();
  const streamed: Array<Record<string, unknown>> = [];
  const uncorrelated: Array<Record<string, unknown>> = [];
  const protocol = createProtocol({
    transport,
    store,
    onStreaming: (m) => streamed.push(m),
    onUncorrelated: (m) => uncorrelated.push(m),
  });
  return { transport, store, protocol, streamed, uncorrelated };
}

function seedSnapshot(store: ReturnType<typeof createSessionStore>, runId = "000001", revision = 3) {
  store.dispatch({
    type: "snapshot",
    runId,
    revision,
    state: { world: {}, characters: {} },
    events: [],
    history: { mode: "full", turns: [] },
    pipeline: { ...PIPELINE },
  });
}

describe("createProtocol：命令身份与应答关联", () => {
  it("sendCommand 从 store 读 runId/revision 自动补身份（requestId 随机）", async () => {
    const { transport, store, protocol } = harness();
    seedSnapshot(store, "000001", 3);
    const p = protocol.sendCommand("continue");
    const cmd = transport.last();
    assert.equal(cmd.type, "continue");
    assert.equal(cmd.runId, "000001");
    assert.equal(cmd.baseRevision, 3);
    assert.equal(typeof cmd.requestId, "string");
    protocol.handleMessage({ type: "command_result", requestId: cmd.requestId, command: "continue" });
    await p; // resolve 不 reject 即通过
  });

  it("豁免口径：pause_options/stop/query 免 baseRevision；new_session 免 runId", () => {
    const { transport, store, protocol } = harness();
    seedSnapshot(store);
    void protocol.sendCommand("query", { query: "snapshot" }).catch(() => {});
    assert.equal(transport.last().baseRevision, undefined);
    assert.equal(transport.last().runId, "000001"); // query 仍带 runId
    void protocol.sendCommand("new_session", {}).catch(() => {});
    assert.equal(transport.last().runId, undefined);
    assert.equal(transport.last().baseRevision, undefined);
  });

  it("未连接（transport.send 返回 false）立即 reject 且不留 pending", async () => {
    const { transport, protocol } = harness();
    transport.connected = false;
    await assert.rejects(protocol.sendCommand("continue"), /WS 未连接/);
    assert.equal(protocol.pending.size, 0);
  });

  it("并发请求按 requestId 寻址、逆序应答互不消费", async () => {
    const { transport, protocol } = harness();
    const p1 = protocol.sendCommand("continue");
    const p2 = protocol.sendCommand("rollback", { targetSeq: 2 });
    const [id1, id2] = transport.sent.map((t) => (JSON.parse(t) as { requestId: string }).requestId);
    assert.equal(protocol.pending.size, 2);

    // 逆序：先答 p2（error）再答 p1（result）
    protocol.handleMessage({
      type: "command_error", requestId: id2, command: "rollback", code: "REVISION_CONFLICT", message: "冲突",
    });
    await assert.rejects(p2, (err: Error & { code?: string }) => err.code === "REVISION_CONFLICT");
    assert.equal(protocol.pending.size, 1); // p1 不被误消费

    protocol.handleMessage({ type: "command_result", requestId: id1, command: "continue" });
    await p1;
    assert.equal(protocol.pending.size, 0);
  });

  it("无关联 command_error → onUncorrelated 兜底", () => {
    const { protocol, uncorrelated } = harness();
    protocol.handleMessage({ type: "command_error", requestId: "nobody", command: "?", message: "协议错误: 未知命令" });
    assert.equal(uncorrelated.length, 1);
    assert.match(String(uncorrelated[0]!.message), /协议错误/);
  });
});

describe("createProtocol：状态同步路由", () => {
  it("snapshot → store 整体替换", () => {
    const { store, protocol } = harness();
    protocol.handleMessage({
      type: "snapshot", runId: "000007", revision: 9,
      state: { world: { x: 1 }, characters: {} }, events: [],
      history: { mode: "full", turns: [] }, pipeline: { ...PIPELINE },
    });
    assert.equal(store.getState().runId, "000007");
    assert.equal(store.getState().revision, 9);
  });

  it("transition 跳号 → store 置 needsResync + 自动补发 snapshot query", () => {
    const { transport, store, protocol } = harness();
    seedSnapshot(store, "000001", 3);
    protocol.handleMessage({
      type: "transition", runId: "000001", fromRevision: 7, revision: 8,
      reason: "step", pipeline: { ...PIPELINE }, changed: {},
    });
    assert.equal(store.getState().needsResync, true);
    const query = transport.last();
    assert.equal(query.type, "query");
    assert.equal(query.query, "snapshot");
  });

  it("transition 连续 → 应用且不补发 query", () => {
    const { transport, store, protocol } = harness();
    seedSnapshot(store, "000001", 3);
    protocol.handleMessage({
      type: "transition", runId: "000001", fromRevision: 3, revision: 4,
      reason: "step", pipeline: { ...PIPELINE, seq: 4 }, changed: { world: { x: 2 } },
    });
    assert.equal(store.getState().revision, 4);
    assert.equal(store.getState().needsResync, false);
    assert.equal(transport.sent.length, 0);
  });
});

describe("createProtocol：流式身份校验", () => {
  const start = { type: "agent_start", runId: "000001", activationId: "a1", agent: "gm", turn: 1, title: "裁决" };

  it("agent_start 置槽并直通；activationId 不匹配的消息不直通", () => {
    const { store, protocol, streamed } = harness();
    seedSnapshot(store);
    protocol.handleMessage({ ...start, runId: "000099" }); // 旧 run
    assert.equal(streamed.length, 0);
    assert.equal(store.getState().streaming, null);

    protocol.handleMessage(start);
    assert.equal(streamed.length, 1);
    assert.equal(store.getState().streaming?.activationId, "a1");

    protocol.handleMessage({ type: "delta", runId: "000001", activationId: "aX", agent: "gm", text: "晚到" });
    assert.equal(streamed.length, 1); // 不直通
    protocol.handleMessage({ type: "delta", runId: "000001", activationId: "a1", agent: "gm", text: "新" });
    assert.equal(streamed.length, 2);

    protocol.handleMessage({ type: "agent_end", runId: "000001", activationId: "a1", agent: "gm" });
    assert.equal(store.getState().streaming, null);
    assert.equal(streamed.length, 3);
  });
});
