import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { projectWorkingSet, type ProjectionStep } from "../src/application/workingSetProjection.js";
import { isNoticeEntry, type WorkingSetSpeechEntry } from "../src/truth/workingSet.js";
import { buildDecision } from "./builders/index.js";
import { DecisionPackageSchema, type DecisionPackage } from "../src/types.js";

// ---------------------------------------------------------------------------
// projectWorkingSet（unit：纯函数零 IO）：回滚目标 / GM 前 / 普通当前三切片表驱动。
// 算法 = 最后一个 gm/prose 边界之后的 player/character 步；切片由调用方负责。
// ---------------------------------------------------------------------------

const PLAYER = "C0";

/** 言行条目窄化（本套件决策均无标记 → 投影产物不含通知条目）。 */
function speechOf(ws: ReturnType<typeof projectWorkingSet>): WorkingSetSpeechEntry[] {
  return ws.filter((e): e is WorkingSetSpeechEntry => !isNoticeEntry(e));
}

function decisionOf(tag: string): DecisionPackage {
  return DecisionPackageSchema.parse(buildDecision({ dialogue: tag }));
}

/** player 步（落账同形：result 带 decision）；character 步 kind 携带 cid。 */
function pStep(decision: DecisionPackage): ProjectionStep {
  return { kind: "player", result: { input: decision.dialogue, decision } };
}
function cStep(cid: string, decision: DecisionPackage): ProjectionStep {
  return { kind: `character:${cid}`, result: { decision } };
}
const GM: ProjectionStep = { kind: "gm", result: {} };
const PROSE: ProjectionStep = { kind: "prose", result: {} };

const d1 = decisionOf("一");
const d2 = decisionOf("二");
const d3 = decisionOf("三");
const d4 = decisionOf("四");

describe("projectWorkingSet（三切片表驱动）", () => {
  const cases: { name: string; steps: ProjectionStep[]; expect: { cid: string; dialogue: unknown }[] }[] = [
    {
      name: "回滚切片：archive 到目标前 + 目标 current（目标是 character）",
      steps: [pStep(d1), cStep("C1001", d2), GM, pStep(d3), cStep("C1001", d4)],
      expect: [
        { cid: "C0", dialogue: "三" },
        { cid: "C1001", dialogue: "四" },
      ],
    },
    {
      name: "回滚切片：目标本身是 gm → 边界即末位，结果为空",
      steps: [pStep(d1), cStep("C1001", d2), GM],
      expect: [],
    },
    {
      name: "回滚切片：目标本身是 prose → 同样为空",
      steps: [pStep(d1), GM, PROSE],
      expect: [],
    },
    {
      name: "GM 前切片：不含当前 GM 的 archive（边界之后的角色步 = 未清算的本轮）",
      steps: [pStep(d1), GM, PROSE, pStep(d2), cStep("C1001", d3), cStep("C1002", d4)],
      expect: [
        { cid: "C0", dialogue: "二" },
        { cid: "C1001", dialogue: "三" },
        { cid: "C1002", dialogue: "四" },
      ],
    },
    {
      name: "普通当前切片：archive + current（current 是 prose 后的角色步）",
      steps: [pStep(d1), GM, PROSE, cStep("C1001", d2)],
      expect: [{ cid: "C1001", dialogue: "二" }],
    },
    {
      name: "无边界（开局）：全部 player/character 步",
      steps: [cStep("C1001", d1), pStep(d2)],
      expect: [
        { cid: "C1001", dialogue: "一" },
        { cid: "C0", dialogue: "二" },
      ],
    },
    {
      name: "空切片 → 空工作集",
      steps: [],
      expect: [],
    },
  ];

  for (const { name, steps, expect } of cases) {
    it(name, () => {
      const ws = projectWorkingSet(steps, PLAYER);
      assert.deepEqual(
        speechOf(ws).map((e) => ({ cid: e.cid, dialogue: e.decision?.dialogue })),
        expect,
      );
    });
  }

  it("player 步转写为调用方给的 playerCid（投影无 player 概念）", () => {
    const ws = projectWorkingSet([pStep(d1)], "C9");
    assert.equal(speechOf(ws)[0]!.cid, "C9");
  });

  it("decision 引用与落账同形（{cid, decision}，逐字节还原原工作集条目）", () => {
    const ws = projectWorkingSet([pStep(d1), cStep("C1001", d2)], PLAYER);
    assert.deepEqual(ws, [
      { cid: "C0", decision: d1 },
      { cid: "C1001", decision: d2 },
    ]);
  });
});
