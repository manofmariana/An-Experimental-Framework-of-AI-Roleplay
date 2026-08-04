import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { CHARACTER_PLACEHOLDERS, type CharacterContext } from "../src/agents/character.js";
import { GM_PLACEHOLDERS, validateAdjudicationRound, type GmContext } from "../src/agents/gm.js";
import type { GameSession } from "../src/application/gameSession.js";
import type { CharacterState } from "../src/truth/charactersStore.js";
import { snapshotCharacterState, snapshotCharacterStates } from "../src/truth/snapshot.js";
import { worldTimeToMinutes } from "../src/truth/timeStore.js";
import { AdjudicationPackageSchema } from "../src/types.js";
import { buildAdjudication as gmPkg, buildCharacterState as state } from "./builders/index.js";
import { SessionHarness } from "./harness/session.js";

// ---------------------------------------------------------------------------
// 集成测试基建：SessionHarness（与 loopSchedule.test.ts 同模式）
// ---------------------------------------------------------------------------

const h = new SessionHarness("airp-gm-timer-");
const llm = h.llm;
const calls = llm.port.calls;
const setupWorld = h.setupWorld.bind(h);
const callsText = h.callsText.bind(h);
const charState = h.charState.bind(h);

function makeSession(
  runId: string,
  worldId: string,
  dice: number[],
  gm: Record<string, unknown>[],
): GameSession {
  return h.makeSession(runId, worldId, { dice, gm, gmIntervalCycles: 5 });
}

// ---------------------------------------------------------------------------

describe("中途 GM 的 durations 覆盖契约（同步组全体成员必须一并覆盖）", () => {
  it("expectedGmDurationCids：同组全体成员（无论 timer 到期与否、甚至为 null）并入期望集；后台他组角色不进", async () => {
    const worldId = `w-gt1-${process.pid}`;
    setupWorld(worldId, [
      { id: "C0", name: "玩家", location: "loc_A", timer: 0, isPlayer: true },
      { id: "C1001", name: "甲", location: "loc_A", timer: 0 },
      { id: "C1002", name: "乙", location: "loc_B", timer: 30 },
    ]);
    const runId = `run-gt1-${process.pid}`;
    const session = makeSession(runId, worldId, [20, 5], []);
    // 开局组已派生：C0 与 C1001 同组（非 0），C1002 他组后台
    assert.equal(charState(session, "C0").group, charState(session, "C1001").group);
    assert.notEqual(charState(session, "C0").group, 0);
    const internals = session as unknown as {
      liveTruth(): unknown;
      expectedGmDurationCids(truth: unknown, cids: string[]): string[];
      characters: { setVars(cid: string, patch: { timer: number | null }): unknown };
    };
    const helper = (cids: string[]): string[] =>
      internals.expectedGmDurationCids(internals.liveTruth(), cids);
    // 中途 GM 形态：工作集仅 C0 → 期望集含同组的 C1001，不含后台他组的 C1002
    assert.deepEqual(helper(["C0"]), ["C0", "C1001"]);
    // 覆盖以组成员身份为准而非到期状态：timer > clock 或 timer = null 的组成员同样必须被覆盖
    internals.characters.setVars("C1001", { timer: 100 });
    assert.deepEqual(helper(["C0"]), ["C0", "C1001"], "timer 未到期的组成员也必须被覆盖");
    internals.characters.setVars("C1001", { timer: null });
    assert.deepEqual(helper(["C0"]), ["C0", "C1001"], "timer 为 null 的组成员同样包含（GM 设 timer 无害）");
    internals.characters.setVars("C1001", { timer: 0 });
    // 周期末形态（全员已行动、都在工作集）：期望集 == 行动者集合，与旧契约等价
    assert.deepEqual(helper(["C0", "C1001"]), ["C0", "C1001"]);
  });

  it("中途 GM 集成：gm_request 激活时工作集只有行动者，裁决包覆盖同组未行动成员才通过", async () => {
    const worldId = `w-gt2-${process.pid}`;
    setupWorld(worldId, [
      { id: "C0", name: "玩家", location: "loc_A", timer: 0, isPlayer: true },
      { id: "C1001", name: "甲", location: "loc_A", timer: 0 },
      { id: "C1002", name: "乙", location: "loc_B", timer: 30 },
    ]);
    const runId = `run-gt2-${process.pid}`;
    const session = makeSession(runId, worldId, [20, 5], [
      gmPkg({ durations: [{ cid: "C0", span: { min: 5 } }] }), // 首次：只覆盖行动者 → 缺少 C1001，重试
      gmPkg({ durations: [{ cid: "C0", span: { min: 5 } }, { cid: "C1001", span: { min: 5 } }] }), // 重试：精确覆盖
    ]);

    // C0（先攻 25 独占一批）立 gm_request → 批完成 → 立即 GM（工作集仅 C0，C1001 同组未行动）
    assert.equal(session.pipelineInfo.phase, "await_player");
    const preGroup = charState(session, "C0").group;
    await session.handlePlayerInput(
      JSON.stringify({ action: "环顾四周", inner: "心里没底", markers: [{ type: "gm_request" }] }),
    );
    assert.equal(session.turnCount, 2);
    assert.equal(calls.filter((c) => c.agent === "gm").length, 2, "首次覆盖不全触发同机制内重试");
    assert.deepEqual(
      [...session.getArchive(), session.getPipelineCurrent()!].map((e) => `${e.seq}:${e.kind}`),
      ["1:player", "2:gm"],
    );
    // 双方 timer 都被推进且 span 一致（未行动成员不滞留原值，组不撕裂）
    assert.equal(charState(session, "C0").timer, 5);
    assert.equal(charState(session, "C1001").timer, 5);
    // 周期状态不被打乱（断言现状行为，规则本身不动）：组编号存续、未行动成员保持 acted=false、
    // 组结算进后台后全员 acted 重置（规则③）、周期计数 X 归 0
    assert.equal(charState(session, "C0").group, preGroup, "span 一致 → 组编号存续");
    assert.equal(charState(session, "C1001").group, preGroup);
    assert.equal(charState(session, "C1001").acted, false, "未行动成员保持 acted=false");
    assert.equal(charState(session, "C0").acted, false, "组结算进后台：全员 acted 重置");
    assert.equal(
      (session.getState().world as Record<string, unknown>)["cycles_since_gm"],
      0,
      "组结算进后台：周期计数 X 归 0",
    );
    // GM 注入的 timers 占位符按 acted 标注：C0 已行动 / C1001 未行动
    const gmPrompt = callsText("gm", 2);
    assert.ok(gmPrompt.includes("@C0：已到期（已行动）"));
    assert.ok(gmPrompt.includes("@C1001：已到期（未行动）"));
    // 快照注入的 timer 为结构化时间（与世界时钟同形）
    assert.ok(gmPrompt.includes('"timer":{"y":0,"m":1,"d":1,"h":0,"min":0}'), "快照 timer 不得是分钟标量");
  });
});

