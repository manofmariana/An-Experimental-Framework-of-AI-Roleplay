import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { GameSession } from "../src/application/gameSession.js";
import {
  buildAdjudication as gmPkg,
  buildDecision as decision,
} from "./builders/index.js";
import { SessionHarness, type CharSpec } from "./harness/session.js";

// ---------------------------------------------------------------------------
// 编辑执行标记（editResult 重放 applyMarkers）+ 工作集跨周期注入（#当前场景）。
// 集成基建：SessionHarness（与 loopSchedule.test.ts 同型）。
// ---------------------------------------------------------------------------

const h = new SessionHarness("airp-edit-markers-");
const llm = h.llm;
llm.defaultDecision = (_agent, seq) => ({ action: `行动#${seq}`, inner: `内心#${seq}`, dialogue: `台词#${seq}` });
const callsText = h.callsText.bind(h);
const charState = h.charState.bind(h);
const worldSys = h.worldSys.bind(h);

function makeSession(
  tag: string,
  specs: CharSpec[],
  dice: number[],
  gmIntervalCycles: number,
  gm: Record<string, unknown>[] = [],
): GameSession {
  const worldId = `w-${tag}-${process.pid}`;
  h.setupWorld(worldId, specs);
  return h.makeSession(`run-${tag}-${process.pid}`, worldId, { dice, gmIntervalCycles, gm });
}

