import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { planActorDecision, type ActorInvitationContext } from "../src/application/actorEffects.js";
import { LEAVE_TIMER } from "../src/scheduler/simulator.js";
import { ArchiveStore } from "../src/truth/archive.js";
import { CharactersStore, type CharacterState } from "../src/truth/charactersStore.js";
import { EventsStore } from "../src/truth/events.js";
import { LoreStore } from "../src/truth/loreStore.js";
import { SAVE_SCHEMA_VERSION } from "../src/truth/saveSchema.js";
import type { TruthStores } from "../src/truth/stores.js";
import { TimeStore } from "../src/truth/timeStore.js";
import type { VarChange } from "../src/truth/varChanges.js";
import { WorldStore } from "../src/truth/worldStore.js";
import { buildManifest } from "./builders/index.js";
import { DecisionPackageSchema, type DecisionPackage } from "../src/types.js";

// ---------------------------------------------------------------------------
// planActorDecision（unit：draft stores 是纯内存容器，零 IO）——
// 表驱动：同一 DecisionPackage 正常/编辑重放产出相同 effects；五标记谱系；邀请应答两分支。
// ---------------------------------------------------------------------------

const START = { y: 1, m: 1, d: 1, h: 0, min: 0 };

function makeTruth(specs: (Parameters<typeof buildManifest>[0])[]): TruthStores {
  return {
    world: WorldStore.initial({ time: START }),
    characters: CharactersStore.fromManifests(specs.map(buildManifest), 0),
    events: new EventsStore(),
    archive: new ArchiveStore(),
    loreStore: LoreStore.initFrom([]),
    timeStore: new TimeStore({ schema_version: SAVE_SCHEMA_VERSION, start: START, periods: [{ key: "白天", from: 0, to: 24 }] }),
  };
}

function decision(overrides?: Record<string, unknown>): DecisionPackage {
  return DecisionPackageSchema.parse({ action: "行动", inner: "内心", ...overrides });
}

/** 确定性骰子队列（耗尽抛错——暴露预期外投掷）。 */
function diceQueue(values: number[]): () => number {
  return () => {
    const v = values.shift();
    if (v === undefined) throw new Error("骰子队列耗尽（出现预期外的先攻投掷）");
    return v;
  };
}

/** 倒序反转一组变更（与 loop.revertVarChanges 同分发口径）。 */
function revert(truth: TruthStores, changes: readonly VarChange[]): void {
  for (const c of [...changes].reverse()) {
    if (c.path.startsWith("world.")) truth.world.revertChange(c);
    else truth.characters.revertChange(c);
  }
}

const trio = () => [
  { id: "C0", name: "玩家", isPlayer: true, timer: 0 },
  { id: "C1001", name: "甲", timer: 0 },
  { id: "C1002", name: "乙", timer: 0 },
];

describe("planActorDecision（同一 DecisionPackage：正常与编辑重放产出相同 effects）", () => {
  it("正常规划确定性：两个相同 draft 同一 pkg → changes 与工作集逐字节一致", () => {
    const pkg = decision({ dialogue: "台词", relations: [{ target: "C0", name: "玩家", impression: "友好" }] });
    const a = makeTruth(trio());
    const b = makeTruth(trio());
    const ea = planActorDecision(a, { cid: "C1001", pkg, rollDice: diceQueue([]) });
    const eb = planActorDecision(b, { cid: "C1001", pkg, rollDice: diceQueue([]) });
    assert.deepEqual(ea.changes, eb.changes);
    assert.deepEqual(a.world.pipeline.working_set, b.world.pipeline.working_set);
    assert.deepEqual(a.characters.all(), b.characters.all());
  });

  it("编辑重放 = 反转旧 effects + 同一 planner：终态与全新规划逐字节一致", () => {
    const pkgOld = decision({ dialogue: "旧台词", relations: [{ target: "C0", name: "玩家", impression: "友好" }] });
    const pkgNew = decision({ dialogue: "新台词" });
    // 重放路径：先规划旧包 → 反转其 effects → 工作集移除旧条目 → 同一 planner 规划新包
    const replayed = makeTruth(trio());
    const oldEffects = planActorDecision(replayed, { cid: "C1001", pkg: pkgOld, rollDice: diceQueue([]) });
    revert(replayed, oldEffects.changes);
    replayed.world.setPipeline({
      working_set: replayed.world.pipeline.working_set.filter((e) => e.cid !== "C1001"),
    });
    const replayEffects = planActorDecision(replayed, { cid: "C1001", pkg: pkgNew, rollDice: diceQueue([]) });
    // 全新路径：同一新包直接规划
    const fresh = makeTruth(trio());
    const freshEffects = planActorDecision(fresh, { cid: "C1001", pkg: pkgNew, rollDice: diceQueue([]) });
    assert.deepEqual(replayEffects.changes, freshEffects.changes, "重放与全新规划产出相同 effects");
    assert.deepEqual(replayed.characters.all(), fresh.characters.all());
    assert.deepEqual(replayed.world.world, fresh.world.world);
    assert.deepEqual(replayed.world.pipeline.working_set, fresh.world.pipeline.working_set);
  });

  it("普通行动：relations 落账 + 工作集追加 + acted 置位（效应顺序 = relations → acted → markers）", () => {
    const truth = makeTruth(trio());
    const pkg = decision({ relations: [{ target: "C0", name: "玩家" }] });
    const { changes } = planActorDecision(truth, { cid: "C1001", pkg, rollDice: diceQueue([]) });
    assert.deepEqual(
      changes.map((c) => c.path),
      ["characters.C1001.relations.C0", "characters.C1001.acted"],
    );
    assert.equal(truth.characters.get("C1001").acted, true);
    assert.deepEqual(truth.characters.get("C1001").relations, { C0: { name: "玩家" } });
    assert.deepEqual(truth.world.pipeline.working_set, [{ cid: "C1001", decision: pkg }]);
  });
});

