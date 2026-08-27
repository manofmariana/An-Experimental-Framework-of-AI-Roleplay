/**
 * 工作集投影：
 * rebuildWorkingSet 与 preGmWorkingSet 的合并纯函数——从给定步骤序列中找到最后一个
 * gm/prose 边界，收集其后的 player/character 步（player 步转写为 {cid: playerCid}，
 * 与落账同形；标记派生的系统通知条目经同一纯函数再生——重建与落账逐字节一致）。
 * 投影函数不知道调用场景：调用方负责传入正确的步骤切片——
 * 回滚传「archive 到目标前 + 目标 current」，GM 编辑传「不含当前 GM 的 archive」。
 * （切片末步本身是 gm/prose 时边界即末位，结果自然为空，无需额外模式参数。）
 */
import { appendNotices, noticesOfMarkers, type WorkingSetEntry } from "../truth/workingSet.js";
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
      pushActorEntry(out, playerCid, (s.result as { decision: DecisionPackage }).decision);
    } else if (s.kind.startsWith("character:")) {
      pushActorEntry(out, s.kind.slice("character:".length), (s.result as { decision: DecisionPackage }).decision);
    }
  }
  return out;
}

/** 言行条目 + 其标记派生的通知条目（与 planActorDecision 落账同一纯函数 → 重建逐字节一致）。 */
function pushActorEntry(out: WorkingSetEntry[], cid: string, decision: DecisionPackage): void {
  out.push({ cid, decision });
  const notices = noticesOfMarkers(cid, decision.markers ?? []);
  if (notices.length > 0) {
    const merged = appendNotices(out, notices);
    out.length = 0;
    out.push(...merged);
  }
}
