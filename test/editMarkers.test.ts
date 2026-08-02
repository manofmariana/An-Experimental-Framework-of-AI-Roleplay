import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it, after } from "node:test";
import { LLMClient, type ChatMessage, type ChatResult } from "../src/llm/client.js";
import { GameSession, LEAVE_TIMER } from "../src/loop.js";
import type { CharacterState } from "../src/truth/charactersStore.js";

// ---------------------------------------------------------------------------
// 编辑执行标记（editResult 重放 applyMarkers）+ 工作集跨周期注入（#当前场景）。
// 集成基建与 loopSchedule.test.ts 同型：临时世界设定集 + fake LLM + 确定性骰子。
// ---------------------------------------------------------------------------

const cfg = { apiKey: "dummy", baseURL: "http://127.0.0.1:9", model: "m", jsonMode: false };
const configs = { character: cfg, gm: cfg, prose: cfg };

const root = fs.mkdtempSync(path.join(os.tmpdir(), "airp-edit-markers-"));
const runsDir = path.join(root, "runs");
const worldsDir = path.join(root, "worlds");

after(() => {
  LLMClient.prototype.chat = originalChat;
  fs.rmSync(root, { recursive: true, force: true });
});

interface CharSpec {
  id: string;
  name: string;
  location: string;
  timer: number;
  isPlayer?: boolean;
}

function manifest(spec: CharSpec) {
  return {
    id: spec.id,
    name: spec.name,
    gender: "未设定",
    age: "未设定",
    personality: `${spec.name}谨慎。`,
    initial_memories: [`${spec.name}的记忆`],
    location: { name: spec.location, level: 1 },
    tags: [],
    reaction: 5,
    timer: spec.timer,
    group: 0,
    initiative: null,
    channel: null,
    acted: false,
    level: 1,
    isPlayer: spec.isPlayer === true,
    relations: {},
    vars: {},
  };
}

function setupWorld(worldId: string, specs: CharSpec[]): void {
  const dir = path.join(worldsDir, worldId);
  fs.mkdirSync(path.join(dir, "characters"), { recursive: true });
  fs.writeFileSync(path.join(dir, "setting.md"), "测试世界设定\n");
  fs.writeFileSync(path.join(dir, "tone-card.md"), "测试基调\n");
  fs.writeFileSync(path.join(dir, "lorebook.json"), "[]\n");
  fs.writeFileSync(
    path.join(dir, "time.json"),
    JSON.stringify({ start: { y: 1, m: 1, d: 1, h: 0, min: 0 }, periods: [{ key: "白天", from: 0, to: 24 }] }),
  );
  for (const spec of specs) {
    const file = spec.isPlayer === true
      ? path.join(dir, "player.json")
      : path.join(dir, "characters", `${spec.id}.json`);
    fs.writeFileSync(file, JSON.stringify(manifest(spec)));
  }
}

// --- fake LLM：character 按 agent 脚本队列生成决策；gm 按脚本队列；prose 回显轮次 ---
interface Call {
  agent: string;
  seq: number;
  messages: ChatMessage[];
}
let calls: Call[] = [];
let gmQueue: Record<string, unknown>[] = [];
let diceQueue: number[] = [];
let characterQueues: Record<string, Record<string, unknown>[]> = {};

const originalChat = LLMClient.prototype.chat;
LLMClient.prototype.chat = (async (
  agent: string,
  seq: number,
  messages: ChatMessage[],
): Promise<ChatResult> => {
  calls.push({ agent, seq, messages: messages.map((m) => ({ ...m })) });
  const usage = { hit: 0, miss: 0, output: 0 };
  if (agent === "gm") {
    const pkg = gmQueue.shift();
    if (pkg === undefined) throw new Error(`GM 脚本耗尽（seq ${seq}）`);
    return { text: JSON.stringify(pkg), reasoning: "", usage };
  }
  if (agent === "prose") return { text: `正文#${seq}`, reasoning: "", usage };
  const scripted = characterQueues[agent]?.shift();
  return {
    text: JSON.stringify(scripted ?? { action: `行动#${seq}`, inner: `内心#${seq}`, dialogue: `台词#${seq}` }),
    reasoning: "",
    usage,
  };
}) as never;

