/**
 * HTTP envelope 集成测试：真实 HTTP（serverHarness + fetch）逐端点验证统一 envelope
 * {ok:true,data} / {ok:false,error:{code,message,details?}} 与状态码矩阵
 * （400 BAD_JSON/VALIDATION_ERROR、404 UNKNOWN_ENDPOINT/RUN_NOT_FOUND/CHARACTER_NOT_FOUND/
 * WORLD_SET_NOT_FOUND/LEGACY_RUN_UNSUPPORTED、405 METHOD_NOT_ALLOWED+Allow、
 * 409 SESSION_ACTIVE、500 INTERNAL_ERROR/RUN_CORRUPT）。
 * 另证：HTTP mutation 成功 → WS 客户端恰收一条 transition；失败 → 无广播。
 * 全部资源目录经 harness 注入临时根，不触碰真实用户数据。
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { describe, it } from "node:test";
import { SAVE_SCHEMA_VERSION } from "../src/truth/saveSchema.js";
import { serverHarness, type ServerHarness } from "./harness/server.js";

interface ApiReply {
  status: number;
  allow: string | null;
  json: { ok: boolean; data?: never; error?: { code: string; message: string; details?: unknown } };
}

async function callApi(
  port: number,
  method: string,
  path_: string,
  body?: unknown,
  rawBody?: string,
): Promise<ApiReply> {
  const hasBody = body !== undefined || rawBody !== undefined;
  const resp = await fetch(`http://127.0.0.1:${port}${path_}`, {
    method,
    ...(hasBody ? { headers: { "Content-Type": "application/json" } } : {}),
    ...(hasBody ? { body: rawBody ?? JSON.stringify(body) } : {}),
  });
  const json = (await resp.json()) as ApiReply["json"];
  return { status: resp.status, allow: resp.headers.get("allow"), json };
}

function okData<T>(reply: ApiReply): T {
  assert.equal(reply.json.ok, true, `应成功: ${JSON.stringify(reply.json)}`);
  return reply.json.data as T;
}

function failCode(reply: ApiReply, status: number, code: string): void {
  assert.equal(reply.status, status, `状态码: ${JSON.stringify(reply.json)}`);
  assert.equal(reply.json.ok, false);
  assert.equal(reply.json.error?.code, code);
  assert.ok(typeof reply.json.error?.message === "string" && reply.json.error.message.length > 0);
}

/** 造一个合法 v7 布局存档（CURRENT + generations/000001/ 五文件）。 */
function mkRun(runsDir: string, id: string): void {
  const v = SAVE_SCHEMA_VERSION;
  const gen = path.join(runsDir, id, "generations", "000001");
  fs.mkdirSync(gen, { recursive: true });
  fs.writeFileSync(path.join(runsDir, id, "CURRENT"), "000001");
  fs.writeFileSync(path.join(gen, "events.json"), `{"schema_version":${v},"events":[{"id":"evt_1","t":0,"seq":1,"kind":"world","tags":[],"payload":"测试事件"}]}`);
  fs.writeFileSync(path.join(gen, "world.json"), `{"schema_version":${v},"world":{"time":{"y":1,"m":1,"d":1,"h":0,"min":0}},"pipeline":{"seq":1,"working_set":[],"current":null}}`);
  fs.writeFileSync(path.join(gen, "characters.json"), `{"schema_version":${v},"characters":{}}`);
  fs.writeFileSync(path.join(gen, "archive.json"), `{"schema_version":${v},"entries":[]}`);
  fs.writeFileSync(path.join(gen, "lore.json"), `{"schema_version":${v},"entries":[],"changelog":[]}`);
}

