/**
 * web/async-guards.js 单元测试（unit 层）：四个竞态的可测纯逻辑——
 * 竞态 1 会话详情 epoch 守卫 + fetchRunDetail 取数归一（fake apiFn 驱动）；
 * 竞态 2 fetchKnownChars 身份取数 + sameCharsIdentity 写闸；
 * 竞态 3 loadSessionThenNavigate（fake sendCommand 可控 resolve/reject，成功才导航）；
 * 竞态 4 isModalLive（runId 身份 + isConnected 双核验）。
 * 零 IO：全部 fake 注入。
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  createEpochGuard,
  fetchKnownChars,
  fetchRunDetail,
  isModalLive,
  loadSessionThenNavigate,
  sameCharsIdentity,
} from "../web/async-guards.js";

// ---------------------------------------------------------------------------
// 竞态 1：会话详情 A/B 晚到互写
// ---------------------------------------------------------------------------

describe("竞态 1：createEpochGuard + fetchRunDetail", () => {
  it("epoch 守卫：新 begin 作废旧令牌（A 晚到即弃，只接受 B）", () => {
    const guard = createEpochGuard();
    const a = guard.begin();
    const b = guard.begin();
    assert.equal(guard.isCurrent(a), false);
    assert.equal(guard.isCurrent(b), true);
  });

  it("fetchRunDetail：六端点并发取数 + 形状归一（缺字段给默认值）", async () => {
    const paths: string[] = [];
    const apiFn = async (path: string): Promise<unknown> => {
      paths.push(path);
      if (path.endsWith("/events")) return { events: [{ id: "e1", seq: 1 }] };
      if (path.endsWith("/world")) return { world: { hp: 1 } };
      if (path.endsWith("/characters")) return {}; // 缺 characters 字段 → 默认 {}
      if (path.endsWith("/archive")) return { entries: [{ seq: 1, kind: "input" }] };
      if (path.endsWith("/sys")) return { pipeline: { seq: 2 } }; // pipeline 随 sys 根
      return [{ hit: 1 }]; // stats
    };
    const data = await fetchRunDetail(apiFn, "000001");
    assert.deepEqual(paths, [
      "/api/sessions/000001/events",
      "/api/sessions/000001/world",
      "/api/sessions/000001/characters",
      "/api/sessions/000001/archive",
      "/api/sessions/000001/sys",
      "/api/sessions/000001/stats",
    ]);
    assert.deepEqual(data.events, [{ id: "e1", seq: 1 }]);
    assert.deepEqual(data.world, { hp: 1 });
    assert.deepEqual(data.pipeline, { seq: 2 });
    assert.deepEqual(data.characters, {});
    assert.deepEqual(data.archive, [{ seq: 1, kind: "input" }]);
    assert.deepEqual(data.stats, [{ hit: 1 }]);
  });

  it("fetchRunDetail：任一端点失败原样抛出（页面层经 epoch 核验后落错误行）", async () => {
    const apiFn = async (path: string): Promise<unknown> => {
      if (path.endsWith("/world")) {
        const err = new Error("旧档") as Error & { code: string };
        err.code = "LEGACY_RUN_UNSUPPORTED";
        throw err;
      }
      return {};
    };
    await assert.rejects(() => fetchRunDetail(apiFn, "000002"), /旧档/);
  });
});

// ---------------------------------------------------------------------------
// 竞态 2：world A→B 角色 CID 请求逆序覆盖 knownChars
// ---------------------------------------------------------------------------

describe("竞态 2：fetchKnownChars + sameCharsIdentity", () => {
  it("有活跃会话：读档内 characters，C0 玩家恒排除", async () => {
    const apiFn = async (path: string): Promise<unknown> => {
      assert.equal(path, "/api/sessions/000003/characters");
      return { characters: { C0: { name: "玩家" }, C1001: { name: "甲" }, C1002: {} } };
    };
    const list = await fetchKnownChars(apiFn, { runId: "000003", worldSetId: "baitan" });
    assert.deepEqual(list, [
      { cid: "C1001", name: "甲" },
      { cid: "C1002", name: "C1002" }, // 缺 name 回落 cid
    ]);
  });

  it("无会话：读世界设定集 manifest，?set= 编码携带", async () => {
    const apiFn = async (path: string): Promise<unknown> => {
      assert.equal(path, `/api/characters?set=${encodeURIComponent("包 甲")}`);
      return [
        { id: "C0", manifest: { name: "玩家" } },
        { id: "C1001", manifest: { name: "乙" } },
      ];
    };
    const list = await fetchKnownChars(apiFn, { runId: null, worldSetId: "包 甲" });
    assert.deepEqual(list, [{ cid: "C1001", name: "乙" }]);
  });

  it("无会话且空 worldSetId：不带 query", async () => {
    const apiFn = async (path: string): Promise<unknown> => {
      assert.equal(path, "/api/characters");
      return [];
    };
    assert.deepEqual(await fetchKnownChars(apiFn, { runId: null }), []);
  });

  it("sameCharsIdentity：runId 或 worldSetId 变化即 false（晚到响应不得写入）", () => {
    const a = { runId: null, worldSetId: "set-a" };
    assert.equal(sameCharsIdentity(a, { runId: null, worldSetId: "set-a" }), true);
    assert.equal(sameCharsIdentity(a, { runId: null, worldSetId: "set-b" }), false); // world A→B
    assert.equal(sameCharsIdentity(a, { runId: "000001", worldSetId: "set-a" }), false); // 会话建立
    assert.equal( // undefined 与 "" 同义（选择器未挂载的极端时序）
      sameCharsIdentity({ runId: null }, { runId: null, worldSetId: "" }),
      true,
    );
  });
});

// ---------------------------------------------------------------------------
// 竞态 3：WS 未连接读档仍导航
// ---------------------------------------------------------------------------

describe("竞态 3：loadSessionThenNavigate", () => {
  it("command_result 成功（按 requestId 匹配的应答）才导航游玩页", async () => {
    const sent: Array<{ type: string; fields?: Record<string, unknown> }> = [];
    const navigated: string[] = [];
    await loadSessionThenNavigate(
      {
        sendCommand: async (type, fields) => {
          sent.push({ type, ...(fields !== undefined ? { fields } : {}) });
        },
        navigate: (page) => {
          navigated.push(page);
        },
      },
      "000001",
    );
    assert.deepEqual(sent, [{ type: "load_session", fields: { runId: "000001" } }]);
    assert.deepEqual(navigated, ["play"]);
  });

  it("失败（含 WS 未连接立即 reject）不导航，错误原样抛出", async () => {
    const navigated: string[] = [];
    await assert.rejects(
      () =>
        loadSessionThenNavigate(
          {
            sendCommand: async () => {
              throw new Error("WS 未连接");
            },
            navigate: (page) => {
              navigated.push(page);
            },
          },
          "000001",
        ),
      /WS 未连接/,
    );
    assert.deepEqual(navigated, []);
  });
});

// ---------------------------------------------------------------------------
// 竞态 4：会话绑定 modal 晚到
// ---------------------------------------------------------------------------

describe("竞态 4：isModalLive", () => {
  it("捕获 runId 与当前一致 且 元素在 DOM 才存活", () => {
    assert.equal(isModalLive("000001", "000001", true), true);
    assert.equal(isModalLive("000001", "000002", true), false); // 会话已切：晚到弃写
    assert.equal(isModalLive("000001", "000001", false), false); // modal 已统一关闭
    assert.equal(isModalLive(null, null, true), true); // 打开时无会话的极端时序
    assert.equal(isModalLive(null, "000001", true), false); // 打开后建立了会话
  });
});