function gmPkg(overrides: Record<string, unknown>): Record<string, unknown> {
  return {
    events: [{ text: "GM事件", tags: [] }],
    narrativity: "skip",
    deltas: [],
    timer: [],
    location: [],
    ...overrides,
  };
}

function decision(overrides: Record<string, unknown>): Record<string, unknown> {
  return { action: "行动", inner: "内心", ...overrides };
}

function makeSession(
  tag: string,
  specs: CharSpec[],
  dice: number[],
  gmIntervalCycles: number,
  gm: Record<string, unknown>[] = [],
): GameSession {
  const worldId = `w-${tag}-${process.pid}`;
  setupWorld(worldId, specs);
  const runId = `run-${tag}-${process.pid}`;
  calls = [];
  gmQueue = [...gm];
  diceQueue = [...dice];
  characterQueues = {};
  return GameSession.create(configs, runId, undefined, worldId, {
    baseDir: path.join(runsDir, runId),
    worldsDir,
    proseWindowTurns: 5,
    gmIntervalCycles,
    rollDice: () => {
      const v = diceQueue.shift();
      if (v === undefined) throw new Error("骰子队列耗尽（出现预期外的先攻投掷）");
      return v;
    },
  });
}

function charState(session: GameSession, cid: string): CharacterState {
  const chars = session.getState().characters as Record<string, CharacterState>;
  const s = chars[cid];
  assert.ok(s, `缺少角色 ${cid}`);
  return s;
}

function worldVars(session: GameSession): Record<string, unknown> {
  return session.getState().world as Record<string, unknown>;
}

function callsText(agent: string, seq: number): string {
  const call = calls.find((c) => c.agent === agent && c.seq === seq);
  assert.ok(call, `缺少调用 ${agent}#${seq}`);
  return call.messages.map((m) => m.content).join("\n");
}

describe("编辑执行标记（editResult 重放 applyMarkers，与普通路径同语义）", () => {
  it("编辑插入 leave → 归 0+超大 timer；再编辑移除 → 旧效应被反向", async () => {
    const session = makeSession("leave", [
      { id: "C0", name: "玩家", location: "loc_A", timer: 0, isPlayer: true },
      { id: "C1001", name: "甲", location: "loc_A", timer: 0 },
    ], [5, 20], 5);
    characterQueues["character:C1001"] = [decision({ dialogue: "原决策台词" })];

    await session.continuePipeline(); // seq1 C1001（无标记）→ 停等玩家
    assert.equal(session.pipelineInfo.kind, "character:C1001");
    assert.equal(charState(session, "C1001").group, 1);

    // 编辑插入 leave：组归 0 + 超大 timer（同普通路径）
    session.editResult(JSON.stringify(decision({ action: "离开现场", markers: [{ type: "leave" }] })));
    assert.equal(charState(session, "C1001").group, 0);
    assert.equal(charState(session, "C1001").timer, LEAVE_TIMER);
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
    characterQueues["character:C1001"] = [decision({ dialogue: "原决策台词" })];

    await session.continuePipeline(); // seq1 C1001（无标记）→ 停等玩家
    assert.equal(charState(session, "C1001").channel, null);
    assert.notEqual(worldVars(session)["gm_trigger"], true);

    session.editResult(
      JSON.stringify(decision({ dialogue: "打个电话", markers: [{ type: "contact", channel: "电话", targets: ["C1002"] }] })),
    );
    const ch1 = charState(session, "C1001").channel;
    assert.ok(ch1 !== null && ch1 === charState(session, "C1002").channel, "邀请双方同频道");
    assert.equal(worldVars(session)["gm_trigger"], true, "contact 触发 GM 立即激活");

    session.editResult(JSON.stringify(decision({ dialogue: "算了" })));
    assert.equal(charState(session, "C1001").channel, null);
    assert.equal(charState(session, "C1002").channel, null);
    // 旧 contact 效应被反向：gm_trigger 还原到编辑前状态（首次立标前该键不存在 → 反向后删键）
    assert.notEqual(worldVars(session)["gm_trigger"], true, "旧 contact 效应被反向");
  });

  it("编辑插入 recall → 拉回未结算离开者（timer 归 clock、归组、先攻复用不补投）", async () => {
    // 骰子只够开局三投：召回必须复用已存先攻（任何重投都会耗尽队列报错）
    const session = makeSession("recall", [
      { id: "C0", name: "玩家", location: "loc_A", timer: 0, isPlayer: true },
      { id: "C1001", name: "甲", location: "loc_A", timer: 0 },
      { id: "C1002", name: "乙", location: "loc_A", timer: 0 },
    ], [5, 20, 15], 5);
    characterQueues["character:C1001"] = [decision({ markers: [{ type: "leave" }] })];
    characterQueues["character:C1002"] = [decision({ dialogue: "乙的台词" })];

    // seq1 C1001（先攻 25 最高，立 leave）→ seq2 C1002 → 停等玩家（C0）
    await session.continuePipeline();
    assert.equal(session.pipelineInfo.kind, "character:C1002");
    assert.equal(charState(session, "C1001").group, 0);
    assert.equal(charState(session, "C1001").timer, LEAVE_TIMER);

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
    assert.equal(charState(session, "C1001").timer, LEAVE_TIMER);
  });
});

