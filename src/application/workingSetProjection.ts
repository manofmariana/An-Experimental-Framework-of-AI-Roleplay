/**
 * 工作集投影：
 * rebuildWorkingSet 与 preGmWorkingSet 的合并纯函数——从给定步骤序列中找到最后一个
 * gm/prose 边界，收集其后的 player/character 步（player 步转写为 {cid: playerCid}，
 * 与落账同形）。投影函数不知道调用场景：调用方负责传入正确的步骤切片——
 * 回滚传「archive 到目标前 + 目标 current」，GM 编辑传「不含当前 GM 的 archive」。
 * （切片末步本身是 gm/prose 时边界即末位，结果自然为空，无需额外模式参数。）
 */
import type { WorkingSetEntry } from "../truth/workingSet.js";
import type { DecisionPackage } from "../types.js";

/** 投影输入的最小步形状（archive 条目与流水线 current 均满足）。 */
export interface ProjectionStep {
  kind: string;
  result?: unknown;
}

export function projectWorkingSet(steps: readonly ProjectionStep[], playerCid: string): WorkingSetEntry[] {
  let boundary = -1;
  steps.forEach((s, i) => {
    if (s.kind === "gm" || s.kind === "prose") boundary = i;
  });
  const out: WorkingSetEntry[] = [];
  for (const s of steps.slice(boundary + 1)) {
    if (s.kind === "player") {
      // 与 stepPlayer 落账同形（{cid, decision}）：投影逐字节还原原工作集
      out.push({ cid: playerCid, decision: (s.result as { decision: DecisionPackage }).decision });
    } else if (s.kind.startsWith("character:")) {
      out.push({
        cid: s.kind.slice("character:".length),
        decision: (s.result as { decision: DecisionPackage }).decision,
      });
    }
  }
  return out;
}
