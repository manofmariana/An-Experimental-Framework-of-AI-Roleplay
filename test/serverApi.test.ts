import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import { describe, it } from "node:test";
import type { IncomingMessage, ServerResponse } from "node:http";
import {
  handleApi,
  listRuns,
  placeholdersCatalog,
  readPromptTemplates,
  readRunArtifact,
  safeSegment,
  characterManifestFile,
  listCharacterManifests,
  validateCharacterManifestForPath,
  validateConfigPayload,
  validateLorebookPayload,
  validatePromptPayload,
} from "../src/server/api.js";
import { Lorebook } from "../src/truth/lorebook.js";
import { CharacterManifestSchema } from "../src/agents/character.js";
import type { SessionManager } from "../src/server/sessionManager.js";

describe("validateConfigPayload", () => {
  it("合法结构通过并保留未知注释字段", () => {
    const raw = {
      _说明: "注释",
      api_key: "sk-x",
      agents: { character: { model: "m" }, gm: {}, prose: { api_key: "sk-y" } },
    };
    const out = validateConfigPayload(raw);
    assert.equal(out._说明, "注释");
    assert.deepEqual(out.agents, raw.agents);
  });

  it("非法结构拒绝", () => {
    assert.throws(() => validateConfigPayload(null), /JSON 对象/);
    assert.throws(() => validateConfigPayload([]), /JSON 对象/);
    assert.throws(() => validateConfigPayload({ api_key: 123 }), /api_key/);
    assert.throws(() => validateConfigPayload({ agents: [] }), /agents/);
    assert.throws(() => validateConfigPayload({ agents: { npc: {} } }), /未知 agent/);
    assert.throws(() => validateConfigPayload({ agents: { gm: { timeout: 5 } } }), /未知字段/);
    assert.throws(() => validateConfigPayload({ agents: { gm: { model: 1 } } }), /必须是字符串/);
  });

  it("memory 块：合法通过，非法拒绝", () => {
    const ok = validateConfigPayload({ memory: { prose_window_turns: 5 } });
    assert.deepEqual(ok.memory, { prose_window_turns: 5 });
    assert.throws(() => validateConfigPayload({ memory: [] }), /memory 必须是对象/);
    assert.throws(() => validateConfigPayload({ memory: { foo: 1 } }), /未知字段/);
    assert.throws(() => validateConfigPayload({ memory: { prose_window_turns: "5" } }), /非负整数/);
    assert.throws(() => validateConfigPayload({ memory: { prose_window_turns: -1 } }), /非负整数/);
    assert.throws(() => validateConfigPayload({ memory: { prose_window_turns: 1.5 } }), /非负整数/);
  });

  it("gm_interval_cycles：≥1 整数通过，非法拒绝", () => {
    assert.equal(validateConfigPayload({ gm_interval_cycles: 5 }).gm_interval_cycles, 5);
    assert.throws(() => validateConfigPayload({ gm_interval_cycles: 0 }), /gm_interval_cycles/);
    assert.throws(() => validateConfigPayload({ gm_interval_cycles: -2 }), /gm_interval_cycles/);
    assert.throws(() => validateConfigPayload({ gm_interval_cycles: 1.5 }), /gm_interval_cycles/);
    assert.throws(() => validateConfigPayload({ gm_interval_cycles: "3" }), /gm_interval_cycles/);
  });

  it("json_mode / reasoning_effort：顶层与 agents 块同规校验", () => {
    const ok = validateConfigPayload({
      json_mode: true,
      reasoning_effort: "high",
      agents: { gm: { json_mode: false, reasoning_effort: "minimal" } },
    });
    assert.equal(ok.json_mode, true);
    assert.equal(ok.reasoning_effort, "high");
    // json_mode 必须 boolean
    assert.throws(() => validateConfigPayload({ json_mode: "true" }), /json_mode 必须是布尔值/);
    assert.throws(() => validateConfigPayload({ json_mode: 1 }), /json_mode 必须是布尔值/);
    assert.throws(
      () => validateConfigPayload({ agents: { gm: { json_mode: "yes" } } }),
      /agents\.gm\.json_mode 必须是布尔值/,
    );
    // reasoning_effort 必须 string
    assert.throws(
      () => validateConfigPayload({ reasoning_effort: 5 }),
      /reasoning_effort 必须是字符串/,
    );
    assert.throws(
      () => validateConfigPayload({ agents: { prose: { reasoning_effort: true } } }),
      /agents\.prose\.reasoning_effort 必须是字符串/,
    );
  });
});