describe("工作集跨周期注入（#当前场景：GM 清算前的全体言行，自己也不例外）", () => {
  it("跨两个无判定周期：NPC 注入含自己与他人上一周期言行；GM 清算后不再含", async () => {
    const session = makeSession("cycle-scene", [
      { id: "C0", name: "玩家", location: "loc_A", timer: 0, isPlayer: true },
      { id: "C1001", name: "甲", location: "loc_A", timer: 0 },
    ], [5, 20], 2, [
      gmPkg({
        timer: [
          { cid: "C0", span: { min: 5 } },
          { cid: "C1001", span: { min: 5 } },
        ],
      }),
    ]);
    characterQueues["character:C1001"] = [
      decision({ dialogue: "甲一周期台词" }),
      decision({ dialogue: "甲二周期台词" }),
      decision({ dialogue: "甲三周期台词" }),
    ];

    // 周期 1：seq1 C1001 → 停等玩家
    await session.continuePipeline();
    // 玩家行动（seq2）→ 周期 1 完成 X=1（<2 无 GM）→ 周期 2：seq3 C1001 → 停等
    await session.handlePlayerInput("玩家一周期");
    assert.equal(session.turnCount, 3);
    assert.equal(worldVars(session)["cycles_since_gm"], 1);

    // 跨周期注入：C1001 第二周期决策时能看到①自己上一周期言行②他人（玩家）上一周期言行
    const scene2 = callsText("character:C1001", 3);
    assert.ok(scene2.includes("甲一周期台词"), "注入含自己上一周期言行");
    assert.ok(scene2.includes("玩家一周期"), "注入含他人上一周期言行");

    // 玩家行动（seq4）→ 周期 2 完成 X=2 达阈值 → 周期末 GM（seq5）→ 清算工作集 → seq6 C1001
    await session.handlePlayerInput("玩家二周期");
    assert.equal(session.turnCount, 6);
    assert.equal(worldVars(session)["cycles_since_gm"], 0, "GM 激活后 X 清零");
    const scene3 = callsText("character:C1001", 6);
    assert.ok(!scene3.includes("甲一周期台词"), "GM 清算后注入不含旧周期言行");
    assert.ok(!scene3.includes("玩家一周期"), "GM 清算后注入不含旧周期玩家言行");
  });
});


