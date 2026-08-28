import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { planActorDecision } from "../src/application/actorEffects.js";
import { planGmAdjudication } from "../src/application/gmEffects.js";
import { applyScheduleSetup } from "../src/application/scheduleEffects.js";
import { evaluateTagFilter, type ReaderScope } from "../src/tags/evaluate.js";
import { FAPPEAR_LEVEL, FAPPEAR_TAG } from "../src/tags/registry.js";
import type { TruthStores } from "../src/truth/stores.js";
import type { VarChange } from "../src/truth/varChanges.js";
import type { DecisionPackage } from "../src/types.js";
import { isTerminalInstance, type TerminalInstance } from "../src/vars/tree.js";
import { buildCharacterState, buildDecision, buildProjectionHost, buildTruthStores } from "./builders/index.js";

// ---------------------------------------------------------------------------
// 在场性 TAG 化契约：
// ① appearance 程序维护（组弹出前台/结算进后台/入组含远程按组籍/离组，回溯可逆）；
// ② vars 源全量遍历 + 后台角色末端虚拟挂载 {fappear, 6 级} 的四档可见性。
// 零 IO：全内存七 Store + 效果规划器直调。
// ---------------------------------------------------------------------------

function idAllocator(): () => string {
  let n = 0;
  return () => `evt_${String((n += 1)).padStart(4, "0")}`;
}

function revert(truth: TruthStores, changes: readonly VarChange[]): void {
  for (const c of [...changes].reverse()) {
    if (c.path.startsWith("world.")) truth.world.revertChange(c);
    else if (c.path.startsWith("sys.")) truth.sys.revertChange(c);
    else truth.characters.revertChange(c);
  }
}

function appearanceOf(truth: TruthStores, cid: string): boolean {
  return truth.characters.get(cid).appearance;
}

describe("appearance 程序维护（writeRaw 白名单通道，随 changes 落账）", () => {
  it("组弹出前台 → 成员置 true（值已到位 = 幂等无变更）", () => {
    const truth = buildTruthStores({
      characters: {
        C0: buildCharacterState({ isPlayer: true }),
        C1001: buildCharacterState({}),
      },
    });
    const changes = applyScheduleSetup(truth, { actedClears: [], cycleIncrement: false, foreground: ["C0", "C1001"] });
    assert.equal(appearanceOf(truth, "C0"), true);
    assert.equal(appearanceOf(truth, "C1001"), true);
    assert.deepEqual(
      changes.map((c) => c.path),
      ["characters.C0.appearance", "characters.C1001.appearance"],
    );
    // 再次弹出同组（值已到位）→ 幂等无新变更
    assert.deepEqual(
      applyScheduleSetup(truth, { actedClears: [], cycleIncrement: false, foreground: ["C0", "C1001"] }),
      [],
    );
  });

  it("结算进后台 → 置 false；回溯反转 changes 还原", () => {
    const truth = buildTruthStores({
      characters: {
        C0: buildCharacterState({ isPlayer: true, appearance: true }),
        C1001: buildCharacterState({ appearance: true }),
      },
    });
    const { changes } = planGmAdjudication(truth, {
      seq: 1,
      pkg: {
        events: [],
        narrativity: "skip",
        deltas: [],
        durations: [
          { cid: "C0", span: { min: 5 } },
          { cid: "C1001", span: { min: 5 } },
        ],
        location: [],
      },
      roundCids: ["C0", "C1001"],
      allocateEventId: idAllocator(),
      rollDice: () => 1,
    });
    assert.equal(appearanceOf(truth, "C0"), false);
    assert.equal(appearanceOf(truth, "C1001"), false);
    const paths = changes.map((c) => c.path);
    assert.ok(paths.includes("characters.C0.appearance") && paths.includes("characters.C1001.appearance"));
    revert(truth, changes);
    assert.equal(appearanceOf(truth, "C0"), true, "回溯反转后在场位还原");
    assert.equal(appearanceOf(truth, "C1001"), true);
  });

  it("入组（远程 confirm，按组籍）→ 置 true；离组（leave 标记）→ 置 false", () => {
    const truth = buildTruthStores({
      characters: {
        C1001: buildCharacterState({ group: 1, appearance: true, location: { name: "loc_A", level: 1 } }),
        C1002: buildCharacterState({ location: { name: "loc_B", level: 1 } }), // 远程：位置 ≠ 组位置
      },
    });
    // contact 步（邀请来源）落档：confirm 据此并入邀请者组
    truth.archive.append({ seq: 1, kind: "character:C1001", result: {}, changes: { setup: [], effects: [] } });
    planActorDecision(truth, {
      cid: "C1002",
      pkg: buildDecision({ markers: [{ type: "confirm" }] }) as DecisionPackage,
      invitation: { contactSeq: 1, inviter: "C1001", channel: "电话", preInviteTimer: 60 },
      rollDice: () => 10,
    });
    assert.equal(truth.characters.get("C1002").group, 1, "远程入组按组籍");
    assert.equal(appearanceOf(truth, "C1002"), true);

    planActorDecision(truth, {
      cid: "C1002",
      pkg: buildDecision({ markers: [{ type: "leave" }] }) as DecisionPackage,
      rollDice: () => 10,
    });
    assert.equal(appearanceOf(truth, "C1002"), false, "离组在场位复位");
  });
});