describe("validateLorebookPayload", () => {
  it("合法条目数组通过", () => {
    const entries = validateLorebookPayload([
      { id: "a", tags: ["白滩镇：常识"], content: "c", enabled: true },
    ]);
    assert.equal(entries[0]!.id, "a");
  });

  it("缺字段 / 重复 ID 拒绝", () => {
    assert.throws(() => validateLorebookPayload([{ id: "a", tags: [] }]));
    assert.throws(
      () =>
        validateLorebookPayload([
          { id: "a", tags: [], content: "1" },
          { id: "a", tags: [], content: "2" },
        ]),
      /重复/,
    );
  });
});

describe("safeSegment（路径安全）", () => {
  it("拒绝目录穿越与非法字符", () => {
    for (const bad of ["..", "../etc", "a/b", "a\\b", "", ".hidden", "a b", "a?b"]) {
      assert.throws(() => safeSegment(bad), /非法名称/, `应拒绝: ${JSON.stringify(bad)}`);
    }
  });

  it("合法名称放行", () => {
    assert.equal(safeSegment("run-2026-07-26"), "run-2026-07-26");
    assert.equal(safeSegment("example"), "example");
  });
});

describe("listRuns / readRunArtifact（存档 v2 产物）", () => {
  it("只认目录、按 mtime 倒序；五文件 + stats 读取回环", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "airp-runs-"));
    const mk = (id: string, mtime: Date) => {
      const d = path.join(dir, id);
      fs.mkdirSync(d);
      fs.writeFileSync(path.join(d, "events.json"), '{"schema_version":4,"events":[{"id":"evt_1","t":0,"seq":3}]}');
      fs.writeFileSync(path.join(d, "world.json"), '{"schema_version":4,"world":{"time":{"y":1,"m":1,"d":1,"h":0,"min":5},"weather":"雾"},"pipeline":{"seq":3,"phase":"await_player","working_set":[],"current":null}}');
      fs.writeFileSync(path.join(d, "characters.json"), '{"schema_version":4,"characters":{"C1001":{"name":"林雾","gender":"女","age":"26","personality":"寡言谨慎。","tags":[],"reaction":0,"location":{"name":"灯塔","level":1},"timer":5,"group":0,"initiative":null,"channel":null,"acted":false,"level":1,"isPlayer":false,"relations":{},"long_term_memory":[],"vars":{}}}}');
      fs.writeFileSync(path.join(d, "archive.json"), '{"schema_version":4,"entries":[{"seq":1,"kind":"player","result":{"input":"你好"},"var_changes":[]}]}');
      fs.writeFileSync(path.join(d, "lore.json"), '{"schema_version":4,"entries":[],"changelog":[]}');
      fs.utimesSync(d, mtime, mtime);
    };
    mk("run-old", new Date(2020, 0, 1));
    mk("run-new", new Date(2026, 0, 1));
    fs.writeFileSync(path.join(dir, "stray-file.txt"), "not a dir");

    const runs = listRuns(dir);
    assert.deepEqual(
      runs.map((r) => r.id),
      ["run-new", "run-old"],
    );

    assert.deepEqual(readRunArtifact(dir, "run-new", "events"), {
      schema_version: 4,
      events: [{ id: "evt_1", t: 0, seq: 3 }],
    });
    const world = readRunArtifact(dir, "run-new", "world") as { world: { time: { min: number } } };
    assert.equal(world.world.time.min, 5);
    const characters = readRunArtifact(dir, "run-new", "characters") as { characters: Record<string, { personality: string }> };
    assert.equal(characters.characters.C1001?.personality, "寡言谨慎。");
    const archive = readRunArtifact(dir, "run-new", "archive") as { entries: unknown[] };
    assert.equal(archive.entries.length, 1);
    assert.deepEqual(readRunArtifact(dir, "run-new", "lore"), { schema_version: 4, entries: [], changelog: [] });
    assert.deepEqual(readRunArtifact(dir, "run-new", "stats"), []); // 缺文件 → 空
    assert.throws(() => readRunArtifact(dir, "..", "events"), /非法名称/);
  });

  it("不存在的 runs 目录返回空列表", () => {
    assert.deepEqual(listRuns(path.join(os.tmpdir(), "airp-no-such-dir")), []);
  });
});

