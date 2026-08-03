import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { GameSession } from "../src/loop.js";
import { buildAdjudication as gmPkg } from "./builders/index.js";
import { SessionHarness } from "./harness/session.js";

// ---------------------------------------------------------------------------
// 暂停选项（取代"默认自动继续"）：一次性闸门——只在本次续跑已执行过步后生效，
// 点"继续"恢复；自动继续 = 全 false。附：玩家纯文本回退映射（inner+dialogue）。
// 集成基建 = SessionHarness（临时世界设定集 + fake LLM + 确定性骰子）。
// ---------------------------------------------------------------------------

const h = new SessionHarness("airp-pause-");
const llm = h.llm;
const calls = llm.port.calls;
const setupWorld = h.setupWorld.bind(h);

/** narrativity=full 的 GM 包（触发正文步；timer 覆盖本轮行动者）。 */
function gmFull(): Record<string, unknown> {
  return gmPkg({
    narrativity: "full",
    timer: [
      { cid: "C0", span: { min: 5 } },
      { cid: "C1001", span: { min: 5 } },
    ],
  });
}

const NO_PAUSE = { everyStep: false, beforeGm: false, afterGm: false, afterProse: false };

/**
 * 固定构图：C0（玩家）+ C1001 同地同刻 → 组 1；骰子 [5,20] → C1001 先攻高先行动。
 * gmIntervalCycles=1：首个行动周期完成即周期末 GM。
 */
function makeSession(tag: string, pause: typeof NO_PAUSE): GameSession {
  const worldId = `w-${tag}-${process.pid}`;
  setupWorld(worldId, [
    { id: "C0", name: "玩家", location: "loc_A", timer: 0, isPlayer: true },
    { id: "C1001", name: "甲", location: "loc_A", timer: 0 },
  ]);
  const runId = `run-${tag}-${process.pid}`;
  const session = h.makeSession(runId, worldId, { dice: [5, 20], gmIntervalCycles: 1, gm: [gmFull()] });
  session.setPauseOptions(pause);
  return session;
}

function gmCalls(): number {
  return calls.filter((c) => c.agent === "gm").length;
}