describe("编辑执行标记（editResult 重放 applyMarkers，与普通路径同语义）", () => {
  it("编辑插入 leave → 归 0+timer 置 null；再编辑移除 → 旧效应被反向", async () => {
    const session = makeSession("leave", [
      { id: "C0", name: "玩家", location: "loc_A", timer: 0, isPlayer: true },
      { id: "C1001", name: "甲", location: "loc_A", timer: 0 },
    ], [5, 20], 5);
    llm.characterQueues["character:C1001"] = [decision({ dialogue: "原决策台词" })];

    await session.continuePipeline(); // seq1 C1001（无标记）→ 停等玩家
    assert.equal(session.pipelineInfo.kind, "character:C1001");
    assert.equal(charState(session, "C1001").group, 1);

    // 编辑插入 leave：组归 0 + timer 置 null（同普通路径）
    session.editResult(JSON.stringify(decision({ action: "离开现场", markers: [{ type: "leave" }] })));
    assert.equal(charState(session, "C1001").group, 0);
    assert.equal(charState(session, "C1001").timer, null);
    let current = session.getPipelineCurrent()!;
    assert.equal((current.result as { decision: { action?: string } }).decision.action, "离开现场");

    // 再编辑移除标记：旧 leave 效应被反向（组与 timer 还原）
    session.editResult(JSON.stringify(decision({ action: "留下" })));
    assert.equal(charState(session, "C1001").group, 1);
    assert.equal(charState(session, "C1001").timer, 0);
    current = session.getPipelineCurrent()!;
    assert.equal((current.result as { decision: { action?: string } }).decision.action, "留下");
  });

  it("编辑插入 contact → 频道分配 + GM 触发；再编辑移除 → 全反向", async () => {
    const session = makeSession("contact", [
      { id: "C0", name: "玩家", location: "loc_A", timer: 0, isPlayer: true },
      { id: "C1001", name: "甲", location: "loc_A", timer: 0 },
      { id: "C1002", name: "乙", location: "loc_B", timer: 30 },
    ], [5, 20], 5);
    llm.characterQueues["character:C1001"] = [decision({ dialogue: "原决策台词" })];

    await session.continuePipeline(); // seq1 C1001（无标记）→ 停等玩家
    assert.equal(charState(session, "C1001").channel, null);
    assert.notEqual(worldSys(session)["gm_trigger"], true);

    session.editResult(
      JSON.stringify(decision({ dialogue: "打个电话", markers: [{ type: "contact", channel: "电话", targets: ["C1002"] }] })),
    );
    const ch1 = charState(session, "C1001").channel;
    assert.ok(ch1 !== null && ch1 === charState(session, "C1002").channel, "邀请双方同频道");
    assert.equal(worldSys(session)["gm_trigger"], true, "contact 触发 GM 立即激活");

    session.editResult(JSON.stringify(decision({ dialogue: "算了" })));
    assert.equal(charState(session, "C1001").channel, null);
    assert.equal(charState(session, "C1002").channel, null);
    // 旧 contact 效应被反向：gm_trigger 还原到编辑前状态（首次立标前该键不存在 → 反向后删键）
    assert.notEqual(worldSys(session)["gm_trigger"], true, "旧 contact 效应被反向");
  });

  it("编辑插入 recall → 拉回未结算离开者（timer 归 clock、归组、先攻复用不补投）", async () => {
    // 骰子只够开局三投：召回必须复用已存先攻（任何重投都会耗尽队列报错）
    const session = makeSession("recall", [
      { id: "C0", name: "玩家", location: "loc_A", timer: 0, isPlayer: true },
      { id: "C1001", name: "甲", location: "loc_A", timer: 0 },
      { id: "C1002", name: "乙", location: "loc_A", timer: 0 },
    ], [5, 20, 15], 5);
    llm.characterQueues["character:C1001"] = [decision({ markers: [{ type: "leave" }] })];
    llm.characterQueues["character:C1002"] = [decision({ dialogue: "乙的台词" })];

    // seq1 C1001（先攻 25 最高，立 leave）→ seq2 C1002 → 停等玩家（C0）
    await session.continuePipeline();
    assert.equal(session.pipelineInfo.kind, "character:C1002");
    assert.equal(charState(session, "C1001").group, 0);
    assert.equal(charState(session, "C1001").timer, null);

    // 编辑 C1002 步插入 recall：C1001 归组 + timer 归当前 clock + 先攻复用
    session.editResult(
      JSON.stringify(decision({ action: "喊住甲", markers: [{ type: "recall", target: "C1001" }] })),
    );
    assert.equal(charState(session, "C1001").timer, session.worldTime);
    assert.equal(charState(session, "C1001").group, charState(session, "C1002").group);
    assert.equal(charState(session, "C1001").initiative?.value, 25, "先攻复用不重投");

    // 再编辑移除 recall：C1001 回到未结算离开集合
    session.editResult(JSON.stringify(decision({ dialogue: "乙的台词" })));
    assert.equal(charState(session, "C1001").group, 0);
    assert.equal(charState(session, "C1001").timer, null);
  });

  it("回滚到 recall 步后编辑移除 recall：A 回未结算离开集合（group=0 + timer=null）", async () => {
    // 复现用户场景：A leave → B recall（A 回组）→ 推进若干步 → 回滚到 B 的 recall 步 →
    // 对该步做原始返回编辑删除 recall 标记 → 召回效应必须被撤销
    const session = makeSession("recall-rollback-edit", [
      { id: "C0", name: "玩家", location: "loc_A", timer: 0, isPlayer: true },
      { id: "C1001", name: "甲", location: "loc_A", timer: 0 },
      { id: "C1002", name: "乙", location: "loc_A", timer: 0 },
    ], [5, 20, 15], 5); // 先攻：C1001=25 / C1002=20 / C0=10，开局同组
    llm.characterQueues["character:C1001"] = [decision({ markers: [{ type: "leave" }] })];
    llm.characterQueues["character:C1002"] = [
      decision({ dialogue: "喊住甲", markers: [{ type: "recall", target: "C1001" }] }),
    ];

    // seq1 C1001 leave → seq2 C1002 recall（C1001 回组；其 acted 在 seq2 setup 按"组进后台清零"已清）
    // → seq3 C1001 补行动 → 停等玩家
    await session.continuePipeline();
    assert.equal(session.turnCount, 3);
    assert.equal(charState(session, "C1001").group, charState(session, "C1002").group);

    // 回滚到 B 的 recall 步（recall 效应仍在：A 在组内）
    session.rollbackTo(2);
    assert.equal(session.getPipelineCurrent()!.kind, "character:C1002");
    assert.notEqual(charState(session, "C1001").group, 0, "回滚到 seq2：recall 效应仍在（A 在组内）");

    // 对 B 的该步编辑删除 recall 标记：旧 effects 反转 → A 回未结算离开集合
    session.editResult(JSON.stringify(decision({ dialogue: "乙的台词" })));
    assert.equal(charState(session, "C1001").group, 0, "删除 recall 标记后 A 必须离组");
    assert.equal(charState(session, "C1001").timer, null, "删除 recall 标记后 A timer 必须还原为 null");
  });
});

