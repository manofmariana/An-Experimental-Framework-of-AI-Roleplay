import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { describe, it } from "node:test";
import { CharacterManifestSchema, type CharacterManifest } from "../src/agents/character.js";
import { PROSE_PLACEHOLDERS, type ProseContext } from "../src/agents/prose.js";
import { compilePrompt, type PlaceholderRegistry } from "../src/compile/compiler.js";
import type { PromptTemplate } from "../src/compile/template.js";
// M2-b 批次 A：loop.ts 待批次 B 重写（simulator 已无 deriveGroups 导出，运行期无法链接），
// 仅「六核心文件」套件跳过并走运行期占位；批次 B 恢复静态 import。
import { readRecent, recordRecent } from "../src/llm/recent.js";
import { GameSession } from "../src/loop.js";
import { reconcileGroups } from "../src/scheduler/simulator.js";
import { CharactersFileSchema, CharactersStore } from "../src/truth/charactersStore.js";
import { LoreStore, rollbackLore, type LoreFile } from "../src/truth/loreStore.js";
import { SAVE_SCHEMA_VERSION } from "../src/truth/saveSchema.js";
import { WorldStore } from "../src/truth/worldStore.js";
import { DecisionPackageSchema, SpanSchema, type LoreEntry } from "../src/types.js";
import { tempDir } from "./harness/tempDir.js";


const start = { y: 1, m: 1, d: 1, h: 0, min: 0 };
const entry = (id: string, content = id): LoreEntry => ({ id, tags: [], content });
const manifest = (id: string, isPlayer = false, timer: number | null = 0): CharacterManifest => ({
  id,
  name: id,
  gender: "未设定",
  age: "未设定",
  personality: "谨慎。",
  tags: [],
  reaction: 0,
  location: { name: "测试地", level: 1 },
  timer,
  group: 0,
  initiative: null,
  channel: null,
  acted: false,
  level: 1,
  isPlayer,
  relations: {},
  initial_memories: [],
  vars: {},
});

function temp(prefix: string): string {
  return tempDir(prefix);
}

function decision(relations: unknown) {
  return { action: "观察", inner: "谨慎确认", relations };
}

describe("WorldStore 原子性与回滚路径契约", () => {
  it("批量 delta 中途失败时内存与磁盘均保持原状", () => {
    const dir = temp("airp-audit-world-");
    const store = new WorldStore("t", { world: { time: start, hp: 10, blocked: 1 } }, dir);
    const before = fs.readFileSync(path.join(dir, "world.json"), "utf8");
    assert.throws(() => store.apply([
      { path: "hp", op: "-=", value: 2 },
      { path: "blocked.value", op: "=", value: 3 },
    ]), /穿过非对象节点/);
    assert.equal(store.world.hp, 10);
    assert.equal(fs.readFileSync(path.join(dir, "world.json"), "utf8"), before);
  });

  it("setClock 拒绝 NaN、Infinity 与小数分钟且不改时钟", () => {
    const dir = temp("airp-audit-clock-");
    const store = new WorldStore("t", { world: { time: start } }, dir);
    for (const value of [Number.NaN, Number.POSITIVE_INFINITY, 1.5]) {
      assert.throws(() => store.setClock(value), /有限整数分钟/);
    }
    assert.equal(store.clock, 0);
  });

  it("同一路径连续 delta 生成逐步 before 并可倒序恢复", () => {
    const dir = temp("airp-audit-revert-");
    const store = new WorldStore("t", { world: { time: start, hp: 10 } }, dir);
    const changes = store.apply([
      { path: "hp", op: "-=", value: 2 },
      { path: "hp", op: "+=", value: 5 },
    ]);
    assert.deepEqual(changes.map((change) => [change.before, change.after]), [[10, 8], [8, 13]]);
    for (const change of [...changes].reverse()) store.revertChange(change);
    assert.equal(store.world.hp, 10);
  });

  it("WorldStore 只接受精确 world. 前缀的回滚路径", () => {
    const dir = temp("airp-audit-path-");
    const store = new WorldStore("t", { world: { time: start } }, dir);
    assert.throws(() => store.revertChange({ path: "worldly.hp", before: 1, after: 2 }), /无法反向的路径/);
  });
});

