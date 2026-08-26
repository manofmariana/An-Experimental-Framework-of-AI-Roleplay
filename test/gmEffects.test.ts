import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { planGmAdjudication } from "../src/application/gmEffects.js";
import { applyVarDeltas } from "../src/truth/varWrite.js";
import { ArchiveStore } from "../src/truth/archive.js";
import { CharactersStore } from "../src/truth/charactersStore.js";
import { EventsStore } from "../src/truth/events.js";
import { LoreStore } from "../src/truth/loreStore.js";
import { SAVE_SCHEMA_VERSION } from "../src/truth/saveSchema.js";
import type { TruthStores } from "../src/truth/stores.js";
import { TimeStore } from "../src/truth/timeStore.js";
import type { VarChange } from "../src/truth/varChanges.js";
import { WorldStore } from "../src/truth/worldStore.js";
import { buildManifest, buildVarsTemplate, buildWorldSysRaw } from "./builders/index.js";
import { parseVarsTemplate } from "../src/vars/template.js";
import { AdjudicationPackageSchema, type AdjudicationPackage } from "../src/types.js";

// ---------------------------------------------------------------------------
// planGmAdjudication（unit：draft stores 纯内存，零 IO）——
// deltas/timer/location/复位/acted/组派生/events 提交形状/工作集清算 + 重放等价。
// ---------------------------------------------------------------------------

const START = { y: 0, m: 1, d: 1, h: 0, min: 0 };
const DECL = buildVarsTemplate().characterVars;

function makeTruth(): TruthStores {
  const truth = {
    // 周期计数与触发标记的既有值（GM 激活后须复位）
    world: WorldStore.initial({ time: START }, buildWorldSysRaw({ cycles_since_gm: 2, gm_trigger: true })),
    characters: CharactersStore.fromManifests(
      [
        { id: "C0", name: "玩家", isPlayer: true, timer: 0, acted: true, location: { name: "loc_A", level: 1 } },
        { id: "C1001", name: "甲", timer: 0, acted: true, location: { name: "loc_A", level: 1 } },
      ].map(buildManifest),
      0,
      DECL,
    ),
    events: new EventsStore(),
    archive: new ArchiveStore(),
    loreStore: LoreStore.initFrom([]),
    timeStore: new TimeStore({ schema_version: SAVE_SCHEMA_VERSION, start: START, periods: [{ key: "白天", from: 0, to: 24 }] }),
  };
  truth.world.setPipeline({ working_set: [{ cid: "C0" }, { cid: "C1001" }] });
  return truth;
}

function adjudication(overrides?: Record<string, unknown>): AdjudicationPackage {
  return AdjudicationPackageSchema.parse({
    events: [],
    narrativity: "skip",
    deltas: [],
    durations: [],
    location: [],
    ...overrides,
  });
}

function diceQueue(values: number[]): () => number {
  return () => {
    const v = values.shift();
    if (v === undefined) throw new Error("骰子队列耗尽（出现预期外的先攻投掷）");
    return v;
  };
}

function idAllocator(): () => string {
  let n = 0;
  return () => `evt_${String((n += 1)).padStart(4, "0")}`;
}

function revert(truth: TruthStores, changes: readonly VarChange[]): void {
  for (const c of [...changes].reverse()) {
    if (c.path.startsWith("world.")) truth.world.revertChange(c);
    else truth.characters.revertChange(c);
  }
}

const fullPkg = () =>
  adjudication({
    deltas: [{ path: "world.region.fog", op: "=", value: true }],
    durations: [
      { cid: "C0", span: { min: 5 } },
      { cid: "C1001", span: { min: 5 } },
    ],
    location: [{ cid: "C1001", location: { name: "loc_A", level: 2 } }],
    events: [
      { text: "事件一", tags: [] },
      { text: "事件二", tags: ["known_by:C0"], location: "灯塔" },
    ],
  });

