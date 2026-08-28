import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  SessionCoordinator,
  type SessionCommand,
} from "../src/application/sessionCoordinator.js";
import type { SessionFactory } from "../src/application/sessionFactory.js";
import type { SessionTransition } from "../src/application/transitionProjection.js";
import { RevisionConflictError, SessionSwitchedError } from "../src/truth/validation/errors.js";
import { buildEvent } from "./builders/index.js";

// ---------------------------------------------------------------------------
// SessionCoordinator（单一命令协调器 + 消息身份/增量同步/会话切换隔离）：
// fake factory + fake session（零 IO）：并发 execute 串行不交错、
// rollback_and_continue 单任务不可插队 + 只发一条合并 Transition、陈旧 baseRevision 拒绝、
// stop 定向中止（runId/activationId 核对）、new/load 强制切换 dispose 旧会话、
// onCommit → Transition 投影广播、一致快照 query。
// ---------------------------------------------------------------------------

const ROOTS = { world: {}, characters: {}, events: [] };

/** 记录调用序的 fake 会话：异步方法跨 await，暴露任务间插队；onCommit 手动触发模拟提交。 */
class FakeSession {
  readonly calls: string[] = [];
  readonly pauseHistory: unknown[] = [];
  aborted = 0;
  reloaded = 0;
  busy: boolean[] = [];
  disposedFlag = false;
  activationId: string | null = null;
  onCommit: ((notice: never) => void) | null = null;
  constructor(
    readonly runId: string,
    public revision = 1,
  ) {}
  setBusy(b: boolean): void { this.busy.push(b); }
  get isBusy(): boolean { return this.busy[this.busy.length - 1] === true; }
  setPauseOptions(o: unknown): void { this.pauseHistory.push(o); }
  abortCurrent(): void { this.aborted += 1; }
  dispose(): void { this.disposedFlag = true; this.abortCurrent(); }
  get disposed(): boolean { return this.disposedFlag; }
  get currentActivationId(): string | null { return this.activationId; }
  applyResolvedConfig(resolved: unknown, settings: unknown): void {
    this.reloaded += 1;
    this.appliedConfig = { resolved, settings };
  }
  appliedConfig: { resolved: unknown; settings: unknown } | null = null;
  /** 模拟一次提交（onCommit 通知；reason/revision 由调用方给定语义）。 */
  fireCommit(reason: string): void {
    this.revision += 1;
    this.onCommit?.({
      reason,
      fromRevision: this.revision - 1,
      revision: this.revision,
      prev: ROOTS,
      next: ROOTS,
    } as never);
  }
  rollbackTo(seq: number): void { this.calls.push(`rollback:${seq}`); }
  editResult(text: string): void { this.calls.push(`edit:${text}`); }
  applyDirectEdit(): void { this.calls.push("direct_edit"); }
  async handlePlayerInput(text: string): Promise<string> {
    this.calls.push(`input:${text}:start`);
    await Promise.resolve();
    this.calls.push(`input:${text}:end`);
    return "";
  }
  async continuePipeline(): Promise<void> {
    this.calls.push("continue:start");
    await Promise.resolve();
    this.calls.push("continue:end");
  }
  get turnCount(): number { return 0; }
  get pipelineInfo(): { seq: number; phase: "await_player"; interrupted: boolean; kind: null } {
    return { seq: 0, phase: "await_player", interrupted: false, kind: null };
  }
  getState(): unknown { return { world: {}, characters: {} }; }
  getEvents(): unknown[] { return [buildEvent({ id: `events-of-${this.runId}` })]; }
  getArchive(): unknown[] { return []; }
  getPipelineCurrent(): null { return null; }
  getStats(): unknown[] { return []; }
}

function makeCoordinator(session?: FakeSession): { coordinator: SessionCoordinator; session: FakeSession } {
  const s = session ?? new FakeSession("temp-run");
  const coordinator = new SessionCoordinator(() => ({}) as never);
  (coordinator as unknown as { session: unknown }).session = s;
  return { coordinator, session: s };
}