describe("validateAdjudicationRound 文案与校验（基准集合 = 期望 durations 覆盖集）", () => {
  const base = { events: [], narrativity: "skip", deltas: [], location: [] };
  it("缺少未行动在场成员 → 报缺少；多给后台他组角色 → 报越界", () => {
    const onlyActor = AdjudicationPackageSchema.parse({ ...base, durations: [{ cid: "C0", span: { min: 5 } }] });
    assert.throws(
      () => validateAdjudicationRound(onlyActor, ["C0", "C1001"]),
      /必须精确覆盖同步组全体成员（含刚离组者）且不重复（缺少: C1001/,
    );
    const extraBackground = AdjudicationPackageSchema.parse({
      ...base,
      durations: [
        { cid: "C0", span: { min: 5 } },
        { cid: "C1001", span: { min: 5 } },
        { cid: "C1002", span: { min: 5 } },
      ],
    });
    assert.throws(
      () => validateAdjudicationRound(extraBackground, ["C0", "C1001"]),
      /越界: C1002/,
    );
    // location 校验基准同样随入参扩大：期望集内的未行动成员可设 location，集外不可
    const withLocation = AdjudicationPackageSchema.parse({
      ...base,
      durations: [{ cid: "C0", span: { min: 5 } }, { cid: "C1001", span: { min: 5 } }],
      location: [{ cid: "C1001", location: { name: "移位", level: 1 } }],
    });
    assert.doesNotThrow(() => validateAdjudicationRound(withLocation, ["C0", "C1001"]));
    const badLocation = AdjudicationPackageSchema.parse({
      ...base,
      durations: [{ cid: "C0", span: { min: 5 } }, { cid: "C1001", span: { min: 5 } }],
      location: [{ cid: "C1002", location: { name: "越界", level: 1 } }],
    });
    assert.throws(
      () => validateAdjudicationRound(badLocation, ["C0", "C1001"]),
      /location cid 只能是不重复的上述集合子集（越界: C1002/,
    );
  });
});

// ---------------------------------------------------------------------------
// 快照 timer 结构化渲染（Task 2）与占位符单测基建
// ---------------------------------------------------------------------------

function charCtx(selfCid: string, states: Record<string, CharacterState>): CharacterContext {
  return {
    selfCid, states, cast: [], worldSnapshot: "{}", activatedLore: "", recentEvents: [],
    proseWindow: [], currentScene: "", timeHeader: "", clock: 10,
  };
}