describe("planGmAdjudication（提交形状）", () => {
  it("deltas/timer/location/周期与触发复位/acted 清零/组派生/工作集清算", () => {
    const truth = makeTruth();
    const clock = truth.world.clock;
    const { changes } = planGmAdjudication(truth, {
      seq: 9,
      pkg: fullPkg(),
      roundCids: ["C0", "C1001"],
      allocateEventId: idAllocator(),
      rollDice: diceQueue([3, 4]), // 两人异地异刻 → 各自成组，各补投一次先攻
    });
    // deltas 落库（末端外壳：写 value，tags 保留）
    const fog = (truth.world.world["region"] as Record<string, unknown>)?.["fog"] as { value: unknown };
    assert.equal(fog.value, true);
    // timer：相对偏移 → 绝对到期时刻
    assert.equal(truth.characters.get("C0").timer, clock + 5);
    assert.equal(truth.characters.get("C1001").timer, clock + 5);
    // location：GM 只设变量
    assert.deepEqual(truth.characters.get("C1001").location, { name: "loc_A", level: 2 });
    // 周期计数 X 清零 + 触发复位（_sys 程序分支）
    assert.equal(truth.world.world._sys["cycles_since_gm"], 0);
    assert.equal(truth.world.world._sys["gm_trigger"], false);
    // 结算成员 acted 清零
    assert.equal(truth.characters.get("C0").acted, false);
    assert.equal(truth.characters.get("C1001").acted, false);
    // 组派生：同地同刻 → 并入同组并各补投先攻（reaction 5：3+5=8 / 4+5=9）
    const g0 = truth.characters.get("C0");
    const g1 = truth.characters.get("C1001");
    assert.notEqual(g0.group, 0);
    assert.equal(g0.group, g1.group);
    assert.deepEqual(g0.initiative, { value: 8, group: g0.group });
    assert.deepEqual(g1.initiative, { value: 9, group: g0.group });
    // 工作集清算
    assert.deepEqual(truth.world.pipeline.working_set, []);
    // 变更记录覆盖关键路径
    const paths = changes.map((c) => c.path);
    for (const p of ["world.region.fog", "characters.C0.timer", "characters.C1001.timer", "world._sys.cycles_since_gm", "world._sys.gm_trigger", "characters.C0.acted", "characters.C1001.group"]) {
      assert.ok(paths.includes(p), `缺少变更路径 ${p}`);
    }
  });

  it("events 提交形状：ID 经注入分配器、tags 缺省 = 本轮行动者、location 透传、seq/t 落账", () => {
    const truth = makeTruth();
    const clock = truth.world.clock;
    const { committed } = planGmAdjudication(truth, {
      seq: 9,
      pkg: fullPkg(),
      roundCids: ["C0", "C1001"],
      allocateEventId: idAllocator(),
      rollDice: diceQueue([3, 4]),
    });
    assert.equal(committed.length, 2);
    assert.deepEqual(committed[0], {
      id: "evt_0001",
      t: clock,
      seq: 9,
      kind: "world",
      tags: ["known_by:C0", "known_by:C1001"],
      payload: "事件一",
    });
    assert.deepEqual(committed[1], {
      id: "evt_0002",
      t: clock,
      seq: 9,
      kind: "world",
      location: "灯塔",
      tags: ["known_by:C0"],
      payload: "事件二",
    });
    assert.deepEqual(truth.events.readAll(), committed, "事件已写入事件库");
  });

  it("未知角色的 timer/location 跳过（告警不抛错），已知角色不受影响", () => {
    const truth = makeTruth();
    planGmAdjudication(truth, {
      seq: 1,
      pkg: adjudication({
        durations: [
          { cid: "C9999", span: { min: 1 } },
          { cid: "C0", span: { min: 5 } },
        ],
        location: [{ cid: "C9999", location: { name: "x", level: 1 } }],
      }),
      roundCids: ["C0"],
      allocateEventId: idAllocator(),
      rollDice: diceQueue([3]),
    });
    assert.equal(truth.characters.get("C0").timer, truth.world.clock + 5);
    assert.equal(truth.characters.all()["C9999"], undefined);
  });
});