describe("SessionCoordinator 串行队列", () => {
  it("并发 execute 串行不交错（player_input 全程 busy 窗口内完成才放行下一条）", async () => {
    const { coordinator, session } = makeCoordinator();
    await Promise.all([
      coordinator.execute({ type: "player_input", text: "甲" }),
      coordinator.execute({ type: "continue" }),
    ]);
    assert.deepEqual(session.calls, ["input:甲:start", "input:甲:end", "continue:start", "continue:end"]);
    assert.deepEqual(session.busy, [true, false, true, false]);
  });

  it("rollback_and_continue 单任务不可插队（命令级：edit_result 不得插入 rollback 与 continue 之间）", async () => {
    const { coordinator, session } = makeCoordinator();
    await Promise.all([
      coordinator.execute({ type: "rollback_and_continue", targetSeq: 5 }),
      coordinator.execute({ type: "edit_result", text: "x" }),
    ]);
    assert.deepEqual(session.calls, ["rollback:4", "continue:start", "continue:end", "edit:x"]);
  });

  it("陈旧 baseRevision 拒绝（RevisionConflictError），匹配/缺省放行", async () => {
    const { coordinator, session } = makeCoordinator(new FakeSession("temp-run", 3));
    await assert.rejects(
      coordinator.execute({ type: "continue", baseRevision: 2 }),
      (err: unknown) => err instanceof RevisionConflictError,
    );
    assert.deepEqual(session.calls, []); // 校验先于派发
    await coordinator.execute({ type: "continue", baseRevision: 3 });
    await coordinator.execute({ type: "continue" }); // 缺省跳过校验
    assert.deepEqual(session.calls, ["continue:start", "continue:end", "continue:start", "continue:end"]);
  });

  it("direct_edit 经队列串行", async () => {
    const { coordinator, session } = makeCoordinator();
    await coordinator.execute({ type: "direct_edit", payload: { world: { hp: 1 } } });
    assert.deepEqual(session.calls, ["direct_edit"]);
  });
});

describe("SessionCoordinator stop 定向中止（消息身份）", () => {
  it("stop 队列外即时中止（不等在途任务完成）", async () => {
    const { coordinator, session } = makeCoordinator();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    session.handlePlayerInput = async () => {
      session.calls.push("input:start");
      await gate;
      session.calls.push("input:end");
      return "";
    };
    const pending = coordinator.execute({ type: "player_input", text: "慢" });
    await Promise.resolve(); // 让任务进入在途
    coordinator.stop(); // 队列外定向中止：立即转发，不在队尾排队
    assert.equal(session.aborted, 1);
    release();
    await pending;
    assert.deepEqual(session.calls, ["input:start", "input:end"]);
  });

  it("runId 不符 → SessionSwitchedError；activationId 不符 → 幂等空成功（不中止当前）", () => {
    const { coordinator, session } = makeCoordinator();
    session.activationId = "temp-run:act:1";
    assert.throws(() => coordinator.stop({ runId: "other-run" }), SessionSwitchedError);
    coordinator.stop({ runId: "temp-run", activationId: "temp-run:act:999" }); // 幂等：不动当前
    assert.equal(session.aborted, 0);
    coordinator.stop({ runId: "temp-run", activationId: "temp-run:act:1" });
    assert.equal(session.aborted, 1);
  });

  it("无会话时 stop 带 runId → SessionSwitchedError；不带身份 → no-op", () => {
    const coordinator = new SessionCoordinator(() => ({}) as never);
    assert.throws(() => coordinator.stop({ runId: "x" }), SessionSwitchedError);
    coordinator.stop();
  });
});

describe("SessionCoordinator 一致快照 query", () => {
  it("snapshot = 单 revision 一致视图（runId/revision/state/events/history/pipeline 同根）", () => {
    const { coordinator } = makeCoordinator();
    const snap = coordinator.query("snapshot");
    assert.equal(snap.runId, "temp-run");
    assert.equal(snap.revision, 1);
    assert.deepEqual(snap.state, { world: {}, characters: {} });
    assert.deepEqual((snap.events as unknown as { id: { value: string } }[]).map((e) => e.id.value), ["events-of-temp-run"]);
    assert.equal(snap.pipeline.phase, "await_player");
    assert.ok(snap.history !== null && typeof snap.history === "object");
    assert.deepEqual(coordinator.query("stats"), []);
  });

  it("query 携带 runId 且 ≠ 当前 → SessionSwitchedError", () => {
    const { coordinator } = makeCoordinator();
    assert.throws(() => coordinator.query("snapshot", "other-run"), SessionSwitchedError);
    assert.equal(coordinator.query("snapshot", "temp-run").runId, "temp-run");
  });
});

