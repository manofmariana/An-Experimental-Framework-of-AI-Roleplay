import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { describe, it } from "node:test";
import { CharacterManifestSchema, type CharacterManifest } from "../src/agents/character.js";
import { parsePlaceholders } from "../src/compile/placeholders.js";
import { renderPrompt, type RenderHost } from "../src/compile/render.js";
import { readRecent, recordRecent } from "../src/llm/recent.js";
import { resumeGameSession } from "../src/application/sessionFactory.js";
import { reconcileGroups } from "../src/scheduler/simulator.js";
import { CharactersFileSchema, CharactersStore } from "../src/truth/charactersStore.js";
import { LoreFileSchema, LoreStore, rollbackLore, type LoreFile } from "../src/truth/loreStore.js";
import { SAVE_SCHEMA_VERSION } from "../src/truth/saveSchema.js";
import { SaveLoadError, type SaveLoadErrorKind } from "../src/truth/validation/errors.js";
import { WorldStore } from "../src/truth/worldStore.js";
import { DecisionPackageSchema, SpanSchema, type LoreEntry } from "../src/types.js";
import {
  buildCharacterState,
  buildProjectionHost,
  buildTruthStores,
  buildVarsTemplate,
  buildWorldSysRaw,
} from "./builders/index.js";
import { tempDir } from "./harness/tempDir.js";

const DECL = buildVarsTemplate().characterVars;