describe("HTTP envelope：未知端点 / 405 / 静态回落", () => {
  it("未知路径 → 404 UNKNOWN_ENDPOINT；已知路径未知方法 → 405 + Allow", async (t) => {
    const h = await serverHarness(t);
    failCode(await callApi(h.port, "GET", "/api/nope"), 404, "UNKNOWN_ENDPOINT");
    failCode(await callApi(h.port, "POST", "/api/config", {}), 405, "METHOD_NOT_ALLOWED");
    const reply = await callApi(h.port, "DELETE", "/api/sessions");
    failCode(reply, 405, "METHOD_NOT_ALLOWED");
    assert.equal(reply.allow, "GET");
    const cfg = await callApi(h.port, "POST", "/api/config", {});
    assert.ok(cfg.allow!.includes("GET") && cfg.allow!.includes("PUT"));
    // 非 /api 路径不走 envelope（静态服务）
    const resp = await fetch(`http://127.0.0.1:${h.port}/no-such-page`);
    assert.equal(resp.status, 404);
  });
});

describe("config 域（ConfigStateView + settings patch 事务）", () => {
  it("GET 返回脱敏 ConfigStateView；PUT patch 带并发闸；BAD_JSON / VALIDATION_ERROR / CONFIG_REVISION_CONFLICT", async (t) => {
    const h = await serverHarness(t);
    // GET：无 legacy config.json → 空三资源视图（不触发迁移）
    const empty = okData<{ secrets: unknown; presets: unknown[]; settings: { configRevision: number } }>(
      await callApi(h.port, "GET", "/api/config"),
    );
    assert.deepEqual(empty.secrets, {});
    assert.deepEqual(empty.presets, []);
    assert.equal(empty.settings.configRevision, 0);
    assert.ok(!fs.existsSync(h.configFile), "无 config.json 时不产生迁移");

    // PUT：非法 JSON → 400 BAD_JSON
    failCode(await callApi(h.port, "PUT", "/api/config", undefined, "{bad"), 400, "BAD_JSON");
    // PUT：缺 baseConfigRevision / 旧整文件形状 / 非法值 → 400 VALIDATION_ERROR
    failCode(await callApi(h.port, "PUT", "/api/config", { proseWindowTurns: 9 }), 400, "VALIDATION_ERROR");
    failCode(await callApi(h.port, "PUT", "/api/config", { model: "m-test", baseConfigRevision: 0 }), 400, "VALIDATION_ERROR");
    failCode(await callApi(h.port, "PUT", "/api/config", { gmIntervalCycles: 0, baseConfigRevision: 0 }), 400, "VALIDATION_ERROR");
    // PUT：解析不出（未绑定 preset）→ 400 VALIDATION_ERROR（CONFIG_INVALID 映射），零落盘
    failCode(
      await callApi(h.port, "PUT", "/api/config", { proseWindowTurns: 9, baseConfigRevision: 0 }),
      400,
      "VALIDATION_ERROR",
    );
    assert.ok(!fs.existsSync(h.dirs.settingsFile), "解析失败不得落盘");
  });

  it("legacy config.json 经 GET 触发迁移：视图脱敏 + .bak + 后续 patch/冲突矩阵", async (t) => {
    const h = await serverHarness(t);
    const legacy = {
      _说明: "注释",
      api_key: "sk-integ-abcdef123456",
      model: "m-top",
      memory: { prose_window_turns: 7 },
      gm_interval_cycles: 4,
    };
    fs.writeFileSync(h.configFile, JSON.stringify(legacy), "utf8");

    const view = okData<{
      secrets: { deepseek: { id: string; maskedValue: string; active: boolean }[] };
      presets: { id: string }[];
      settings: { configRevision: number; proseWindowTurns?: number; agentPresets?: Record<string, string> };
    }>(await callApi(h.port, "GET", "/api/config"));
    // 迁移落盘：原文件消失 + .bak 保留
    assert.ok(!fs.existsSync(h.configFile));
    assert.ok(fs.existsSync(`${h.configFile}.migrated.bak`));
    assert.equal(view.settings.configRevision, 0);
    assert.equal(view.settings.proseWindowTurns, 7);
    assert.deepEqual(view.presets.map((p) => p.id), ["migrated-default"]);
    assert.deepEqual(view.settings.agentPresets, {
      character: "migrated-default",
      gm: "migrated-default",
      prose: "migrated-default",
    });
    assert.equal(view.secrets.deepseek[0]!.maskedValue, "****3456");

    // PUT patch 成功 → 200 + 新 revision + 脱敏视图
    const saved = okData<{ configRevision: number; view: { settings: { gmIntervalCycles?: number } } }>(
      await callApi(h.port, "PUT", "/api/config", { gmIntervalCycles: 5, baseConfigRevision: 0 }),
    );
    assert.equal(saved.configRevision, 1);
    assert.equal(saved.view.settings.gmIntervalCycles, 5);
    // 版本冲突 → 409 CONFIG_REVISION_CONFLICT（details 附双值）
    const conflict = await callApi(h.port, "PUT", "/api/config", { gmIntervalCycles: 6, baseConfigRevision: 0 });
    failCode(conflict, 409, "CONFIG_REVISION_CONFLICT");
    assert.deepEqual(conflict.json.error?.details, { baseConfigRevision: 0, currentConfigRevision: 1 });

    // 无明文泄漏：全部公共响应不含原始 key
    for (const path_ of ["/api/config", "/api/secrets", "/api/presets"]) {
      const resp = await fetch(`http://127.0.0.1:${h.port}${path_}`);
      assert.ok(!(await resp.text()).includes("sk-integ-abcdef123456"), `${path_} 不得含明文 key`);
    }

    // WS snapshot 同样不含明文 key（配置不进入会话下行载荷）
    const ws = await h.connect();
    ws.send({ type: "new_session", worldSetId: "w", requestId: "r-cfg" });
    const snapshot = await ws.waitFor((m) => m.type === "snapshot");
    assert.ok(!JSON.stringify(snapshot).includes("sk-integ-abcdef123456"), "WS snapshot 不得含明文 key");
    ws.close();
  });

  it("secrets.json 损坏（故障注入）→ 500 INTERNAL_ERROR", async (t) => {
    const h = await serverHarness(t);
    fs.mkdirSync(path.dirname(h.dirs.secretsFile), { recursive: true });
    fs.writeFileSync(h.dirs.secretsFile, "{bad json", "utf8");
    failCode(await callApi(h.port, "GET", "/api/config"), 500, "INTERNAL_ERROR");
  });
});