describe("vars 源：全量遍历 + 后台角色末端虚拟挂载 fappear 六级", () => {
  const speakerVars = (): Record<string, unknown> => ({
    hp: { value: 10, tags: [] },
    tags: { value: [], tags: [] },
  });

  function makeTruth(readerOverrides?: Partial<Parameters<typeof buildCharacterState>[0]>): TruthStores {
    return buildTruthStores({
      characters: {
        C0: buildCharacterState({ isPlayer: true, appearance: true, vars: speakerVars(), ...readerOverrides }),
        C1001: buildCharacterState({ appearance: false, vars: speakerVars() }), // 后台
        C1002: buildCharacterState({ appearance: true, vars: speakerVars() }), // 前台
      },
    });
  }

  function terminalOf(view: ReturnType<ReturnType<typeof buildProjectionHost>["vars"]>, cid: string): TerminalInstance {
    const node = (view.characters[cid] as Record<string, unknown>)["hp"];
    if (!isTerminalInstance(node)) throw new Error("hp 不是末端");
    return node;
  }

  it("取数范围全量（角色读者同见全体 cid）；后台末端虚拟挂载不落盘、不污染前台", () => {
    const truth = makeTruth();
    const view = buildProjectionHost({ kind: "character", cid: "C0" }, truth).vars();
    assert.deepEqual(Object.keys(view.characters), ["C0", "C1001", "C1002"], "一切读者全量遍历");
    assert.deepEqual(terminalOf(view, "C1001").tags, [{ name: FAPPEAR_TAG, level: FAPPEAR_LEVEL }]);
    assert.deepEqual(terminalOf(view, "C1002").tags, [], "前台角色末端不挂");
    assert.deepEqual(terminalOf(view, "C0").tags, [], "读者自身（前台）不挂");
    // 不落盘：真相层原树不受虚拟挂载污染
    assert.deepEqual((truth.characters.get("C1001").vars["hp"] as TerminalInstance).tags, []);
  });

  it("四档可见性：权重 0 不见后台；权重 6 恒见；对象侧持 fappear 纯名可见；权重 5 全知不见", () => {
    const truth = makeTruth();
    const host = buildProjectionHost({ kind: "character", cid: "C0" }, truth);
    const view = host.vars();
    const bg = terminalOf(view, "C1001");
    const filter = (scope: ReaderScope) =>
      evaluateTagFilter({ content: bg.value, tags: bg.tags }, scope, view.filter.registry).status;
    // 权重 0 常规读者：不见后台角色末端
    assert.equal(filter(view.filter.scope), "fail");
    // 对象侧持 fappear 纯名 = 感知后台 escape hatch
    assert.equal(filter({ tags: new Set(["C0", FAPPEAR_TAG]) }), "pass");
    // 权重 5 全知 NPC：虚拟全知只覆盖 ≤5 级组，六级组不见
    assert.equal(filter({ tags: new Set<string>(), omniscienceWeight: 5 }), "fail");
    // 权重 6（GM/正文上下文）：虚拟全知覆盖六级组恒见
    const gmView = buildProjectionHost({ kind: "gm" }, truth).vars();
    const gmBg = terminalOf(gmView, "C1001");
    assert.equal(
      evaluateTagFilter({ content: gmBg.value, tags: gmBg.tags }, gmView.filter.scope, gmView.filter.registry).status,
      "pass",
    );
    // 权重 0 读者看前台角色末端：不受影响
    const fg = terminalOf(view, "C1002");
    assert.equal(
      evaluateTagFilter({ content: fg.value, tags: fg.tags }, view.filter.scope, view.filter.registry).status,
      "pass",
    );
  });

  it("自豁免：后台读者读自身子树不挂载（自己的变量自己恒见）", () => {
    const truth = makeTruth();
    // 读者 = C1001（appearance=false，邀请应答即此场景）
    const view = buildProjectionHost({ kind: "character", cid: "C1001" }, truth).vars();
    const self = terminalOf(view, "C1001");
    assert.deepEqual(self.tags, [], "属主 = 读者：不做 fappear 虚拟挂载");
    assert.equal(
      evaluateTagFilter({ content: self.value, tags: self.tags }, view.filter.scope, view.filter.registry).status,
      "pass",
      "后台读者读自身末端恒过",
    );
  });
});