describe("Lore 顺序保持与 v3 changelog 兼容", () => {
  it("update 应用和回滚都保持条目原顺序", () => {
    const file: LoreFile = {
      schema_version: SAVE_SCHEMA_VERSION,
      entries: [entry("a"), entry("b", "new"), entry("c")],
      changelog: [{ seq: 2, op: "update", before: entry("b", "old"), after: entry("b", "new"), before_index: 1 }],
    };
    assert.deepEqual(rollbackLore(file, 1).entries, [entry("a"), entry("b", "old"), entry("c")]);
  });

  it("delete 回滚按 before_index 恢复条目原位置", () => {
    const file: LoreFile = {
      schema_version: SAVE_SCHEMA_VERSION,
      entries: [entry("a"), entry("c")],
      changelog: [{ seq: 2, op: "delete", before: entry("b"), after: null, before_index: 1 }],
    };
    assert.deepEqual(rollbackLore(file, 1).entries.map((item) => item.id), ["a", "b", "c"]);
  });

  it("既有 v3 changelog 缺 before_index 仍可加载并回滚", () => {
    const dir = temp("airp-audit-lore-v3-");
    fs.writeFileSync(path.join(dir, "lore.json"), JSON.stringify({
      schema_version: SAVE_SCHEMA_VERSION,
      entries: [entry("b", "new")],
      changelog: [{ seq: 2, op: "update", before: entry("b", "old"), after: entry("b", "new") }],
    }));
    const store = LoreStore.load("t", dir);
    store.rollbackToSeq(1);
    assert.equal(store.book().all()[0]!.content, "old");
  });
});

describe("整数分钟与 simulator 分桶契约", () => {
  it("SpanSchema 拒绝小数与非有限分量", () => {
    for (const span of [{ min: 0.5 }, { h: Number.NaN }, { d: Number.POSITIVE_INFINITY }]) {
      assert.throws(() => SpanSchema.parse(span));
    }
  });

  it("角色 manifest 与存档状态都拒绝非整数绝对 timer", () => {
    assert.throws(() => CharacterManifestSchema.parse({ ...manifest("C1001"), timer: 1.5 }));
    const state = {
      name: "甲", gender: "", age: "", personality: "谨慎", tags: [], reaction: 0,
      location: { name: "测试地", level: 1 }, timer: 1.5, group: 0,
      initiative: null, channel: null, acted: false, level: 1, isPlayer: false, relations: {}, long_term_memory: [], vars: {},
    };
    assert.throws(() => CharactersFileSchema.parse({ schema_version: SAVE_SCHEMA_VERSION, characters: { C1001: state } }));
  });

  it("location 与 timer 的旧字符串拼接碰撞不再合并分桶", () => {
    const result = reconcileGroups({
      C1001: { location: { name: "a1" }, timer: 2 },
      C1002: { location: { name: "a" }, timer: 12 },
    }, { C1001: 0, C1002: 0 });
    assert.deepEqual(result.group, { C1001: 0, C1002: 0 });
  });
});

describe("Recent upsert 与按需提示词 provider", () => {
  it("recordRecent 对同 seq 原位更新且不产生重复项", () => {
    const dir = temp("airp-audit-recent-");
    recordRecent("t", "gm", { seq: 4, messages: ["old"], reasoning: "old" }, dir);
    recordRecent("t", "gm", { seq: 4, messages: ["new"], reasoning: "new" }, dir);
    assert.deepEqual(readRecent("t", "gm", dir), [{ seq: 4, messages: ["new"], reasoning: "new" }]);
  });

  it("prose 的空动态 provider 返回纯数据空串", () => {
    const context: ProseContext = {
      toneCard: "", worldLore: "", recentEvents: [], cast: [], triggeredLore: "",
      lastProse: "", gmEvent: "", currentScene: "",
    };
    assert.equal(PROSE_PLACEHOLDERS.recent_events!.provide(context), "");
    assert.equal(PROSE_PLACEHOLDERS.triggered_lore!.provide(context), "");
  });

  it("compilePrompt 只执行模板实际引用的 provider", () => {
    let unusedCalls = 0;
    const registry: PlaceholderRegistry<{}> = {
      used: { description: "used", provide: () => "ok" },
      unused: { description: "unused", provide: () => { unusedCalls += 1; throw new Error("不应执行"); } },
    };
    const template: PromptTemplate = { id: "audit", modules: [{ key: "m", role: "system", content: "{{used}}" }] };
    assert.deepEqual(compilePrompt(template, registry, {}), [{ role: "system", content: "ok" }]);
    assert.equal(unusedCalls, 0);
  });
});

