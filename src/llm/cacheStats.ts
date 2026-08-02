import fs from "node:fs";
import path from "node:path";
import { runDir } from "../config.js";
import type { CacheStat } from "../types.js";

/** 追加一条缓存埋点到 runs/{runId}/cache-stats.jsonl。 */
export function recordCacheStat(runId: string, stat: CacheStat): void {
  const dir = runDir(runId);
  fs.mkdirSync(dir, { recursive: true });
  fs.appendFileSync(path.join(dir, "cache-stats.jsonl"), JSON.stringify(stat) + "\n", "utf8");
}

/** 读取全部埋点（/stats 命令用）。 */
export function readCacheStats(runId: string): CacheStat[] {
  const file = path.join(runDir(runId), "cache-stats.jsonl");
  if (!fs.existsSync(file)) return [];
  return fs
    .readFileSync(file, "utf8")
    .split("\n")
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line) as CacheStat);
}