describe("secrets 域（端点矩阵）", () => {
  /** 迁移出可操作基线（绑定 migrated-default + 一条 active key），返回当前 revision。 */
  async function seedViaLegacy(h: ServerHarness, key = "sk-seed-aaaa9999"): Promise<number> {
    fs.writeFileSync(h.configFile, JSON.stringify({ api_key: key, model: "m" }), "utf8");
    const view = okData<{ settings: { configRevision: number } }>(await callApi(h.port, "GET", "/api/config"));
    return view.settings.configRevision;
  }

  it("write/activate/rotate/rename/delete + 状态码矩阵 + view 403", async (t) => {
    const h = await serverHarness(t);
    let rev = await seedViaLegacy(h);

    // write：新 key（inactive）
    const written = okData<{ configRevision: number; view: { secrets: { deepseek: { id: string; active: boolean; maskedValue: string }[] } } }>(
      await callApi(h.port, "POST", "/api/secrets", { kind: "deepseek", value: "sk-second-bbbb8888", label: "备", baseConfigRevision: rev }),
    );
    rev = written.configRevision;
    const records = written.view.secrets.deepseek;
    assert.equal(records.length, 2);
    const second = records.find((r) => r.maskedValue === "****8888")!;
    assert.equal(second.active, false);

    // activate 第二把 → active 切换
    const act = okData<{ configRevision: number; view: { secrets: { deepseek: { id: string; active: boolean }[] } } }>(
      await callApi(h.port, "POST", `/api/secrets/deepseek/${second.id}/activate`, { baseConfigRevision: rev }),
    );
    rev = act.configRevision;
    assert.equal(act.view.secrets.deepseek.find((r) => r.id === second.id)!.active, true);

    // rotate：激活当前 active 的下一条（循环回第一把）
    const rot = okData<{ configRevision: number; view: { secrets: { deepseek: { id: string; active: boolean }[] } } }>(
      await callApi(h.port, "POST", `/api/secrets/deepseek/${second.id}/rotate`, { baseConfigRevision: rev }),
    );
    rev = rot.configRevision;
    assert.equal(rot.view.secrets.deepseek.find((r) => r.id === second.id)!.active, false);

    // rename
    const ren = okData<{ configRevision: number; view: { secrets: { deepseek: { id: string; label: string }[] } } }>(
      await callApi(h.port, "POST", `/api/secrets/deepseek/${second.id}/rename`, { label: "备用钥匙", baseConfigRevision: rev }),
    );
    rev = ren.configRevision;
    assert.equal(ren.view.secrets.deepseek.find((r) => r.id === second.id)!.label, "备用钥匙");

    // GET state：掩码，无明文
    const state = await fetch(`http://127.0.0.1:${h.port}/api/secrets`);
    const stateText = await state.text();
    assert.ok(!stateText.includes("sk-second-bbbb8888"));
    assert.ok(stateText.includes("****8888"));

    // view：allowKeysExposure 未开启 → 403 FORBIDDEN
    failCode(await callApi(h.port, "GET", `/api/secrets/deepseek/${second.id}/view`), 403, "FORBIDDEN");

    // 404：不存在的 id
    failCode(await callApi(h.port, "POST", `/api/secrets/deepseek/nope/activate`, { baseConfigRevision: rev }), 404, "SECRET_NOT_FOUND");
    // 409：旧 revision
    failCode(await callApi(h.port, "POST", `/api/secrets/deepseek/${second.id}/activate`, { baseConfigRevision: 0 }), 409, "CONFIG_REVISION_CONFLICT");
    // 400：非法 kind / 缺字段
    failCode(await callApi(h.port, "POST", "/api/secrets", { kind: "bad kind", value: "sk-x", label: "l", baseConfigRevision: rev }), 400, "VALIDATION_ERROR");
    failCode(await callApi(h.port, "POST", "/api/secrets", { kind: "deepseek", label: "l", baseConfigRevision: rev }), 400, "VALIDATION_ERROR");

    // delete：删 inactive 的第二把
    const del = okData<{ configRevision: number; view: { secrets: { deepseek: { id: string }[] } } }>(
      await callApi(h.port, "DELETE", `/api/secrets/deepseek/${second.id}`, { baseConfigRevision: rev }),
    );
    assert.equal(del.view.secrets.deepseek.length, 1);
  });

  it("删除最后一把 key → 400（CONFIG_INVALID 映射），secrets.json 原样", async (t) => {
    const h = await serverHarness(t);
    const rev = await seedViaLegacy(h);
    const before = fs.readFileSync(h.dirs.secretsFile, "utf8");
    failCode(
      await callApi(h.port, "DELETE", "/api/secrets/deepseek/migrated-1", { baseConfigRevision: rev }),
      400,
      "VALIDATION_ERROR",
    );
    assert.equal(fs.readFileSync(h.dirs.secretsFile, "utf8"), before);
  });
});