describe("Decision relations 与 CharactersStore 初始化不变量", () => {
  it("relations target 只接受可选 @ 前缀的严格 CID", () => {
    for (const target of ["C", "C-1", "C01", "player", "@C1x"]) {
      assert.throws(() => DecisionPackageSchema.parse(decision([{ target, name: "甲" }])));
    }
    assert.equal(DecisionPackageSchema.parse(decision([{ target: "@C1001", name: "甲" }])).relations![0]!.target, "@C1001");
  });

  it("relation 必须至少提供非空 name 或 impression", () => {
    for (const relation of [{ target: "C0" }, { target: "C0", name: "" }, { target: "C0", impression: "" }]) {
      assert.throws(() => DecisionPackageSchema.parse(decision([relation])));
    }
  });

  it("CharactersStore.initFrom 拒绝重复角色 ID", () => {
    const dir = temp("airp-audit-chars-dup-");
    assert.throws(() => CharactersStore.initFrom("t", [manifest("C1001"), manifest("C1001")], 0, dir), /重复角色 CID/);
  });

  it("CharactersStore.initFrom 强制 C0 与 isPlayer 双向一致", () => {
    assert.throws(() => CharactersStore.initFrom("t", [manifest("C0", false)], 0, temp("airp-audit-player-c0-")), /必须标记为玩家/);
    assert.throws(() => CharactersStore.initFrom("t", [manifest("C1001", true)], 0, temp("airp-audit-player-npc-")), /只有 C0/);
  });
});

describe("六核心文件 schema_version 一致性", () => {
  const cfg = { apiKey: "dummy", baseURL: "http://127.0.0.1:9", model: "m", jsonMode: false };
  const configs = { character: cfg, gm: cfg, prose: cfg };
  const coreFiles = ["world.json", "events.json", "characters.json", "lore.json", "time.json", "archive.json"];

  function initializedDir(): string {
    const dir = temp("airp-audit-core-");
    GameSession.resume(configs, "audit", undefined, { baseDir: dir, proseWindowTurns: 5, rollDice: () => 10 });
    return dir;
  }

  it("六个核心文件任一版本混入均明确拒绝", () => {
    for (const file of coreFiles) {
      const dir = initializedDir();
      const filePath = path.join(dir, file);
      const data = JSON.parse(fs.readFileSync(filePath, "utf8")) as { schema_version: number };
      fs.writeFileSync(filePath, JSON.stringify({ ...data, schema_version: SAVE_SCHEMA_VERSION - 1 }));
      assert.throws(() => GameSession.resume(configs, "audit", undefined, { baseDir: dir, proseWindowTurns: 5 }), /核心文件版本混合/);
    }
  });

  it("六核心文件存在但缺少其中一个时明确拒绝", () => {
    const dir = initializedDir();
    fs.rmSync(path.join(dir, "archive.json"));
    assert.throws(() => GameSession.resume(configs, "audit", undefined, { baseDir: dir, proseWindowTurns: 5 }), /核心文件版本混合/);
  });

  it("六核心文件版本一致时可纯数据续档", () => {
    const dir = initializedDir();
    const resumed = GameSession.resume(configs, "audit", undefined, { baseDir: dir, proseWindowTurns: 5, rollDice: () => 10 });
    assert.equal(resumed.turnCount, 0);
    assert.equal(resumed.getEvents().length, 0);
  });
});