describe("planGmAdjudication（重放等价：正常裁决与编辑重放同一规划器）", () => {
  it("同一裁决包两次独立规划 → changes 与 committed 逐字节一致", () => {
    const a = makeTruth();
    const b = makeTruth();
    const ea = planGmAdjudication(a, { seq: 9, pkg: fullPkg(), roundCids: ["C0", "C1001"], allocateEventId: idAllocator(), rollDice: diceQueue([3, 4]) });
    const eb = planGmAdjudication(b, { seq: 9, pkg: fullPkg(), roundCids: ["C0", "C1001"], allocateEventId: idAllocator(), rollDice: diceQueue([3, 4]) });
    assert.deepEqual(ea.changes, eb.changes);
    assert.deepEqual(ea.committed, eb.committed);
  });

  it("编辑重放 = 反转旧 effects + 事件截断 + 同一 planner：终态与全新规划逐字节一致", () => {
    const pkgOld = fullPkg();
    const pkgNew = adjudication({
      durations: [
        { cid: "C0", span: { min: 7 } },
        { cid: "C1001", span: { min: 7 } },
      ],
      events: [{ text: "替换事件", tags: [] }],
    });
    // 重放路径（同 editResult GM 分支）：规划旧包 → 反转 effects → 事件截断 → 工作集还原 → 规划新包
    const replayed = makeTruth();
    const oldEffects = planGmAdjudication(replayed, { seq: 9, pkg: pkgOld, roundCids: ["C0", "C1001"], allocateEventId: idAllocator(), rollDice: diceQueue([3, 4]) });
    revert(replayed, oldEffects.changes);
    replayed.events.truncateToSeq(8);
    replayed.world.setPipeline({ working_set: [{ cid: "C0" }, { cid: "C1001" }] });
    const replayEffects = planGmAdjudication(replayed, { seq: 9, pkg: pkgNew, roundCids: ["C0", "C1001"], allocateEventId: idAllocator(), rollDice: diceQueue([6, 6]) });
    // 全新路径
    const fresh = makeTruth();
    const freshEffects = planGmAdjudication(fresh, { seq: 9, pkg: pkgNew, roundCids: ["C0", "C1001"], allocateEventId: idAllocator(), rollDice: diceQueue([6, 6]) });
    assert.deepEqual(replayEffects.changes, freshEffects.changes, "重放与全新规划产出相同 effects");
    assert.deepEqual(replayEffects.committed, freshEffects.committed);
    assert.deepEqual(replayed.characters.all(), fresh.characters.all());
    assert.deepEqual(replayed.world.world, fresh.world.world);
    assert.deepEqual(replayed.events.readAll(), fresh.events.readAll());
    assert.deepEqual(replayed.world.pipeline.working_set, fresh.world.pipeline.working_set);
  });
});

