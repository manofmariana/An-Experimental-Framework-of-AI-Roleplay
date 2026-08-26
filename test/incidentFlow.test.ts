import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { GameSession } from "../src/application/gameSession.js";
import { buildAdjudication as gmPkg } from "./builders/index.js";
import { SessionHarness } from "./harness/session.js";

// ---------------------------------------------------------------------------
// 突发管线集成：命中 → incident 步 → timer 对齐 → 注入派生 → 转写消解 → 回溯复活
// 世界：玩家 C0（loc_A level 1）+ 闭关的甲 C1001（山谷 level 90，timer 30 天）
// 时间原点 44640 分钟（time.json start 0年1月1日）；甲的剩余休眠 T = 43200 分钟
// 甲的错位度 D = 33·ln((90+10)/(1+10)) ≈ 72.84 → f≈0.991、g(30天)≈0.583、p≈0.578
// ---------------------------------------------------------------------------

const h = new SessionHarness("airp-incident-flow-");
const callsText = h.callsText.bind(h);
const charState = h.charState.bind(h);
const worldVars = h.worldVars.bind(h);

const INCIDENT_TEXT = "一伙山贼摸到了 @C1001 隐居的山谷外，正在扎营踩点。";

interface FlowOpts {
  dice: number[];
  gm: Record<string, unknown>[];
}

function makeFlow(runId: string, worldId: string, opts: FlowOpts): GameSession {
  return h.makeSession(runId, worldId, { dice: opts.dice, gmIntervalCycles: 3, gm: opts.gm });
}

function setup() {
  const worldId = `w-inc-${process.pid}-${Math.random().toString(36).slice(2, 8)}`;
  h.setupWorld(worldId, [
    { id: "C0", name: "玩家", location: "loc_A", timer: 0, isPlayer: true },
    { id: "C1001", name: "甲", location: "山谷", locationLevel: 90, timer: 43200 },
  ]);
  return worldId;
}

// 骰子队列（按消费序）：
//   GM#seq2 fortune 4 骰（d100 良性 + 2d20 + d20）→ 评估 1 骰（42 ≤ 57.8 命中）
//   → 突发 GM fortune 4 骰（d100=77 ≤ p恶性100 恶性）→ GM#seq5 fortune 4 骰
//   → 第二次评估 1 骰（100 未命中）→ GM#seq7 fortune 4 骰 → 第三次评估 1 骰（100 未命中）
//   → GM#seq9 fortune 4 骰 → 第四次评估 1 骰（100 未命中）
// 开局两人均为单人组（group 0），无先攻投掷。
const HIT_DICE = [40, 5, 5, 10, 42, 77, 12, 8, 15, 90, 3, 3, 3, 100, 30, 7, 7, 7, 100, 60, 9, 9, 9, 100];

const GM_ROUND1 = gmPkg({
  narrativity: "skip",
  events: [],
  durations: [{ cid: "C0", span: { min: 30 } }],
});
const GM_INCIDENT = { text: INCIDENT_TEXT, deltas: [] };
const GM_ROUND2 = gmPkg({
  narrativity: "skip",
  events: [{ text: "@C1001 发现了山贼的营地，悄悄退开了。", tags: [] }],
  durations: [{ cid: "C1001", span: { h: 1 } }],
});
// 第三轮：玩家 span 2h，让甲（timer = 时钟+60）先于玩家弹出，验证注入消解
const GM_ROUND3 = gmPkg({
  narrativity: "skip",
  events: [],
  durations: [{ cid: "C0", span: { h: 2 } }],
});
const GM_ROUND4 = gmPkg({
  narrativity: "skip",
  events: [],
  durations: [{ cid: "C1001", span: { h: 2 } }],
});

