import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { planGmAdjudication } from "../src/application/gmEffects.js";
import { ArchiveStore } from "../src/truth/archive.js";
import { CharactersStore } from "../src/truth/charactersStore.js";
import { EventsStore } from "../src/truth/events.js";
import { LoreStore } from "../src/truth/loreStore.js";
import { SAVE_SCHEMA_VERSION } from "../src/truth/saveSchema.js";
import type { TruthStores } from "../src/truth/stores.js";
import { TimeStore } from "../src/truth/timeStore.js";
import type { VarChange } from "../src/truth/varChanges.js";
import { WorldStore } from "../src/truth/worldStore.js";
import { buildManifest } from "./builders/index.js";
import { AdjudicationPackageSchema, type AdjudicationPackage } from "../src/types.js";

// ---------------------------------------------------------------------------
// planGmAdjudication（unit：draft stores 纯内存，零 IO）——
// deltas/timer/location/复位/acted/组派生/events 提交形状/工作集清算 + 重放等价。
// ---------------------------------------------------------------------------

const START = { y: 1, m: 1, d: 1, h: 0, min: 0 };

function makeTruth(): TruthStores {
  const truth = {
    world: WorldStore.initial({ time: START }),
    characters: CharactersStore.fromManifests(
      [
        { id: "C0", name: "玩家", isPlayer: true, timer: 0, acted: true, location: { name: "loc_A", level: 1 } },
        { id: "C1001", name: "甲", timer: 0, acted: true, location: { name: "loc_A", level: 1 } },
      ].map(buildManifest),
      0,
    ),
    events: new EventsStore(),
    archive: new ArchiveStore(),
    loreStore: LoreStore.initFrom([]),
    timeStore: new TimeStore({ schema_version: SAVE_SCHEMA_VERSION, start: START, periods: [{ key: "白天", from: 0, to: 24 }] }),
  };
  // 周期计数与触发标记的既有值（GM 激活后须复位）
  truth.world.apply([
    { path: "cycles_since_gm", op: "=", value: 2 },
    { path: "gm_trigger", op: "=", value: true },
  ]);
  truth.world.setPipeline({ working_set: [{ cid: "C0" }, { cid: "C1001" }] });
  return truth;
}

function adjudication(overrides?: Record<string, unknown>): AdjudicationPackage {
  return AdjudicationPackageSchema.parse({
    events: [],
    narrativity: "skip",
    deltas: [],
    timer: [],
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
    deltas: [{ path: "region.fog", op: "=", value: true }],
    timer: [
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
    // deltas 落库
    assert.equal((truth.world.world["region"] as Record<string, unknown>)?.["fog"], true);
    // timer：相对偏移 → 绝对到期时刻
    assert.equal(truth.characters.get("C0").timer, clock + 5);
    assert.equal(truth.characters.get("C1001").timer, clock + 5);
    // location：GM 只设变量
    assert.deepEqual(truth.characters.get("C1001").location, { name: "loc_A", level: 2 });
    // 周期计数 X 清零 + 触发复位
    assert.equal(truth.world.world["cycles_since_gm"], 0);
    assert.equal(truth.world.world["gm_trigger"], false);
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
    for (const p of ["world.region.fog", "characters.C0.timer", "characters.C1001.timer", "world.cycles_since_gm", "world.gm_trigger", "characters.C0.acted", "characters.C1001.group"]) {
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
        timer: [
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
      timer: [
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