describe("SessionCoordinator Transition 投影", () => {
  /** 经 factory create 路径建会话（onCommit 钩子由 wireSession 接线）。 */
  function wiredCoordinator(): { coordinator: SessionCoordinator; session: FakeSession; transitions: SessionTransition[] } {
    const session = new FakeSession("run-a");
    const transitions: SessionTransition[] = [];
    const factory: SessionFactory = {
      create: () => session as never,
      resume: () => session as never,
    };
    const coordinator = new SessionCoordinator(() => ({}) as never, { newRunId: () => "run-a" }, factory);
    coordinator.onTransition = (t) => transitions.push(t);
    return { coordinator, session, transitions };
  }

  it("onCommit → 每次提交一条 Transition（historyPatch 恒 replace，含 pipeline）", async () => {
    const { coordinator, session, transitions } = wiredCoordinator();
    await coordinator.execute({ type: "new_session" });
    session.fireCommit("step");
    assert.equal(transitions.length, 1);
    const t = transitions[0]!;
    assert.equal(t.type, "transition");
    assert.equal(t.runId, "run-a");
    assert.equal(t.fromRevision, 1);
    assert.equal(t.revision, 2);
    assert.equal(t.reason, "step");
    assert.equal(t.changed.historyPatch?.type, "replace");
    assert.equal(t.pipeline.phase, "await_player");
  });

  it("rollback_and_continue 抑制中间提交：只发一条合并 Transition（fromRevision→终 revision）", async () => {
    const { coordinator, session, transitions } = wiredCoordinator();
    await coordinator.execute({ type: "new_session" });
    session.rollbackTo = (seq: number) => { session.calls.push(`rollback:${seq}`); session.fireCommit("rollback"); };
    session.continuePipeline = async () => { session.calls.push("continue"); await Promise.resolve(); session.fireCommit("step"); };
    await coordinator.execute({ type: "rollback_and_continue", targetSeq: 5 });
    assert.equal(transitions.length, 1);
    assert.equal(transitions[0]!.reason, "rollback");
    assert.equal(transitions[0]!.fromRevision, 1);
    assert.equal(transitions[0]!.revision, 3);
  });

  it("旧会话（已切换走）的晚到 onCommit 不广播（代际防御）", async () => {
    const { coordinator, session, transitions } = wiredCoordinator();
    await coordinator.execute({ type: "new_session" });
    (coordinator as unknown as { session: unknown }).session = new FakeSession("run-b"); // 模拟已切换
    session.fireCommit("step"); // 旧会话晚到提交
    assert.equal(transitions.length, 0);
  });
});

