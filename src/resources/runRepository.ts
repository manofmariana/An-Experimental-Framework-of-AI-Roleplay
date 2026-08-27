/**
 * 存档仓储。
 *
 * save/ 目录（data/users/{username}/save/，原 runs/ 改名）的读取与旁路产物（别名 save-meta.json）读写、存档删除、回放产物读取。
 * 全部函数显式接收 saveDir（组成根经 UserDirectories 注入），本模块不 import config。
 *
 * 错误一律抛 RunRepositoryError（稳定 code），HTTP 层（server/http/errors.ts）负责
 * code → 状态码映射；本模块不知道 HTTP 存在。
 */
import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import { safeSegment } from "../shared/safeSegment.js";

/** 仓储错误码（HTTP 映射：RUN_NOT_FOUND/LEGACY_RUN_UNSUPPORTED→404，SESSION_ACTIVE→409，RUN_CORRUPT→500，INVALID_ALIAS→400）。 */
export type RunErrorCode =
  | "RUN_NOT_FOUND"
  | "LEGACY_RUN_UNSUPPORTED"
  | "RUN_CORRUPT"
  | "SESSION_ACTIVE"
  | "INVALID_ALIAS";

export class RunRepositoryError extends Error {
  constructor(
    public readonly code: RunErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "RunRepositoryError";
  }
}

export interface RunInfo {
  id: string;
  mtimeMs: number;
  /** 存档别名（save-meta.json；无则前端回退显示 id） */
  alias?: string;
}

const SaveMetaSchema = z.object({ alias: z.string() });

function readAlias(dir: string): string | undefined {
  const file = path.join(dir, "save-meta.json");
  if (!fs.existsSync(file)) return undefined;
  try {
    return SaveMetaSchema.parse(JSON.parse(fs.readFileSync(file, "utf8"))).alias;
  } catch {
    return undefined;
  }
}

/** 列出 save/ 下的会话目录（按修改时间倒序；只认目录；附别名）。 */
export function listRuns(runsDir: string): RunInfo[] {
  if (!fs.existsSync(runsDir)) return [];
  return fs
    .readdirSync(runsDir, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => {
      const dir = path.join(runsDir, d.name);
      const alias = readAlias(dir);
      const info: RunInfo = { id: d.name, mtimeMs: fs.statSync(dir).mtimeMs };
      if (alias !== undefined) info.alias = alias;
      return info;
    })
    .sort((a, b) => b.mtimeMs - a.mtimeMs);
}

/** 校验存档别名：去空白后 1-50 字符，拒绝路径字符与控制字符。 */
export function validateAlias(raw: unknown): string {
  if (typeof raw !== "string") throw new RunRepositoryError("INVALID_ALIAS", "alias 必须是字符串");
  const alias = raw.trim();
  if (alias.length === 0 || alias.length > 50) {
    throw new RunRepositoryError("INVALID_ALIAS", "alias 长度须为 1-50 字符");
  }
  if (/[/\\<>:"|?*\x00-\x1f]|\.\./.test(alias)) {
    throw new RunRepositoryError("INVALID_ALIAS", "alias 含非法字符");
  }
  return alias;
}

/** 写存档别名（save/{id}/save-meta.json）。 */
export function writeAlias(runsDir: string, id: string, alias: string): void {
  const dir = path.join(runsDir, safeSegment(id));
  if (!fs.existsSync(dir)) throw new RunRepositoryError("RUN_NOT_FOUND", `存档不存在: ${id}`);
  fs.writeFileSync(
    path.join(dir, "save-meta.json"),
    JSON.stringify({ alias: validateAlias(alias) }, null, 2) + "\n",
    "utf8",
  );
}

/** 删除存档目录（拒绝删除当前活跃会话）。 */
export function deleteRun(runsDir: string, id: string, activeRunId: string | null): void {
  const safe = safeSegment(id);
  if (safe === activeRunId) throw new RunRepositoryError("SESSION_ACTIVE", "不能删除进行中的会话");
  const dir = path.join(runsDir, safe);
  if (!fs.existsSync(dir)) throw new RunRepositoryError("RUN_NOT_FOUND", `存档不存在: ${safe}`);
  fs.rmSync(dir, { recursive: true, force: true });
}

export type RunArtifactKind = "events" | "world" | "characters" | "archive" | "lore" | "prompts" | "stats";

const TRUTH_FILES: Record<Exclude<RunArtifactKind, "stats">, string> = {
  events: "events.json",
  world: "world.json",
  characters: "characters.json",
  archive: "archive.json",
  lore: "lore.json",
  prompts: "prompts.json",
};

function readJsonl(file: string, id: string): unknown[] {
  if (!fs.existsSync(file)) return [];
  try {
    return fs
      .readFileSync(file, "utf8")
      .split("\n")
      .filter((line) => line.trim().length > 0)
      .map((line) => JSON.parse(line) as unknown);
  } catch {
    throw new RunRepositoryError("RUN_CORRUPT", `存档产物损坏: ${id}/cache-stats.jsonl`);
  }
}

/**
 * 读历史会话产物（回放用；纯读取不校验版本）。
 * 存档 v7：events/world/characters/archive/lore/prompts 读 CURRENT 指向的 Generation 目录；
 * stats 仍读 run 根 cache-stats.jsonl（旁路产物，不进 Generation，缺文件 = 空）。
 * D3 清理（原 api.ts readJson fallback 与平铺回落已删）：
 * - 存档目录不存在 → RUN_NOT_FOUND；
 * - 无 CURRENT（旧平铺档）→ LEGACY_RUN_UNSUPPORTED（旧档永不迁移，不可回放）；
 * - CURRENT 非数字 / 目标文件 JSON 损坏 → RUN_CORRUPT；
 * - 目标文件缺失 → RUN_NOT_FOUND。
 * id 先过 safeSegment。
 */
export function readRunArtifact(runsDir: string, id: string, kind: RunArtifactKind): unknown {
  const dir = path.join(runsDir, safeSegment(id));
  if (!fs.existsSync(dir)) throw new RunRepositoryError("RUN_NOT_FOUND", `存档不存在: ${id}`);
  const currentFile = path.join(dir, "CURRENT");
  if (!fs.existsSync(currentFile)) {
    throw new RunRepositoryError(
      "LEGACY_RUN_UNSUPPORTED",
      `旧版平铺存档不可回放: ${id}（无 CURRENT 指针；旧档不迁移，须新建会话）`,
    );
  }
  const revision = fs.readFileSync(currentFile, "utf8").trim();
  if (!/^\d+$/.test(revision)) {
    throw new RunRepositoryError("RUN_CORRUPT", `存档 CURRENT 指针损坏: ${id}`);
  }
  if (kind === "stats") return readJsonl(path.join(dir, "cache-stats.jsonl"), id);
  const file = path.join(dir, "generations", revision, TRUTH_FILES[kind]);
  if (!fs.existsSync(file)) {
    throw new RunRepositoryError("RUN_NOT_FOUND", `存档产物缺失: ${id}/${TRUTH_FILES[kind]}`);
  }
  try {
    return JSON.parse(fs.readFileSync(file, "utf8")) as unknown;
  } catch {
    throw new RunRepositoryError("RUN_CORRUPT", `存档产物损坏: ${id}/${TRUTH_FILES[kind]}`);
  }
}
