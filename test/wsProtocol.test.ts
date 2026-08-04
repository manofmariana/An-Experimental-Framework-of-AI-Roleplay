/**
 * WS 消息身份 + Snapshot/Transition 集成测试（integration 层，优化阶段 D2，
 * docs/optimization-review.md §5 验收条件）：真实 http/ws 服务 + 双真实 ws 客户端 +
 * DeferredChatPort（挂起/abort 可控），不再依赖源码正则断言。
 *
 * 场景：双客户端并发 mutation 的 REVISION_CONFLICT 与同一 transition 收敛；
 * 延迟 LLM 期间强制切换会话（旧 run 无提交、无旧 runId 广播）；rollback_and_continue
 * 只发一条合并 transition；LLM 挂起中双客户端一致 snapshot query；stop 幂等与
 * activationId 定向中止；流式消息的 runId/activationId 身份。
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { describe, it } from "node:test";
import { textResult } from "./fakes/deferredChatPort.js";
import { serverHarness, type ServerHarness, type WsClient } from "./harness/server.js";

/** 角色决策包的自动应答（inner 必填，action/dialogue 至少其一）。 */
const AUTO_DECISION = JSON.stringify({ inner: "观察四周", action: "环顾", dialogue: "……" });

function enableAuto(h: ServerHarness): void {
  h.deferred.auto = (req) =>
    textResult(req.agent === "prose" ? "正文。" : req.agent === "gm" ? "{}" : AUTO_DECISION);
}

/** 发命令（自动带 requestId；身份字段按调用方显式给出——测试要精确控制 baseRevision）。 */
let reqCounter = 0;
function sendCmd(client: WsClient, cmd: Record<string, unknown>): string {
  const requestId = `req-${++reqCounter}`;
  client.send({ requestId, ...cmd });
  return requestId;
}

function waitReply(client: WsClient, requestId: string): Promise<Record<string, unknown>> {
  return client.waitFor(
    (m) => (m.type === "command_result" || m.type === "command_error") && m.requestId === requestId,
  );
}