const start = { y: 0, m: 1, d: 1, h: 0, min: 0 };
const entry = (id: string, content = id): LoreEntry => ({ id, tags: [], content });
const manifest = (id: string, isPlayer = false, timer: number | null = 0): CharacterManifest => ({
  id,
  name: id,
  gender: "未设定",
  age: "未设定",
  personality: "谨慎。",
  reaction: 0,
  location: { name: "测试地", level: 1 },
  timer,
  group: 0,
  initiative: null,
  channel: null,
  acted: false,
  level: 1,
  omniscience: 0,
  isPlayer,
  relations: [],
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
  it("setClock 拒绝 NaN、Infinity 与小数分钟且不改时钟", () => {
    const store = WorldStore.initial({ time: start }, buildWorldSysRaw());
    for (const value of [Number.NaN, Number.POSITIVE_INFINITY, 1.5]) {
      assert.throws(() => store.setClock(value), /有限整数分钟/);
    }
    assert.equal(store.clock, 0);
  });

  it("同一路径连续 writeRaw 生成逐步 before 并可倒序恢复", () => {
    const store = WorldStore.initial({ time: start, hp: 10 }, buildWorldSysRaw());
    const changes = [store.writeRaw("hp", 8), store.writeRaw("hp", 13)];
    assert.deepEqual(changes.map((change) => [change.before, change.after]), [[10, 8], [8, 13]]);
    for (const change of [...changes].reverse()) store.revertChange(change);
    assert.equal(store.world["hp"], 10);
  });

  it("WorldStore 只接受精确 world. 前缀的回滚路径", () => {
    const store = WorldStore.initial({ time: start }, buildWorldSysRaw());
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
    const store = new LoreStore(LoreFileSchema.parse({
      schema_version: SAVE_SCHEMA_VERSION,
      entries: [entry("b", "new")],
      changelog: [{ seq: 2, op: "update", before: entry("b", "old"), after: entry("b", "new") }],
    }));
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
      name: "甲", gender: "", age: "", personality: "谨慎", reaction: 0,
      location: { name: "测试地", level: 1 }, timer: 1.5, group: 0,
      initiative: null, channel: null, acted: false, level: 1, isPlayer: false, relations: [], long_term_memory: [], vars: {},
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

describe("Recent upsert 与投影层按需取数", () => {
  it("recordRecent 对同 seq 原位更新且不产生重复项", () => {
    const dir = temp("airp-audit-recent-");
    recordRecent("t", "gm", { seq: 4, messages: ["old"], reasoning: "old" }, dir);
    recordRecent("t", "gm", { seq: 4, messages: ["new"], reasoning: "new" }, dir);
    assert.deepEqual(readRecent("t", "gm", dir), [{ seq: 4, messages: ["new"], reasoning: "new" }]);
  });

  it("空真相下 prose 读者的动态源取数为空/空串", () => {
    const truth = buildTruthStores({ characters: { C1001: buildCharacterState({ name: "林雾" }) } });
    const host = buildProjectionHost({ kind: "prose" }, truth, {
      adjudication: { events: [], narrativity: "skip", deltas: [], durations: [], location: [] },
      currentScene: "",
      participantCids: ["C1001"],
    });
    assert.deepEqual(host.entries("events"), []);
    assert.equal(host.entries("lore")[0]!.content, "");
  });

  it("renderPrompt 懒求值：未引用的占位符不取数", () => {
    const catalog = parsePlaceholders({
      used: { description: "used", source: "setting", segments: [{ kind: "entry", pass: { template: "{_content}" } }] },
      unused: { description: "unused", source: "tone_card", segments: [{ kind: "entry", pass: { template: "{_content}" } }] },
    });
    const host: RenderHost = {
      reader: { kind: "gm" },
      readerLabel: "GM",
      entries: (source) => {
        if (source === "tone_card") throw new Error("不应执行");
        return [{ content: "ok" }];
      },
      vars: () => {
        throw new Error("不应执行");
      },
      renderIdentity: (text) => text,
    };
    assert.deepEqual(
      renderPrompt({ id: "audit", modules: [{ key: "m", role: "system", content: "{{used}}" }] }, catalog, host),
      [{ role: "system", content: "ok" }],
    );
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

  it("CharactersStore.fromManifests 拒绝重复角色 ID", () => {
    assert.throws(() => CharactersStore.fromManifests([manifest("C1001"), manifest("C1001")], 0, DECL), /重复角色 CID/);
  });

  it("CharactersStore.fromManifests 强制 C0 与 isPlayer 双向一致", () => {
    assert.throws(() => CharactersStore.fromManifests([manifest("C0", false)], 0, DECL), /必须标记为玩家/);
    assert.throws(() => CharactersStore.fromManifests([manifest("C1001", true)], 0, DECL), /只有 C0/);
  });
});

describe("Generation 内七核心文件 schema_version 一致性", () => {
  const cfg = { apiKey: "dummy", baseURL: "http://127.0.0.1:9", model: "m", jsonMode: false };
  const configs = { character: cfg, gm: cfg, prose: cfg };
  const coreFiles = ["world.json", "events.json", "characters.json", "lore.json", "time.json", "archive.json", "prompts.json"];

  /** 新档 → 返回 {dir, genDir}（genDir = CURRENT 指向的 Generation 目录）。 */
  function initializedDir(): { dir: string; genDir: string } {
    const dir = temp("airp-audit-core-");
    resumeGameSession(configs, "audit", undefined, { baseDir: dir, proseWindowTurns: 5, rollDice: () => 10 });
    const revision = fs.readFileSync(path.join(dir, "CURRENT"), "utf8").trim();
    return { dir, genDir: path.join(dir, "generations", revision) };
  }

  it("Generation 布局：CURRENT + generations/{rev}/ 七文件，续档不再推进 revision", () => {
    const { dir, genDir } = initializedDir();
    assert.equal(fs.readFileSync(path.join(dir, "CURRENT"), "utf8"), "000001");
    for (const file of coreFiles) {
      const data = JSON.parse(fs.readFileSync(path.join(genDir, file), "utf8")) as { schema_version: unknown };
      assert.equal(data.schema_version, SAVE_SCHEMA_VERSION, `${file} 带统一版本`);
    }
    // 旁路产物留 run 根：meta.json 不进 Generation
    assert.ok(fs.existsSync(path.join(dir, "meta.json")));
    assert.ok(!fs.existsSync(path.join(genDir, "meta.json")));
  });

  /** 断言 resume 抛 SaveLoadError 且 kind 命中 + 措辞正则（类型化加载错误）。 */
  function expectResumeError(dir: string, kind: SaveLoadErrorKind, pattern: RegExp): void {
    assert.throws(
      () => resumeGameSession(configs, "audit", undefined, { baseDir: dir, proseWindowTurns: 5 }),
      (error: unknown) => {
        assert.ok(error instanceof SaveLoadError, `应为 SaveLoadError，实为 ${String(error)}`);
        assert.equal(error.kind, kind, `kind 应为 ${kind}：${error.message}`);
        assert.match(error.message, pattern);
        return true;
      },
    );
  }

  it("旧档（存档 v10）任一核心文件版本均明确拒绝（version 类，保留新建会话措辞；版本号钉死字面量）", () => {
    for (const file of coreFiles) {
      const { dir, genDir } = initializedDir();
      const filePath = path.join(genDir, file);
      const data = JSON.parse(fs.readFileSync(filePath, "utf8")) as { schema_version: number };
      // legacy fixture：固定旧版本号 10（存档 v10 = 六文件布局末版），勿随存档版本更新
      fs.writeFileSync(filePath, JSON.stringify({ ...data, schema_version: 10 }));
      expectResumeError(dir, "version", /核心文件版本混合/);
    }
  });

  it("Generation 内缺少任一核心文件时明确拒绝（incomplete 类；单代存档无上一代可回退）", () => {
    const { dir, genDir } = initializedDir();
    fs.rmSync(path.join(genDir, "archive.json"));
    expectResumeError(dir, "incomplete", /缺核心文件/);
  });

  it("七核心文件版本一致时可纯数据续档", () => {
    const { dir } = initializedDir();
    const resumed = resumeGameSession(configs, "audit", undefined, { baseDir: dir, proseWindowTurns: 5, rollDice: () => 10 });
    assert.equal(resumed.turnCount, 0);
    assert.equal(resumed.getEvents().length, 0);
  });
});