describe("GM deltas 写入通道（applyVarDeltas：双根路由 + 模板校验）", () => {
  function planWith(deltas: Record<string, unknown>[]) {
    const truth = makeTruth();
    return {
      truth,
      plan: () =>
        planGmAdjudication(truth, {
          seq: 9,
          pkg: adjudication({ deltas, durations: [{ cid: "C0", span: { min: 5 } }] }),
          roundCids: ["C0"],
          allocateEventId: idAllocator(),
          rollDice: diceQueue([3, 4]),
        }),
    };
  }

  it("拒写 world.time / world._sys / 无声明路径（抛错拒绝该条；之前的 delta 已落账，原子性归 draft 丢弃）", () => {
    const a = planWith([{ path: "world.omen", op: "=", value: 1 }, { path: "world.time.h", op: "=", value: 2 }]);
    assert.throws(a.plan, /world.time/);
    assert.equal(((a.truth.world.world["omen"] as { value: unknown }).value), 1, "前序 delta 已落账（draft 级原子性由调用方保证）");
    assert.throws(planWith([{ path: "world._sys.cycles_since_gm", op: "=", value: 9 }]).plan, /程序分支/);
    assert.throws(planWith([{ path: "world.undeclared.deep", op: "=", value: 1 }]).plan, /不可解析/);
  });

  it("+=/-= 仅 number 末端且当前值与增量均数值；写容器 = 整体对象经 normalize", () => {
    const { truth, plan } = planWith([
      { path: "world.omen", op: "=", value: 10 },
      { path: "world.omen", op: "+=", value: 5 },
      { path: "world.region", op: "=", value: { fog: true } },
    ]);
    const { changes } = plan();
    assert.equal((truth.world.world["omen"] as { value: unknown }).value, 15);
    const region = truth.world.world["region"] as Record<string, unknown>;
    assert.deepEqual(region["fog"], { value: true, tags: [] });
    const omenChanges = changes.filter((c) => c.path === "world.omen");
    assert.deepEqual(omenChanges.map((c) => [c.before, c.after]), [
      [null, { value: 10, tags: [] }],
      [{ value: 10, tags: [] }, { value: 15, tags: [] }],
    ]);
    assert.throws(planWith([{ path: "world.omen", op: "+=", value: 1 }]).plan, /当前值与增量均为数值/);
    assert.throws(planWith([{ path: "world.region.fog", op: "+=", value: 1 }]).plan, /仅支持 number 末端/);
  });

  it("角色域：只可写 vars 子树；写 attachtags 后 tags 池重算并追加 VarChange；不合法 TAG 名拒绝", () => {
    const { truth, plan } = planWith([
      { path: "characters.C1001.vars.attachtags", op: "=", value: ["aud"] },
    ]);
    const { changes } = plan();
    assert.deepEqual(truth.characters.tagNames("C1001"), ["aud"]);
    const pool = changes.find((c) => c.path === "characters.C1001.vars.tags");
    assert.ok(pool, "tags 池重算追加 VarChange");
    assert.deepEqual(pool.after, { value: ["aud"], tags: [] });
    assert.throws(planWith([{ path: "characters.C1001.timer", op: "=", value: 1 }]).plan, /系统字段/);
    assert.throws(planWith([{ path: "characters.C1001.vars.tags", op: "=", value: [] }]).plan, /从动末端拒写/);
    // CID 形态名按 cid 类别判定：未知 CID = 手误拒绝（channel/location 放行不兜底）
    assert.throws(
      planWith([{ path: "characters.C1001.vars.attachtags", op: "=", value: ["C9999"] }]).plan,
      /未注册 TAG 名 "C9999"/,
    );
    assert.throws(planWith([{ path: "characters.C9999.vars.attachtags", op: "=", value: [] }]).plan, /未知角色/);
  });

  it("cid 类别写值判定：attachtags 写现存角色 CID 放行（类别已声明 ∧ 实例存在）", () => {
    const { truth, plan } = planWith([
      { path: "characters.C1001.vars.attachtags", op: "=", value: ["C1001", "C0"] },
    ]);
    plan();
    assert.deepEqual(truth.characters.tagNames("C1001"), ["C1001", "C0"]);
    // 未声明类别（空 categories）= 实例名不放行（deps 单元口径，生产注册表三类别齐备）
    const truth2 = makeTruth();
    assert.throws(
      () =>
        applyVarDeltas(
          truth2,
          [{ path: "characters.C1001.vars.attachtags", op: "=", value: ["C1001"] }],
          { template: buildVarsTemplate(), registeredNames: new Set(["aud"]), categories: {} },
        ),
      /未注册 TAG 名 "C1001"/,
    );
  });

  it("tag_list 末端写值同口径：内容侧挂载表写现存角色 CID 放行、未知 CID 拒绝", () => {
    const tpl = parseVarsTemplate({
      world: { children: { pool: "tag_list" } },
      character: {
        children: {
          attachtags: "string_list",
          tags: { valueType: "string_list", formula: { op: "union_attach", paths: [] as string[] } },
        },
      },
    });
    const deps = {
      template: tpl,
      registeredNames: new Set(["aud"]),
      categories: { cid: new Set(["C1001"]), channel: new Set<string>(), location: new Set<string>() },
    };
    const truth = makeTruth();
    applyVarDeltas(truth, [{ path: "world.pool", op: "=", value: [{ name: "C1001", level: 2 }] }], deps);
    assert.deepEqual(truth.world.world["pool"], { value: [{ name: "C1001", level: 2 }], tags: [] });
    assert.throws(
      () => applyVarDeltas(truth, [{ path: "world.pool", op: "=", value: [{ name: "C9999", level: 1 }] }], deps),
      /未注册 TAG 名 "C9999"/,
    );
  });

  it("角色域：vars 下系统分支路径命中系统声明分支 = 拒写（系统字段走专用通道）", () => {
    for (const path of [
      "characters.C1001.vars.name",
      "characters.C1001.vars.timer",
      "characters.C1001.vars.location.name",
      "characters.C1001.vars.relations[0].name",
      "characters.C1001.vars.long_term_memory",
    ]) {
      assert.throws(planWith([{ path, op: "=", value: "x" }]).plan, new RegExp(`系统字段走白名单专用通道`), path);
    }
  });
});

