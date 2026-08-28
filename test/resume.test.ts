import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { describe, it } from "node:test";
import { resumeGameSession } from "../src/application/sessionFactory.js";
import type { GameSession } from "../src/application/gameSession.js";
import { SaveLoadError } from "../src/truth/validation/errors.js";
import { SessionHarness } from "./harness/session.js";

// ---------------------------------------------------------------------------
// resumeGameSession：空目录初始化带版本核心文件；旧结构/混合版本明确拒载。
// 基建 = SessionHarness（临时 save 根 + fake ChatPort；本文件不建世界，纯续档路径）。
// ---------------------------------------------------------------------------

const h = new SessionHarness("airp-resume-");
// 空目录 resume 回退默认世界集（DEFAULT_WORLD_SET = "baitan"）：harness assetsDir 内需存在
h.setupWorld("baitan", [
  { id: "C0", name: "玩家", timer: 0, isPlayer: true },
  { id: "C1001", name: "甲", timer: 0 },
]);
const options = (runId: string) => h.sessionOptions(runId, { rollDice: () => 10 });

describe("resumeGameSession 新版存档", () => {
  it("空目录初始化 Generation 布局（CURRENT + generations/000001/ 七文件），随后可纯数据 resume", () => {
    const runId = `test-resume-${process.pid}-new`;
    const dir = path.join(h.saveDir, runId);
    fs.mkdirSync(dir, { recursive: true });
    const createdSession = resumeGameSession(h.configs, runId, undefined, options(runId));
    const resumed = resumeGameSession(h.configs, runId, undefined, options(runId));
    assert.equal(resumed.worldTime, createdSession.worldTime); assert.equal(resumed.turnCount, 0); assert.equal(resumed.getEvents().length, 0);
    assert.equal(fs.readFileSync(path.join(dir, "CURRENT"), "utf8"), "000001");
    for (const file of ["world.json", "events.json", "characters.json", "lores.json", "archive.json", "sys.json", "prompts.json"]) {
      const data = JSON.parse(h.readGenerationFile(runId, "current", file)) as { schema_version?: unknown };
      // schema_version 单点化：只有 sys.json 盖章
      if (file === "sys.json") assert.equal(typeof data.schema_version, "number");
      else assert.equal(data.schema_version, undefined, `${file} 不再盖章`);
    }
  });
  it("旧结构明确拒绝并提示新建会话/重启服务", () => {
    const runId = `test-resume-${process.pid}-old`;
    const dir = path.join(h.saveDir, runId);
    fs.mkdirSync(dir, { recursive: true });
    // legacy fixture：固定旧结构（平铺、无 schema_version、无 CURRENT），勿随存档版本更新
    fs.writeFileSync(path.join(dir, "world.json"), JSON.stringify({ vars: {}, clock: 0, pipeline: {} }));
    // version 类（旧平铺档）：措辞保留"请新建会话/重启服务"
    assert.throws(
      () => resumeGameSession(h.configs, runId, undefined, options(runId)),
      (error: unknown) =>
        error instanceof SaveLoadError && error.kind === "version" && /请新建会话\/重启服务/.test(error.message),
    );
  });
  it("混合版本或核心文件缺失明确拒绝", () => {
    const runId = `test-resume-${process.pid}-mixed`;
    const dir = path.join(h.saveDir, runId);
    fs.mkdirSync(dir, { recursive: true });
    // legacy fixture：固定旧版本号平铺文件（≠ 当前 SAVE_SCHEMA_VERSION 才触发拒载），勿随存档版本更新
    fs.writeFileSync(path.join(dir, "world.json"), JSON.stringify({ schema_version: 3 }));
    assert.throws(
      () => resumeGameSession(h.configs, runId, undefined, options(runId)),
      (error: unknown) =>
        error instanceof SaveLoadError && error.kind === "version" && /请新建会话\/重启服务/.test(error.message),
    );
  });
});