describe("暂停选项（一次性闸门：本次续跑已执行过步才生效，继续恢复）", () => {
  it("自动继续（全 false）：一口气跑到 await_player（现状不变）", async () => {
    const session = makeSession("auto", NO_PAUSE);
    await session.continuePipeline(); // C1001 行动（seq1）→ 停等玩家
    assert.equal(session.turnCount, 1);
    await session.handlePlayerInput("玩家行动"); // seq2 → GM(seq3) → 正文(seq4) → C1001(seq5) → 停等
    assert.equal(session.turnCount, 5);
    assert.equal(session.pipelineInfo.phase, "await_player");
    assert.equal(gmCalls(), 1);
  });

  it("每轮暂停：每次输入/继续只推进一步", async () => {
    const session = makeSession("every", { ...NO_PAUSE, everyStep: true });
    await session.continuePipeline(); // seq1（C1001）→ 自然停在 await_player
    assert.equal(session.turnCount, 1);
    // 玩家输入步完成后立即停（每步完成后停）：GM 未激活
    await session.handlePlayerInput("玩家行动");
    assert.equal(session.turnCount, 2);
    assert.equal(session.pipelineInfo.phase, "await_gm");
    assert.equal(gmCalls(), 0);
    await session.continuePipeline(); // seq3 GM → 停（正文前）
    assert.equal(session.turnCount, 3);
    assert.equal(session.pipelineInfo.kind, "gm");
    assert.equal(gmCalls(), 1);
    await session.continuePipeline(); // seq4 正文 → 停
    assert.equal(session.turnCount, 4);
    assert.equal(session.pipelineInfo.kind, "prose");
    await session.continuePipeline(); // seq5 C1001 → 停等玩家
    assert.equal(session.turnCount, 5);
    assert.equal(session.pipelineInfo.phase, "await_player");
  });

  it("GM 前暂停：玩家步后停在 await_gm；继续后 GM 照常跑完", async () => {
    const session = makeSession("before-gm", { ...NO_PAUSE, beforeGm: true });
    await session.continuePipeline(); // seq1
    await session.handlePlayerInput("玩家行动"); // seq2 → 下一步 await_gm → 停
    assert.equal(session.turnCount, 2);
    assert.equal(session.pipelineInfo.phase, "await_gm");
    assert.equal(gmCalls(), 0);
    await session.continuePipeline(); // 闸门一次性：GM(seq3) → 正文(seq4) → C1001(seq5) → 停等
    assert.equal(session.turnCount, 5);
    assert.equal(gmCalls(), 1);
    assert.equal(session.pipelineInfo.phase, "await_player");
  });

  it("GM 后暂停：GM 步完成后停在正文前；继续跑正文", async () => {
    const session = makeSession("after-gm", { ...NO_PAUSE, afterGm: true });
    await session.continuePipeline(); // seq1
    await session.handlePlayerInput("玩家行动"); // seq2 → GM(seq3) → 停
    assert.equal(session.turnCount, 3);
    assert.equal(session.pipelineInfo.kind, "gm");
    assert.equal(session.pipelineInfo.phase, "await_prose");
    assert.equal(calls.filter((c) => c.agent === "prose").length, 0);
    await session.continuePipeline(); // 正文(seq4) → C1001(seq5) → 停等
    assert.equal(session.turnCount, 5);
    assert.equal(calls.filter((c) => c.agent === "prose").length, 1);
    assert.equal(session.pipelineInfo.phase, "await_player");
  });

  it("正文后暂停：正文步完成后停；继续进下一周期", async () => {
    const session = makeSession("after-prose", { ...NO_PAUSE, afterProse: true });
    await session.continuePipeline(); // seq1
    await session.handlePlayerInput("玩家行动"); // seq2 → GM(seq3) → 正文(seq4) → 停
    assert.equal(session.turnCount, 4);
    assert.equal(session.pipelineInfo.kind, "prose");
    assert.equal(calls.filter((c) => c.agent === "character:C1001").length, 1, "正文后未进下一周期");
    await session.continuePipeline(); // C1001(seq5) → 停等玩家
    assert.equal(session.turnCount, 5);
    assert.equal(session.pipelineInfo.phase, "await_player");
  });

  it("GM 前+GM 后组合：两处各停一次", async () => {
    const session = makeSession("gm-sandwich", { ...NO_PAUSE, beforeGm: true, afterGm: true });
    await session.continuePipeline(); // seq1
    await session.handlePlayerInput("玩家行动"); // seq2 → GM 前停
    assert.equal(session.turnCount, 2);
    assert.equal(gmCalls(), 0);
    await session.continuePipeline(); // GM(seq3) → GM 后停
    assert.equal(session.turnCount, 3);
    assert.equal(session.pipelineInfo.phase, "await_prose");
    await session.continuePipeline(); // 正文(seq4) → C1001(seq5) → 停等
    assert.equal(session.turnCount, 5);
    assert.equal(session.pipelineInfo.phase, "await_player");
  });
});

describe("玩家纯文本回退映射（无结构化 JSON → { inner, dialogue }）", () => {
  it("纯文本进工作集为 decision（dialogue=inner=原文），GM 场景按发言渲染", async () => {
    const session = makeSession("plain", NO_PAUSE);
    await session.continuePipeline(); // seq1 C1001 → 停等玩家
    await session.handlePlayerInput("随便说说"); // seq2 → GM(seq3) → 正文(seq4) → C1001(seq5)
    const playerStep = session.getArchive().find((e) => e.kind === "player");
    assert.ok(playerStep, "玩家步已归档");
    const result = playerStep.result as { input: string; decision?: { inner: string; dialogue?: string; action?: string } };
    assert.equal(result.input, "随便说说");
    assert.deepEqual(result.decision, { inner: "随便说说", dialogue: "随便说说" });
    const gmCall = calls.find((c) => c.agent === "gm");
    assert.ok(gmCall, "GM 已激活");
    const gmPrompt = gmCall.messages.map((m) => m.content).join("\n");
    assert.ok(gmPrompt.includes("发言：随便说说"), "纯文本按台词注入 GM 场景");
  });

  it("结构化 JSON 路径不变（含 action/dialogue 省略组合）", async () => {
    const session = makeSession("structured", NO_PAUSE);
    await session.continuePipeline();
    // 纯台词轮（无 action）：契约合法，原样进工作集
    await session.handlePlayerInput(JSON.stringify({ inner: "警觉", dialogue: "谁在那？" }));
    const playerStep = session.getArchive().find((e) => e.kind === "player");
    const result = playerStep!.result as { decision?: { inner: string; dialogue?: string; action?: string } };
    assert.deepEqual(result.decision, { inner: "警觉", dialogue: "谁在那？" });
  });
});