describe("SessionCoordinator 会话切换与生命周期（强制切换隔离）", () => {
  /** fake factory：create/resume 各回各的会话，记录装配入参。 */
  function fakeFactory(a: FakeSession, b: FakeSession): { factory: SessionFactory; made: string[] } {
    const made: string[] = [];
    return {
      made,
      factory: {
        create(runId) { made.push(`create:${runId}`); return a as never; },
        resume(runId) { made.push(`resume:${runId}`); return b as never; },
      },
    };
  }

  it("new/load 切换后旧 session 不可达（stop/query 只命中新会话）", async () => {
    const a = new FakeSession("run-a");
    const b = new FakeSession("run-b");
    const { factory, made } = fakeFactory(a, b);
    const coordinator = new SessionCoordinator(() => ({}) as never, { newRunId: () => "run-a" }, factory);

    const runId = await coordinator.execute({ type: "new_session" });
    assert.equal(runId, "run-a");
    assert.equal(coordinator.currentRunId, "run-a");
    assert.deepEqual(made, ["create:run-a"]);

    const loaded = await coordinator.execute({ type: "load_session", runId: "run-b" });
    assert.equal(loaded.runId, "run-b");
    assert.equal(coordinator.currentRunId, "run-b");
    assert.deepEqual((coordinator.query("snapshot").events as unknown as { id: { value: string } }[]).map((e) => e.id.value), ["events-of-run-b"]);
    coordinator.stop();
    assert.equal(a.aborted, 0); // 旧会话不可达
    assert.equal(b.aborted, 1);
  });

  it("new/load 强制切换：在途旧会话入队前即被 dispose（abort + 旗标），epoch 递增", async () => {
    const a = new FakeSession("run-a");
    const b = new FakeSession("run-b");
    const { factory } = fakeFactory(a, b);
    const coordinator = new SessionCoordinator(() => ({}) as never, { newRunId: () => "run-a" }, factory);
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    a.handlePlayerInput = async () => {
      a.calls.push("input:start");
      await gate;
      a.calls.push("input:end");
      return "";
    };
    const epoch0 = coordinator.currentEpoch;
    const pending = coordinator.execute({ type: "player_input", text: "慢" });
    await Promise.resolve(); // 任务在途
    const switching = coordinator.execute({ type: "load_session", runId: "run-b" });
    await Promise.resolve();
    assert.equal(a.disposed, true); // 入队前即 dispose（不等任务开头——串行队列下任务开头旧任务必已完成）
    assert.equal(a.aborted, 1);
    release();
    await pending;
    await switching;
    assert.equal(coordinator.currentRunId, "run-b");
    assert.ok(coordinator.currentEpoch > epoch0); // 代际递增
  });

  it("旧会话不在途：new/load 直接切换（无需 dispose）", async () => {
    const a = new FakeSession("run-a");
    const b = new FakeSession("run-b");
    const { factory } = fakeFactory(a, b);
    const coordinator = new SessionCoordinator(() => ({}) as never, { newRunId: () => "run-a" }, factory);
    (coordinator as unknown as { session: unknown }).session = a;
    await coordinator.execute({ type: "load_session", runId: "run-b" });
    assert.equal(a.disposed, false);
    assert.equal(coordinator.currentRunId, "run-b");
  });

  it("pause_options 记忆：命令下发即时生效，新会话/读档自动套用", async () => {
    const a = new FakeSession("run-a");
    const b = new FakeSession("run-b");
    const { factory } = fakeFactory(a, b);
    const coordinator = new SessionCoordinator(() => ({}) as never, { newRunId: () => "run-a" }, factory);
    (coordinator as unknown as { session: unknown }).session = a;
    const options = { everyStep: true, beforeGm: false, afterGm: true, afterProse: false };
    await coordinator.execute({ type: "pause_options", options } satisfies SessionCommand);
    assert.deepEqual(a.pauseHistory, [options]);
    await coordinator.execute({ type: "load_session", runId: "run-b" });
    assert.deepEqual(b.pauseHistory, [options]); // 切换后自动套用记忆的选项
  });

  it("setPauseOptions camelCase 直收（WS pause_options 入站收敛后蛇形适配已删除）", () => {
    const { coordinator, session } = makeCoordinator();
    const options = { everyStep: false, beforeGm: true, afterGm: false, afterProse: true };
    coordinator.setPauseOptions(options);
    assert.deepEqual(session.pauseHistory, [options]);
  });

  it("stale 标记：markStale 后 needsReset，new_session 后清除", async () => {
    const a = new FakeSession("run-a");
    const { factory } = fakeFactory(a, new FakeSession("run-b"));
    const coordinator = new SessionCoordinator(() => ({}) as never, { newRunId: () => "run-a" }, factory);
    assert.equal(coordinator.needsReset, false); // 无会话
    await coordinator.execute({ type: "new_session" });
    assert.equal(coordinator.needsReset, false);
    coordinator.markStale();
    assert.equal(coordinator.needsReset, true);
    await coordinator.execute({ type: "new_session" });
    assert.equal(coordinator.needsReset, false);
  });

  it("applyResolvedConfig 热更新转发（不入队，同一份 resolved 对象，无会话 no-op）", async () => {
    const { coordinator, session } = makeCoordinator();
    const resolved = { character: {}, gm: {}, prose: {} };
    const settings = { configRevision: 1 };
    coordinator.applyResolvedConfig(resolved as never, settings as never);
    assert.equal(session.reloaded, 1);
    assert.strictEqual(session.appliedConfig?.resolved, resolved); // 同一对象引用转发
    assert.strictEqual(session.appliedConfig?.settings, settings);
    const empty = new SessionCoordinator(() => ({}) as never, { newRunId: () => "x" }, {
      create() { throw new Error("不应建会话"); },
      resume() { throw new Error("不应续档"); },
    });
    empty.applyResolvedConfig(resolved as never, settings as never); // 无会话：no-op，不触发装配
  });
});