describe("突发事件管线", () => {
  it("命中 → incident 步归档 → timer 对齐 → 角色/GM 两侧注入 → GM 转写消解", async () => {
    const worldId = setup();
    const runId = `run-inc1-${process.pid}`;
    const session = makeFlow(runId, worldId, {
      dice: [...HIT_DICE],
      gm: [GM_ROUND1, GM_INCIDENT, GM_ROUND2, GM_ROUND3, GM_ROUND4],
    });

    // 玩家行动（seq1）→ 周期末 GM（seq2，skip）→ 突发评估命中 → incident 步（seq3）
    // → 甲 timer 对齐到期 → 甲行动（seq4）→ 周期末 GM 转写（seq5）→ 评估未命中 → 停等玩家
    await session.handlePlayerInput("玩家在村里走动");
    assert.equal(session.pipelineInfo.phase, "await_player");
    assert.deepEqual(
      session.getArchive().map((e) => `${e.seq}:${e.kind}`),
      ["1:player", "2:gm", "3:incident", "4:character:C1001"],
      "incident 是调度透明步：插在 GM 与甲的行动之间，不是裁决边界",
    );
    assert.equal(session.getPipelineCurrent()!.kind, "gm");

    // incident 步 result：slim 突发包 + 目标组 + 判定快照（重跑不重投的凭据）
    const incidentStep = session.getArchive()[2]!;
    const result = incidentStep.result as {
      incident: { text: string; deltas: unknown[] };
      target: { cids: string[]; location: string };
      roll: { D: number; T: number; p: number; malignant: boolean; severity: number };
    };
    assert.equal(result.incident.text, INCIDENT_TEXT);
    assert.deepEqual(result.target.cids, ["C1001"]);
    assert.equal(result.target.location, "山谷");
    assert.ok(Math.abs(result.roll.D - 33 * Math.log(100 / 11)) < 1e-9, `D=${result.roll.D}`);
    assert.equal(result.roll.T, 43200);
    assert.equal(result.roll.malignant, true, "D≈72.8 → p恶性=100 必恶性");

    // timer 对齐 = 可逆 VarChange（effects 段：before 43200 → after 世界时钟 0）
    const timerChange = incidentStep.changes!.effects.find((c) => c.path === "characters.C1001.timer");
    assert.ok(timerChange !== undefined);
    assert.equal(timerChange.before, 43200);
    assert.equal(timerChange.after, 0);

    // 突发内容不落 Event：事件库只有 GM#seq5 转写的那一条
    assert.deepEqual(session.getEvents().map((e) => e.payload), ["@C1001 发现了山贼的营地，悄悄退开了。"]);

    // 注入派生：甲的 #当前场景 开头带突发文本（角色侧）
    const charPrompt = callsText("character:C1001", 4);
    assert.ok(charPrompt.includes(`【突发事件】${INCIDENT_TEXT}`), "角色当前场景注入突发文本");
    // 常规 GM 的 ##当前场景 开头同样注入（转写依据）
    const gmPrompt = callsText("gm", 5);
    assert.ok(gmPrompt.includes(`【突发事件】${INCIDENT_TEXT}`), "GM 当前场景注入突发文本");

    // 突发 GM 提示词：gm-incident 模板注入目标组与良恶判定
    const incidentPrompt = callsText("gm", 3);
    assert.ok(incidentPrompt.includes("山谷（level 90）"), "目标组机械渲染含地点 level");
    assert.ok(incidentPrompt.includes("已休眠 30天"), "目标组机械渲染含剩余休眠时长");
    assert.ok(incidentPrompt.includes("恶性"), "良恶判定注入");

    // 续跑一轮：玩家 span 2h → 甲（timer=时钟+60）先弹出再次行动（seq8）。
    // 此时末个 gm 边界已越过 incident 步 → 注入自动消解（无边界派生则会错误残留）
    await session.handlePlayerInput("玩家继续走动");
    assert.equal(session.pipelineInfo.phase, "await_player");
    const charPrompt2 = callsText("character:C1001", 8);
    assert.ok(!charPrompt2.includes("【突发事件】"), "GM 结算覆盖后注入自动消解");
  });

  it("narrativity=full：突发等正文步结束后才激活", async () => {
    const worldId = setup();
    const runId = `run-inc2-${process.pid}`;
    const session = makeFlow(runId, worldId, {
      dice: [...HIT_DICE],
      gm: [gmPkg({ ...GM_ROUND1, narrativity: "full" }), GM_INCIDENT, GM_ROUND2],
    });

    await session.handlePlayerInput("玩家在村里走动");
    assert.deepEqual(
      session.getArchive().map((e) => `${e.seq}:${e.kind}`),
      ["1:player", "2:gm", "3:prose", "4:incident", "5:character:C1001"],
      "incident 排在正文步之后",
    );
  });

  it("未命中：无 incident 步、沉睡组原样不动", async () => {
    const worldId = setup();
    const runId = `run-inc3-${process.pid}`;
    const session = makeFlow(runId, worldId, {
      dice: [40, 5, 5, 10, 100], // GM fortune 4 骰 + 评估 100 > p·100 未命中
      gm: [GM_ROUND1],
    });

    await session.handlePlayerInput("玩家在村里走动");
    assert.equal(session.pipelineInfo.phase, "await_player");
    assert.deepEqual(
      session.getArchive().map((e) => `${e.seq}:${e.kind}`),
      ["1:player"],
    );
    assert.equal(session.getPipelineCurrent()!.kind, "gm");
    assert.equal(charState(session, "C1001").timer, 43200, "未命中：甲继续沉睡");
    assert.equal(session.pipelineInfo.pending_incident, false, "步内钩子评估：无挂起");
  });

  it("编辑常规 GM 步（skip 轮）重置突发计算：续跑前重投命中评估", async () => {
    const worldId = setup();
    const runId = `run-inc5-${process.pid}`;
    const session = makeFlow(runId, worldId, {
      // GM#seq2 fortune 4 骰 → 首次评估 100 未命中 →（编辑不投骰）→ 编辑后重评 42 命中
      // → 突发 GM fortune 4 骰 → GM#seq5 fortune 4 骰 → 第三次评估 100 未命中
      dice: [40, 5, 5, 10, 100, 42, 77, 12, 8, 15, 90, 3, 3, 3, 100],
      gm: [GM_ROUND1, GM_INCIDENT, GM_ROUND2],
    });

    // 首次评估未命中：无 incident 步，停在 await_player
    await session.handlePlayerInput("玩家在村里走动");
    assert.equal(session.pipelineInfo.phase, "await_player");
    assert.deepEqual(session.getArchive().map((e) => `${e.seq}:${e.kind}`), ["1:player"]);
    assert.equal(charState(session, "C1001").timer, 43200);

    // 编辑当前 GM 步（同形新包）：编辑 = 该步的一次新输出，结算轮重置
    session.editResult(JSON.stringify(GM_ROUND1));
    assert.equal(session.pipelineInfo.pending_incident, true, "编辑后评估挂起（前端据此屏蔽输入）");

    // 续跑前结算挂起的评估：重投命中 → incident 步 → 甲激活 → GM 转写
    await session.continuePipeline();
    assert.equal(session.pipelineInfo.pending_incident, false, "续跑前已结算挂起评估");
    assert.equal(session.pipelineInfo.phase, "await_player");
    assert.deepEqual(
      session.getArchive().map((e) => `${e.seq}:${e.kind}`),
      ["1:player", "2:gm", "3:incident", "4:character:C1001"],
      "编辑 GM 步后重投命中，incident 步照常归档",
    );
    const result = session.getArchive()[2]!.result as { incident: { text: string } };
    assert.equal(result.incident.text, INCIDENT_TEXT);
  });

  it("编辑正文步重置突发计算：续跑前重投命中评估", async () => {
    const worldId = setup();
    const runId = `run-inc6-${process.pid}`;
    const session = makeFlow(runId, worldId, {
      // GM#seq2 fortune 4 骰 → 正文（seq3）后首次评估 100 未命中 →（编辑正文不投骰）
      // → 编辑后重评 42 命中 → 突发 GM fortune 4 骰 → GM#seq6 fortune 4 骰 → 第三次评估 100 未命中
      dice: [40, 5, 5, 10, 100, 42, 77, 12, 8, 15, 90, 3, 3, 3, 100],
      gm: [gmPkg({ ...GM_ROUND1, narrativity: "full" }), GM_INCIDENT, GM_ROUND2],
    });

    // 正文后首次评估未命中：无 incident 步，停在 await_player
    await session.handlePlayerInput("玩家在村里走动");
    assert.equal(session.pipelineInfo.phase, "await_player");
    assert.deepEqual(
      session.getArchive().map((e) => `${e.seq}:${e.kind}`),
      ["1:player", "2:gm"],
    );
    assert.equal(session.getPipelineCurrent()!.kind, "prose");

    // 编辑正文步：该步的一次新输出 → 结算轮重置，续跑前重投命中评估
    session.editResult("改后的正文");
    await session.continuePipeline();
    assert.deepEqual(
      session.getArchive().map((e) => `${e.seq}:${e.kind}`),
      ["1:player", "2:gm", "3:prose", "4:incident", "5:character:C1001"],
      "编辑正文步后重投命中，incident 步照常归档",
    );
    const result = session.getArchive()[3]!.result as { incident: { text: string } };
    assert.equal(result.incident.text, INCIDENT_TEXT);
  });

  it("回溯过 incident 步：沉睡组原样复活（timer 经 VarChange 反向还原）", async () => {
    const worldId = setup();
    const runId = `run-inc4-${process.pid}`;
    const session = makeFlow(runId, worldId, {
      dice: [...HIT_DICE],
      gm: [GM_ROUND1, GM_INCIDENT, GM_ROUND2, GM_ROUND3, GM_ROUND4],
    });

    await session.handlePlayerInput("玩家在村里走动");
    assert.equal(charState(session, "C1001").timer, 60, "甲已被突发激活并经 GM 结算");

    // 回溯到 incident 步（seq3 = current）：突发步同 GM 步语义可编辑（反转旧 effects 重放）
    session.rollbackTo(3);
    assert.equal(session.getPipelineCurrent()!.kind, "incident");
    assert.equal(charState(session, "C1001").timer, 0, "timer 对齐随 incident 步保留");

    // 编辑突发步：deltas 按编辑包重落库、timer 仍对齐时钟；target/roll 命中快照是投骰凭据不变
    session.editResult(
      JSON.stringify({ text: "改后的突发文本", deltas: [{ path: "world.omen", op: "=", value: 3 }] }),
    );
    assert.equal(charState(session, "C1001").timer, 0, "编辑后 timer 仍对齐时钟");
    assert.equal((worldVars(session)["omen"] as { value: unknown }).value, 3, "编辑包 deltas 重落库");
    const editedIncident = session.getPipelineCurrent()!.result as {
      incident: { text: string };
      roll: { D: number };
    };
    assert.equal(editedIncident.incident.text, "改后的突发文本");
    assert.ok(Math.abs(editedIncident.roll.D - 33 * Math.log(100 / 11)) < 1e-9, "roll 快照不随编辑改变");
    assert.equal(session.pipelineInfo.pending_incident, false, "评估已发生，编辑突发步不重挂");

    // 回溯到 GM#seq2（incident seq3 之前）：甲恢复沉睡，转写事件随事件截断消失
    session.rollbackTo(2);
    assert.equal(charState(session, "C1001").timer, 43200, "回溯过 incident 步 → 甲原样复活");
    assert.deepEqual(session.getEvents(), [], "转写事件随 seq 截断移除");
    assert.deepEqual(
      session.getArchive().map((e) => `${e.seq}:${e.kind}`),
      ["1:player"],
    );
    assert.equal(session.getPipelineCurrent()!.kind, "gm");
  });

  it("回溯到结算轮 GM 步：续跑前重投命中评估（突发不被吞）", async () => {
    const worldId = setup();
    const runId = `run-inc7-${process.pid}`;
    const session = makeFlow(runId, worldId, {
      // GM#seq2 fortune 4 骰 → 评估 100 未命中 → 玩家 seq3 → GM#seq4 fortune 4 骰 → 评估 100 未命中
      // → 回溯到 seq2（不投骰）→ 续跑前重评 42 命中 → 突发 GM fortune 4 骰 → GM#seq5 fortune 4 骰 → 评估 100 未命中
      dice: [40, 5, 5, 10, 100, 30, 7, 7, 7, 100, 42, 77, 12, 8, 15, 90, 3, 3, 3, 100],
      gm: [GM_ROUND1, GM_ROUND1, GM_INCIDENT, GM_ROUND2],
    });

    await session.handlePlayerInput("玩家在村里走动");
    await session.handlePlayerInput("玩家继续走动");
    assert.equal(session.pipelineInfo.phase, "await_player");
    assert.deepEqual(
      session.getArchive().map((e) => `${e.seq}:${e.kind}`),
      ["1:player", "2:gm", "3:player"],
    );

    // 回溯到 GM#seq2：落点是 skip 结算轮终点 → 命中评估重挂（执行钩子不随落点步重跑）
    session.rollbackTo(2);
    assert.equal(session.getPipelineCurrent()!.kind, "gm");
    assert.equal(charState(session, "C1001").timer, 43200);
    assert.equal(session.pipelineInfo.pending_incident, true, "回溯落点重挂评估（前端据此屏蔽输入）");

    // 续跑前重投：命中 → incident 步 → 甲激活 → GM 转写
    await session.continuePipeline();
    assert.equal(session.pipelineInfo.pending_incident, false, "续跑前已结算挂起评估");
    assert.equal(session.pipelineInfo.phase, "await_player");
    assert.deepEqual(
      session.getArchive().map((e) => `${e.seq}:${e.kind}`),
      ["1:player", "2:gm", "3:incident", "4:character:C1001"],
      "回溯到结算轮 GM 步后续跑重投命中，incident 步照常归档",
    );
    assert.equal(charState(session, "C1001").timer, 60);
  });

  it("回溯到正文步：续跑前重投命中评估（突发不被吞）", async () => {
    const worldId = setup();
    const runId = `run-inc8-${process.pid}`;
    const session = makeFlow(runId, worldId, {
      // GM#seq2(full) fortune 4 骰 → 正文 seq3 → 评估 100 未命中 → 玩家 seq4 → GM#seq5 fortune 4 骰 → 评估 100 未命中
      // → 回溯到 seq3 正文步（不投骰）→ 续跑前重评 42 命中 → 突发 GM fortune 4 骰 → GM#seq6 fortune 4 骰 → 评估 100 未命中
      dice: [40, 5, 5, 10, 100, 30, 7, 7, 7, 100, 42, 77, 12, 8, 15, 90, 3, 3, 3, 100],
      gm: [gmPkg({ ...GM_ROUND1, narrativity: "full" }), GM_ROUND1, GM_INCIDENT, GM_ROUND2],
    });

    await session.handlePlayerInput("玩家在村里走动");
    assert.equal(session.getPipelineCurrent()!.kind, "prose");
    await session.handlePlayerInput("玩家继续走动");
    assert.equal(session.pipelineInfo.phase, "await_player");

    // 回溯到正文步（seq3）：落点是正文结算轮终点 → 命中评估重挂
    session.rollbackTo(3);
    assert.equal(session.getPipelineCurrent()!.kind, "prose");

    await session.continuePipeline();
    assert.deepEqual(
      session.getArchive().map((e) => `${e.seq}:${e.kind}`),
      ["1:player", "2:gm", "3:prose", "4:incident", "5:character:C1001"],
      "回溯到正文步后续跑重投命中，incident 步照常归档",
    );
  });

  it("直编变量（休眠 timer）后重投命中评估（变量消费重算纪律）", async () => {
    const worldId = setup();
    const runId = `run-inc9-${process.pid}`;
    const session = makeFlow(runId, worldId, {
      // GM#seq2 fortune 4 骰 → 评估 100 未命中 →（直编不投骰）→ 直编后重评 42 命中
      // → 突发 GM fortune 4 骰 → GM#seq5 fortune 4 骰 → 第三次评估 100 未命中
      dice: [40, 5, 5, 10, 100, 42, 77, 12, 8, 15, 90, 3, 3, 3, 100],
      gm: [GM_ROUND1, GM_INCIDENT, GM_ROUND2],
    });

    // 首次评估未命中：无 incident 步，停在 await_player
    await session.handlePlayerInput("玩家在村里走动");
    assert.equal(session.pipelineInfo.phase, "await_player");
    assert.deepEqual(session.getArchive().map((e) => `${e.seq}:${e.kind}`), ["1:player"]);

    // 直编甲的休眠 timer：命中评估自变量被修改 → 结算轮重挂，续跑前重投
    const c0 = charState(session, "C0");
    const c1001 = charState(session, "C1001");
    session.applyDirectEdit({ characters: { C0: c0, C1001: { ...c1001, timer: 43190 } } });
    assert.equal(session.pipelineInfo.pending_incident, true, "直编后评估重挂（前端据此屏蔽输入）");

    await session.continuePipeline();
    assert.equal(session.pipelineInfo.pending_incident, false, "续跑前已结算挂起评估");
    assert.deepEqual(
      session.getArchive().map((e) => `${e.seq}:${e.kind}`),
      ["1:player", "2:gm", "3:incident", "4:character:C1001"],
      "直编变量后重投命中，incident 步照常归档",
    );
  });
});