describe("presets 域（端点矩阵）", () => {
  it("save（id 缺省 = 新建）/duplicate/delete；绑定中拒删 409 PRESET_IN_USE；404/409/400", async (t) => {
    const h = await serverHarness(t);
    fs.writeFileSync(h.configFile, JSON.stringify({ api_key: "sk-preset-cccc7777", model: "m" }), "utf8");
    let rev = okData<{ settings: { configRevision: number } }>(await callApi(h.port, "GET", "/api/config")).settings.configRevision;

    // GET 列表：迁移产物
    const list = okData<{ id: string }[]>(await callApi(h.port, "GET", "/api/presets"));
    assert.deepEqual(list.map((p) => p.id), ["migrated-default"]);

    // save：新建（id 缺省由服务端生成）
    const saved = okData<{ configRevision: number; view: { presets: { id: string; name: string }[] } }>(
      await callApi(h.port, "POST", "/api/presets", {
        preset: { name: "第二预设", provider: "deepseek", baseUrl: "https://api2.example.com", model: "m2", secretKind: "deepseek" },
        baseConfigRevision: rev,
      }),
    );
    rev = saved.configRevision;
    assert.equal(saved.view.presets.length, 2);
    const created = saved.view.presets.find((p) => p.name === "第二预设")!;
    assert.ok(created.id.length > 0);

    // duplicate migrated-default
    const dup = okData<{ configRevision: number; view: { presets: { id: string; name: string }[] } }>(
      await callApi(h.port, "POST", "/api/presets/migrated-default/duplicate", { baseConfigRevision: rev }),
    );
    rev = dup.configRevision;
    const copy = dup.view.presets.find((p) => p.name === "migrated-default (副本)")!;
    assert.ok(copy);

    // delete 绑定中的 migrated-default → 409 PRESET_IN_USE
    failCode(await callApi(h.port, "DELETE", "/api/presets/migrated-default", { baseConfigRevision: rev }), 409, "PRESET_IN_USE");
    // delete 未绑定的副本 → 200
    const del = okData<{ configRevision: number; view: { presets: { id: string }[] } }>(
      await callApi(h.port, "DELETE", `/api/presets/${copy.id}`, { baseConfigRevision: rev }),
    );
    rev = del.configRevision;
    assert.ok(!del.view.presets.some((p) => p.id === copy.id));
    assert.ok(!fs.existsSync(path.join(h.dirs.presetsDir, `${copy.id}.json`)));

    // 404：duplicate/delete 不存在的 id
    failCode(await callApi(h.port, "POST", "/api/presets/nope/duplicate", { baseConfigRevision: rev }), 404, "PRESET_NOT_FOUND");
    failCode(await callApi(h.port, "DELETE", "/api/presets/nope", { baseConfigRevision: rev }), 404, "PRESET_NOT_FOUND");
    // 409：旧 revision
    failCode(await callApi(h.port, "DELETE", `/api/presets/${created.id}`, { baseConfigRevision: 0 }), 409, "CONFIG_REVISION_CONFLICT");
    // 400：preset 载荷非法
    failCode(await callApi(h.port, "POST", "/api/presets", { preset: { name: "x" }, baseConfigRevision: rev }), 400, "VALIDATION_ERROR");
  });
});

