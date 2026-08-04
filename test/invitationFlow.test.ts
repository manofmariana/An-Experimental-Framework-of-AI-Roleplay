import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { GameSession } from "../src/application/gameSession.js";
import { buildAdjudication as gmPkg, buildDecision as decision } from "./builders/index.js";
import { SessionHarness } from "./harness/session.js";

// ---------------------------------------------------------------------------
// 多人邀请集成（application，docs/optimization-review.md §2 验收清单）：
// InvitationProjection 增量/重建在 GameSession 各提交路径上的行为。
// ---------------------------------------------------------------------------

const h = new SessionHarness("airp-invite-flow-");
const llm = h.llm;
const calls = llm.port.calls;
const setupWorld = h.setupWorld.bind(h);
const charState = h.charState.bind(h);

function makeSession(
  runId: string,
  worldId: string,
  dice: number[],
  gm: Record<string, unknown>[],
): GameSession {
  return h.makeSession(runId, worldId, { dice, gm, gmIntervalCycles: 1 });
}

/** 全部步（archive + current）中携带邀请上下文的应答步。 */
function invitationSteps(session: GameSession): { seq: number; kind: string }[] {
  return [...session.getArchive(), ...(session.getPipelineCurrent() !== null ? [session.getPipelineCurrent()!] : [])]
    .filter((e) => (e.result as { invitation?: unknown } | null)?.invitation !== undefined)
    .map((e) => ({ seq: e.seq, kind: e.kind }));
}

function stepKinds(session: GameSession): string[] {
  return [...session.getArchive(), session.getPipelineCurrent()!].map((e) => `${e.seq}:${e.kind}`);
}

describe("多人邀请：多目标按序应答（先攻降序 + CID 升序），接受/拒绝混合每人只应答一次", () => {
  it("两目标异地同组：先攻高者先应答（contact 目标列表顺序无关）；接受入组 / 拒绝还原", async () => {
    const worldId = `w-if1-${process.pid}`;
    setupWorld(worldId, [
      { id: "C0", name: "玩家", location: "loc_A", timer: 0, isPlayer: true },
      { id: "C1001", name: "甲", location: "loc_A", timer: 0 },
      { id: "C1002", name: "乙", location: "loc_B", timer: 60 },
      { id: "C1003", name: "丙", location: "loc_B", timer: 60 },
    ]);
    const runId = `run-if1-${process.pid}`;
    // 开局先攻：C0=10，C1001=25（组 1）；C1002=13，C1003=20（组 2）；
    // C1003 入组补投 10+5-1=14；seq7 GM 合组后 C1002 补投 12+5-1=16
    const session = makeSession(runId, worldId, [5, 20, 8, 15, 10, 12], [
      gmPkg({ timer: [{ cid: "C1001", span: { min: 5 } }, { cid: "C0", span: { min: 5 } }] }), // seq2：contact 触发 GM
      gmPkg({ // seq7：周期末（邀请双方 + 拒绝者都在工作集，契约全覆盖）
        timer: [
          { cid: "C1001", span: { min: 10 } },
          { cid: "C1002", span: { min: 10 } },
          { cid: "C1003", span: { min: 10 } },
          { cid: "C0", span: { min: 10 } },
        ],
      }),
    ]);
    llm.characterQueues["character:C1001"] = [
      decision({ markers: [{ type: "contact", channel: "电话", targets: ["C1002", "C1003"] }] }),
    ];
    llm.characterQueues["character:C1002"] = [decision({ dialogue: "抱歉，走不开。" })]; // 拒绝
    llm.characterQueues["character:C1003"] = [decision({ dialogue: "马上到。", markers: [{ type: "confirm" }] })]; // 接受

    // seq1 C1001 contact（targets 列表 C1002 在前）→ seq2 GM → t=5 弹出：
    // 应答顺序按先攻降序——C1003（20）先于 C1002（13），与 contact 目标列表顺序无关；
    // 应答完毕 → C1001 补完（seq5：GM 结算清 acted 后的周期补完）→ 停等玩家
    await session.continuePipeline();
    assert.equal(session.pipelineInfo.phase, "await_player");
    assert.deepEqual(stepKinds(session), [
      "1:character:C1001", "2:gm", "3:character:C1003", "4:character:C1002", "5:character:C1001",
    ]);
    // 接受/拒绝混合：C1003 入邀请者组（confirm），C1002 timer 还原为邀请前值且不计入已行动
    assert.equal(charState(session, "C1003").group, charState(session, "C1001").group);
    assert.equal(charState(session, "C1002").timer, 60);
    assert.equal(charState(session, "C1002").acted, false);
    // 每人只应答一次：应答步恰好 seq3/seq4 各一
    assert.deepEqual(invitationSteps(session), [
      { seq: 3, kind: "character:C1003" },
      { seq: 4, kind: "character:C1002" },
    ]);

    // seq6 玩家 → seq7 周期末 GM（t=15，合组）→ 正常周期行动：受邀者不再被重复激活应答
    await session.handlePlayerInput("玩家等待");
    assert.equal(session.turnCount, 10);
    assert.equal(session.pipelineInfo.phase, "await_player");
    assert.deepEqual(
      stepKinds(session).slice(5),
      ["6:player", "7:gm", "8:character:C1001", "9:character:C1002", "10:character:C1003"],
    );
    assert.deepEqual(
      invitationSteps(session),
      [
        { seq: 3, kind: "character:C1003" },
        { seq: 4, kind: "character:C1002" },
      ],
      "GM 重设 timer 后不再出现重复应答",
    );
    // 频道生命周期：接受者与邀请者保持频道（仍异地），拒绝者失去频道
    assert.equal(charState(session, "C1001").channel, 1);
    assert.equal(charState(session, "C1003").channel, 1);
    assert.equal(charState(session, "C1002").channel, null);
  });
});

