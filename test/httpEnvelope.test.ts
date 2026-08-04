/**
 * HTTP envelope 集成测试（优化阶段 D3，docs/optimization-review.md §9「HTTP envelope」
 * 「测试收敛」）：真实 HTTP（serverHarness + fetch）逐端点验证统一 envelope
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

describe("config 域", () => {
  it("GET 缺文件 = 空对象；PUT 成功带 note 且落盘；BAD_JSON / VALIDATION_ERROR", async (t) => {
    const h = await serverHarness(t);
    // GET：文件缺失 → 200 空对象
    const empty = okData<Record<string, unknown>>(await callApi(h.port, "GET", "/api/config"));
    assert.deepEqual(empty, {});
    // PUT：非法 JSON → 400 BAD_JSON
    failCode(await callApi(h.port, "PUT", "/api/config", undefined, "{bad"), 400, "BAD_JSON");
    // PUT：字段校验失败 → 400 VALIDATION_ERROR
    failCode(await callApi(h.port, "PUT", "/api/config", { gm_interval_cycles: 0 }), 400, "VALIDATION_ERROR");
    failCode(await callApi(h.port, "PUT", "/api/config", { agents: { npc: {} } }), 400, "VALIDATION_ERROR");
    // PUT：合法（含未知注释字段 passthrough）→ 200 note + 落盘
    const saved = okData<{ note: string }>(
      await callApi(h.port, "PUT", "/api/config", { model: "m-test", _说明: "注释" }),
    );
    assert.equal(saved.note, "已保存，立即生效");
    const onDisk = JSON.parse(fs.readFileSync(h.configFile, "utf8")) as Record<string, unknown>;
    assert.equal(onDisk.model, "m-test");
    assert.equal(onDisk._说明, "注释");
    // GET 读回
    const back = okData<Record<string, unknown>>(await callApi(h.port, "GET", "/api/config"));
    assert.equal(back.model, "m-test");
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
      fs.readFileSync(path.join(h.dirs.worldsDir, "w", "setting.md"), "utf8"),
      "改写后的设定\n",
    );
    failCode(await callApi(h.port, "PUT", "/api/world/bogus?set=w", { content: "x" }), 404, "UNKNOWN_ENDPOINT");
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
    const runsDir = h.dirs.runsDir;
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
    mkRun(h.dirs.runsDir, "run-a");
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
    assert.ok(!fs.existsSync(path.join(h.dirs.runsDir, "run-a")));
  });
});

describe("prompts 域", () => {
  it("placeholders 目录 200；模板文件缺失（故障注入）→ 500 INTERNAL_ERROR", async (t) => {
    const h = await serverHarness(t);
    const catalog = okData<{ agent: string }[]>(await callApi(h.port, "GET", "/api/prompts/placeholders"));
    assert.deepEqual(catalog.map((c) => c.agent), ["character", "gm", "prose"]);
    // harness promptsDir 下无模板文件 → 未预期 fs 错误映射 500（不再一律 400）
    failCode(await callApi(h.port, "GET", "/api/prompts"), 500, "INTERNAL_ERROR");
    failCode(await callApi(h.port, "PUT", "/api/prompts/npc", { id: "npc", modules: [] }), 400, "VALIDATION_ERROR");
  });
});

describe("HTTP mutation 与 WS transition 广播（D3 边界联证）", () => {
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
    assert.equal((transition.changed as { world: { hp: number } }).world.hp, 42);
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