describe("prompts API（提示词模板端点的纯逻辑）", () => {
  it("readPromptTemplates：三个出厂模板结构完整", () => {
    const templates = readPromptTemplates();
    assert.deepEqual(
      templates.map((t) => t.id),
      ["character", "gm", "prose"],
    );
    for (const t of templates) {
      assert.ok(t.modules.length >= 2);
      for (const m of t.modules) assert.ok(["system", "user", "assistant"].includes(m.role));
    }
  });

  it("placeholdersCatalog：从注册表导出，含各 agent 关键占位符", () => {
    const catalog = placeholdersCatalog();
    assert.deepEqual(
      catalog.map((c) => c.agent),
      ["character", "gm", "prose"],
    );
    const keysOf = (agent: string) =>
      catalog.find((c) => c.agent === agent)!.placeholders.map((p) => p.key);
    for (const k of ["world_snapshot", "character_snapshot", "recent_events", "prose_window", "current_scene", "time", "location"]) {
      assert.ok(keysOf("character").includes(k), `character 缺 ${k}`);
    }
    for (const k of ["setting", "lore_full", "events", "current_scene", "world_snapshot", "characters_snapshot"]) {
      assert.ok(keysOf("gm").includes(k), `gm 缺 ${k}`);
    }
    for (const k of ["tone_card", "world_lore", "recent_events", "cast", "triggered_lore", "last_prose", "gm_event", "current_scene"]) {
      assert.ok(keysOf("prose").includes(k), `prose 缺 ${k}`);
    }
    // 每项都带描述
    for (const c of catalog) for (const p of c.placeholders) assert.ok(p.description.length > 0);
  });

  it("validatePromptPayload：合法通过；未知占位符列出名字；id 不符拒绝", () => {
    const ok = validatePromptPayload("gm", {
      id: "gm",
      modules: [{ key: "m", role: "system", content: "设定：{{setting}}" }],
    });
    assert.equal(ok.id, "gm");

    assert.throws(
      () =>
        validatePromptPayload("gm", {
          id: "gm",
          modules: [{ key: "m", role: "system", content: "{{nope}}" }],
        }),
      /nope/,
    );
    assert.throws(
      () =>
        validatePromptPayload("gm", {
          id: "character",
          modules: [{ key: "m", role: "system", content: "{{setting}}" }],
        }),
      /不一致/,
    );
  });
});

describe("角色 manifest API/前端往返契约", () => {
  it("characters manifest 列表纳入 player.json/C0 并映射正确路径", () => {
    const worldDir = fs.mkdtempSync(path.join(os.tmpdir(), "airp-character-api-"));
    fs.mkdirSync(path.join(worldDir, "characters"));
    const base = {
      name: "玩家", gender: "未设定", age: "未设定", personality: "谨慎。", tags: [], reaction: 0,
      location: { name: "起点", level: 1 }, timer: 0, group: 0, initiative: null, channel: null, acted: false,
      level: 1, relations: {}, initial_memories: [], vars: {},
    };
    fs.writeFileSync(path.join(worldDir, "player.json"), JSON.stringify({ ...base, id: "C0", isPlayer: true }));
    fs.writeFileSync(path.join(worldDir, "characters", "C1001.json"), JSON.stringify({ ...base, id: "C1001", name: "甲", isPlayer: false }));
    assert.equal(characterManifestFile(worldDir, "C0"), path.join(worldDir, "player.json"));
    assert.deepEqual(listCharacterManifests(worldDir).map((item) => item.id), ["C0", "C1001"]);
  });

  it("characters PUT 路径校验拒绝 id/isPlayer 不一致并允许 C0 roundtrip", () => {
    const player = {
      id: "C0", name: "玩家", gender: "未设定", age: "未设定", personality: "谨慎。", tags: [], reaction: 0,
      location: { name: "起点", level: 1 }, timer: 0, group: 0, initiative: null, channel: null, acted: false,
      level: 1, isPlayer: true, relations: {}, initial_memories: [], vars: {},
    };
    assert.deepEqual(validateCharacterManifestForPath("C0", JSON.parse(JSON.stringify(player))), player);
    assert.throws(() => validateCharacterManifestForPath("C1001", player), /路径 id/);
    assert.throws(() => validateCharacterManifestForPath("C0", { ...player, isPlayer: false }), /isPlayer=true/);
    assert.throws(() => validateCharacterManifestForPath("C1001", { ...player, id: "C1001" }), /只有 C0/);
  });

  it("统一字段 parse→JSON→parse 不丢失，前端表单包含结构化 location 与保留字段", () => {
    const manifest = CharacterManifestSchema.parse({
      id: "C1001", name: "林雾", gender: "女", age: "26", personality: "谨慎。", tags: ["灯塔"], reaction: 5,
      location: { name: "塔顶", level: 2 }, timer: 30, group: 0, initiative: null, channel: null, acted: false, level: 1,
      isPlayer: false, relations: {}, initial_memories: ["记忆"], vars: { hp: 10 },
    });
    assert.deepEqual(CharacterManifestSchema.parse(JSON.parse(JSON.stringify(manifest))), manifest);
    const frontend = fs.readFileSync(path.join(process.cwd(), "web/pages/characters.js"), "utf8");
    for (const field of ["gender", "age", "personality", "locationName", "locationLevel", "timer", "reaction", "level", "tags", "initial_memories"]) assert.ok(frontend.includes(field));
  });
});