describe("多人邀请：目标含玩家", () => {
  it("停在 await_player（邀请应答），玩家 confirm 输入后入组继续", async () => {
    const worldId = `w-if2-${process.pid}`;
    setupWorld(worldId, [
      { id: "C0", name: "玩家", location: "loc_A", timer: 10, isPlayer: true },
      { id: "C1001", name: "甲", location: "loc_B", timer: 0 },
    ]);
    const runId = `run-if2-${process.pid}`;
    // 全员单人组（开局无投掷）；confirm 配对补投：C1001=25，C0=10-1=9（异地 -1）
    const session = makeSession(runId, worldId, [20, 5], [
      gmPkg({ timer: [{ cid: "C1001", span: { min: 5 } }] }), // seq2：contact 触发 GM（工作集仅 C1001）
      gmPkg({ // seq5：周期末（配对组全体成员）
        timer: [{ cid: "C1001", span: { min: 10 } }, { cid: "C0", span: { min: 10 } }],
      }),
    ]);
    llm.characterQueues["character:C1001"] = [
      decision({ markers: [{ type: "contact", channel: "电话", targets: ["C0"] }] }),
      decision({ action: "碰头后的行动" }),
    ];

    // seq1 C1001 contact → seq2 GM → t=5 弹出：邀请目标是玩家 → 停 await_player（不自动前进）
    await session.continuePipeline();
    assert.equal(session.turnCount, 2);
    assert.equal(session.pipelineInfo.phase, "await_player");

    // 玩家 confirm 应答（seq3）：入组（配对成新组）、timer 置 0、计入已行动 → C1001 补完（seq4）
    // → 周期末 GM（seq5）→ t=15 弹出：C1001（先攻 25，seq6）→ 再停等玩家
    await session.handlePlayerInput(
      JSON.stringify({ action: "赴约", inner: "去看看", markers: [{ type: "confirm" }] }),
    );
    assert.equal(session.turnCount, 6);
    assert.equal(session.pipelineInfo.phase, "await_player");
    assert.equal(charState(session, "C0").group, charState(session, "C1001").group);
    assert.notEqual(charState(session, "C0").group, 0);
    assert.deepEqual(charState(session, "C0").initiative, { value: 9, group: charState(session, "C0").group });
    // 玩家应答步显式记录邀请上下文（contactSeq=1）：投影重建/增量共用的应答判据
    assert.deepEqual(invitationSteps(session), [{ seq: 3, kind: "player" }]);
    const answerStep = session.getArchive()[2]!;
    assert.equal(
      (answerStep.result as { invitation: { contactSeq: number } }).invitation.contactSeq,
      1,
    );
  });
});

