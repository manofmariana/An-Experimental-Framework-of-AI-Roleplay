import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, describe, it } from "node:test";
import { LLMClient } from "../src/llm/client.js";
import { GameSession } from "../src/loop.js";
import type { LLMConfig } from "../src/config.js";

// ---------------------------------------------------------------------------
// reloadConfig 链路：LLMClient.updateConfig + GameSession.applyResolvedConfigs
// （reloadConfig() 本身只负责读全局 CONFIG_FILE 后调注入方法，故测注入方法）
// ---------------------------------------------------------------------------

const root = fs.mkdtempSync(path.join(os.tmpdir(), "airp-reload-config-"));
const runsDir = path.join(root, "runs");
const worldsDir = path.join(root, "worlds");

after(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

const cfgA: LLMConfig = { apiKey: "sk-a", baseURL: "http://127.0.0.1:9/a", model: "m-a", jsonMode: false };
const cfgB: LLMConfig = {
  apiKey: "sk-b",
  baseURL: "http://127.0.0.1:9/b",
  model: "m-b",
  jsonMode: true,
  reasoningEffort: "high",
};

function manifest(id: string, isPlayer: boolean) {
  return {
    id,
    name: `角色${id}`,
    gender: "未设定",
    age: "未设定",
    personality: "谨慎。",
    initial_memories: [],
    location: { name: "灯塔", level: 1 },
    tags: [],
    reaction: 5,
    timer: isPlayer ? null : 5,
    group: 0,
    initiative: null,
    channel: null,
    acted: false,
    level: 1,
    isPlayer,
    relations: {},
    vars: {},
  };
}

function setupWorld(worldId: string): void {
  const dir = path.join(worldsDir, worldId);
  fs.mkdirSync(path.join(dir, "characters"), { recursive: true });
  fs.writeFileSync(path.join(dir, "setting.md"), "测试世界设定\n");
  fs.writeFileSync(path.join(dir, "tone-card.md"), "测试基调\n");
  fs.writeFileSync(path.join(dir, "lorebook.json"), "[]\n");
  fs.writeFileSync(
    path.join(dir, "time.json"),
    JSON.stringify({ start: { y: 1, m: 1, d: 1, h: 0, min: 0 }, periods: [{ key: "白天", from: 0, to: 24 }] }),
  );
  fs.writeFileSync(path.join(dir, "player.json"), JSON.stringify(manifest("C0", true)));
  fs.writeFileSync(path.join(dir, "characters", "C1001.json"), JSON.stringify(manifest("C1001", false)));
}

/** 私有字段读取（测试专用收窄，模式同 abort.test.ts）。 */
function priv<T>(obj: unknown, key: string): T {
  return (obj as never as Record<string, T>)[key]!;
}

describe("LLMClient.updateConfig（热更新：原地换配置，abort 语义不动）", () => {
  it("apiKey/baseURL/model/jsonMode/reasoningEffort 全部换到新值", () => {
    const client = new LLMClient(cfgA, `test-update-${process.pid}`);
    assert.equal(priv<LLMConfig>(client, "config").model, "m-a");
    client.updateConfig(cfgB);
    const config = priv<LLMConfig>(client, "config");
    assert.deepEqual(config, cfgB);
    // 底层 OpenAI 实例已重建（baseURL 跟随新配置）
    assert.equal(priv<{ baseURL: string }>(client, "openai").baseURL, "http://127.0.0.1:9/b");
    // abort 语义保持：无在途调用时 no-op，不抛错
    client.abort();
  });
});

describe("GameSession.applyResolvedConfigs（设置页保存即生效的可注入核心）", () => {
  it("三个 LLMClient 换配置；proseWindowTurns / gmIntervalCycles 字段更新", () => {
    setupWorld("w-reload");
    const runId = `test-reload-${process.pid}`;
    const session = GameSession.create(
      { character: cfgA, gm: cfgA, prose: cfgA },
      runId,
      undefined,
      "w-reload",
      {
        baseDir: path.join(runsDir, runId),
        worldsDir,
        proseWindowTurns: 5,
        gmIntervalCycles: 3,
        rollDice: () => 10,
      },
    );
    assert.equal(priv<number>(session, "proseWindowTurns"), 5);
    assert.equal(priv<number>(session, "gmIntervalCycles"), 3);

    session.applyResolvedConfigs(
      { character: cfgB, gm: cfgB, prose: cfgB },
      { proseWindowTurns: 9 },
      7,
    );

    const llms = priv<Record<string, LLMClient>>(session, "llms");
    for (const kind of ["character", "gm", "prose"]) {
      assert.deepEqual(priv<LLMConfig>(llms[kind]!, "config"), cfgB);
    }
    assert.equal(priv<number>(session, "proseWindowTurns"), 9);
    assert.equal(priv<number>(session, "gmIntervalCycles"), 7);
  });
});
