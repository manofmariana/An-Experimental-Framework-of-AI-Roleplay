import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { GameSession } from "../src/application/gameSession.js";
import type { VarChange } from "../src/truth/varChanges.js";
import { buildAdjudication as gmPkg } from "./builders/index.js";
import { SessionHarness } from "./harness/session.js";

// ---------------------------------------------------------------------------
// 从动变量级联（GameSession 级出口测试）：写路径整根级联（expr 公式 + union terms +
// 结构化数组 "*" 段元素枚举）、直编回归、回溯还原、成环拒装。
// 集成基建 = SessionHarness（临时世界设定集 + fake LLM + 确定性骰子）。
// ---------------------------------------------------------------------------

/** 级联测试模板：world 域 tension = omen*2；角色 hp = max_hp - wounds；
 *  tags 池 union terms = attach ["armor"] + cid/location/channel 常驻；item 类型内
 *  load = weight*2（类型内路径以类型根为基准）。 */
const CASCADE_TEMPLATE_RAW = {
  world: {
    children: {
      omen: "number",
      tension: { valueType: "number", formula: { expr: "omen * 2", binds: { omen: "omen" } } },
    },
  },
  character: {
    children: {
      attachtags: "string_list",
      tags: {
        valueType: "string_list",
        formula: { op: "union", terms: [{ attach: ["armor"] }, { sys: "cid" }, { sys: "location" }, { sys: "channel" }] },
      },
      armor: { array: { type: "item" } },
      max_hp: "number",
      wounds: "number",
      hp: { valueType: "number", formula: { expr: "max_hp - wounds", binds: { max_hp: "max_hp", wounds: "wounds" } } },
    },
  },
  types: {
    item: {
      children: {
        attachtags: "string_list",
        weight: "number",
        load: { valueType: "number", formula: { expr: "weight * 2", binds: { weight: "weight" } } },
      },
    },
  },
};

const SWORD = { attachtags: ["aud"], weight: 3 };
const SHIELD = { attachtags: ["vis"], weight: 5 };

const h = new SessionHarness("airp-derived-cascade-");

const WORLD_ID = `w-cascade-${process.pid}`;
h.setupWorld(
  WORLD_ID,
  [
    { id: "C0", name: "玩家", location: "loc_A", timer: 0, isPlayer: true },
    {
      id: "C1001",
      name: "甲",
      location: "loc_A",
      timer: 0,
      vars: { max_hp: 100, wounds: 0, armor: [SWORD, SHIELD] },
    },
  ],
  { varsTemplate: CASCADE_TEMPLATE_RAW },
);

const PAUSE_AFTER_GM = { everyStep: false, beforeGm: false, afterGm: true, afterProse: false };

/** narrativity=skip 的 GM 包（durations 覆盖本轮行动者——命中评估不消费骰子）。 */
function gmSkip(deltas: Record<string, unknown>[]): Record<string, unknown> {
  return gmPkg({
    narrativity: "skip",
    deltas,
    durations: [
      { cid: "C0", span: { min: 5 } },
      { cid: "C1001", span: { min: 5 } },
    ],
  });
}

function makeSession(tag: string, gm: Record<string, unknown>[]): { session: GameSession; runId: string } {
  const runId = `run-cascade-${tag}-${process.pid}`;
  const session = h.makeSession(runId, WORLD_ID, {
    // 先攻 2 枚 + 每 GM 步 fortune 4 枚（统一填 50，富余无害）
    dice: [5, 20, ...Array<number>(40).fill(50)],
    gmIntervalCycles: 1,
    gm,
  });
  session.setPauseOptions(PAUSE_AFTER_GM);
  return { session, runId };
}

/** 跑一轮到 GM 步停（C1001 行动 → 玩家输入 → GM 结算）。 */
async function runGmStep(session: GameSession): Promise<void> {
  await session.continuePipeline();
  await session.handlePlayerInput("玩家行动");
}

/** 当前步（= 刚停的 GM 步）effects 段变更记录（读档内 sys.json 的 pipeline 分支）。 */
function currentEffects(runId: string): VarChange[] {
  const raw = JSON.parse(h.runFile(runId, "sys.json")) as {
    pipeline: { current: { changes?: { effects?: VarChange[] } } | null };
  };
  return raw.pipeline.current?.changes?.effects ?? [];
}

function varsOf(session: GameSession, cid: string): Record<string, unknown> {
  return h.charState(session, cid).vars as Record<string, unknown>;
}

function valueOf(node: unknown): unknown {
  return (node as { value: unknown }).value;
}