describe("planActorDecision（标记谱系：程序即时执行，全走 VarChange）", () => {
  it("gm_request：立 gm_trigger + 触发批 = 当前先攻值（无先攻 → 哨兵批）", () => {
    const withInit = makeTruth([{ id: "C1001", initiative: { value: 12, group: 1 }, group: 1 }]);
    const r1 = planActorDecision(withInit, {
      cid: "C1001",
      pkg: decision({ markers: [{ type: "gm_request" }] }),
      rollDice: diceQueue([]),
    });
    assert.equal(withInit.world.world["gm_trigger"], true);
    assert.equal(withInit.world.world["gm_trigger_batch"], 12);
    assert.ok(r1.changes.some((c) => c.path === "world.gm_trigger" && c.after === true));

    const noInit = makeTruth([{ id: "C1001" }]);
    planActorDecision(noInit, {
      cid: "C1001",
      pkg: decision({ markers: [{ type: "gm_request" }] }),
      rollDice: diceQueue([]),
    });
    assert.equal(noInit.world.world["gm_trigger_batch"], -Number.MAX_SAFE_INTEGER);
  });

  it("leave：组归 0 + LEAVE_TIMER 冻结 + 清频道，不触发 GM", () => {
    const truth = makeTruth([{ id: "C1001", group: 2, channel: 3 }]);
    planActorDecision(truth, {
      cid: "C1001",
      pkg: decision({ markers: [{ type: "leave" }] }),
      rollDice: diceQueue([]),
    });
    const s = truth.characters.get("C1001");
    assert.equal(s.group, 0);
    assert.equal(s.timer, LEAVE_TIMER);
    assert.equal(s.channel, null);
    assert.notEqual(truth.world.world["gm_trigger"], true);
  });

  it("contact：邀请双方分配同一新频道 + 立 GM 触发；未知目标忽略", () => {
    const truth = makeTruth(trio());
    truth.characters.setVars("C1002", { channel: 7 }); // 现有最大频道 7 → 新频道 8
    const { changes } = planActorDecision(truth, {
      cid: "C1001",
      pkg: decision({ markers: [{ type: "contact", channel: "电话", targets: ["@C0", "C9999"] }] }),
      rollDice: diceQueue([]),
    });
    assert.equal(truth.characters.get("C1001").channel, 8, "邀请者入新频道（max+1）");
    assert.equal(truth.characters.get("C0").channel, 8, "@ 前缀目标归一化后入同一频道");
    assert.equal(truth.characters.get("C1002").channel, 7, "非目标不受影响");
    assert.equal(truth.world.world["gm_trigger"], true, "contact 触发 GM 立即激活");
    assert.ok(!changes.some((c) => c.path.includes("C9999")), "未知目标不产生变更");
  });

  it("recall：拉回未结算离开者（timer 归 clock、按进组规则归组、先攻复用不重投）", () => {
    const truth = makeTruth([
      { id: "C1001", timer: 0, group: 1, initiative: { value: 25, group: 1 } },
      { id: "C1002", timer: LEAVE_TIMER, group: 0, initiative: { value: 20, group: 1 } },
    ]);
    planActorDecision(truth, {
      cid: "C1001",
      pkg: decision({ markers: [{ type: "recall", target: "C1002" }] }),
      rollDice: diceQueue([]), // 先攻复用：任何投掷都会耗尽队列报错
    });
    const s = truth.characters.get("C1002");
    assert.equal(s.timer, truth.world.clock);
    assert.equal(s.group, 1, "同地同刻 → 归回邀请者所在组");
    assert.deepEqual(s.initiative, { value: 20, group: 1 }, "已存先攻组编号对上即复用");
  });

  it("recall 目标不在未结算离开集合 → 忽略（无变更）", () => {
    const truth = makeTruth([{ id: "C1001" }, { id: "C1002", timer: 30 }]);
    const { changes } = planActorDecision(truth, {
      cid: "C1001",
      pkg: decision({ markers: [{ type: "recall", target: "C1002" }] }),
      rollDice: diceQueue([]),
    });
    assert.deepEqual(changes.map((c) => c.path), ["characters.C1001.acted"], "只剩 acted 置位");
    assert.equal(truth.characters.get("C1002").timer, 30);
  });

  it("游离 confirm（非应答步）：忽略", () => {
    const truth = makeTruth([{ id: "C1001" }]);
    const { changes } = planActorDecision(truth, {
      cid: "C1001",
      pkg: decision({ markers: [{ type: "confirm" }] }),
      rollDice: diceQueue([]),
    });
    assert.deepEqual(changes.map((c) => c.path), ["characters.C1001.acted"]);
  });
});

