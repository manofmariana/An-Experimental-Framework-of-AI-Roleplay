import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { CHARACTER_PLACEHOLDERS, type CharacterContext } from "../src/agents/character.js";
import { GM_PLACEHOLDERS, type GmContext } from "../src/agents/gm.js";
import type { GameSession } from "../src/application/gameSession.js";
import { LEAVE_TIMER } from "../src/scheduler/simulator.js";
import type { CharacterState } from "../src/truth/charactersStore.js";
import {
  buildAdjudication as gmPkg,
  buildCharacterState as state,
  buildDecision as decision,
} from "./builders/index.js";
import { SessionHarness } from "./harness/session.js";

// ---------------------------------------------------------------------------
// 集成测试基建：SessionHarness（临时世界设定集（每测试独立构图）+ fake LLM（脚本化）+ 确定性骰子）
// ---------------------------------------------------------------------------

const h = new SessionHarness("airp-loop-schedule-");
const llm = h.llm;
const calls = llm.port.calls;
const setupWorld = h.setupWorld.bind(h);
const callsText = h.callsText.bind(h);
const readRun = h.runFile.bind(h);
const charState = h.charState.bind(h);
const worldVars = h.worldVars.bind(h);

/** StepChanges 扁平视图（断言用：先 setup 后 effects，与存档 v6 扁平 var_changes 同序）。 */
function flat(step: {
  changes?: { setup: readonly { path: string; before?: unknown; after?: unknown }[]; effects: readonly { path: string; before?: unknown; after?: unknown }[] } | undefined;
}): readonly { path: string; before?: unknown; after?: unknown }[] {
  return [...(step.changes?.setup ?? []), ...(step.changes?.effects ?? [])];
}

function makeSession(
  runId: string,
  worldId: string,
  dice: number[],
  gmIntervalCycles: number,
  gm: Record<string, unknown>[],
): GameSession {
  return h.makeSession(runId, worldId, { dice, gmIntervalCycles, gm });
}

// ---------------------------------------------------------------------------

