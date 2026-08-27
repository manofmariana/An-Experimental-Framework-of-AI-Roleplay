import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  prepareNextCommand,
  type DeterministicRulePort,
  type PrepareNextCommandDeps,
} from "../src/application/prepareNextCommand.js";
import { deriveNext, type SchedulerSnapshot } from "../src/scheduler/derive.js";
import { ArchiveStore } from "../src/truth/archive.js";
import { CharactersStore } from "../src/truth/charactersStore.js";
import { EventsStore } from "../src/truth/events.js";
import { LoreStore } from "../src/truth/loreStore.js";
import { SAVE_SCHEMA_VERSION } from "../src/truth/saveSchema.js";
import { cloneTruth, type TruthStores } from "../src/truth/stores.js";
import { TimeStore } from "../src/truth/timeStore.js";
import type { VarChange } from "../src/truth/varChanges.js";
import { WorldStore } from "../src/truth/worldStore.js";
import { buildManifest, buildPromptsStore, buildVarsTemplate, buildWorldSysRaw } from "./builders/index.js";

// ---------------------------------------------------------------------------
// prepareNextCommand（unit：纯内存 draft + 注入回调，零 IO）——
// 空 rules 短路；固定点收敛 + commit 恰好一次；签名重复/超迭代上限 → 弃稿报错。
// ---------------------------------------------------------------------------

const START = { y: 0, m: 1, d: 1, h: 0, min: 0 };
const DECL = buildVarsTemplate().characterVars;

function makeTruth(): TruthStores {
  return {
    world: WorldStore.initial({ time: START }, buildWorldSysRaw()),
    characters: CharactersStore.fromManifests(
      [buildManifest({ id: "C0", name: "玩家", isPlayer: true, timer: 0 })],
      0,
      DECL,
    ),
    events: new EventsStore(),
    archive: new ArchiveStore(),
    loreStore: LoreStore.initFrom([]),
    timeStore: new TimeStore({ schema_version: SAVE_SCHEMA_VERSION, start: START, periods: [{ key: "白天", from: 0, to: 24 }] }),
    promptsStore: buildPromptsStore(),
  };
}

/** 固定最小快照（空角色表 → deriveNext 恒为 player/deadlock，与规则变异无耦合）。 */
const SNAPSHOT: SchedulerSnapshot = {
  chars: {},
  clock: 0,
  cycleCount: 0,
  gmIntervalCycles: 3,
  gmTrigger: false,
  gmTriggerBatch: null,
  lastStepKind: null,
  lastGmNarrativity: null,
  pendingInvitation: null,
};

interface Harness {
  deps: PrepareNextCommandDeps;
  live: TruthStores;
  cloneCalls: () => number;
  commits: () => readonly { draft: TruthStores; changes: VarChange[] }[];
  rebuilds: () => number;
}

function makeDeps(rules: readonly DeterministicRulePort[], maxIterations?: number): Harness {
  const live = makeTruth();
  let cloneCalls = 0;
  const commits: { draft: TruthStores; changes: VarChange[] }[] = [];
  let rebuilds = 0;
  return {
    live,
    cloneCalls: () => cloneCalls,
    commits: () => commits,
    rebuilds: () => rebuilds,
    deps: {
      liveTruth: live,
      cloneTruth: (l) => {
        cloneCalls += 1;
        return cloneTruth(l);
      },
      commit: (draft, changes) => {
        commits.push({ draft, changes });
      },
      rebuildProjections: () => {
        rebuilds += 1;
      },
      buildSnapshot: () => SNAPSHOT,
      rules,
      ...(maxIterations !== undefined ? { maxIterations } : {}),
    },
  };
}

/** world.counter 递增规则（每轮真的变异状态，永不自发到固定点）。 */
function counterRule(id: string): DeterministicRulePort {
  return {
    id,
    runPass(draft) {
      const before = typeof draft.world.world["counter"] === "number" ? (draft.world.world["counter"] as number) : 0;
      return [draft.world.writeRaw("counter", before + 1)];
    },
  };
}

describe("prepareNextCommand（空 rules 短路）", () => {
  it("rules=[]：不克隆 draft、不 commit，直接 deriveNext，committed=false", () => {
    const h = makeDeps([]);
    const result = prepareNextCommand(h.deps);
    assert.deepEqual(result.command, deriveNext(SNAPSHOT));
    assert.equal(result.committed, false);
    assert.equal(h.cloneCalls(), 0, "短路路径不得建草稿（性能短路）");
    assert.equal(h.commits().length, 0);
    assert.equal(h.rebuilds(), 0);
  });
});

