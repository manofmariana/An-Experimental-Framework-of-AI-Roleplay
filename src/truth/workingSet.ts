import { z } from "zod";
import { DecisionPackageSchema } from "../types.js";

export const WorkingSetEntrySchema = z.object({ cid: z.string(), input: z.string().optional(), decision: DecisionPackageSchema.optional() });
export type WorkingSetEntry = z.infer<typeof WorkingSetEntrySchema>;

export function renderScene(
  entries: readonly WorkingSetEntry[],
  viewerCid?: string,
  /** 远程成员（位置 ≠ 组位置）：标题行加注入标注 */
  remoteCids?: ReadonlySet<string>,
): string {
  const lines: string[] = [];
  for (const entry of entries) {
    lines.push(`##@${entry.cid}${remoteCids?.has(entry.cid) === true ? "（远程）" : ""}`);
    if (entry.input !== undefined) lines.push(`  言行：${entry.input}`);
    if (entry.decision !== undefined) {
      if (entry.decision.action !== undefined) lines.push(`  行动：${entry.decision.action}`);
      // 私域字段：视角过滤——他人条目对角色观察者只暴露可观测的行动与发言
      if (viewerCid === undefined || entry.cid === viewerCid) {
        lines.push(`  内心：${entry.decision.inner}`);
      }
      if (entry.decision.dialogue !== undefined) lines.push(`  发言：${entry.decision.dialogue}`);
    }
  }
  return lines.join("\n");
}

export function renderSpeech(entries: readonly WorkingSetEntry[]): string {
  const lines: string[] = [];
  for (const entry of entries) {
    lines.push(`##@${entry.cid}`);
    if (entry.input !== undefined) lines.push(`  言行：${entry.input}`);
    if (entry.decision !== undefined) {
      if (entry.decision.dialogue !== undefined) lines.push(`  发言：${entry.decision.dialogue}`);
      lines.push(`  内心：${entry.decision.inner}`);
    }
  }
  return lines.join("\n");
}