describe("planActorDecision（邀请应答：confirm 接受 / 拒绝两分支）", () => {
  /** 带 contact 步（seq1，C1001 发起）的 draft：C1001 单人，C1002 远程受邀。 */
  function inviteTruth() {
    const truth = makeTruth([
      { id: "C0", name: "玩家", isPlayer: true, timer: 100, location: { name: "loc_A", level: 1 } },
      { id: "C1001", name: "甲", timer: 0, channel: 1, location: { name: "loc_A", level: 1 } },
      { id: "C1002", name: "乙", timer: 60, channel: 1, location: { name: "loc_B", level: 1 } },
    ]);
    truth.archive.append({
      seq: 1,
      kind: "character:C1001",
      result: {},
      changes: { setup: [], effects: [] },
    });
    return truth;
  }
  const invitation: ActorInvitationContext = { contactSeq: 1, inviter: "C1001", channel: "电话", preInviteTimer: 60 };

  it("confirm 接受：单人邀请者配对成新组并补投、受邀者远程 -1、timer 归 0、计入已行动", () => {
    const truth = inviteTruth();
    planActorDecision(truth, {
      cid: "C1002",
      pkg: decision({ markers: [{ type: "confirm" }] }),
      invitation,
      rollDice: diceQueue([10, 8]), // 邀请者 10+5=15；受邀者 8+5=13，远程 -1 → 12
    });
    const invitee = truth.characters.get("C1002");
    const inviter = truth.characters.get("C1001");
    assert.notEqual(invitee.group, 0);
    assert.equal(inviter.group, invitee.group, "配对成同一新组");
    assert.deepEqual(inviter.initiative, { value: 15, group: invitee.group });
    assert.deepEqual(invitee.initiative, { value: 12, group: invitee.group });
    assert.equal(invitee.timer, 0);
    assert.equal(invitee.acted, true, "首轮回复计入已行动");
  });

  it("拒绝：timer 还原邀请前值 + 失去频道；全体持有者同地 → 频道自动清除；不计入已行动", () => {
    const truth = inviteTruth();
    // 双方都在 loc_A（同地）→ 拒绝后持有者只剩 C1001 且同地 → 频道清理 pass 全清
    truth.characters.setVars("C1002", { location: { name: "loc_A", level: 1 } });
    planActorDecision(truth, {
      cid: "C1002",
      pkg: decision({ dialogue: "走不开。" }),
      invitation,
      rollDice: diceQueue([]),
    });
    const s = truth.characters.get("C1002");
    assert.equal(s.timer, 60, "timer 还原邀请前值");
    assert.equal(s.channel, null);
    assert.equal(s.acted, false, "拒绝回复不计入已行动");
    assert.equal(truth.characters.get("C1001").channel, null, "全体持有者同地 → 频道全清");
  });

  it("应答重放等价：接受后反转再按拒绝重放 = 全新拒绝规划", () => {
    const pkg = decision({ dialogue: "走不开。" });
    const replayed = inviteTruth();
    const accepted = planActorDecision(replayed, {
      cid: "C1002",
      pkg: decision({ markers: [{ type: "confirm" }] }),
      invitation,
      rollDice: diceQueue([10, 8]),
    });
    revert(replayed, accepted.changes);
    replayed.world.setPipeline({
      working_set: replayed.world.pipeline.working_set.filter((e) => e.cid !== "C1002"),
    });
    const replayEffects = planActorDecision(replayed, { cid: "C1002", pkg, invitation, rollDice: diceQueue([]) });

    const fresh = inviteTruth();
    const freshEffects = planActorDecision(fresh, { cid: "C1002", pkg, invitation, rollDice: diceQueue([]) });
    assert.deepEqual(replayEffects.changes, freshEffects.changes);
    assert.deepEqual(replayed.characters.all(), fresh.characters.all());
  });
});