describe("工作集跨周期注入（#当前场景：GM 清算前的全体言行，自己也不例外）", () => {
  it("跨两个无判定周期：NPC 注入含自己与他人上一周期言行；GM 清算后不再含", async () => {
    const session = makeSession("cycle-scene", [
      { id: "C0", name: "玩家", location: "loc_A", timer: 0, isPlayer: true },
      { id: "C1001", name: "甲", location: "loc_A", timer: 0 },
      // 开局先攻 2 骰；seq5 GM 激活前 fortune 4 骰（值随意，填 50）；
      // GM 后评估：全员被 durations 覆盖 → 无休眠组，不消费评估骰
    ], [5, 20, 50, 50, 50, 50], 2, [
      gmPkg({
        durations: [
          { cid: "C0", span: { min: 5 } },
          { cid: "C1001", span: { min: 5 } },
        ],
      }),
    ]);
    llm.characterQueues["character:C1001"] = [
      decision({ dialogue: "甲一周期台词" }),
      decision({ dialogue: "甲二周期台词" }),
      decision({ dialogue: "甲三周期台词" }),
    ];

    // 周期 1：seq1 C1001 → 停等玩家
    await session.continuePipeline();
    // 玩家行动（seq2）→ 周期 1 完成 X=1（<2 无 GM）→ 周期 2：seq3 C1001 → 停等
    await session.handlePlayerInput("玩家一周期");
    assert.equal(session.turnCount, 3);
    assert.equal(worldSys(session)["cycles_since_gm"], 1);

    // 跨周期注入：C1001 第二周期决策时能看到①自己上一周期言行②他人（玩家）上一周期言行
    const scene2 = callsText("character:C1001", 3);
    assert.ok(scene2.includes("甲一周期台词"), "注入含自己上一周期言行");
    assert.ok(scene2.includes("玩家一周期"), "注入含他人上一周期言行");

    // 玩家行动（seq4）→ 周期 2 完成 X=2 达阈值 → 周期末 GM（seq5）→ 清算工作集 → seq6 C1001
    await session.handlePlayerInput("玩家二周期");
    assert.equal(session.turnCount, 6);
    assert.equal(worldSys(session)["cycles_since_gm"], 0, "GM 激活后 X 清零");
    const scene3 = callsText("character:C1001", 6);
    assert.ok(!scene3.includes("甲一周期台词"), "GM 清算后注入不含旧周期言行");
    assert.ok(!scene3.includes("玩家一周期"), "GM 清算后注入不含旧周期玩家言行");
  });
});


