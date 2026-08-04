import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { SessionCoordinator } from "../src/application/sessionCoordinator.js";
import { parseClientCommand, ProtocolError } from "../src/contracts/protocol.js";
import { serverHarness } from "./harness/server.js";

/**
 * 原子重 roll = rollback_and_continue 单条复合命令：
 * 协议权威 = contracts/protocol.ts。
 * server 侧语义 = SessionCoordinator 的 rollback_and_continue 复合命令——
 * 回滚与续跑同处一个队列任务，两步间不接受其他命令。
 * 领域行为（串行不交错/复合命令不可插队）的系统断言见 test/sessionCoordinator.test.ts。
 */

/** 记录调用序的 fake 会话（rollbackTo/continuePipeline 各记一笔，续跑跨 await 以暴露插队）。 */
class FakeSession {
  readonly runId = "temp-run";
  readonly calls: string[] = [];
  readonly revision = 1;
  setBusy(): void {} // runOnSession 包装的 busy 位（直接编辑空闲闸），本测试不观测
  rollbackTo(seq: number): void {
    this.calls.push(`rollback:${seq}`);
  }
  async continuePipeline(): Promise<void> {
    this.calls.push("continue:start");
    await Promise.resolve();
    this.calls.push("continue:end");
  }
  getEvents(): unknown[] { return []; }
  getArchive(): unknown[] { return []; }
  getPipelineCurrent(): null { return null; }
}

function coordinatorWith(session: FakeSession): SessionCoordinator {
  const coordinator = new SessionCoordinator(() => ({}) as never);
  (coordinator as unknown as { session: unknown }).session = session;
  return coordinator;
}

describe("原子重 roll = rollback_and_continue 单命令", () => {
  it("parseClientCommand 接受 rollback_and_continue 并拒绝非法 targetSeq（含旧 reroll 消息）", () => {
    assert.deepEqual(parseClientCommand('{"type":"rollback_and_continue","targetSeq":4}'), {
      type: "rollback_and_continue",
      targetSeq: 4,
    });
    for (const raw of [
      '{"type":"rollback_and_continue","targetSeq":"4"}',
      '{"type":"rollback_and_continue","targetSeq":1}',
      '{"type":"rollback_and_continue","targetSeq":2.5}',
      '{"type":"reroll","seq":4}', // 旧消息名：不留兼容映射
    ]) {
      assert.throws(() => parseClientCommand(raw), ProtocolError);
    }
  });

  it("rollback_and_continue 在单个串行任务内 rollback(targetSeq-1) 后续跑", async () => {
    const fake = new FakeSession();
    const coordinator = coordinatorWith(fake);
    await coordinator.execute({ type: "rollback_and_continue", targetSeq: 7 });
    assert.deepEqual(fake.calls, ["rollback:6", "continue:start", "continue:end"]);
  });

  it("rollback_and_continue 拒绝 targetSeq ≤ 1（与旧 reroll 同口径）", async () => {
    const fake = new FakeSession();
    const coordinator = coordinatorWith(fake);
    await assert.rejects(
      coordinator.execute({ type: "rollback_and_continue", targetSeq: 1 }),
      /无效的重 roll 轮次/,
    );
    assert.deepEqual(fake.calls, []);
  });

  it("前端重 roll 为单条 rollback_and_continue（两步 rollback+continue 已删除）", async () => {
    const fs = await import("node:fs");
    const path = await import("node:path");
    const source = fs.readFileSync(path.join(process.cwd(), "web/views/play-stream.js"), "utf8");
    assert.match(source, /sendCmd\("rollback_and_continue", \{ targetSeq: seq \}\)/);
    assert.doesNotMatch(source, /sendCmd\("rollback", \{ targetSeq: seq - 1 \}\)/);
    assert.doesNotMatch(source, /"reroll"/);
    assert.match(source, /when: \(\) => getState\(\)\.streaming === null && seq === getState\(\)\.pipeline\.seq/);
  });

  it("WS 重连同步 = 单条一致 snapshot 单播（真实连接；D3 取代源码切片断言）", async (t) => {
    const h = await serverHarness(t);
    const a = await h.connect();
    a.send({ type: "new_session", worldSetId: "w", requestId: "r-new" });
    const snap = await a.waitFor((m) => m.type === "snapshot");

    // 重连：会话活跃时新客户端接入 → 恰收一条 snapshot（旧散装五条已删）
    const b = await h.connect();
    await b.waitFor((m) => m.type === "snapshot");
    await new Promise((resolve) => setTimeout(resolve, 200));
    const snapshots = b.messages.filter((m) => m.type === "snapshot");
    assert.equal(snapshots.length, 1, "重连应恰收一条 snapshot");
    assert.equal(snapshots[0]!.runId, snap.runId);
    assert.deepEqual(
      b.messages.filter((m) => m.type !== "snapshot"),
      [],
      "重连不应收到 snapshot 以外的消息",
    );
    a.close();
    b.close();
  });
});