describe("world / characters 域", () => {
  it("worlds 列表 / world 读取 / WORLD_SET_NOT_FOUND / PUT note / 未知文件名 404", async (t) => {
    const h = await serverHarness(t);
    const worlds = okData<{ sets: string[] }>(await callApi(h.port, "GET", "/api/worlds"));
    assert.deepEqual(worlds.sets, ["w"]);
    const world = okData<{ setting: string; toneCard: string; lorebook: unknown }>(
      await callApi(h.port, "GET", "/api/world?set=w"),
    );
    assert.ok(world.setting.includes("测试世界设定"));
    failCode(await callApi(h.port, "GET", "/api/world?set=nope"), 404, "WORLD_SET_NOT_FOUND");
    const saved = okData<{ note: string }>(
      await callApi(h.port, "PUT", "/api/world/setting?set=w", { content: "改写后的设定\n" }),
    );
    assert.equal(saved.note, "已保存，修改在新会话生效");
    assert.equal(
      fs.readFileSync(path.join(h.dirs.assetsDir, "w", "setting.md"), "utf8"),
      "改写后的设定\n",
    );
    failCode(await callApi(h.port, "PUT", "/api/world/bogus?set=w", { content: "x" }), 404, "UNKNOWN_ENDPOINT");
  });

  it("变量体系端点：GET 缺省空结构 / PUT 校验失败 400 零落盘 / 成功写盘 note / tags 只读", async (t) => {
    const h = await serverHarness(t);
    const packDir = path.join(h.dirs.assetsDir, "w");

    // 包内三文件齐备：GET 原样返回（harness 模板含 character 根保留名）
    const tpl = okData<{ character: { children: Record<string, unknown> } }>(
      await callApi(h.port, "GET", "/api/world/vars-template?set=w"),
    );
    assert.ok("attachtags" in tpl.character.children);
    const registry = okData<Record<string, unknown>>(await callApi(h.port, "GET", "/api/world/tags?set=w"));
    assert.ok("aud" in registry); // harness 注册表 = 六 system 条目
    assert.deepEqual(await callApi(h.port, "GET", "/api/world/vars-tags?set=w").then(okData), {
      world: {},
      character: {},
    });

    // 缺文件：GET 回缺省空结构（模板 = 最小保留名 / 附加 = 空双根 / 注册表 = 空对象）
    fs.rmSync(path.join(packDir, "vars-template.json"));
    fs.rmSync(path.join(packDir, "vars-tags.json"));
    fs.rmSync(path.join(packDir, "tags.json"));
    const emptyTpl = okData<{ world: unknown; character: { children: Record<string, unknown> }; types: unknown }>(
      await callApi(h.port, "GET", "/api/world/vars-template?set=w"),
    );
    assert.deepEqual(emptyTpl.world, { children: {} });
    assert.ok("attachtags" in emptyTpl.character.children && "tags" in emptyTpl.character.children);
    assert.deepEqual(emptyTpl.types, {});
    assert.deepEqual(await callApi(h.port, "GET", "/api/world/vars-tags?set=w").then(okData), {
      world: {},
      character: {},
    });
    assert.deepEqual(await callApi(h.port, "GET", "/api/world/tags?set=w").then(okData), {});

    // PUT vars-template：character 根缺保留名 → 400 VALIDATION_ERROR 零落盘
    failCode(
      await callApi(h.port, "PUT", "/api/world/vars-template?set=w", { world: { children: {} }, character: { children: {} } }),
      400,
      "VALIDATION_ERROR",
    );
    assert.ok(!fs.existsSync(path.join(packDir, "vars-template.json")), "校验失败不得落盘");

    // PUT vars-template：合法（缺省空结构原样回写）→ note + 创建文件 + GET 可读
    const savedTpl = okData<{ note: string }>(
      await callApi(h.port, "PUT", "/api/world/vars-template?set=w", emptyTpl),
    );
    assert.equal(savedTpl.note, "已保存，修改在新会话生效");
    assert.ok(fs.existsSync(path.join(packDir, "vars-template.json")), "PUT 创建缺文件");

    // PUT vars-tags：路径不在模板中 → 400 零落盘
    failCode(
      await callApi(h.port, "PUT", "/api/world/vars-tags?set=w", {
        world: { children: { nosuch: { tags: [{ name: "x", level: 1 }] } } },
        character: {},
      }),
      400,
      "VALIDATION_ERROR",
    );
    assert.ok(!fs.existsSync(path.join(packDir, "vars-tags.json")), "校验失败不得落盘");

    // PUT vars-tags：合法（character 根 attachtags 整型条目）→ note + 写盘
    const savedTags = okData<{ note: string }>(
      await callApi(h.port, "PUT", "/api/world/vars-tags?set=w", {
        world: {},
        character: { children: { attachtags: { tags: [{ name: "aud", level: 2 }] } } },
      }),
    );
    assert.equal(savedTags.note, "已保存，修改在新会话生效");
    const roundTrip = okData<{ character: { children: Record<string, unknown> } }>(
      await callApi(h.port, "GET", "/api/world/vars-tags?set=w"),
    );
    assert.deepEqual(roundTrip.character.children.attachtags, { tags: [{ name: "aud", level: 2 }] });

    // tags.json 只读：PUT → 404；旧三文件名不走新 GET
    failCode(await callApi(h.port, "PUT", "/api/world/tags?set=w", {}), 404, "UNKNOWN_ENDPOINT");
    failCode(await callApi(h.port, "GET", "/api/world/setting?set=w"), 404, "UNKNOWN_ENDPOINT");
  });

  it("characters 列表/单读/CHARACTER_NOT_FOUND/PUT 校验", async (t) => {
    const h = await serverHarness(t);
    const list = okData<{ id: string; manifest: unknown }[]>(await callApi(h.port, "GET", "/api/characters?set=w"));
    assert.deepEqual(list.map((c) => c.id), ["C0", "C1"]);
    const one = okData<{ id: string; name: string }>(await callApi(h.port, "GET", "/api/characters/C1?set=w"));
    assert.equal(one.name, "同伴");
    failCode(await callApi(h.port, "GET", "/api/characters/C999?set=w"), 404, "CHARACTER_NOT_FOUND");
    // PUT：manifest.id 与路径不一致 → 400 VALIDATION_ERROR
    failCode(
      await callApi(h.port, "PUT", "/api/characters/C1?set=w", { id: "C2" }),
      400,
      "VALIDATION_ERROR",
    );
  });
});

