import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { GameSession } from "../src/loop.js";
import type { CharacterState } from "../src/truth/charactersStore.js";
import { SessionHarness } from "./harness/session.js";

// ---------------------------------------------------------------------------
// 复现：二人同步组 {C0, C1001}，NPC 发言 → 玩家发言（周期完成，X+1，全员 acted 清零）
// → NPC 再次发言 → 回滚到第一次 NPC 发言。预期 acted_C1001 === true、下一步 await_player。
// 集成基建 = SessionHarness（临时世界设定集 + fake LLM + 确定性骰子）。
// fake LLM：本场景不应激活 GM（gmQueue 恒空，被调用即报"GM 脚本耗尽"）。
// ---------------------------------------------------------------------------

const h = new SessionHarness("airp-repro-acted-");
const worldId = `w-repro-${process.pid}`;
h.setupWorld(worldId, [
  { id: "C0", name: "玩家", location: "loc_A", timer: 0, isPlayer: true },
  { id: "C1001", name: "甲", location: "loc_A", timer: 0 },
]);

function createSession(runId: string, dice: number[]): GameSession {
  return h.makeSession(runId, worldId, { dice, gmIntervalCycles: 5 });
}

function resumeSession(runId: string): GameSession {
  return h.resumeSession(runId, {
    gmIntervalCycles: 5,
    options: {
      rollDice: () => {
        throw new Error("恢复后不应有先攻投掷");
      },
    },
  });
}

function acted(session: GameSession, cid: string): boolean {
  const chars = session.getState().characters as Record<string, CharacterState>;
  return chars[cid]!.acted;
}

describe("复现：跨周期回滚吞 acted", () => {
  it("(a) 纯内存会话", async () => {
    // 开局先攻：C0=10，C1001=25（先行动）
    const session = createSession(`run-a-${process.pid}`, [5, 20]);

    // seq1：C1001 发言 → 停等玩家
    await session.continuePipeline();
    assert.equal(session.pipelineInfo.kind, "character:C1001");
    assert.equal(session.pipelineInfo.phase, "await_player");
    assert.equal(acted(session, "C1001"), true);
    assert.equal(acted(session, "C0"), false);

    // seq2：玩家发言 → 周期完成 X+1、全员 acted 清零 → seq3：C1001 再次发言 → 停等玩家
    await session.handlePlayerInput("玩家台词");
    assert.equal(session.turnCount, 3);
    assert.equal(session.pipelineInfo.kind, "character:C1001");
    assert.equal(acted(session, "C1001"), true);
    assert.equal(acted(session, "C0"), false);

    // 回滚到 seq1（第一次 NPC 发言刚完成）
    session.rollbackTo(1);
    assert.equal(acted(session, "C1001"), true, "回滚后 acted_C1001 应为 true");
    assert.equal(acted(session, "C0"), false);
    assert.equal(session.pipelineInfo.phase, "await_player", "回滚后下一步应轮到玩家");
  });

  it("(b) 第一步后存档→恢复→再走 2-4", async () => {
    const runId = `run-b-${process.pid}`;
    const s1 = createSession(runId, [5, 20]);
    await s1.continuePipeline(); // seq1：C1001 发言 → 停等玩家
    assert.equal(s1.pipelineInfo.phase, "await_player");

    // 恢复会话
    const session = resumeSession(runId);
    assert.equal(session.pipelineInfo.kind, "character:C1001");
    assert.equal(session.pipelineInfo.phase, "await_player");
    assert.equal(acted(session, "C1001"), true);

    // seq2 玩家 → seq3 C1001
    await session.handlePlayerInput("玩家台词");
    assert.equal(session.turnCount, 3);
    assert.equal(session.pipelineInfo.kind, "character:C1001");

    // 回滚到 seq1
    session.rollbackTo(1);
    assert.equal(acted(session, "C1001"), true, "回滚后 acted_C1001 应为 true");
    assert.equal(acted(session, "C0"), false);
    assert.equal(session.pipelineInfo.phase, "await_player", "回滚后下一步应轮到玩家");
  });
});
