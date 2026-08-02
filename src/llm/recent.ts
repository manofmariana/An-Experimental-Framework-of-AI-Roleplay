/**
 * LLM 最近轮次持久化（存档 v2 文件 6）：runs/{runId}/llm-recent/{agent}.json。
 * 每对象一个文件（此处允许），只存该对象**亲身参与的最近 5 轮**
 * {seq, messages, reasoning}（滚动窗口）——替代旧 prompts/ 逐轮散文件。
 * 用途：将来的 LLM 日志界面；历史轮"提示词/思维链"按钮读此，
 * 超出窗口显示"已轮换出窗"。
 */
import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import { runDir } from "../config.js";

export const LLM_RECENT_WINDOW = 5;

const RecentEntrySchema = z.object({
  seq: z.number(),
  messages: z.array(z.unknown()),
  reasoning: z.string(),
});
export type RecentEntry = z.infer<typeof RecentEntrySchema>;

/** agent 名 → 文件名安全 slug（"character:C1001" → "character-C1001"）。 */
export function agentSlug(agent: string): string {
  return agent.replace(/[^\w-]/g, "-");
}

function recentFile(dir: string, agent: string): string {
  return path.join(dir, "llm-recent", `${agentSlug(agent)}.json`);
}

/** 追加一条并滚动到最近 5 条，落盘。 */
export function recordRecent(
  runId: string,
  agent: string,
  entry: RecentEntry,
  baseDir?: string,
): void {
  const dir = baseDir ?? runDir(runId);
  const file = recentFile(dir, agent);
  const entries: RecentEntry[] = fs.existsSync(file)
    ? z.array(RecentEntrySchema).parse(JSON.parse(fs.readFileSync(file, "utf8")))
    : [];
  const upserted = entries.filter((current) => current.seq !== entry.seq);
  upserted.push(entry);
  upserted.sort((a, b) => a.seq - b.seq);
  const windowed = upserted.slice(-LLM_RECENT_WINDOW);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(windowed, null, 2) + "\n", "utf8");
}

/** 读某 agent 的最近轮次（按 seq 升序；无文件 = 空）。 */
export function readRecent(runId: string, agent: string, baseDir?: string): RecentEntry[] {
  const file = recentFile(baseDir ?? runDir(runId), agent);
  if (!fs.existsSync(file)) return [];
  return z.array(RecentEntrySchema).parse(JSON.parse(fs.readFileSync(file, "utf8")));
}