describe("sessions 域：产物读取错误矩阵", () => {
  it("列表 / 正常产物 / 未知产物 / RUN_NOT_FOUND / LEGACY / CORRUPT / 产物缺失", async (t) => {
    const h = await serverHarness(t);
    const runsDir = h.dirs.saveDir;
    mkRun(runsDir, "run-ok");
    // 旧平铺档（无 CURRENT）
    fs.mkdirSync(path.join(runsDir, "run-legacy"), { recursive: true });
    fs.writeFileSync(path.join(runsDir, "run-legacy", "events.json"), `{"schema_version":1,"events":[]}`);
    // CURRENT 指向的 Generation 缺 events.json
    fs.mkdirSync(path.join(runsDir, "run-no-gen", "generations", "000001"), { recursive: true });
    fs.writeFileSync(path.join(runsDir, "run-no-gen", "CURRENT"), "000001");
    // events.json 损坏
    const corruptGen = path.join(runsDir, "run-corrupt", "generations", "000001");
    fs.mkdirSync(corruptGen, { recursive: true });
    fs.writeFileSync(path.join(runsDir, "run-corrupt", "CURRENT"), "000001");
    fs.writeFileSync(path.join(corruptGen, "events.json"), "{bad json");

    const list = okData<{ active: string | null; runs: { id: string }[] }>(
      await callApi(h.port, "GET", "/api/sessions"),
    );
    assert.equal(list.active, null);
    assert.ok(list.runs.some((r) => r.id === "run-ok"));

    const events = okData<{ events: { id: string }[] }>(await callApi(h.port, "GET", "/api/sessions/run-ok/events"));
    assert.equal(events.events[0]!.id, "evt_1");
    // stats 旁路产物：缺文件 = 空数组
    assert.deepEqual(okData<unknown[]>(await callApi(h.port, "GET", "/api/sessions/run-ok/stats")), []);

    failCode(await callApi(h.port, "GET", "/api/sessions/run-ok/bogus"), 400, "VALIDATION_ERROR");
    failCode(await callApi(h.port, "GET", "/api/sessions/nope/events"), 404, "RUN_NOT_FOUND");
    failCode(await callApi(h.port, "GET", "/api/sessions/run-legacy/events"), 404, "LEGACY_RUN_UNSUPPORTED");
    failCode(await callApi(h.port, "GET", "/api/sessions/run-no-gen/events"), 404, "RUN_NOT_FOUND");
    failCode(await callApi(h.port, "GET", "/api/sessions/run-corrupt/events"), 500, "RUN_CORRUPT");
  });

  it("rename / delete：别名写入回环、非法别名 400、不存在 404", async (t) => {
    const h = await serverHarness(t);
    mkRun(h.dirs.saveDir, "run-a");
    const renamed = await callApi(h.port, "POST", "/api/sessions/run-a/rename", { alias: "灯塔之夜" });
    assert.equal(renamed.status, 200);
    assert.deepEqual(renamed.json, { ok: true, data: {} });
    const list = okData<{ runs: { id: string; alias?: string }[] }>(await callApi(h.port, "GET", "/api/sessions"));
    assert.equal(list.runs.find((r) => r.id === "run-a")?.alias, "灯塔之夜");

    failCode(await callApi(h.port, "POST", "/api/sessions/nope/rename", { alias: "x" }), 404, "RUN_NOT_FOUND");
    failCode(await callApi(h.port, "POST", "/api/sessions/run-a/rename", { alias: "a/b" }), 400, "VALIDATION_ERROR");
    failCode(await callApi(h.port, "POST", "/api/sessions/run-a/rename", {}), 400, "VALIDATION_ERROR");
    failCode(await callApi(h.port, "DELETE", "/api/sessions/nope"), 404, "RUN_NOT_FOUND");
    const del = await callApi(h.port, "DELETE", "/api/sessions/run-a");
    assert.equal(del.status, 200);
    assert.ok(!fs.existsSync(path.join(h.dirs.saveDir, "run-a")));
  });
});