describe("prepareNextCommand（固定点收敛）", () => {
  it("计数规则两轮后返回空 → 收敛，commit 恰好一次（累积全部 changes），committed=true", () => {
    let passes = 0;
    const rule: DeterministicRulePort = {
      id: "two-pass",
      runPass(draft) {
        passes += 1;
        if (passes > 2) return []; // 第三轮起已达固定点
        return [draft.world.writeRaw("counter", passes)];
      },
    };
    const h = makeDeps([rule]);
    const result = prepareNextCommand(h.deps);

    assert.equal(passes, 3, "两轮变异 + 一轮空跑确认固定点");
    assert.equal(result.committed, true);
    assert.equal(h.commits().length, 1, "全部收敛轮累积成一次提交，无中间 Generation");
    assert.equal(h.commits()[0]!.changes.length, 2, "两轮 changes 累积进同一份提交");
    assert.equal(h.rebuilds(), 1, "提交成功后重建投影一次");
    assert.deepEqual(result.command, deriveNext(SNAPSHOT));
    // 提交的是收敛后的 draft（counter=2）
    assert.equal(h.commits()[0]!.draft.world.world["counter"], 2);
    // 本测试的 fake commit 不 adopt：live 不被 draft 变异污染（草稿隔离）
    assert.equal(h.live.world.world["counter"], undefined);
  });

  it("规则首轮即返回空（已在固定点）：建草稿但不 commit，committed=false", () => {
    const rule: DeterministicRulePort = { id: "idle", runPass: () => [] };
    const h = makeDeps([rule]);
    const result = prepareNextCommand(h.deps);
    assert.equal(result.committed, false);
    assert.equal(h.cloneCalls(), 1, "有 rules 时必须建草稿跑规则");
    assert.equal(h.commits().length, 0);
    assert.equal(h.rebuilds(), 0);
  });
});

describe("prepareNextCommand（收敛保护：禁止无限循环）", () => {
  it("循环规则（恒返回非空 changes 但不变异状态）：签名重复 → 报错弃稿，commit 未调用", () => {
    const loopRule: DeterministicRulePort = {
      id: "no-op-loop",
      runPass: () => [{ path: "world.x", before: 1, after: 2 }], // 声称有变化但不动 draft
    };
    const h = makeDeps([loopRule]);
    assert.throws(() => prepareNextCommand(h.deps), /签名重复.*no-op-loop/);
    assert.equal(h.commits().length, 0, "报错即丢弃 draft，不得提交");
    assert.equal(h.rebuilds(), 0);
    assert.equal(h.live.world.world["x"], undefined, "live 零变化");
  });

  it("真变异振荡（A→B→A）：第二轮签名回到初始值 → 报错弃稿", () => {
    const oscillate: DeterministicRulePort = {
      id: "oscillate",
      runPass(draft) {
        const cur = draft.world.world["flag"];
        return [draft.world.writeRaw("flag", cur === 1 ? 2 : 1)];
      },
    };
    const h = makeDeps([oscillate]);
    assert.throws(() => prepareNextCommand(h.deps), /签名重复.*oscillate/);
    assert.equal(h.commits().length, 0);
  });

  it("持续新状态但永不收敛：超 maxIterations 报错（带规则 id 与签名），commit 未调用", () => {
    const h = makeDeps([counterRule("counter")], 3);
    assert.throws(() => prepareNextCommand(h.deps), /最大迭代次数 3.*counter/);
    assert.equal(h.commits().length, 0);
    assert.equal(h.rebuilds(), 0);
  });

  it("maxIterations 内恰好收敛：允许等于上限的迭代轮数", () => {
    // 每轮 +1，规则在 counter 达 3 后返回空 → 3 轮变异（= 上限）后第四轮空跑收敛
    const rule: DeterministicRulePort = {
      id: "to-three",
      runPass(draft) {
        const cur = typeof draft.world.world["counter"] === "number" ? (draft.world.world["counter"] as number) : 0;
        if (cur >= 3) return [];
        return [draft.world.writeRaw("counter", cur + 1)];
      },
    };
    const h = makeDeps([rule], 3);
    const result = prepareNextCommand(h.deps);
    assert.equal(result.committed, true);
    assert.equal(h.commits().length, 1);
    assert.equal(h.commits()[0]!.draft.world.world["counter"], 3);
  });
});
