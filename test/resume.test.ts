import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { describe, it } from "node:test";
import { GameSession } from "../src/loop.js";
import { SessionHarness } from "./harness/session.js";

// ---------------------------------------------------------------------------
// GameSession.resume：空目录初始化带版本核心文件；旧结构/混合版本明确拒载。
// 基建 = SessionHarness（临时 runs 根 + fake ChatPort；本文件不建世界，纯续档路径）。
// ---------------------------------------------------------------------------

const h = new SessionHarness("airp-resume-");
// 空目录 resume 回退默认世界集（DEFAULT_WORLD_SET = "baitan"）：harness worldsDir 内需存在
h.setupWorld("baitan", [
  { id: "C0", name: "玩家", timer: 0, isPlayer: true },
  { id: "C1001", name: "甲", timer: 0 },
]);
const options = (runId: string) => h.sessionOptions(runId, { rollDice: () => 10 });

describe("GameSession.resume 新版存档", () => {
  it("空目录初始化所有带 schema_version 的核心文件，随后可纯数据 resume", () => {
    const runId = `test-resume-${process.pid}-new`;
    const dir = path.join(h.runsDir, runId);
    fs.mkdirSync(dir, { recursive: true });
    const createdSession = GameSession.resume(h.configs, runId, undefined, options(runId));
    const resumed = GameSession.resume(h.configs, runId, undefined, options(runId));
    assert.equal(resumed.worldTime, createdSession.worldTime); assert.equal(resumed.turnCount, 0); assert.equal(resumed.getEvents().length, 0);
    for (const file of ["world.json", "events.json", "characters.json", "lore.json", "time.json", "archive.json"]) {
      assert.equal(typeof (JSON.parse(fs.readFileSync(path.join(dir, file), "utf8")) as { schema_version: unknown }).schema_version, "number");
    }
  });
  it("旧结构明确拒绝并提示新建会话/重启服务", () => {
    const runId = `test-resume-${process.pid}-old`;
    const dir = path.join(h.runsDir, runId);
    fs.mkdirSync(dir, { recursive: true });
    // legacy fixture：固定旧结构（无 schema_version），勿随 SAVE_SCHEMA_VERSION 更新
    fs.writeFileSync(path.join(dir, "world.json"), JSON.stringify({ vars: {}, clock: 0, pipeline: {} }));
    assert.throws(() => GameSession.resume(h.configs, runId, undefined, options(runId)), /请新建会话\/重启服务/);
  });
  it("混合版本或核心文件缺失明确拒绝", () => {
    const runId = `test-resume-${process.pid}-mixed`;
    const dir = path.join(h.runsDir, runId);
    fs.mkdirSync(dir, { recursive: true });
    // legacy fixture：固定旧版本号（≠ 当前 SAVE_SCHEMA_VERSION 才触发拒载），勿随 SAVE_SCHEMA_VERSION 更新
    fs.writeFileSync(path.join(dir, "world.json"), JSON.stringify({ schema_version: 3 }));
    assert.throws(() => GameSession.resume(h.configs, runId, undefined, options(runId)), /请新建会话\/重启服务/);
  });
});
