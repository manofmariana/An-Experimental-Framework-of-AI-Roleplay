import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, describe, it } from "node:test";
import { GameSession } from "../src/loop.js";

const cfg = { apiKey: "dummy", baseURL: "http://127.0.0.1:9", model: "m", jsonMode: false };
const configs = { character: cfg, gm: cfg, prose: cfg };
const root = fs.mkdtempSync(path.join(os.tmpdir(), "airp-resume-"));
after(() => fs.rmSync(root, { recursive: true, force: true }));
const options = { rollDice: () => 10, baseDir: root, proseWindowTurns: 5 };

describe("GameSession.resume 新版存档", () => {
  it("空目录初始化所有带 schema_version 的核心文件，随后可纯数据 resume", () => {
    const runId = `test-resume-${process.pid}-new`; const dir = path.join(root, runId); fs.mkdirSync(dir, { recursive: true });
    const isolated = { ...options, baseDir: dir };
    const createdSession = GameSession.resume(configs, runId, undefined, isolated);
    const resumed = GameSession.resume(configs, runId, undefined, isolated);
    assert.equal(resumed.worldTime, createdSession.worldTime); assert.equal(resumed.turnCount, 0); assert.equal(resumed.getEvents().length, 0);
    for (const file of ["world.json", "events.json", "characters.json", "lore.json", "time.json", "archive.json"]) {
      assert.equal(typeof (JSON.parse(fs.readFileSync(path.join(dir, file), "utf8")) as { schema_version: unknown }).schema_version, "number");
    }
  });
  it("旧结构明确拒绝并提示新建会话/重启服务", () => {
    const runId = `test-resume-${process.pid}-old`; const dir = path.join(root, runId); fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "world.json"), JSON.stringify({ vars: {}, clock: 0, pipeline: {} }));
    assert.throws(() => GameSession.resume(configs, runId, undefined, { ...options, baseDir: dir }), /请新建会话\/重启服务/);
  });
  it("混合版本或核心文件缺失明确拒绝", () => {
    const runId = `test-resume-${process.pid}-mixed`; const dir = path.join(root, runId); fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "world.json"), JSON.stringify({ schema_version: 3 }));
    assert.throws(() => GameSession.resume(configs, runId, undefined, { ...options, baseDir: dir }), /请新建会话\/重启服务/);
  });
});
