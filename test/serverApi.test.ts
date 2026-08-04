import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import { describe, it } from "node:test";
import type { IncomingMessage, ServerResponse } from "node:http";
import { validateFileConfig } from "../src/contracts/config.js";
import {
  listRuns,
  readRunArtifact,
  RunRepositoryError,
} from "../src/resources/runRepository.js";
import {
  characterManifestFile,
  listCharacterManifests,
  packPromptsDir,
  validateLorebookPayload,
} from "../src/resources/worldRepository.js";
import { resolveUserDirectories } from "../src/resources/userDirectories.js";
import { createApiHandler, type ApiDeps } from "../src/server/http/router.js";
import { validateCharacterManifestForPath } from "../src/server/http/routes/characters.js";
import {
  placeholdersCatalog,
  readPromptTemplates,
  validatePromptPayload,
} from "../src/server/http/routes/prompts.js";
import { resolveWorldDir } from "../src/config.js";
import { safeSegment } from "../src/shared/safeSegment.js";
import { Lorebook } from "../src/truth/lorebook.js";
import { CharacterManifestSchema } from "../src/agents/character.js";
import { SAVE_SCHEMA_VERSION } from "../src/truth/saveSchema.js";
import type { SessionCoordinator } from "../src/application/sessionCoordinator.js";
import { tempDir } from "./harness/tempDir.js";

/** 出厂模板目录 = 默认世界包内 prompts/（data/assets/baitan/prompts/）。 */
const FACTORY_PROMPTS_DIR = packPromptsDir(resolveWorldDir());