describe("编辑 = 重读整个输出并完整处理（changes.effects 整段反向 + 同一规划器全效应重放）", () => {
  it("邀请应答步：编辑移除 confirm → 接受效应全反向（含单人邀请者的配对）+ 拒绝效应重放；再编辑加回 confirm → 再次接受", async () => {
    // C0 远未来（不抢前台）；C1001 单人邀请者；C1002 受邀者。开局无同桶 → 无组无先攻投掷。
    // 骰子序：seq2 GM 激活前 fortune 4 骰（50×4）→ GM 后评估 2 个休眠单人组
    // （sC0 timer=100、sC1002 timer=60 均在未来；C1001 被 durations 覆盖整组跳过）各 1 个 d100
    // （给 100 恒不命中）→ seq3 配对补投 2 骰 → 再次接受重放再补投 2 骰。
    const session = makeSession("invite-edit", [
      { id: "C0", name: "玩家", location: "loc_A", timer: 100, isPlayer: true },
      { id: "C1001", name: "甲", location: "loc_A", timer: 0 },
      { id: "C1002", name: "乙", location: "loc_B", timer: 60 },
    ], [50, 50, 50, 50, 100, 100, 10, 8, 10, 8], 5, [
      gmPkg({ durations: [{ cid: "C1001", span: { min: 5 } }] }), // seq2：contact 触发 GM 立即结算
    ]);
    session.setPauseOptions({ everyStep: true, beforeGm: false, afterGm: false, afterProse: false });
    llm.characterQueues["character:C1001"] = [
      decision({ markers: [{ type: "contact", channel: "电话", targets: ["C1002"] }] }),
    ];
    llm.characterQueues["character:C1002"] = [
      decision({ dialogue: "喂，我马上到。", markers: [{ type: "confirm" }] }),
    ];

    await session.continuePipeline(); // seq1 C1001 contact
    await session.continuePipeline(); // seq2 GM（邀请生效待激活）
    await session.continuePipeline(); // seq3 C1002 应答（confirm）：C1001 单人 → 配对成新组并补投
    assert.equal(session.turnCount, 3);
    assert.equal(session.pipelineInfo.kind, "character:C1002");
    // 接受落账：双方入新组、各补投先攻（乙远程 -1）、乙 timer 归当前时钟（立即到期）、计入已行动
    const acceptedInvitee = charState(session, "C1002");
    assert.notEqual(acceptedInvitee.group, 0);
    assert.equal(charState(session, "C1001").group, acceptedInvitee.group);
    assert.deepEqual(charState(session, "C1001").initiative, { value: 15, group: acceptedInvitee.group });
    assert.deepEqual(acceptedInvitee.initiative, { value: 12, group: acceptedInvitee.group });
    assert.equal(acceptedInvitee.timer, 5);
    assert.equal(acceptedInvitee.acted, true);

    // 编辑移除 confirm（改为普通拒绝言辞）：setup 之后整段反向 → 按拒绝重放
    session.editResult(JSON.stringify(decision({ dialogue: "抱歉，走不开。" })));
    const rejected = charState(session, "C1002");
    assert.equal(rejected.group, 0, "入组效应被反向");
    assert.equal(rejected.timer, 60, "timer 还原为邀请前值（拒绝重放）");
    assert.equal(rejected.channel, null, "拒绝：失去频道");
    assert.equal(rejected.acted, false, "拒绝回复不计入已行动");
    assert.equal(rejected.initiative, null, "补投先攻被反向");
    const inviterAfterReject = charState(session, "C1001");
    assert.equal(inviterAfterReject.group, 0, "单人邀请者的配对成组被一并反向");
    assert.equal(inviterAfterReject.initiative, null, "邀请者补投先攻被反向");
    assert.equal(inviterAfterReject.channel, null, "全体持有者同地 → 频道全清");
    // 落账：changes 分段（setup 保留在反向范围外）+ invitation 上下文保留（供再次编辑）
    let current = session.getPipelineCurrent()!;
    let result = current.result as {
      invitation?: { contactSeq: number; inviter: string; channel: string; preInviteTimer: number | null };
    };
    assert.equal(current.changes?.setup.length, 2, "setup（时钟跳转 + timer 弹出）保留在反向范围外");
    assert.ok(result !== null && !("effects_from" in result) && !("markers_from" in result), "下标定位字段已删除");
    assert.deepEqual(result.invitation, { contactSeq: 1, inviter: "C1001", channel: "电话", preInviteTimer: 60 });

    // 连续编辑同一步：加回 confirm → 基于落账的 changes.effects 再次反向+重放接受
    session.editResult(JSON.stringify(decision({ dialogue: "改主意了，我到。", markers: [{ type: "confirm" }] })));
    const reaccepted = charState(session, "C1002");
    assert.notEqual(reaccepted.group, 0);
    assert.equal(charState(session, "C1001").group, reaccepted.group);
    assert.deepEqual(charState(session, "C1001").initiative, { value: 15, group: reaccepted.group });
    assert.deepEqual(reaccepted.initiative, { value: 12, group: reaccepted.group });
    assert.equal(reaccepted.timer, 5);
    assert.equal(reaccepted.acted, true);
    current = session.getPipelineCurrent()!;
    result = current.result as {
      invitation?: { contactSeq: number; inviter: string; channel: string; preInviteTimer: number | null };
    };
    assert.deepEqual(result.invitation, { contactSeq: 1, inviter: "C1001", channel: "电话", preInviteTimer: 60 });
  });

  it("普通步：编辑改 relations → 旧 relation 反向、新 relation 生效；再编辑删掉 → relations 归空", async () => {
    const session = makeSession("relations-edit", [
      { id: "C0", name: "玩家", location: "loc_A", timer: 0, isPlayer: true },
      { id: "C1001", name: "甲", location: "loc_A", timer: 0 },
    ], [5, 20], 5);
    llm.characterQueues["character:C1001"] = [
      decision({ dialogue: "原台词", relations: [{ target: "C0", name: "玩家", impression: "友好" }] }),
    ];

    await session.continuePipeline(); // seq1 C1001 → 停等玩家
    assert.equal(session.pipelineInfo.kind, "character:C1001");
    assert.deepEqual(charState(session, "C1001").relations, [{ cid: "C0", name: "玩家", impression: "友好" }]);

    // 编辑改印象：旧 relation 反向、新 relation 重放；acted 经重放保持置位
    session.editResult(
      JSON.stringify(decision({ dialogue: "改台词", relations: [{ target: "C0", name: "玩家", impression: "警惕" }] })),
    );
    assert.deepEqual(charState(session, "C1001").relations, [{ cid: "C0", name: "玩家", impression: "警惕" }]);
    assert.equal(charState(session, "C1001").acted, true, "普通步 acted 置位经重放保持");

    // 再编辑删掉 relations：重放为空 → relations 归空
    session.editResult(JSON.stringify(decision({ dialogue: "再改台词" })));
    assert.deepEqual(charState(session, "C1001").relations, []);
    assert.equal(charState(session, "C1001").acted, true);
  });
});

