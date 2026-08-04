/**
 * web/session-store.js 单元测试（unit 层）：
 * snapshot 替换/runId 变化信号、transition 各分支（world 整换/characters 增删/events
 * append/truncate/pipeline）、跳号置 needsResync、旧 runId 丢弃、streaming 身份校验、
 * selectBusy 语义锁（busy = streaming 非空 || phase !== await_player）。
 * 零 IO：直接 import web/ 纯 ESM（另附源码纯度断言守护）。
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { describe, it } from "node:test";
import {
  CONNECTION,
  createSessionStore,
  selectBusy,
} from "../web/session-store.js";

const PIPELINE = { seq: 1, phase: "await_player", interrupted: false, kind: null };

function snapshotMsg(runId: string, revision: number, extra: Record<string, unknown> = {}) {
  return {
    type: "snapshot",
    runId,
    revision,
    state: { world: { x: 1 }, characters: { C1001: { name: "甲" } } },
    events: [{ seq: 1, id: "e1" }, { seq: 2, id: "e2" }],
    history: { mode: "full", turns: [] },
    pipeline: { ...PIPELINE },
    ...extra,
  };
}

function transitionMsg(
  runId: string,
  fromRevision: number,
  revision: number,
  changed: Record<string, unknown> = {},
) {
  return {
    type: "transition",
    runId,
    fromRevision,
    revision,
    reason: "step",
    pipeline: { ...PIPELINE, seq: revision },
    changed,
  };
}

describe("session-store：snapshot", () => {
  it("整体替换 + runId 变化信号（首次建立不信号，换 run 才信号）", () => {
    const store = createSessionStore();
    const metas: Array<Record<string, unknown>> = [];
    store.subscribe((_s, m) => metas.push(m as unknown as Record<string, unknown>));

    store.dispatch(snapshotMsg("000001", 3));
    let s = store.getState();
    assert.equal(s.runId, "000001");
    assert.equal(s.revision, 3);
    assert.deepEqual(s.world, { x: 1 });
    assert.deepEqual(s.characters, { C1001: { name: "甲" } });
    assert.equal(s.events.length, 2);
    assert.equal(metas[0]!.runIdChanged, false); // 首次建立：无旧 run，不算切换

    store.dispatch(snapshotMsg("000001", 4)); // 同 run 重连快照：不信号
    assert.equal(metas[1]!.runIdChanged, false);

    store.dispatch(snapshotMsg("000002", 0, { state: { world: {}, characters: {} }, events: [] }));
    s = store.getState();
    assert.equal(s.runId, "000002");
    assert.equal(s.revision, 0);
    assert.deepEqual(s.events, []);
    assert.equal(metas[2]!.runIdChanged, true); // 换 run：transient reset 信号
  });

  it("快照清 streaming/needsResync，保留 connection 状态", () => {
    const store = createSessionStore();
    store.dispatch({ type: "connection", status: CONNECTION.OPEN });
    store.dispatch(snapshotMsg("000001", 1));
    store.dispatch({
      type: "agent_start", runId: "000001", activationId: "a1", agent: "gm", turn: 1, title: "裁决",
    });
    store.dispatch(transitionMsg("000001", 9, 10)); // 跳号 → needsResync
    assert.equal(store.getState().needsResync, true);
    assert.notEqual(store.getState().streaming, null);

    store.dispatch(snapshotMsg("000001", 10));
    const s = store.getState();
    assert.equal(s.needsResync, false);
    assert.equal(s.streaming, null);
    assert.equal(s.connection, CONNECTION.OPEN); // 连接态归 transport 上报，快照不碰
  });
});

describe("session-store：transition", () => {
  it("各分支应用：world 整换 / characters 增改删 / events append / pipeline 更新", () => {
    const store = createSessionStore();
    store.dispatch(snapshotMsg("000001", 3));
    store.dispatch(
      transitionMsg("000001", 3, 4, {
        world: { x: 2 },
        characters: { C1001: { name: "甲改" }, C1002: { name: "乙" } },
        appendedEvents: [{ seq: 3, id: "e3" }],
      }),
    );
    const s = store.getState();
    assert.equal(s.revision, 4);
    assert.deepEqual(s.world, { x: 2 }); // 整换
    assert.deepEqual(s.characters, { C1001: { name: "甲改" }, C1002: { name: "乙" } });
    assert.deepEqual(s.events.map((e) => e.seq), [1, 2, 3]);
    assert.equal(s.pipeline.seq, 4);
  });

  it("characters null 值 = 删除该 CID", () => {
    const store = createSessionStore();
    store.dispatch(snapshotMsg("000001", 3));
    store.dispatch(transitionMsg("000001", 3, 4, { characters: { C1001: null } }));
    assert.deepEqual(store.getState().characters, {});
  });

  it("events 截断（含截断后再补尾：先截后补）", () => {
    const store = createSessionStore();
    store.dispatch(snapshotMsg("000001", 3));
    store.dispatch(transitionMsg("000001", 3, 4, { truncateEventsAfterSeq: 1 }));
    assert.deepEqual(store.getState().events.map((e) => e.seq), [1]);
    store.dispatch(
      transitionMsg("000001", 4, 5, {
        truncateEventsAfterSeq: 0,
        appendedEvents: [{ seq: 1, id: "n1" }],
      }),
    );
    assert.deepEqual(store.getState().events.map((e) => e.id), ["n1"]);
  });

  it("historyPatch replace → history 整体替换", () => {
    const store = createSessionStore();
    store.dispatch(snapshotMsg("000001", 3));
    const history = { mode: "full", turns: [{ turn: 1 }] };
    store.dispatch(transitionMsg("000001", 3, 4, { historyPatch: { type: "replace", history } }));
    assert.deepEqual(store.getState().history, history);
  });

  it("跳号（fromRevision ≠ 当前 revision）→ 置 needsResync 且数据不变", () => {
    const store = createSessionStore();
    store.dispatch(snapshotMsg("000001", 3));
    store.dispatch(transitionMsg("000001", 7, 8, { world: { x: 99 } }));
    const s = store.getState();
    assert.equal(s.needsResync, true);
    assert.equal(s.revision, 3); // 未前进
    assert.deepEqual(s.world, { x: 1 });
  });

  it("旧 runId / 无身份（快照未到）的 transition 一律丢弃", () => {
    const store = createSessionStore();
    store.dispatch(transitionMsg("000001", 0, 1)); // 无身份
    assert.equal(store.getState().runId, null);
    store.dispatch(snapshotMsg("000001", 3));
    store.dispatch(transitionMsg("000099", 3, 4, { world: { x: 99 } })); // 旧 run 晚到
    const s = store.getState();
    assert.equal(s.revision, 3);
    assert.deepEqual(s.world, { x: 1 });
    assert.equal(s.needsResync, false);
  });
});

describe("session-store：streaming 身份校验", () => {
  const start = (runId: string, activationId: string) => ({
    type: "agent_start", runId, activationId, agent: "character:C1001", turn: 2, title: "决策",
  });

  it("agent_start 置槽（仅 runId 匹配）；agent_end 清槽（仅 activationId 匹配）", () => {
    const store = createSessionStore();
    store.dispatch(snapshotMsg("000001", 3));
    store.dispatch(start("000099", "a9")); // 旧 run → 丢弃
    assert.equal(store.getState().streaming, null);

    store.dispatch(start("000001", "a1"));
    assert.equal(store.getState().streaming?.activationId, "a1");
    assert.equal(store.getState().streaming?.agent, "character:C1001");

    store.dispatch({ type: "agent_end", runId: "000001", activationId: "a2", agent: "character:C1001" });
    assert.notEqual(store.getState().streaming, null); // activationId 不匹配 → 不清
    store.dispatch({ type: "agent_end", runId: "000001", activationId: "a1", agent: "character:C1001" });
    assert.equal(store.getState().streaming, null);
  });

  it("activationId 不匹配的 delta/decision 等不改变流式槽", () => {
    const store = createSessionStore();
    store.dispatch(snapshotMsg("000001", 3));
    store.dispatch(start("000001", "a1"));
    const before = store.getState().streaming;
    store.dispatch({ type: "delta", runId: "000001", activationId: "aX", agent: "character:C1001", text: "晚到" });
    store.dispatch({ type: "decision", runId: "000001", activationId: "aX", agent: "character:C1001", pkg: {}, turn: 2 });
    assert.equal(store.getState().streaming, before); // 槽引用未变
  });
});

describe("session-store：selectBusy 语义锁", () => {
  it("busy = streaming 非空 || phase !== await_player", () => {
    const store = createSessionStore();
    store.dispatch(snapshotMsg("000001", 3)); // phase await_player、无流式
    assert.equal(selectBusy(store.getState()), false);

    store.dispatch({
      type: "agent_start", runId: "000001", activationId: "a1", agent: "gm", turn: 1, title: "裁决",
    });
    assert.equal(selectBusy(store.getState()), true); // 流式在途

    store.dispatch({ type: "agent_end", runId: "000001", activationId: "a1", agent: "gm" });
    store.dispatch(
      transitionMsg("000001", 3, 4, {}), // pipeline.seq 前进但 phase 仍 await_player（快照带）
    );
    assert.equal(selectBusy(store.getState()), false);

    // 步间/暂停点：phase 非 await_player（即使无流式）仍 busy —— 中段瞬闪按此收敛
    store.dispatch({
      ...transitionMsg("000001", 4, 5, {}),
      pipeline: { seq: 5, phase: "await_gm", interrupted: false, kind: "gm" },
    });
    assert.equal(selectBusy(store.getState()), true);
  });
});

describe("session-store：模块纯度", () => {
  it("纯 ESM 零 DOM 零存储零 socket 全局（node 环境直接 import + 源码断言防回归）", () => {
    const source = fs.readFileSync(path.join(process.cwd(), "web/session-store.js"), "utf8");
    assert.doesNotMatch(source, /\b(document|window|localStorage|WebSocket|fetch)\b/);
  });
});