describe("prompts 域", () => {
  it("placeholders 目录 200；?set= 定位包内 prompts/（缺包 404；模板缺失 500）", async (t) => {
    const h = await serverHarness(t);
    const catalog = okData<{ agent: string }[]>(await callApi(h.port, "GET", "/api/prompts/placeholders"));
    assert.deepEqual(catalog.map((c) => c.agent), ["character", "gm", "prose"]);
    // ?set=w 命中 harness 包（setupWorld 已拷入三份模板）→ 200 三模板
    const templates = okData<{ id: string }[]>(await callApi(h.port, "GET", "/api/prompts?set=w"));
    assert.deepEqual(templates.map((tpl) => tpl.id), ["character", "gm", "prose"]);
    // 不存在的包 → 404 WORLD_SET_NOT_FOUND
    failCode(await callApi(h.port, "GET", "/api/prompts?set=nope"), 404, "WORLD_SET_NOT_FOUND");
    // 包存在但无 prompts/ 模板文件 → 未预期 fs 错误映射 500（不再一律 400）
    fs.mkdirSync(path.join(h.dirs.assetsDir, "bare"), { recursive: true });
    failCode(await callApi(h.port, "GET", "/api/prompts?set=bare"), 500, "INTERNAL_ERROR");
    failCode(await callApi(h.port, "PUT", "/api/prompts/npc?set=w", { id: "npc", modules: [] }), 400, "VALIDATION_ERROR");
  });
});