describe("玩家步编辑（与角色步同一路径：反转旧 effects + 同一 planner 重放）", () => {
  it("玩家立 leave → 编辑删除 leave 标记 → 组/timer 还原", async () => {
    // 骰子按 cid 升序消费：C0=20+5=25 > C1001=5+5=10 → 开局即等玩家
    const session = makeSession("player-leave", [
      { id: "C0", name: "玩家", location: "loc_A", timer: 0, isPlayer: true },
      { id: "C1001", name: "甲", location: "loc_A", timer: 0 },
    ], [20, 5], 5);
    session.setPauseOptions({ everyStep: true, beforeGm: false, afterGm: false, afterProse: false });

    // 玩家结构化输入立 leave：组归 0、timer 置 null；everyStep 暂停使玩家步停在 current
    assert.equal(session.pipelineInfo.phase, "await_player");
    await session.handlePlayerInput(JSON.stringify(decision({ action: "离开现场", markers: [{ type: "leave" }] })));
    assert.equal(session.getPipelineCurrent()!.kind, "player");
    assert.equal(charState(session, "C0").group, 0);
    assert.equal(charState(session, "C0").timer, null);

    // 编辑删除 leave 标记：旧 effects 反转 → 组/timer 还原；result.input 同步为新文本
    const edited = JSON.stringify(decision({ action: "留下" }));
    session.editResult(edited);
    assert.equal(charState(session, "C0").group, 1);
    assert.equal(charState(session, "C0").timer, 0);
    const current = session.getPipelineCurrent()!;
    assert.equal(current.kind, "player");
    assert.equal(current.edited, true);
    const result = current.result as { input: string; decision: { action?: string } };
    assert.equal(result.input, edited);
    assert.equal(result.decision.action, "留下");
  });

  it("玩家原输入无标记 → 编辑加入 leave → 立即生效（组归 0/timer=null）", async () => {
    const session = makeSession("player-leave-add", [
      { id: "C0", name: "玩家", location: "loc_A", timer: 0, isPlayer: true },
      { id: "C1001", name: "甲", location: "loc_A", timer: 0 },
    ], [20, 5], 5);
    session.setPauseOptions({ everyStep: true, beforeGm: false, afterGm: false, afterProse: false });

    await session.handlePlayerInput(JSON.stringify(decision({ dialogue: "先聊着" })));
    assert.equal(session.getPipelineCurrent()!.kind, "player");
    assert.equal(charState(session, "C0").group, 1);
    assert.equal(charState(session, "C0").timer, 0);

    session.editResult(JSON.stringify(decision({ action: "起身离开", markers: [{ type: "leave" }] })));
    assert.equal(charState(session, "C0").group, 0);
    assert.equal(charState(session, "C0").timer, null);
  });
});