describe("lorebook 读写回环", () => {
  it("validateLorebookPayload → 写盘 → Lorebook.load 读回一致", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "airp-lore-"));
    const file = path.join(dir, "lorebook.json");
    const entries = validateLorebookPayload([
      { id: "b", tags: ["白滩镇：常识"], content: "B", enabled: false },
      { id: "a", tags: [], content: "A" },
    ]);
    fs.writeFileSync(file, JSON.stringify(entries, null, 2) + "\n", "utf8");

    const book = Lorebook.load(file);
    assert.deepEqual(
      book.all().map((e) => e.id),
      ["a", "b"], // all() 按 ID 排序
    );
    assert.equal(book.getByIds(["b"])[0]!.content, "B");
    assert.deepEqual(
      book.getByTags(["白滩镇：常识"]).map((e) => e.id),
      ["b"],
    );
  });
});

// ---------------------------------------------------------------------------
// PUT /api/session/state（状态栏直接编辑端点）：薄壳转发 SessionManager.applyDirectEdit，
// busy/校验失败 → 400 + 错误消息。GameSession 层行为见 test/directEdit.test.ts。
// ---------------------------------------------------------------------------

function mockPut(url: string, body: unknown): { req: IncomingMessage; res: ServerResponse; out: { status: number; text: string } } {
  const req = Readable.from([Buffer.from(JSON.stringify(body))]) as unknown as IncomingMessage;
  req.method = "PUT";
  req.url = url;
  const out = { status: 0, text: "" };
  const res = {
    writeHead(code: number) {
      out.status = code;
      return this;
    },
    end(data?: string) {
      out.text = data ?? "";
    },
  } as unknown as ServerResponse;
  return { req, res, out };
}

describe("PUT /api/session/state（直接编辑端点）", () => {
  it("正常路径：payload 原样转发 applyDirectEdit，返回 200", async () => {
    let captured: unknown = null;
    const manager = {
      applyDirectEdit(payload: unknown) {
        captured = payload;
      },
    } as unknown as SessionManager;
    const body = { world: { time: { y: 1, m: 1, d: 1, h: 0, min: 0 }, hp: 1 }, characters: {}, events: [] };
    const { req, res, out } = mockPut("/api/session/state", body);
    assert.equal(await handleApi(req, res, manager), true);
    assert.equal(out.status, 200);
    assert.deepEqual(captured, body);
    assert.deepEqual(JSON.parse(out.text), { ok: true, note: "已保存，立即生效" });
  });

  it("校验/忙碌失败：applyDirectEdit 抛错 → 400 + 错误消息", async () => {
    const manager = {
      applyDirectEdit(): void {
        throw new Error("LLM 运行中：请等待当前生成结束后再直接编辑");
      },
    } as unknown as SessionManager;
    const { req, res, out } = mockPut("/api/session/state", { events: [] });
    assert.equal(await handleApi(req, res, manager), true);
    assert.equal(out.status, 400);
    assert.match((JSON.parse(out.text) as { error: string }).error, /运行中/);
  });

  it("直编成功后 onStateRefresh 回调广播 pipeline（前端输入权限立刻跟随 phase 变化）", async () => {
    // 广播路径回归：调度变量（acted/initiative 等）直编会改变 deriveNext 的 phase，
    // 若只广播 state/events，前端输入权限/继续按钮停留在旧 phase（"不生效"假象）
    const fs = await import("node:fs");
    const path = await import("node:path");
    const source = fs.readFileSync(path.join(process.cwd(), "src/server/index.ts"), "utf8");
    const refresh = source.slice(source.indexOf("onStateRefresh"), source.indexOf("http.createServer"));
    assert.ok(refresh.includes('type: "state"'), "应广播 state");
    assert.ok(refresh.includes('type: "events"'), "应广播 events");
    assert.ok(refresh.includes('type: "pipeline"'), "应广播 pipeline");
  });
});
