import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { SessionManager } from "../src/server/sessionManager.js";
import { parseClientMessage } from "../src/server/ws-protocol.js";

class FakeSession {
  readonly runId = "temp-run";
  readonly calls: string[] = [];
  setBusy(): void {} // enqueue 包装的 busy 位（直接编辑空闲闸），本测试不观测
  async reroll(seq: number): Promise<void> {
    this.calls.push(`reroll:${seq}:start`);
    await Promise.resolve();
    this.calls.push(`reroll:${seq}:end`);
  }
}

describe("原子 WS reroll", () => {
  it("parseClientMessage 接受单条 reroll 并拒绝非法 seq 类型", () => {
    assert.deepEqual(parseClientMessage('{"type":"reroll","seq":4}'), { type: "reroll", seq: 4 });
    for (const raw of ['{"type":"reroll","seq":"4"}', '{"type":"reroll","seq":1}', '{"type":"reroll","seq":2.5}']) {
      assert.throws(() => parseClientMessage(raw), /无法识别/);
    }
  });

  it("SessionManager.enqueueReroll 在单个串行任务内调用 GameSession.reroll", async () => {
    const manager = new SessionManager(() => ({}) as never);
    const fake = new FakeSession();
    (manager as unknown as { session: FakeSession }).session = fake;
    await manager.enqueueReroll(7);
    assert.deepEqual(fake.calls, ["reroll:7:start", "reroll:7:end"]);
  });

  it("前端重 roll 改为两步（rollback+continue）且仅最新步可见", async () => {
    const fs = await import("node:fs");
    const path = await import("node:path");
    const source = fs.readFileSync(path.join(process.cwd(), "web/pages/play.js"), "utf8");
    assert.match(source, /sendMsg\(\{ type: "rollback", seq: seq - 1 \}\)/);
    assert.match(source, /sendMsg\(\{ type: "continue" \}\)/);
    assert.doesNotMatch(source, /sendMsg\(\{ type: "reroll"/);
    assert.match(source, /when: \(\) => !busy && seq === pipe\.seq/);
  });

  it("server reroll handler 调用原子队列并统一广播 history/turn_done/pipeline", async () => {
    const fs = await import("node:fs");
    const path = await import("node:path");
    const source = fs.readFileSync(path.join(process.cwd(), "src/server/index.ts"), "utf8");
    assert.match(source, /msg\.type === "reroll"[\s\S]*enqueueReroll\(msg\.seq\)[\s\S]*type: "history"[\s\S]*type: "turn_done"[\s\S]*sendPipeline\(\)/);
  });

  it("WS 重连同步 session_started/history/pipeline", async () => {
    const fs = await import("node:fs");
    const path = await import("node:path");
    const source = fs.readFileSync(path.join(process.cwd(), "src/server/index.ts"), "utf8");
    const reconnect = source.slice(source.indexOf("wss.handleUpgrade"), source.indexOf('ws.on("close"'));
    for (const type of ["session_started", "history", "pipeline"]) assert.ok(reconnect.includes(`type: "${type}"`));
  });
});