describe("快照注入的 timer 结构化渲染", () => {
  it("snapshotCharacterState 两态：null / 正常分钟值；其余字段原样透传", () => {
    const base = state({ name: "甲", timer: null });
    assert.deepEqual(snapshotCharacterState(base), { ...base, timer: null });

    const minutes = worldTimeToMinutes({ y: 2, m: 3, d: 4, h: 5, min: 6 });
    const timed = state({ name: "乙", timer: minutes });
    assert.deepEqual(snapshotCharacterState(timed), { ...timed, timer: { y: 2, m: 3, d: 4, h: 5, min: 6 } });

    const many = snapshotCharacterStates({ C1: timed, C2: base });
    assert.deepEqual(many["C1"]!.timer, { y: 2, m: 3, d: 4, h: 5, min: 6 });
    assert.equal(many["C2"]!.timer, null);
  });

  it("character_snapshot / characters_snapshot 占位符输出结构化 timer", () => {
    const minutes = worldTimeToMinutes({ y: 1, m: 1, d: 1, h: 6, min: 30 });
    const states: Record<string, CharacterState> = {
      C0: state({ name: "玩家", isPlayer: true, timer: minutes }),
      C1001: state({ name: "甲", timer: null }),
    };
    const selfSnap = JSON.parse(CHARACTER_PLACEHOLDERS.character_snapshot!.provide(charCtx("C0", states))) as {
      timer: unknown;
    };
    assert.deepEqual(selfSnap.timer, { y: 1, m: 1, d: 1, h: 6, min: 30 });

    const gmCtx: GmContext = {
      setting: "", cast: [], loreFull: "", events: [], proseWindow: [], currentScene: "",
      worldSnapshot: "{}", states, clock: 10, timeHeader: "",
    };
    const allSnap = JSON.parse(GM_PLACEHOLDERS.characters_snapshot!.provide(gmCtx)) as Record<string, { timer: unknown }>;
    assert.deepEqual(allSnap["C0"]!.timer, { y: 1, m: 1, d: 1, h: 6, min: 30 });
    assert.equal(allSnap["C1001"]!.timer, null);
  });

  it("GM timers 占位符按 acted 区分标注；未到期与无计时器分支不变", () => {
    const states: Record<string, CharacterState> = {
      C0: state({ name: "玩家", isPlayer: true, timer: 5, acted: true }), // 已到期已行动
      C1001: state({ name: "甲", timer: 5, acted: false }), // 已到期未行动
      C1002: state({ name: "乙", timer: 100 }), // 未到期
      C1003: state({ name: "丙", timer: null }), // 无计时器
    };
    const gmCtx: GmContext = {
      setting: "", cast: [], loreFull: "", events: [], proseWindow: [], currentScene: "",
      worldSnapshot: "{}", states, clock: 10, timeHeader: "",
    };
    const out = GM_PLACEHOLDERS.timers!.provide(gmCtx);
    assert.ok(out.includes("- @C0：已到期（已行动）"));
    assert.ok(out.includes("- @C1001：已到期（未行动）"));
    assert.ok(out.includes("- @C1002：") && out.includes("后到期"));
    assert.ok(out.includes("- @C1003：无计时器"));
    assert.ok(!out.includes("本轮行动"), "旧标注已移除");
  });
});

// ---------------------------------------------------------------------------

describe("group_members 占位符（同组角色表）", () => {
  it("单人组（group === 0）→ 空串", () => {
    const states: Record<string, CharacterState> = {
      C0: state({ name: "玩家", isPlayer: true, group: 0 }),
      C1001: state({ name: "甲", group: 3, location: { name: "灯塔", level: 1 } }),
    };
    assert.strictEqual(CHARACTER_PLACEHOLDERS.group_members!.provide(charCtx("C0", states)), "");
  });

  it("多人组：按 cid 排序、含自己并标注（你）、含地点名；他组成员不进", () => {
    const states: Record<string, CharacterState> = {
      C0: state({ name: "玩家", isPlayer: true, group: 2, location: { name: "广场", level: 1 } }),
      C1001: state({ name: "甲", group: 2, location: { name: "广场", level: 1 } }),
      C1002: state({ name: "乙", group: 2, location: { name: "码头", level: 1 } }),
      C1003: state({ name: "丙", group: 5, location: { name: "灯塔", level: 1 } }),
    };
    const out = CHARACTER_PLACEHOLDERS.group_members!.provide(charCtx("C1001", states));
    assert.equal(
      out,
      "- @C0 玩家（广场）\n- @C1001 甲（广场）（你）\n- @C1002 乙（码头）",
    );
    // 视角换成玩家：标注随行
    const outC0 = CHARACTER_PLACEHOLDERS.group_members!.provide(charCtx("C0", states));
    assert.ok(outC0.includes("- @C0 玩家（广场）（你）"));
    assert.ok(!outC0.includes("@C1003"), "他组成员不进同组角色表");
  });
});
