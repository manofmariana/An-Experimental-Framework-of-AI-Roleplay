import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it, after } from "node:test";
import { LLMClient, type ChatMessage, type ChatResult } from "../src/llm/client.js";
import { GameSession } from "../src/loop.js";
import type { CharacterState } from "../src/truth/charactersStore.js";

// ---------------------------------------------------------------------------
// 复现：二人同步组 {C0, C1001}，NPC 发言 → 玩家发言（周期完成，X+1，全员 acted 清零）
// → NPC 再次发言 → 回滚到第一次 NPC 发言。预期 acted_C1001 === true、下一步 await_player。
// ---------------------------------------------------------------------------

const cfg = { apiKey: "dummy", baseURL: "http://127.0.0.1:9", model: "m", jsonMode: false };
const configs = { character: cfg, gm: cfg, prose: cfg };

const root = fs.mkdtempSync(path.join(os.tmpdir(), "airp-repro-acted-"));
const runsDir = path.join(root, "runs");
const worldsDir = path.join(root, "worlds");

after(() => {
  LLMClient.prototype.chat = originalChat;
  fs.rmSync(root, { recursive: true, force: true });
});

const worldId = `w-repro-${process.pid}`;
function setupWorld(): void {
  const dir = path.join(worldsDir, worldId);
  fs.mkdirSync(path.join(dir, "characters"), { recursive: true });
  fs.writeFileSync(path.join(dir, "setting.md"), "测试世界设定\n");
  fs.writeFileSync(path.join(dir, "tone-card.md"), "测试基调\n");
  fs.writeFileSync(path.join(dir, "lorebook.json"), "[]\n");
  fs.writeFileSync(
    path.join(dir, "time.json"),
    JSON.stringify({ start: { y: 1, m: 1, d: 1, h: 0, min: 0 }, periods: [{ key: "白天", from: 0, to: 24 }] }),
  );
  const base = {
    gender: "未设定",
    age: "未设定",
    personality: "谨慎。",
    initial_memories: ["记忆"],
    location: { name: "loc_A", level: 1 },
    tags: [],
    reaction: 5,
    timer: 0,
    group: 0,
    initiative: null,
    channel: null,
    acted: false,
    level: 1,
    relations: {},
    vars: {},
  };
  fs.writeFileSync(
    path.join(dir, "player.json"),
    JSON.stringify({ ...base, id: "C0", name: "玩家", isPlayer: true }),
  );
  fs.writeFileSync(
    path.join(dir, "characters", "C1001.json"),
    JSON.stringify({ ...base, id: "C1001", name: "甲", isPlayer: false }),
  );
}

const originalChat = LLMClient.prototype.chat;
LLMClient.prototype.chat = (async (
  agent: string,
  seq: number,
  _messages: ChatMessage[],
): Promise<ChatResult> => {
  const usage = { hit: 0, miss: 0, output: 0 };
  if (agent === "gm") throw new Error(`本场景不应激活 GM（seq ${seq}）`);
  if (agent === "prose") return { text: `正文#${seq}`, reasoning: "", usage };
  return {
    text: JSON.stringify({ action: `行动#${seq}`, inner: `内心#${seq}`, dialogue: `台词#${seq}` }),
    reasoning: "",
    usage,
  };
}) as never;

function createSession(runId: string, dice: number[]): GameSession {
  return GameSession.create(configs, runId, undefined, worldId, {
    baseDir: path.join(runsDir, runId),
    worldsDir,
    proseWindowTurns: 5,
    gmIntervalCycles: 5,
    rollDice: () => {
      const v = dice.shift();
      if (v === undefined) throw new Error("骰子队列耗尽");
      return v;
    },
  });
}

function resumeSession(runId: string): GameSession {
  return GameSession.resume(configs, runId, undefined, {
    baseDir: path.join(runsDir, runId),
    worldsDir,
    proseWindowTurns: 5,
    gmIntervalCycles: 5,
    rollDice: () => {
      throw new Error("恢复后不应有先攻投掷");
    },
  });
}

function acted(session: GameSession, cid: string): boolean {
  const chars = session.getState().characters as Record<string, CharacterState>;
  return chars[cid]!.acted;
}

describe("复现：跨周期回滚吞 acted", () => {
  it("(a) 纯内存会话", async () => {
    setupWorld();
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
    setupWorld();
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