describe("主循环集成（M2-b：无判定轮 + 行动顺序表 + 标记体系）", () => {
  it("无判定轮默认形态：周期完成 X+1、硬保险周期末 GM、X 清零、时钟跳转下一轮", async () => {
    const worldId = `w-t1-${process.pid}`;
    setupWorld(worldId, [
      { id: "C0", name: "玩家", location: "loc_A", timer: 0, isPlayer: true },
      { id: "C1001", name: "甲", location: "loc_A", timer: 0 },
      { id: "C1002", name: "乙", location: "loc_B", timer: 30 },
    ]);
    // 骰子按 cid 升序消费：C0=5+5=10，C1001=20+5=25 → C1001 先动
    const runId = `run-t1-${process.pid}`;
    const session = makeSession(runId, worldId, [5, 20], 2, [
      gmPkg({ // seq5：硬保险周期末 GM（X=2）
        narrativity: "full",
        timer: [
          { cid: "C0", span: { min: 5 } },
          { cid: "C1001", span: { min: 5 } },
        ],
      }),
    ]);

    // 开局：C0+C1001 同地同刻 → 组 1；C1001 先攻高 → await_character
    assert.equal(session.pipelineInfo.phase, "await_character");
    await assert.rejects(() => session.handlePlayerInput("抢跑"), /不是玩家回合.*C1001/);

    // 周期 1：C1001 行动（seq1，acted 置位）→ 轮到玩家 → 停等
    await session.continuePipeline();
    assert.equal(session.pipelineInfo.phase, "await_player");
    assert.equal(session.turnCount, 1);
    assert.equal(charState(session, "C1001").acted, true);

    // 玩家行动（seq2）→ 周期完成 → X=1（<2 无 GM）→ 清全员 acted → C1001 第二周期（seq3）→ 停等
    await session.handlePlayerInput("玩家行动一");
    assert.equal(session.pipelineInfo.phase, "await_player");
    assert.equal(session.turnCount, 3);
    assert.equal(worldVars(session)["cycles_since_gm"], 1);
    assert.equal(calls.filter((c) => c.agent === "gm").length, 0, "无判定轮：周期内 GM 不激活");
    assert.equal(charState(session, "C1001").acted, true, "第二周期 C1001 已行动");
    assert.equal(charState(session, "C0").acted, false, "第二周期玩家未行动");

    // 玩家行动（seq4）→ 周期完成 X=2 达阈值 → 周期末 GM（seq5）→ 正文（seq6）
    // → 组 1 timer 到期（seq7 setClock 0→5，C1001 先动）→ 停等玩家
    await session.handlePlayerInput("玩家行动二");
    assert.equal(session.pipelineInfo.phase, "await_player");
    assert.equal(session.turnCount, 7);
    assert.deepEqual(
      session.getArchive().map((e) => `${e.seq}:${e.kind}`),
      ["1:character:C1001", "2:player", "3:character:C1001", "4:player", "5:gm", "6:prose"],
    );

    // GM 激活后 X 清零、触发复位、结算成员 acted 清零
    assert.equal(worldVars(session)["cycles_since_gm"], 0);
    assert.equal(worldVars(session)["gm_trigger"], false);
    assert.equal(charState(session, "C0").acted, false);
    assert.equal(charState(session, "C1001").acted, true, "seq7 已再次行动");

    // 事件 commit：tags 缺省 = 本轮行动者（工作集顺序去重），t = 当前 clock
    const events = session.getEvents();
    assert.deepEqual(
      events.map((e) => ({ payload: e.payload, tags: e.tags, t: e.t, seq: e.seq })),
      [{ payload: "GM事件", tags: ["known_by:C1001", "known_by:C0"], t: 0, seq: 5 }],
    );

    // seq7 是 current（组 1 第三周期首步）：changes 含时钟跳转（setup 段）
    const world = JSON.parse(readRun(runId, "world.json")) as {
      world: { time: { min: number } };
      pipeline: { working_set: { cid: string }[] };
    };
    assert.equal(world.world.time.min, 5);
    assert.deepEqual(world.pipeline.working_set.map((w) => w.cid), ["C1001"], "GM 步已清算工作集");
    const seq7 = session.getPipelineCurrent()!;
    assert.deepEqual(flat(seq7).map((c) => c.path), ["world.time", "characters.C1001.acted"]);

    // 正文输入：台词+内心（无标记）+ GM 事件包
    const prosePrompt = callsText("prose", 6);
    assert.ok(prosePrompt.includes("台词@character:C1001#1"));
    assert.ok(prosePrompt.includes("内心#1"));
    assert.ok(prosePrompt.includes("玩家行动一"));
    assert.ok(!prosePrompt.includes("行动#1"), "正文注入不得含行动描述");
    assert.ok(prosePrompt.includes("GM事件"));
  });

  it("gm_request 标记立即激活：同先攻批全员行动完才 GM；中途 GM 的 timer 契约覆盖同步组全体成员", async () => {
    const worldId = `w-t2-${process.pid}`;
    setupWorld(worldId, [
      { id: "C0", name: "玩家", location: "loc_A", timer: 0, isPlayer: true },
      { id: "C1001", name: "甲", location: "loc_A", timer: 0 },
      { id: "C1002", name: "乙", location: "loc_B", timer: 30 },
    ]);
    const runId = `run-t2-${process.pid}`;
    const session = makeSession(runId, worldId, [5, 20], 5, [
      gmPkg({ // seq2：标记触发立即 GM——工作集仅 C1001，契约要求一并覆盖同组未行动的 C0（不设会撕裂组）
        timer: [{ cid: "C1001", span: { min: 5 } }, { cid: "C0", span: { min: 5 } }],
      }),
    ]);
    llm.characterQueues["character:C1001"] = [
      decision({ markers: [{ type: "gm_request" }] }),
    ];

    // C1001（先攻 25 独占一批）立 gm_request → 批完成 → 立即 GM（seq2），不等周期末也不等玩家
    // GM 把同组未行动的 C0 一并推远 → 组保持完整，t=5 弹出后 C1001 再动（seq3）→ 停等玩家
    await session.continuePipeline();
    assert.equal(session.turnCount, 3);
    assert.deepEqual(
      [...session.getArchive(), session.getPipelineCurrent()!].map((e) => `${e.seq}:${e.kind}`),
      ["1:character:C1001", "2:gm", "3:character:C1001"],
    );
    // 中途 GM：X 清零、触发复位；双方 timer 都被推进（未行动成员不滞留原值）
    assert.equal(worldVars(session)["gm_trigger"], false);
    assert.equal(worldVars(session)["cycles_since_gm"], 0);
    assert.equal(charState(session, "C1001").timer, 5);
    assert.equal(charState(session, "C0").timer, 5, "在场组未行动成员一并被 GM 推进（组不撕裂）");
    // 结算成员转后台 acted 清零（GM 步 changes 留痕）；C1001 在 seq3 重新行动
    assert.ok(
      flat(session.getArchive()[1]!).some((c) => c.path === "characters.C1001.acted" && c.after === false),
      "结算成员转后台 acted 清零",
    );
    assert.equal(charState(session, "C1001").acted, true, "seq3 已重新行动");
    assert.equal(charState(session, "C0").acted, false);
    // C0 未丢轮：前台停等玩家
    assert.equal(session.pipelineInfo.phase, "await_player");
    // 事件 tags 缺省 = 本轮行动者（仅 C1001）
    assert.deepEqual(session.getEvents()[0]!.tags, ["known_by:C1001"]);
  });

  it("同值批次：批内互不见言行（GM 见全部）；玩家结构化输入的 gm_request 等批完再激活", async () => {
    const worldId = `w-t2b-${process.pid}`;
    setupWorld(worldId, [
      { id: "C0", name: "玩家", location: "loc_A", timer: 0, isPlayer: true },
      { id: "C1001", name: "甲", location: "loc_A", timer: 0 },
      { id: "C1002", name: "乙", location: "loc_B", timer: 30 },
    ]);
    const runId = `run-t2b-${process.pid}`;
    const session = makeSession(runId, worldId, [15, 15], 5, [
      gmPkg({ // seq3：批完成后 GM（覆盖本轮全部行动者）
        timer: [
          { cid: "C0", span: { min: 5 } },
          { cid: "C1001", span: { min: 5 } },
        ],
      }),
    ]);

    // 同值批 [C0, C1001]（cid 升序）→ 玩家先行动：开局即停等
    assert.equal(session.pipelineInfo.phase, "await_player");
    const playerInput = JSON.stringify(
      decision({ dialogue: "秘密输入X", markers: [{ type: "gm_request" }] }),
    );
    await session.handlePlayerInput(playerInput);

    // 玩家立 gm_request，但同值批 C1001 未行动 → 不立即 GM；C1001 行动完批齐 → GM（seq3）
    assert.deepEqual(
      [...session.getArchive(), session.getPipelineCurrent()!].map((e) => `${e.seq}:${e.kind}`),
      ["1:player", "2:character:C1001", "3:gm"],
    );
    // 玩家步 changes 含触发落账（结构化输入的标记程序即时执行）
    const seq1 = session.getArchive()[0]!;
    assert.ok(flat(seq1).some((c) => c.path === "world.gm_trigger" && c.after === true));
    // 同值批注入隔离：C1001 的 #当前场景 不含玩家言行；GM 见全部
    assert.ok(!callsText("character:C1001", 2).includes("秘密输入X"), "同值批互不可见");
    assert.ok(callsText("gm", 3).includes("秘密输入X"));
    // GM 后推远 → 组 1 到期再停等玩家（同值批 → 玩家先）
    assert.equal(session.pipelineInfo.phase, "await_player");
  });

  it("leave/recall：离场归 0 + 超大 timer 冻结；召回复用先攻、timer 归当前 clock、按进组规则归组", async () => {
    const worldId = `w-t3-${process.pid}`;
    setupWorld(worldId, [
      { id: "C0", name: "玩家", location: "loc_A", timer: 0, isPlayer: true },
      { id: "C1001", name: "甲", location: "loc_A", timer: 0 },
    ]);
    const runId = `run-t3-${process.pid}`;
    // 骰子只够开局两投：召回必须复用已存先攻（任何重投都会耗尽队列报错）
    const session = makeSession(runId, worldId, [5, 20], 5, []);
    llm.characterQueues["character:C1001"] = [
      decision({ markers: [{ type: "leave" }] }),
      decision({ action: "被召回后的行动" }),
    ];

    // C1001 立离开标记：不触发 GM——程序当场归 0 + 超大 timer
    await session.continuePipeline();
    assert.equal(session.pipelineInfo.phase, "await_player");
    assert.equal(charState(session, "C1001").group, 0);
    assert.equal(charState(session, "C1001").timer, LEAVE_TIMER);
    assert.equal(calls.filter((c) => c.agent === "gm").length, 0, "离开不触发 GM");

    // 玩家结构化输入召回 C1001：timer 归当前 clock（0）、按进组规则归组、先攻复用（25 不变）
    const recall = JSON.stringify(decision({ markers: [{ type: "recall", target: "@C1001" }] }));
    await session.handlePlayerInput(recall);
    assert.equal(charState(session, "C1001").timer, 0);
    assert.equal(charState(session, "C1001").group, charState(session, "C0").group);
    assert.notEqual(charState(session, "C1001").group, 0);
    assert.deepEqual(charState(session, "C1001").initiative, { value: 25, group: charState(session, "C1001").group });
    // 召回后 C1001 补完本周期（seq3 行动）→ 周期完成 → 下一周期首步（seq4）→ 停等玩家
    assert.equal(session.turnCount, 4);
    assert.equal(session.getArchive()[2]!.kind, "character:C1001");
    assert.equal(session.pipelineInfo.phase, "await_player");
  });

  it("玩家 leave 统一程序化：group=0 + 超大 timer + 清频道，绝不触发 GM", async () => {
    const worldId = `w-t3b-${process.pid}`;
    setupWorld(worldId, [
      { id: "C0", name: "玩家", location: "loc_A", timer: 0, isPlayer: true },
      { id: "C1001", name: "甲", location: "loc_B", timer: null },
    ]);
    const runId = `run-t3b-${process.pid}`;
    const session = makeSession(runId, worldId, [], 5, []);

    // 开局：仅玩家有计时器 → 停等玩家
    assert.equal(session.pipelineInfo.phase, "await_player");

    // 玩家结构化输入立离开标记：与 NPC 同规——程序当场归 0 + 超大 timer + 清频道
    await session.handlePlayerInput(
      JSON.stringify(decision({ action: "独自离开", markers: [{ type: "leave" }] })),
    );
    const player = charState(session, "C0");
    assert.equal(player.group, 0);
    assert.equal(player.timer, LEAVE_TIMER);
    assert.equal(player.channel, null);
    assert.notEqual(worldVars(session)["gm_trigger"], true, "玩家离开不置 GM 触发");
    assert.equal(calls.filter((c) => c.agent === "gm").length, 0, "玩家离开不触发 GM");
    // 全员无计时器（玩家冻结、甲本就没有）→ 死锁防御停等玩家，不空转
    assert.equal(session.pipelineInfo.phase, "await_player");
    assert.equal(session.turnCount, 1);
  });

  it("离开者的过去言行保持注入：剩余成员 #当前场景 仍含其离开前言行（同值批也不例外），inner 仍隐藏", async () => {
    const worldId = `w-t3c-${process.pid}`;
    setupWorld(worldId, [
      { id: "C0", name: "玩家", location: "loc_A", timer: 0, isPlayer: true },
      { id: "C1001", name: "甲", location: "loc_A", timer: 0 },
      { id: "C1002", name: "乙", location: "loc_A", timer: 0 },
    ]);
    const runId = `run-t3c-${process.pid}`;
    // 骰子按 cid 升序消费：C0=5+5=10，C1001=15+5=20，C1002=15+5=20 → 甲与乙同值批（甲先动）
    const session = makeSession(runId, worldId, [5, 15, 15], 5, []);
    llm.characterQueues["character:C1001"] = [
      decision({ dialogue: "甲离开前的台词", inner: "甲的隐秘内心", markers: [{ type: "leave" }] }),
    ];
    llm.characterQueues["character:C1002"] = [decision({ dialogue: "乙的回应" })];

    // seq1 C1001 行动并立 leave（归 0 + 超大 timer）→ seq2 C1002（同值批）→ 停等玩家
    await session.continuePipeline();
    assert.equal(session.pipelineInfo.phase, "await_player");
    assert.equal(charState(session, "C1001").group, 0);
    assert.equal(charState(session, "C1001").timer, LEAVE_TIMER);
    assert.equal(calls.filter((c) => c.agent === "gm").length, 0, "离开不触发 GM");

    // C1002 与 C1001 同值批：离开者的条目产生时仍在组内，对原组成员保持可见（不受同值批隔离）
    const scene = callsText("character:C1002", 2);
    assert.ok(scene.includes("甲离开前的台词"), "剩余成员注入仍含离开者离开前的言行");
    assert.ok(!scene.includes("甲的隐秘内心"), "他人 inner 隐藏规则不变");
  });

  it("邀请·接受：contact 触发 GM 立即结算 → 邀请者组下次弹出激活 → confirm 入组（远程 -1）→ timer 归 0 待 GM 重设", async () => {
    const worldId = `w-t4-${process.pid}`;
    setupWorld(worldId, [
      { id: "C0", name: "玩家", location: "loc_A", timer: 0, isPlayer: true },
      { id: "C1001", name: "甲", location: "loc_A", timer: 0 },
      { id: "C1002", name: "乙", location: "loc_B", timer: 60 },
    ]);
    const runId = `run-t4-${process.pid}`;
    const session = makeSession(runId, worldId, [5, 20, 8], 1, [
      gmPkg({ timer: [{ cid: "C1001", span: { min: 5 } }, { cid: "C0", span: { min: 5 } }] }), // seq2：contact 触发 GM 立即结算（覆盖同组未行动的 C0）
      gmPkg({ // seq6：新组周期末（覆盖应答者与新组全部行动者）
        timer: [
          { cid: "C1001", span: { min: 10 } },
          { cid: "C1002", span: { min: 10 } },
          { cid: "C0", span: { min: 10 } },
        ],
      }),
    ]);
    llm.characterQueues["character:C1001"] = [
      decision({ markers: [{ type: "contact", channel: "电话", targets: ["C1002"] }] }),
      decision({ action: "接听后的行动" }),
    ];
    llm.characterQueues["character:C1002"] = [
      decision({ dialogue: "喂，我马上到。", markers: [{ type: "confirm" }] }),
    ];

    // seq1 C1001 contact：频道分配（双方同 id）+ 触发立即 GM（seq2，C0/C1001 一并推远到 t=5）
    // → 时钟跳到 5 组弹出：邀请激活，C1002 timer→0 应答（seq3，confirm 入组、远程 -1）
    // → C1001 补完（seq4）→ 停等玩家
    await session.continuePipeline();
    assert.equal(session.turnCount, 4);
    assert.equal(charState(session, "C1001").channel, 1);
    assert.equal(charState(session, "C1002").channel, 1);
    assert.equal(session.pipelineInfo.phase, "await_player");
    // 邀请延迟生效：邀请时 timer 不动，激活落账才从邀请前值 60 置 0（应答步 changes 留痕）
    const answer = session.getArchive()[2]!;
    assert.equal(answer.kind, "character:C1002");
    assert.ok(
      flat(answer).some((c) => c.path === "characters.C1002.timer" && c.before === 60 && c.after === 0),
      "邀请激活：timer 置 0 弹出（before 留存邀请前值）",
    );
    // confirm：并入邀请者组（新组）、位置 ≠ 组位置 → 先攻 8+5-1=12、timer 归 0、计入已行动
    const invitee = charState(session, "C1002");
    const inviter = charState(session, "C1001");
    assert.equal(invitee.group, inviter.group);
    assert.notEqual(invitee.group, 0);
    assert.deepEqual(invitee.initiative, { value: 12, group: invitee.group });
    assert.ok(
      flat(answer).some((c) => c.path === "characters.C1002.acted" && c.after === true),
      "首轮回复计入已行动（confirm 效应置 acted）",
    );
    // incoming_contact 注入（无状态 activation §4，逐调用 Context）：应答步（seq3）激活的 prompt
    // 含邀请者 + 途径通知；其后的常规激活（seq8，见下方续跑）不再注入该通知
    assert.ok(
      callsText("character:C1002", 3).includes("@C1001 正在通过「电话」联系你"),
      "应答步激活注入被联系通知（邀请者 @C1001、途径「电话」）",
    );

    // 玩家行动（seq5）→ 周期完成 X=1 → 周期末 GM（seq6，覆盖三人）→ 全部推远到 15
    // → t=15 组弹出：C1001（先攻 25，seq7）→ C1002（12，seq8）→ 停等玩家
    await session.handlePlayerInput("玩家静观其变");
    assert.equal(session.pipelineInfo.phase, "await_player");
    assert.equal(session.turnCount, 8);
    const kinds = [...session.getArchive(), session.getPipelineCurrent()!].map((e) => `${e.seq}:${e.kind}`);
    assert.deepEqual(kinds, [
      "1:character:C1001", "2:gm", "3:character:C1002", "4:character:C1001",
      "5:player", "6:gm", "7:character:C1001", "8:character:C1002",
    ]);
    // GM（seq6）重设 timer 后：双方推入未来、结算成员 acted 清零（GM 步 changes 留痕）、频道跨地点存续（不同地不清）
    assert.equal(charState(session, "C1002").timer, 15);
    assert.ok(
      flat(session.getArchive()[5]!).some((c) => c.path === "characters.C1002.acted" && c.after === false),
      "结算成员 acted 清零",
    );
    assert.equal(charState(session, "C1002").channel, 1, "接受者保留频道（持有者仍异地）");
    assert.equal(charState(session, "C1001").channel, 1);
    // 常规激活（seq8 非应答步）不再注入被联系通知
    assert.ok(!callsText("character:C1002", 8).includes("正在通过"), "常规激活不注入被联系通知");
  });

  it("邀请·拒绝：timer 还原为邀请前值、不计入已行动、失去频道（全体同地 → 频道全清）", async () => {
    const worldId = `w-t5-${process.pid}`;
    setupWorld(worldId, [
      { id: "C0", name: "玩家", location: "loc_A", timer: 0, isPlayer: true },
      { id: "C1001", name: "甲", location: "loc_A", timer: 0 },
      { id: "C1002", name: "乙", location: "loc_B", timer: 60 },
    ]);
    const runId = `run-t5-${process.pid}`;
    const session = makeSession(runId, worldId, [5, 20], 1, [
      gmPkg({ timer: [{ cid: "C1001", span: { min: 5 } }, { cid: "C0", span: { min: 5 } }] }), // seq2（覆盖同组未行动的 C0）
      gmPkg({ // seq6：周期末（拒绝应答在工作集中，契约须覆盖）
        timer: [
          { cid: "C1001", span: { min: 10 } },
          { cid: "C1002", span: { min: 10 } },
          { cid: "C0", span: { min: 10 } },
        ],
      }),
    ]);
    llm.characterQueues["character:C1001"] = [
      decision({ markers: [{ type: "contact", channel: "电话", targets: ["C1002"] }] }),
    ];
    llm.characterQueues["character:C1002"] = [
      decision({ dialogue: "抱歉，走不开。" }), // 无 confirm → 拒绝
    ];

    // seq1 contact + seq2 GM → t=5 弹出：seq3 C1002 应答（拒绝）→ seq4 C1001 行动 → 停等玩家
    await session.continuePipeline();
    assert.equal(session.pipelineInfo.phase, "await_player");
    await session.handlePlayerInput("玩家等待");
    // seq5 玩家 → 周期完成 → seq6 周期末 GM → t=15 弹出：seq7 C1001（C1002 单人组串行在后）→ 停等玩家
    assert.equal(session.turnCount, 7);
    assert.equal(session.pipelineInfo.phase, "await_player");
    // 拒绝：timer 自动还原为邀请前值（应答步 changes：0 → 60），不调用 GM
    const answer = session.getArchive()[2]!;
    assert.ok(
      flat(answer).some((c) => c.path === "characters.C1002.timer" && c.before === 0 && c.after === 60),
      "拒绝：timer 自动还原为邀请前值",
    );
    assert.ok(
      !flat(answer).some((c) => c.path === "characters.C1002.acted" && c.after === true),
      "拒绝回复不计入已行动",
    );
    const invitee = charState(session, "C1002");
    assert.equal(invitee.channel, null, "拒绝者失去频道");
    assert.equal(invitee.group, 0);
    assert.equal(charState(session, "C1001").channel, null, "全体持有者同地判定 → 频道全清");
  });

  it("回溯逐字节一致：覆盖 acted/X/channel/邀请激活 timer 各效应，续档派生恢复", async () => {
    const worldId = `w-t6-${process.pid}`;
    setupWorld(worldId, [
      { id: "C0", name: "玩家", location: "loc_A", timer: 0, isPlayer: true },
      { id: "C1001", name: "甲", location: "loc_A", timer: 0 },
      { id: "C1002", name: "乙", location: "loc_B", timer: 60 },
    ]);
    const runId = `run-t6-${process.pid}`;
    const gmScripts = () => [
      gmPkg({ timer: [{ cid: "C1001", span: { min: 5 } }, { cid: "C0", span: { min: 5 } }] }), // seq2（覆盖同组未行动的 C0）
      gmPkg({ timer: [{ cid: "C1001", span: { min: 10 } }, { cid: "C1002", span: { min: 10 } }, { cid: "C0", span: { min: 10 } }] }), // seq6（新组完整周期末）
      gmPkg({ timer: [{ cid: "C1001", span: { min: 10 } }, { cid: "C1002", span: { min: 10 } }, { cid: "C0", span: { min: 10 } }] }), // seq10（回溯前继续）
    ];
    const session = makeSession(runId, worldId, [5, 20, 8, 8], 1, gmScripts());
    llm.characterQueues["character:C1001"] = [
      decision({ markers: [{ type: "contact", channel: "电话", targets: ["C1002"] }] }),
      decision({ action: "接听后的行动" }),
      decision({ action: "接听后的行动" }), // 回溯后重跑
    ];
    llm.characterQueues["character:C1002"] = [
      decision({ dialogue: "来了。", markers: [{ type: "confirm" }] }), // 邀请应答
      decision({ action: "到场后的行动" }), // seq8 周期行动
      decision({ action: "到场后的行动" }), // seq12 周期行动
      decision({ dialogue: "来了。", markers: [{ type: "confirm" }] }), // 回溯后重跑应答
    ];

    await session.continuePipeline(); // seq1-4（contact → GM → 邀请激活 confirm → C1001 补完）
    await session.handlePlayerInput("玩家等待"); // seq5 → seq6 周期末 GM → seq7 C1001 → seq8 C1002 → 停等玩家
    assert.equal(session.turnCount, 8);
    const snapWorld = readRun(runId, "world.json");
    const snapChars = readRun(runId, "characters.json");

    // 继续推进：seq9 玩家 → seq10 GM → 新组完整周期（seq11 C1001 → seq12 C1002），然后回溯到 seq8
    await session.handlePlayerInput("后续行动");
    assert.equal(session.turnCount, 12);
    session.rollbackTo(8);
    assert.equal(readRun(runId, "world.json"), snapWorld, "world.json 逐字节一致");
    assert.equal(readRun(runId, "characters.json"), snapChars, "characters.json 逐字节一致");

    // 回溯到邀请激活之前（seq2）：受邀者 timer/频道/组别全部还原
    session.rollbackTo(2);
    assert.equal(charState(session, "C1002").timer, 60);
    assert.equal(charState(session, "C1002").channel, 1);
    assert.equal(charState(session, "C1002").group, 0);

    // 续档：从磁盘重建（纯数据），deriveNext 推出同一调度点——受邀者应答步（邀请再激活）
    const resumed = h.resumeSession(runId, { gmIntervalCycles: 1, options: { rollDice: () => 8 } });
    assert.equal(resumed.pipelineInfo.phase, "await_character");
    await resumed.continuePipeline(); // seq3 重跑（confirm）→ seq4 C1001 → 停等玩家
    assert.equal(resumed.turnCount, 4);
    assert.equal(charState(resumed, "C1002").group, charState(resumed, "C1001").group);
    assert.equal(resumed.pipelineInfo.phase, "await_player");
  });

  it("interrupted character 保留 schedule setup 段（含时钟跳转；effects 空段），回滚逐字节恢复", async () => {
    const worldId = `w-t7-${process.pid}`;
    setupWorld(worldId, [
      { id: "C0", name: "玩家", location: "loc_A", timer: 0, isPlayer: true },
      { id: "C1001", name: "甲", location: "loc_A", timer: 0 },
    ]);
    const runId = `run-t7-${process.pid}`;
    const session = makeSession(runId, worldId, [5, 20], 1, [
      gmPkg({ narrativity: "full", timer: [{ cid: "C0", span: { min: 5 } }, { cid: "C1001", span: { min: 5 } }] }), // seq3
      gmPkg({ timer: [{ cid: "C0", span: { min: 5 } }, { cid: "C1001", span: { min: 5 } }] }), // seq7（abort 后继续）
    ]);
    await session.continuePipeline(); // seq1 → 停等
    llm.abortAt = { agent: "character:C1001", seq: 5, partial: "半截" };
    await session.handlePlayerInput("推进"); // seq2 player → seq3 GM(full) → seq4 prose → seq5 abort
    const current = session.getPipelineCurrent()!;
    assert.equal(current.interrupted, true);
    assert.deepEqual(flat(current).map((change) => change.path), ["world.time"]);
    assert.equal(session.worldTime, 5);
    session.rollbackTo(4);
    const beforeWorld = readRun(runId, "world.json");
    llm.abortAt = null;
    await session.continuePipeline(); // seq5 重跑 → 停等玩家
    session.rollbackTo(4);
    assert.equal(readRun(runId, "world.json"), beforeWorld);
  });

  it("interrupted GM 编辑使用激活前捕获的 round_scenes（group id）", async () => {
    const worldId = `w-t8-${process.pid}`;
    setupWorld(worldId, [
      { id: "C0", name: "玩家", location: "loc_A", timer: 0, isPlayer: true },
      { id: "C1001", name: "甲", location: "loc_A", timer: 0 },
    ]);
    const runId = `run-t8-${process.pid}`;
    const session = makeSession(runId, worldId, [5, 20], 1, []);
    llm.abortAt = { agent: "gm", seq: 3, partial: "半截裁决" };
    await session.continuePipeline(); // seq1
    await session.handlePlayerInput("玩家行动"); // seq2 → seq3 GM abort
    const pkg = gmPkg({
      narrativity: "skip",
      timer: [{ cid: "C0", span: { min: 5 } }, { cid: "C1001", span: { min: 5 } }],
      location: [{ cid: "C0", location: { name: "分开地点", level: 1 } }],
    });
    session.editResult(JSON.stringify(pkg));
    assert.deepEqual(
      (session.getPipelineCurrent()?.result as { round_scenes: unknown }).round_scenes,
      { C1001: 1, C0: 1 },
    );
  });

  it("回滚到 GM 步后可编辑：旧效应整体反向 + 编辑包重放（事件替换提交）", async () => {
    const worldId = `w-t9-${process.pid}`;
    setupWorld(worldId, [
      { id: "C0", name: "玩家", location: "loc_A", timer: 0, isPlayer: true },
      { id: "C1001", name: "甲", location: "loc_A", timer: 0 },
      { id: "C1002", name: "乙", location: "loc_B", timer: 30 },
    ]);
    const runId = `run-t9-${process.pid}`;
    const session = makeSession(runId, worldId, [5, 20], 1, [
      gmPkg({ narrativity: "full", timer: [{ cid: "C0", span: { min: 5 } }, { cid: "C1001", span: { min: 5 } }] }), // seq3
    ]);
    llm.abortAt = { agent: "prose", seq: 4, partial: "停住" };
    await session.continuePipeline(); // seq1
    await session.handlePlayerInput("玩家行动"); // seq2 → seq3 GM → seq4 prose abort
    session.rollbackTo(3);

    const edited = gmPkg({
      events: [{ text: "@C0 对 @C1001 说：\"玩家行动\"", tags: ["known_by:C0"], location: "loc_A" }],
      narrativity: "full",
      timer: [{ cid: "C0", span: { min: 10 } }, { cid: "C1001", span: { min: 10 } }],
    });
    session.editResult(JSON.stringify(edited));

    const events = session.getEvents();
    assert.equal(events.length, 1);
    assert.equal(events[0]!.payload, "@C0 对 @C1001 说：\"玩家行动\"");
    assert.equal(events[0]!.seq, 3);
    assert.deepEqual(events[0]!.tags, ["known_by:C0"]);
    assert.equal(charState(session, "C0").timer, 10);
    assert.equal(charState(session, "C1001").timer, 10);
    const current = session.getPipelineCurrent()!;
    assert.equal(current.edited, true);
    assert.deepEqual(
      flat(current).map((c) => c.path).filter((p) => p.endsWith(".timer")).sort(),
      ["characters.C0.timer", "characters.C1001.timer"],
    );

    llm.abortAt = null;
    await session.continuePipeline(); // prose seq4 → 组 1 到期 seq5 → 停等玩家
    assert.equal(session.pipelineInfo.phase, "await_player");
  });

  it("GM 激活闸：工作集为空或行动者无计时器时拒绝", async () => {
    const worldId = `w-t10-${process.pid}`;
    setupWorld(worldId, [
      { id: "C0", name: "玩家", location: "loc_A", timer: 0, isPlayer: true },
      { id: "C1001", name: "甲", location: "loc_A", timer: 0 },
    ]);
    const runId = `run-t10-${process.pid}`;
    const session = makeSession(runId, worldId, [5, 20], 5, []);
    const validate = (session as unknown as { validateWorkingSetRound: (cids: string[]) => void }).validateWorkingSetRound.bind(session);
    assert.doesNotThrow(() => validate(["C0", "C1001"]));
    assert.throws(() => validate([]), /工作集为空/);
    const characters = (session as unknown as { characters: { setVars: (cid: string, patch: { timer: null }) => unknown } }).characters;
    characters.setVars("C1001", { timer: null });
    assert.throws(() => validate(["C1001"]), /无计时器/);
  });

  it("联系人列表 provider：排除频道持有者与前台（timer 未到期才可被联系）", () => {
    const states: Record<string, CharacterState> = {
      C0: state({ name: "玩家", isPlayer: true }),
      C1001: state({ name: "甲", channel: 1 }), // 频道持有者 → 排除
      C1002: state({ name: "乙" }), // 后台无频道 → 可联系
      C1003: state({ name: "丙", timer: 5 }), // timer 已到期（前台）→ 排除
      C1004: state({ name: "丁", timer: null }), // 无计时器 → 可联系
    };
    const charCtx: CharacterContext = {
      selfCid: "C0", states, cast: [], worldSnapshot: "{}", activatedLore: "", recentEvents: [],
      proseWindow: [], currentScene: "", timeHeader: "", clock: 10,
    };
    const contacts = CHARACTER_PLACEHOLDERS.contacts!.provide(charCtx);
    assert.ok(contacts.includes("C1002") && contacts.includes("C1004"));
    assert.ok(!contacts.includes("C1001"), "频道持有者可被重复邀请（防重入失败）");
    assert.ok(!contacts.includes("C1003"), "前台角色结构上不可被联系");
    assert.ok(!contacts.includes("C0"), "不含自己");
    // 整体可见性：自身持有频道 → 名单整体不可见
    const holderCtx: CharacterContext = { ...charCtx, states: { ...states, C0: state({ name: "玩家", isPlayer: true, channel: 2 }) } };
    assert.strictEqual(CHARACTER_PLACEHOLDERS.contacts!.provide(holderCtx), "", "频道持有者不应看见联系人名单");
    // 整体可见性：自身正在应答邀请 → 名单整体不可见
    const invitedCtx: CharacterContext = { ...charCtx, incomingContact: { inviter: "C1001", channel: "传音" } };
    assert.strictEqual(CHARACTER_PLACEHOLDERS.contacts!.provide(invitedCtx), "", "待答邀请者不应看见联系人名单");
    const gmCtx: GmContext = {
      setting: "", cast: [], loreFull: "", events: [], proseWindow: [], currentScene: "",
      worldSnapshot: "{}", states, clock: 10, timeHeader: "",
    };
    const gmContacts = GM_PLACEHOLDERS.contacts!.provide(gmCtx);
    assert.ok(gmContacts.includes("C1002") && gmContacts.includes("C1004"));
    assert.ok(!gmContacts.includes("C1001") && !gmContacts.includes("C1003"));
  });
});