describe("HTTP mutation 与 WS transition 广播（边界联证）", () => {
  it("直编成功 → WS 恰收一条 transition（admin_edit）；直编失败 → 无广播；删活跃会话 → 409 SESSION_ACTIVE", async (t) => {
    const h = await serverHarness(t);
    const ws = await h.connect();
    // 建会话（worldSetId=w；init 提交会先发一条 transition + snapshot 广播）
    ws.send({ type: "new_session", worldSetId: "w", requestId: "r-new" });
    const snapshot = await ws.waitFor((m) => m.type === "snapshot");
    const runId = snapshot.runId as string;
    const transitionsBefore = ws.messages.filter((m) => m.type === "transition").length;

    // 成功直编：world 加变量（snapshot.state.world 含 time 锚）
    const world = { ...(snapshot.state as { world: Record<string, unknown> }).world, hp: 42 };
    const ok = await callApi(h.port, "PUT", "/api/session/state", { world });
    assert.equal(ok.status, 200);
    assert.equal(okData<{ note: string }>(ok).note, "已保存，立即生效");
    const transition = await ws.waitFor((m) => m.type === "transition" && m.reason === "admin_edit");
    // 直编世界变量经模板 normalize 落为末端外壳 {value, tags}
    assert.deepEqual((transition.changed as { world: { hp: unknown } }).world.hp, { value: 42, tags: [] });
    const transitionsAfter = ws.messages.filter((m) => m.type === "transition").length;
    assert.equal(transitionsAfter - transitionsBefore, 1, "成功直编应恰广播一条 transition");

    // 失败直编：角色集合不一致 → 400 VALIDATION_ERROR，且无新 transition
    const bad = await callApi(h.port, "PUT", "/api/session/state", { characters: {} });
    failCode(bad, 400, "VALIDATION_ERROR");
    await new Promise((resolve) => setTimeout(resolve, 200));
    assert.equal(
      ws.messages.filter((m) => m.type === "transition").length,
      transitionsAfter,
      "失败直编不得广播",
    );

    // 删除活跃会话 → 409 SESSION_ACTIVE
    failCode(await callApi(h.port, "DELETE", `/api/sessions/${runId}`), 409, "SESSION_ACTIVE");
    ws.close();
  });
});