function transitionsOf(client: WsClient): Record<string, unknown>[] {
  return client.messages.filter((m) => m.type === "transition");
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

describe("WS 消息身份与增量同步（D2）", () => {
  it("双客户端同时提交 mutation：陈旧 baseRevision 稳定 REVISION_CONFLICT，双方收同一 transition", async (t) => {
    const h = await serverHarness(t, { dice: [20, 1] });
    enableAuto(h);
    const a = await h.connect();
    const b = await h.connect();

    const newReq = sendCmd(a, { type: "new_session" });
    const snap = await a.waitFor((m) => m.type === "snapshot");
    await b.waitFor((m) => m.type === "snapshot");
    await waitReply(a, newReq);
    const runId = snap.runId as string;
    assert.equal(snap.revision, 1);

    // 每轮暂停：player_input 提交后停，不产生预期外 LLM 调用
    sendCmd(a, { type: "pause_options", options: { everyStep: true, beforeGm: false, afterGm: false, afterProse: false } });
    const inputReq = sendCmd(a, { type: "player_input", text: "我推开门。", runId, baseRevision: 1 });
    const inputReply = await waitReply(a, inputReq);
    assert.equal(inputReply.type, "command_result");
    assert.equal(inputReply.revision, 2);
    const tA = await a.waitFor((m) => m.type === "transition" && m.revision === 2);
    const tB = await b.waitFor((m) => m.type === "transition" && m.revision === 2);
    assert.deepEqual(tA, tB); // 双方收同一 transition

    // 双客户端并发 continue（同 baseRevision=2）：先者成功，后者稳定 REVISION_CONFLICT
    const reqA = sendCmd(a, { type: "continue", runId, baseRevision: 2 });
    const reqB = sendCmd(b, { type: "continue", runId, baseRevision: 2 });
    const [replyA, replyB] = await Promise.all([waitReply(a, reqA), waitReply(b, reqB)]);
    const results = [replyA, replyB];
    const ok = results.filter((m) => m.type === "command_result");
    const conflict = results.filter((m) => m.type === "command_error" && m.code === "REVISION_CONFLICT");
    assert.equal(ok.length, 1);
    assert.equal(ok[0]!.revision, 3);
    assert.equal(conflict.length, 1);
    assert.deepEqual(conflict[0]!.details, { baseRevision: 2, currentRevision: 3 });
    // 双方只见一条 rev 2→3 transition（胜者的提交）
    for (const c of [a, b]) {
      const list = transitionsOf(c).filter((m) => (m.revision as number) >= 3);
      assert.equal(list.length, 1);
      assert.equal(list[0]!.fromRevision, 2);
      assert.equal(list[0]!.revision, 3);
    }
  });

  it("延迟 LLM 期间 new_session 强制切换：旧 run 无提交、无旧 runId 广播、发起方收 SESSION_SWITCHED", async (t) => {
    const h = await serverHarness(t, { dice: [20, 1, 20, 1] }); // 两次建会话各投一组先攻
    const a = await h.connect();
    const b = await h.connect();
    sendCmd(a, { type: "new_session" });
    const snap1 = await a.waitFor((m) => m.type === "snapshot");
    const oldRun = snap1.runId as string;
    await b.waitFor((m) => m.type === "snapshot" && m.runId === oldRun);

    // 挂起模式：player 步提交后角色步 LLM 挂起
    const inputReq = sendCmd(a, { type: "player_input", text: "我推开门。", runId: oldRun, baseRevision: 1 });
    const start = await a.waitFor((m) => m.type === "agent_start" && m.runId === oldRun);
    assert.equal(start.activationId, `${oldRun}:act:1`);
    await b.waitFor((m) => m.type === "agent_start" && m.runId === oldRun);
    assert.equal(h.deferred.pendingCount, 1);

    // B 强制切换：dispose 旧会话（abort 在途 LLM；commit 闸拒绝晚到提交）
    const switchReq = sendCmd(b, { type: "new_session" });
    const snap2 = await b.waitFor((m) => m.type === "snapshot" && m.runId !== oldRun);
    const newRun = snap2.runId as string;
    await a.waitFor((m) => m.type === "snapshot" && m.runId === newRun);
    const switchReply = await waitReply(b, switchReq);
    assert.equal(switchReply.type, "command_result");

    // 旧任务（A 的 player_input）失败：SESSION_SWITCHED
    const inputReply = await waitReply(a, inputReq);
    assert.equal(inputReply.type, "command_error");
    assert.equal(inputReply.code, "SESSION_SWITCHED");

    await sleep(200); // 给晚到消息留出到达窗口
    // 旧 run 无任何晚到提交：磁盘 CURRENT 停在 player 步（init=1 + player=2）
    const current = fs.readFileSync(path.join(h.sessions.runsDir, oldRun, "CURRENT"), "utf8").trim();
    assert.equal(current, "000002");
    // 双客户端：切换快照之后无任何旧 runId 消息（含流式收尾）
    for (const c of [a, b]) {
      const idx = c.messages.findIndex((m) => m.type === "snapshot" && m.runId === newRun);
      assert.ok(idx >= 0);
      const late = c.messages.slice(idx + 1).filter((m) => m.runId === oldRun);
      assert.deepEqual(late, []);
    }
    // 旧 run 的 transition 只有 player 步那一条（rev 2）；rev>2 的旧 run transition 不存在
    assert.deepEqual(transitionsOf(a).filter((m) => m.runId === oldRun).map((m) => m.revision), [2]);
  });

  it("rollback_and_continue：双客户端只见一条合并 transition（fromRevision→终 revision）", async (t) => {
    const h = await serverHarness(t, { dice: [20, 1] });
    enableAuto(h);
    const a = await h.connect();
    const b = await h.connect();
    sendCmd(a, { type: "new_session" });
    const snap = await a.waitFor((m) => m.type === "snapshot");
    const runId = snap.runId as string;
    await b.waitFor((m) => m.type === "snapshot");
    sendCmd(a, { type: "pause_options", options: { everyStep: true, beforeGm: false, afterGm: false, afterProse: false } });

    const r1 = sendCmd(a, { type: "player_input", text: "第一步。", runId, baseRevision: 1 });
    await waitReply(a, r1); // rev 2（player 步，seq 1）
    const r2 = sendCmd(a, { type: "continue", runId, baseRevision: 2 });
    await waitReply(a, r2); // rev 3（角色步，seq 2）

    const rac = sendCmd(a, { type: "rollback_and_continue", targetSeq: 2, runId, baseRevision: 3 });
    const reply = await waitReply(a, rac);
    assert.equal(reply.type, "command_result");
    assert.equal(reply.revision, 5); // rollback(3→4) + 续跑角色步(4→5)
    for (const c of [a, b]) {
      await c.waitFor((m) => m.type === "transition" && m.revision === 5);
      const merged = transitionsOf(c).filter((m) => (m.revision as number) >= 4);
      assert.equal(merged.length, 1); // 中间 rollback transition 被抑制
      assert.equal(merged[0]!.fromRevision, 3);
      assert.equal(merged[0]!.revision, 5);
      assert.equal(merged[0]!.reason, "rollback");
      assert.equal((merged[0]!.pipeline as { phase: string }).phase, "await_player");
    }
  });

  it("LLM 挂起中双客户端各 query snapshot：单 revision 内部一致", async (t) => {
    const h = await serverHarness(t, { dice: [20, 1] });
    const a = await h.connect();
    const b = await h.connect();
    sendCmd(a, { type: "new_session" });
    const snap = await a.waitFor((m) => m.type === "snapshot");
    const runId = snap.runId as string;
    await b.waitFor((m) => m.type === "snapshot");

    // 挂起在角色步（player 步已提交 rev 2）
    const inputReq = sendCmd(a, { type: "player_input", text: "我推开门。", runId, baseRevision: 1 });
    await a.waitFor((m) => m.type === "agent_start");
    assert.equal(h.deferred.pendingCount, 1);

    const qA = sendCmd(a, { type: "query", query: "snapshot", runId });
    const qB = sendCmd(b, { type: "query", query: "snapshot", runId });
    const [snapA, snapB] = await Promise.all([
      a.waitFor((m) => m.type === "snapshot" && m.requestId === qA),
      b.waitFor((m) => m.type === "snapshot" && m.requestId === qB),
    ]);
    assert.equal(snapA.revision, 2);
    assert.equal(snapA.runId, runId);
    assert.equal((snapA.pipeline as { phase: string }).phase, "await_character");
    const { requestId: _a, ...restA } = snapA;
    const { requestId: _b, ...restB } = snapB;
    assert.deepEqual(restA, restB); // 两客户端一致
    assert.ok(Array.isArray(snapA.events) && typeof snapA.state === "object");

    // 收尾：放行挂起的 LLM，避免遗留任务影响其他用例
    enableAuto(h);
    h.deferred.resolveNext(textResult(AUTO_DECISION));
    await waitReply(a, inputReq);
  });

  it("stop 幂等与 activationId 定向中止：错误 activationId 空成功不动当前；正确者中止并冻结", async (t) => {
    const h = await serverHarness(t, { dice: [20, 1] });
    const a = await h.connect();
    const b = await h.connect();
    sendCmd(a, { type: "new_session" });
    const snap = await a.waitFor((m) => m.type === "snapshot");
    const runId = snap.runId as string;
    await b.waitFor((m) => m.type === "snapshot");

    const inputReq = sendCmd(a, { type: "player_input", text: "我推开门。", runId, baseRevision: 1 });
    const start = await a.waitFor((m) => m.type === "agent_start" && m.runId === runId);
    const activationId = start.activationId as string;
    assert.ok(activationId.length > 0);
    assert.equal(h.deferred.pendingCount, 1);

    // 错误 activationId：幂等空成功，当前 activation 不受影响
    const wrongStop = sendCmd(b, { type: "stop", runId, activationId: `${runId}:act:999` });
    const wrongReply = await waitReply(b, wrongStop);
    assert.equal(wrongReply.type, "command_result");
    await sleep(200);
    assert.equal(h.deferred.pendingCount, 1); // 未中止
    assert.equal(b.messages.filter((m) => m.type === "agent_end").length, 0);

    // 错误 runId：SESSION_SWITCHED
    const wrongRun = sendCmd(b, { type: "stop", runId: "run-9999", activationId });
    const wrongRunReply = await waitReply(b, wrongRun);
    assert.equal(wrongRunReply.type, "command_error");
    assert.equal(wrongRunReply.code, "SESSION_SWITCHED");

    // 正确 activationId：中止 → interrupted 提交（transition）+ agent_end + A 的命令完成
    const stopReq = sendCmd(b, { type: "stop", runId, activationId });
    const stopReply = await waitReply(b, stopReq);
    assert.equal(stopReply.type, "command_result");
    const end = await a.waitFor((m) => m.type === "agent_end" && m.activationId === activationId);
    assert.equal(end.runId, runId);
    const frozen = await a.waitFor((m) => m.type === "transition" && m.revision === 3);
    assert.equal((frozen.pipeline as { interrupted: boolean }).interrupted, true);
    const inputReply = await waitReply(a, inputReq);
    assert.equal(inputReply.type, "command_result");
    assert.equal(h.deferred.pendingCount, 0);

    await sleep(200);
    // 旧 activationId 的流式消息不再到达（agent_end 是最后一条）
    const afterEnd = a.messages.slice(a.messages.indexOf(end) + 1);
    assert.deepEqual(afterEnd.filter((m) => m.activationId === activationId), []);
    // 流式消息身份形状：全部带 runId + 非空 activationId
    const streaming = a.messages.filter((m) =>
      ["agent_start", "delta", "reasoning", "agent_end", "retry", "decision", "adjudication"].includes(m.type as string),
    );
    assert.ok(streaming.length >= 2);
    for (const m of streaming) {
      assert.equal(m.runId, runId);
      assert.ok(typeof m.activationId === "string" && m.activationId.length > 0);
    }
  });
});