describe("GM deltas 结构化数组写入（`键[数字]` 下标语法）", () => {
  /** 含 items 数组的角色模板与 deps（元素结构 = {count, name}）。 */
  function arrayDeps() {
    const tpl = parseVarsTemplate({
      world: { children: {} },
      character: {
        children: {
          attachtags: "string_list",
          tags: { valueType: "string_list", formula: { op: "union_attach", paths: [] as string[] } },
          items: { array: { children: { count: "number", name: "string" } } },
        },
      },
    });
    return { template: tpl, registeredNames: new Set<string>(), categories: {} };
  }

  it("[数字] 精确下标写元素末端；元素结构错型 = 拒写", () => {
    const truth = makeTruth();
    const deps = arrayDeps();
    applyVarDeltas(
      truth,
      [{ path: "characters.C1001.vars.items", op: "=", value: [{ count: 1, name: "剑" }, { count: 2, name: "盾" }] }],
      deps,
    );
    applyVarDeltas(truth, [{ path: "characters.C1001.vars.items[1].count", op: "=", value: 5 }], deps);
    const items = (truth.characters.get("C1001").vars as Record<string, unknown>)["items"] as Record<string, unknown>[];
    assert.equal((items[1]!["count"] as { value: unknown }).value, 5);
    assert.equal((items[0]!["count"] as { value: unknown }).value, 1, "兄弟元素不受影响");
    // 元素结构错型拒写
    assert.throws(
      () => applyVarDeltas(truth, [{ path: "characters.C1001.vars.items[0].count", op: "=", value: "x" }], deps),
      /类型错配/,
    );
    // 元素未声明字段拒写
    assert.throws(
      () => applyVarDeltas(truth, [{ path: "characters.C1001.vars.items[0].ghost", op: "=", value: 1 }], deps),
      /不可解析/,
    );
  });

  it("[*] 通配 / 非数组对象整体 / 缺下标 = 拒写", () => {
    const truth = makeTruth();
    const deps = arrayDeps();
    assert.throws(
      () => applyVarDeltas(truth, [{ path: "characters.C1001.vars.items[*].count", op: "=", value: 1 }], deps),
      /\[\*\] 通配/,
    );
    assert.throws(
      () => applyVarDeltas(truth, [{ path: "characters.C1001.vars.items", op: "=", value: { "0": { count: 1 } } }], deps),
      /必须是数组/,
    );
    assert.throws(
      () => applyVarDeltas(truth, [{ path: "characters.C1001.vars.items.count", op: "=", value: 1 }], deps),
      /需要 \[数字\] 或 \[\*\] 下标/,
    );
  });
});