describe("validateFileConfig（contracts FileConfigSchema）", () => {
  it("合法结构通过并保留未知注释字段", () => {
    const raw = {
      _说明: "注释",
      api_key: "sk-x",
      agents: { character: { model: "m" }, gm: {}, prose: { api_key: "sk-y" } },
    };
    const out = validateFileConfig(raw);
    assert.equal(out._说明, "注释");
    assert.deepEqual(out.agents, raw.agents);
  });

  it("非法结构拒绝", () => {
    assert.throws(() => validateFileConfig(null), /JSON 对象/);
    assert.throws(() => validateFileConfig([]), /JSON 对象/);
    assert.throws(() => validateFileConfig({ api_key: 123 }), /api_key/);
    assert.throws(() => validateFileConfig({ agents: [] }), /agents/);
    assert.throws(() => validateFileConfig({ agents: { npc: {} } }), /npc/);
    assert.throws(() => validateFileConfig({ agents: { gm: { timeout: 5 } } }), /timeout/);
    assert.throws(() => validateFileConfig({ agents: { gm: { model: 1 } } }), /agents\.gm\.model/);
  });

  it("memory 块：合法通过，非法拒绝", () => {
    const ok = validateFileConfig({ memory: { prose_window_turns: 5 } });
    assert.deepEqual(ok.memory, { prose_window_turns: 5 });
    assert.throws(() => validateFileConfig({ memory: [] }), /memory/);
    assert.throws(() => validateFileConfig({ memory: { foo: 1 } }), /foo/);
    assert.throws(() => validateFileConfig({ memory: { prose_window_turns: "5" } }), /prose_window_turns/);
    assert.throws(() => validateFileConfig({ memory: { prose_window_turns: -1 } }), /prose_window_turns/);
    assert.throws(() => validateFileConfig({ memory: { prose_window_turns: 1.5 } }), /prose_window_turns/);
  });

  it("gm_interval_cycles：≥1 整数通过，非法拒绝", () => {
    assert.equal(validateFileConfig({ gm_interval_cycles: 5 }).gm_interval_cycles, 5);
    assert.throws(() => validateFileConfig({ gm_interval_cycles: 0 }), /gm_interval_cycles/);
    assert.throws(() => validateFileConfig({ gm_interval_cycles: -2 }), /gm_interval_cycles/);
    assert.throws(() => validateFileConfig({ gm_interval_cycles: 1.5 }), /gm_interval_cycles/);
    assert.throws(() => validateFileConfig({ gm_interval_cycles: "3" }), /gm_interval_cycles/);
  });

  it("json_mode / reasoning_effort：顶层与 agents 块同规校验", () => {
    const ok = validateFileConfig({
      json_mode: true,
      reasoning_effort: "high",
      agents: { gm: { json_mode: false, reasoning_effort: "minimal" } },
    });
    assert.equal(ok.json_mode, true);
    assert.equal(ok.reasoning_effort, "high");
    // json_mode 必须 boolean
    assert.throws(() => validateFileConfig({ json_mode: "true" }), /json_mode/);
    assert.throws(() => validateFileConfig({ json_mode: 1 }), /json_mode/);
    assert.throws(() => validateFileConfig({ agents: { gm: { json_mode: "yes" } } }), /agents\.gm\.json_mode/);
    // reasoning_effort 必须 string
    assert.throws(() => validateFileConfig({ reasoning_effort: 5 }), /reasoning_effort/);
    assert.throws(
      () => validateFileConfig({ agents: { prose: { reasoning_effort: true } } }),
      /agents\.prose\.reasoning_effort/,
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

describe("listRuns / readRunArtifact（存档 v7 Generation 布局）", () => {
  it("只认目录、按 mtime 倒序；Generation 内五文件 + run 根 stats 读取回环", () => {
    const dir = tempDir("airp-runs-");
    // readRunArtifact 是纯读取（不校验版本），fixture 跟随当前 SAVE_SCHEMA_VERSION
    const v = SAVE_SCHEMA_VERSION;
    const mk = (id: string, mtime: Date) => {
      const d = path.join(dir, id);
      const gen = path.join(d, "generations", "000001");
      fs.mkdirSync(gen, { recursive: true });
      fs.writeFileSync(path.join(d, "CURRENT"), "000001");
      fs.writeFileSync(path.join(gen, "events.json"), `{"schema_version":${v},"events":[{"id":"evt_1","t":0,"seq":3}]}`);
      fs.writeFileSync(path.join(gen, "world.json"), `{"schema_version":${v},"world":{"time":{"y":1,"m":1,"d":1,"h":0,"min":5},"weather":"雾"},"pipeline":{"seq":3,"working_set":[],"current":null}}`);
      fs.writeFileSync(path.join(gen, "characters.json"), `{"schema_version":${v},"characters":{"C1001":{"name":"林雾","gender":"女","age":"26","personality":"寡言谨慎。","tags":[],"reaction":0,"location":{"name":"灯塔","level":1},"timer":5,"group":0,"initiative":null,"channel":null,"acted":false,"level":1,"isPlayer":false,"relations":{},"long_term_memory":[],"vars":{}}}}`);
      fs.writeFileSync(path.join(gen, "archive.json"), `{"schema_version":${v},"entries":[{"seq":1,"kind":"player","result":{"input":"你好"},"changes":{"setup":[],"effects":[]}}]}`);
      fs.writeFileSync(path.join(gen, "lore.json"), `{"schema_version":${v},"entries":[],"changelog":[]}`);
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
      schema_version: v,
      events: [{ id: "evt_1", t: 0, seq: 3 }],
    });
    const world = readRunArtifact(dir, "run-new", "world") as { world: { time: { min: number } } };
    assert.equal(world.world.time.min, 5);
    const characters = readRunArtifact(dir, "run-new", "characters") as { characters: Record<string, { personality: string }> };
    assert.equal(characters.characters.C1001?.personality, "寡言谨慎。");
    const archive = readRunArtifact(dir, "run-new", "archive") as { entries: unknown[] };
    assert.equal(archive.entries.length, 1);
    assert.deepEqual(readRunArtifact(dir, "run-new", "lore"), { schema_version: v, entries: [], changelog: [] });
    assert.deepEqual(readRunArtifact(dir, "run-new", "stats"), []); // 缺文件 → 空
    assert.throws(() => readRunArtifact(dir, "..", "events"), /非法名称/);
  });

  it("D3 清理：不存在/旧平铺档/损坏/产物缺失 → 类型化错误（无 readJson fallback、无平铺回落）", () => {
    const dir = tempDir("airp-runs-err-");
    const codeOf = (fn: () => unknown) => {
      try {
        fn();
      } catch (err) {
        assert.ok(err instanceof RunRepositoryError);
        return err.code;
      }
      throw new Error("应抛错");
    };
    // 存档目录不存在 → RUN_NOT_FOUND
    assert.equal(codeOf(() => readRunArtifact(dir, "nope", "events")), "RUN_NOT_FOUND");
    // 旧平铺档（无 CURRENT）→ LEGACY_RUN_UNSUPPORTED
    const legacy = path.join(dir, "run-legacy");
    fs.mkdirSync(legacy, { recursive: true });
    fs.writeFileSync(path.join(legacy, "events.json"), `{"schema_version":1,"events":[]}`);
    assert.equal(codeOf(() => readRunArtifact(dir, "run-legacy", "events")), "LEGACY_RUN_UNSUPPORTED");
    // CURRENT 非数字 → RUN_CORRUPT
    const badPtr = path.join(dir, "run-bad-ptr");
    fs.mkdirSync(badPtr, { recursive: true });
    fs.writeFileSync(path.join(badPtr, "CURRENT"), "abc");
    assert.equal(codeOf(() => readRunArtifact(dir, "run-bad-ptr", "events")), "RUN_CORRUPT");
    // 目标文件缺失 → RUN_NOT_FOUND
    const missing = path.join(dir, "run-missing");
    fs.mkdirSync(path.join(missing, "generations", "000001"), { recursive: true });
    fs.writeFileSync(path.join(missing, "CURRENT"), "000001");
    assert.equal(codeOf(() => readRunArtifact(dir, "run-missing", "events")), "RUN_NOT_FOUND");
    // JSON 损坏 → RUN_CORRUPT
    const corrupt = path.join(dir, "run-corrupt");
    const corruptGen = path.join(corrupt, "generations", "000001");
    fs.mkdirSync(corruptGen, { recursive: true });
    fs.writeFileSync(path.join(corrupt, "CURRENT"), "000001");
    fs.writeFileSync(path.join(corruptGen, "events.json"), "{bad json");
    assert.equal(codeOf(() => readRunArtifact(dir, "run-corrupt", "events")), "RUN_CORRUPT");
  });

  it("不存在的 runs 目录返回空列表", () => {
    assert.deepEqual(listRuns(path.join(os.tmpdir(), "airp-no-such-dir")), []);
  });
});

describe("prompts API（提示词模板端点的纯逻辑）", () => {
  it("readPromptTemplates：三个出厂模板结构完整", () => {
    const templates = readPromptTemplates(FACTORY_PROMPTS_DIR);
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
    const worldDir = tempDir("airp-character-api-");
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
    const dir = tempDir("airp-lore-");
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
// PUT /api/session/state（状态栏直接编辑端点）：路由层薄壳转发 SessionCoordinator.applyDirectEdit。
// envelope：成功 200 {ok:true,data:{note}}；LLM 在途 409 SESSION_BUSY；域校验失败 400 VALIDATION_ERROR。
// GameSession 层行为见 test/directEdit.test.ts；真实 HTTP + transition 广播见 test/httpEnvelope.test.ts。
// ---------------------------------------------------------------------------

function mockReq(method: string, url: string, body?: unknown): IncomingMessage {
  const req = Readable.from(body === undefined ? [] : [Buffer.from(JSON.stringify(body))]) as unknown as IncomingMessage;
  req.method = method;
  req.url = url;
  return req;
}

function mockRes(): { res: ServerResponse; out: { status: number; text: string } } {
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
  return { res, out };
}

function stubDeps(applyDirectEdit: (payload: unknown) => void): ApiDeps {
  const root = tempDir("airp-cfg-");
  const dirs = {
    ...resolveUserDirectories(),
    presetsDir: path.join(root, "api-presets"),
    secretsFile: path.join(root, "secrets.json"),
    settingsFile: path.join(root, "settings.json"),
  };
  return {
    coordinator: { applyDirectEdit } as unknown as SessionCoordinator,
    dirs,
    config: { dirs, env: {}, legacyConfigFile: path.join(root, "config.json") },
  };
}

describe("PUT /api/session/state（直接编辑端点，envelope）", () => {
  it("正常路径：payload 原样转发 applyDirectEdit，返回 200 + note", async () => {
    let captured: unknown = null;
    const handleApi = createApiHandler(stubDeps((payload) => {
      captured = payload;
    }));
    const body = { world: { time: { y: 1, m: 1, d: 1, h: 0, min: 0 }, hp: 1 }, characters: {}, events: [] };
    const { res, out } = mockRes();
    assert.equal(await handleApi(mockReq("PUT", "/api/session/state", body), res), true);
    assert.equal(out.status, 200);
    assert.deepEqual(captured, body);
    assert.deepEqual(JSON.parse(out.text), { ok: true, data: { note: "已保存，立即生效" } });
  });

  it("忙碌失败：applyDirectEdit 抛「LLM 运行中」→ 409 SESSION_BUSY", async () => {
    const handleApi = createApiHandler(
      stubDeps(() => {
        throw new Error("LLM 运行中：请等待当前生成结束后再直接编辑");
      }),
    );
    const { res, out } = mockRes();
    assert.equal(await handleApi(mockReq("PUT", "/api/session/state", { events: [] }), res), true);
    assert.equal(out.status, 409);
    const body = JSON.parse(out.text) as { ok: false; error: { code: string; message: string } };
    assert.equal(body.ok, false);
    assert.equal(body.error.code, "SESSION_BUSY");
    assert.match(body.error.message, /运行中/);
  });

  it("域校验失败：角色集合不一致 → 400 VALIDATION_ERROR", async () => {
    const handleApi = createApiHandler(
      stubDeps(() => {
        throw new Error("角色集合必须与当前一致（直接编辑只改内容，不增删角色）");
      }),
    );
    const { res, out } = mockRes();
    await handleApi(mockReq("PUT", "/api/session/state", { characters: {} }), res);
    assert.equal(out.status, 400);
    assert.equal((JSON.parse(out.text) as { error: { code: string } }).error.code, "VALIDATION_ERROR");
  });
});