describe("编辑 = 重读整个输出并完整处理（effects_from 整段反向 + 全效应重放）", () => {
  it("邀请应答步：编辑移除 confirm → 接受效应全反向（含单人邀请者的配对）+ 拒绝效应重放；再编辑加回 confirm → 再次接受", async () => {
    // C0 远未来（不抢前台）；C1001 单人邀请者；C1002 受邀者。开局无同桶 → 无组无先攻投掷。
    const session = makeSession("invite-edit", [
      { id: "C0", name: "玩家", location: "loc_A", timer: 100, isPlayer: true },
      { id: "C1001", name: "甲", location: "loc_A", timer: 0 },
      { id: "C1002", name: "乙", location: "loc_B", timer: 60 },
    ], [10, 8, 10, 8], 5, [
      gmPkg({ timer: [{ cid: "C1001", span: { min: 5 } }] }), // seq2：contact 触发 GM 立即结算
    ]);
    session.setPauseOptions({ everyStep: true, beforeGm: false, afterGm: false, afterProse: false });
    characterQueues["character:C1001"] = [
      decision({ markers: [{ type: "contact", channel: "电话", targets: ["C1002"] }] }),
    ];
    characterQueues["character:C1002"] = [
      decision({ dialogue: "喂，我马上到。", markers: [{ type: "confirm" }] }),
    ];

    await session.continuePipeline(); // seq1 C1001 contact
    await session.continuePipeline(); // seq2 GM（邀请生效待激活）
    await session.continuePipeline(); // seq3 C1002 应答（confirm）：C1001 单人 → 配对成新组并补投
    assert.equal(session.turnCount, 3);
    assert.equal(session.pipelineInfo.kind, "character:C1002");
    // 接受落账：双方入新组、各补投先攻（乙远程 -1）、乙 timer 归 0、计入已行动
    const acceptedInvitee = charState(session, "C1002");
    assert.notEqual(acceptedInvitee.group, 0);
    assert.equal(charState(session, "C1001").group, acceptedInvitee.group);
    assert.deepEqual(charState(session, "C1001").initiative, { value: 15, group: acceptedInvitee.group });
    assert.deepEqual(acceptedInvitee.initiative, { value: 12, group: acceptedInvitee.group });
    assert.equal(acceptedInvitee.timer, 0);
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
    // 落账：effects_from/invitation 上下文保留（供再次编辑）
    let result = session.getPipelineCurrent()!.result as {
      effects_from?: number;
      invitation?: { contactSeq: number; inviter: string; channel: string; preInviteTimer: number | null };
    };
    assert.equal(result.effects_from, 2, "setup（时钟跳转 + timer 弹出）保留在反向范围外");
    assert.deepEqual(result.invitation, { contactSeq: 1, inviter: "C1001", channel: "电话", preInviteTimer: 60 });

    // 连续编辑同一步：加回 confirm → 基于第一次落账的 effects_from 再次反向+重放接受
    session.editResult(JSON.stringify(decision({ dialogue: "改主意了，我到。", markers: [{ type: "confirm" }] })));
    const reaccepted = charState(session, "C1002");
    assert.notEqual(reaccepted.group, 0);
    assert.equal(charState(session, "C1001").group, reaccepted.group);
    assert.deepEqual(charState(session, "C1001").initiative, { value: 15, group: reaccepted.group });
    assert.deepEqual(reaccepted.initiative, { value: 12, group: reaccepted.group });
    assert.equal(reaccepted.timer, 0);
    assert.equal(reaccepted.acted, true);
    result = session.getPipelineCurrent()!.result as {
      effects_from?: number;
      invitation?: { contactSeq: number; inviter: string; channel: string; preInviteTimer: number | null };
    };
    assert.deepEqual(result.invitation, { contactSeq: 1, inviter: "C1001", channel: "电话", preInviteTimer: 60 });
  });

  it("普通步：编辑改 relations → 旧 relation 反向、新 relation 生效；再编辑删掉 → relations 归空", async () => {
    const session = makeSession("relations-edit", [
      { id: "C0", name: "玩家", location: "loc_A", timer: 0, isPlayer: true },
      { id: "C1001", name: "甲", location: "loc_A", timer: 0 },
    ], [5, 20], 5);
    characterQueues["character:C1001"] = [
      decision({ dialogue: "原台词", relations: [{ target: "C0", name: "玩家", impression: "友好" }] }),
    ];

    await session.continuePipeline(); // seq1 C1001 → 停等玩家
    assert.equal(session.pipelineInfo.kind, "character:C1001");
    assert.deepEqual(charState(session, "C1001").relations, { C0: { name: "玩家", impression: "友好" } });

    // 编辑改印象：旧 relation 反向、新 relation 重放；acted 经重放保持置位
    session.editResult(
      JSON.stringify(decision({ dialogue: "改台词", relations: [{ target: "C0", name: "玩家", impression: "警惕" }] })),
    );
    assert.deepEqual(charState(session, "C1001").relations, { C0: { name: "玩家", impression: "警惕" } });
    assert.equal(charState(session, "C1001").acted, true, "普通步 acted 置位经重放保持");

    // 再编辑删掉 relations：重放为空 → relations 归空
    session.editResult(JSON.stringify(decision({ dialogue: "再改台词" })));
    assert.deepEqual(charState(session, "C1001").relations, {});
    assert.equal(charState(session, "C1001").acted, true);
  });
});