describe("从动级联：union 装备穿脱 + 结构化数组元素枚举", () => {
  it("初始池 = 装备 attachtags ∪ cid/location/channel；GM delta 脱一件 → 池同步移除；穿回 → 恢复", async () => {
    const { session, runId } = makeSession("equip", [
      gmSkip([{ path: "characters.C1001.vars.armor", op: "=", value: [SWORD] }]),
    ]);
    // 装配物化：池 = 自身 attachtags（空）∪ armor 子树（两件装备）∪ 常驻系统项
    assert.deepEqual(valueOf(varsOf(session, "C1001")["tags"]), ["aud", "vis", "C1001", "loc_A"]);

    // 脱掉一件：池同步移除 vis；armor[0].load 经 "*" 枚举重算（weight 3 → 6）
    await runGmStep(session);
    assert.deepEqual(valueOf(varsOf(session, "C1001")["tags"]), ["aud", "C1001", "loc_A"]);
    const armor = varsOf(session, "C1001")["armor"] as Record<string, unknown>[];
    assert.equal(valueOf(armor[0]?.["load"]), 6);
    const effects = currentEffects(runId);
    const pool = effects.find((c) => c.path === "characters.C1001.vars.tags");
    assert.ok(pool, "池重算追加 VarChange");
    assert.deepEqual(pool.after, { value: ["aud", "C1001", "loc_A"], tags: [] });
    assert.deepEqual(pool.before, { value: ["aud", "vis", "C1001", "loc_A"], tags: [] });
    const load = effects.find((c) => c.path === "characters.C1001.vars.armor.0.load");
    assert.ok(load, "数组内从动末端经元素枚举重算");
    assert.deepEqual(load.after, { value: 6, tags: [] });

    // 穿回：池恢复并集；armor[1].load 物化（weight 5 → 10）
    h.llm.gmQueue.push(
      gmSkip([{ path: "characters.C1001.vars.armor", op: "=", value: [SWORD, SHIELD] }]),
    );
    await runGmStep(session);
    assert.deepEqual(valueOf(varsOf(session, "C1001")["tags"]), ["aud", "vis", "C1001", "loc_A"]);
    const armor2 = varsOf(session, "C1001")["armor"] as Record<string, unknown>[];
    assert.equal(valueOf(armor2[1]?.["load"]), 10);
  });

  it("GM delta 走 `键[数字]` 下标语法写数组元素末端", async () => {
    const { session } = makeSession("index-write", [
      gmSkip([{ path: "characters.C1001.vars.armor[1].weight", op: "=", value: 9 }]),
    ]);
    await runGmStep(session);
    const armor = varsOf(session, "C1001")["armor"] as Record<string, unknown>[];
    assert.equal(valueOf(armor[1]?.["weight"]), 9);
    assert.equal(valueOf(armor[1]?.["load"]), 18, "元素内从动末端随下标写级联");
  });
});

describe("从动级联：expr 公式", () => {
  it("GM delta 写 wounds/omen → hp/tension 同 commit 重算，VarChange 齐", async () => {
    const { session, runId } = makeSession("expr", [
      gmSkip([
        { path: "characters.C1001.vars.wounds", op: "+=", value: 10 },
        { path: "world.omen", op: "=", value: 5 },
      ]),
    ]);
    await runGmStep(session);
    assert.equal(valueOf(varsOf(session, "C1001")["hp"]), 90);
    assert.equal(valueOf(h.worldVars(session)["tension"]), 10);
    const effects = currentEffects(runId);
    const hp = effects.find((c) => c.path === "characters.C1001.vars.hp");
    assert.ok(hp, "hp 级联追加 VarChange");
    assert.equal(hp.before, null);
    assert.equal(hp.before_exists, false, "hp 首次物化（before 不存在）");
    assert.deepEqual(hp.after, { value: 90, tags: [] });
    const tension = effects.find((c) => c.path === "world.tension");
    assert.ok(tension, "world 域从动末端级联追加 VarChange");
    assert.deepEqual(tension.after, { value: 10, tags: [] });
  });

  it("直编把从动值改成任意值 → commit 后回归计算值", async () => {
    const { session } = makeSession("direct", [
      gmSkip([{ path: "characters.C1001.vars.wounds", op: "+=", value: 10 }]),
    ]);
    await runGmStep(session);
    assert.equal(valueOf(varsOf(session, "C1001")["hp"]), 90, "前置：hp 已级联物化");

    const characters = JSON.parse(JSON.stringify(session.getState().characters)) as Record<
      string,
      { vars: Record<string, unknown> }
    >;
    characters["C1001"]!.vars["hp"] = { value: 999, tags: [] };
    session.applyDirectEdit({ characters });
    assert.equal(valueOf(varsOf(session, "C1001")["hp"]), 90, "直编的从动值回归 max_hp - wounds");
  });

  it("触发过级联的步 rollback → 从动末端随 changes 反转还原", async () => {
    const { session } = makeSession("rollback", [
      gmSkip([
        { path: "characters.C1001.vars.wounds", op: "+=", value: 10 },
        { path: "world.omen", op: "=", value: 5 },
      ]),
    ]);
    await runGmStep(session);
    assert.equal(session.pipelineInfo.seq, 3, "前置：seq1 C1001 / seq2 玩家 / seq3 GM");
    assert.equal(valueOf(varsOf(session, "C1001")["hp"]), 90);

    session.rollbackTo(2);
    assert.equal(varsOf(session, "C1001")["hp"], undefined, "级联物化的 hp 随回溯删除");
    assert.equal(valueOf(varsOf(session, "C1001")["wounds"]), 0);
    assert.equal(h.worldVars(session)["tension"], undefined, "world 域级联末端随回溯删除");
    assert.equal(h.worldVars(session)["omen"], undefined);
  });
});

describe("从动依赖成环", () => {
  it("模板 A↔B 互相依赖 → 装配拒装（消息带环路径）", () => {
    const cyclicId = `w-cascade-cyclic-${process.pid}`;
    h.setupWorld(
      cyclicId,
      [
        { id: "C0", name: "玩家", location: "loc_A", timer: 0, isPlayer: true },
        { id: "C1001", name: "甲", location: "loc_A", timer: 0 },
      ],
      {
        varsTemplate: {
          world: { children: {} },
          character: {
            children: {
              attachtags: "string_list",
              tags: { valueType: "string_list", formula: { op: "union", terms: [{ attach: [] }] } },
              a: { valueType: "number", formula: { expr: "b + 1", binds: { b: "b" } } },
              b: { valueType: "number", formula: { expr: "a + 1", binds: { a: "a" } } },
            },
          },
        },
      },
    );
    assert.throws(
      () => h.makeSession(`run-cascade-cyclic-${process.pid}`, cyclicId, { dice: [5, 20], gm: [] }),
      /从动变量依赖成环/,
    );
  });
});