describe("多人邀请：回滚 / 读档 / 编辑后只继续未应答目标", () => {
  it("编辑已应答步（重放 confirm）→ 续跑只应答剩余目标；回滚到应答中途 + 读档同口径", async () => {
    const worldId = `w-if3-${process.pid}`;
    setupWorld(worldId, [
      { id: "C0", name: "玩家", location: "loc_A", timer: 0, isPlayer: true },
      { id: "C1001", name: "甲", location: "loc_A", timer: 0 },
      { id: "C1002", name: "乙", location: "loc_B", timer: 60 },
      { id: "C1003", name: "丙", location: "loc_B", timer: 60 },
    ]);
    const runId = `run-if3-${process.pid}`;
    // 开局 4 投 + C1003 入组补投（10）+ 编辑重放 confirm 再补投（11，反向后 initiative 组编号不符）
    const session = makeSession(runId, worldId, [5, 20, 8, 15, 10, 11], [
      gmPkg({ timer: [{ cid: "C1001", span: { min: 5 } }, { cid: "C0", span: { min: 5 } }] }), // seq2
    ]);
    llm.characterQueues["character:C1001"] = [
      decision({ markers: [{ type: "contact", channel: "电话", targets: ["C1002", "C1003"] }] }),
    ];
    llm.characterQueues["character:C1002"] = [
      decision({ dialogue: "拒绝一。" }), // 首跑 seq4
      decision({ dialogue: "拒绝二。" }), // 编辑后续跑 seq4
      decision({ dialogue: "拒绝三。" }), // 回滚 + 读档后续跑 seq4
    ];
    llm.characterQueues["character:C1003"] = [
      decision({ dialogue: "来了。", markers: [{ type: "confirm" }] }), // seq3（仅首跑调 LLM）
    ];

    // 首跑：seq3 C1003 接受、seq4 C1002 拒绝、seq5 C1001 补完 → 停等玩家
    await session.continuePipeline();
    assert.equal(session.turnCount, 5);
    assert.equal(session.pipelineInfo.phase, "await_player");

    // 回滚到 seq3（C1003 应答步）并编辑（仍 confirm、换台词）：效应整段反向 + 应答重放
    session.rollbackTo(3);
    session.editResult(JSON.stringify(decision({ dialogue: "改口：我也来。", markers: [{ type: "confirm" }] })));
    assert.equal(charState(session, "C1003").group, charState(session, "C1001").group, "编辑重放 confirm：C1003 仍在邀请者组");
    assert.equal(charState(session, "C1002").timer, 60, "seq4 已回滚：C1002 还原为邀请前值");

    // 续跑：投影重建后只剩 C1002 未应答 → seq4 C1002 重跑 + seq5 C1001 补完（C1003 不被重复激活）
    const callsBefore = calls.length;
    await session.continuePipeline();
    assert.equal(session.turnCount, 5);
    assert.equal(session.pipelineInfo.phase, "await_player");
    const newCalls = calls.slice(callsBefore);
    assert.deepEqual(newCalls.map((c) => c.agent), ["character:C1002", "character:C1001"], "只继续未应答目标 C1002");
    assert.ok(!newCalls.some((c) => c.agent === "character:C1003"), "已应答的 C1003 不被重复激活");
    assert.deepEqual(invitationSteps(session), [
      { seq: 3, kind: "character:C1003" },
      { seq: 4, kind: "character:C1002" },
    ]);

    // 回滚到应答中途（seq3 之后、seq4 之前）→ 读档：投影从 archive + current 全量重建，
    // 只继续未应答目标（C1002），不重复激活已应答的 C1003
    session.rollbackTo(3);
    const resumed = h.resumeSession(runId, { gmIntervalCycles: 1 });
    assert.equal(resumed.pipelineInfo.phase, "await_character", "读档派生：C1002 应答步");
    const resumedCallsBefore = calls.length;
    await resumed.continuePipeline();
    assert.equal(resumed.turnCount, 5);
    assert.equal(resumed.pipelineInfo.phase, "await_player");
    const resumedCalls = calls.slice(resumedCallsBefore);
    assert.deepEqual(resumedCalls.map((c) => c.agent), ["character:C1002", "character:C1001"]);
    assert.ok(!resumedCalls.some((c) => c.agent === "character:C1003"));
    assert.deepEqual(invitationSteps(resumed), [
      { seq: 3, kind: "character:C1003" },
      { seq: 4, kind: "character:C1002" },
    ]);
  });
});
