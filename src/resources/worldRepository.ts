/**
 * 世界设定集仓储（优化阶段 D3，docs/optimization-review.md §9「服务端职责边界」迁移顺序步 5）。
 *
 * data/worlds/{setId}/ 三文件（setting.md / tone-card.md / lorebook.json）、角色 manifest
 * （player.json + characters/*.json）、提示词模板文件（promptsDir 下 {agent}.prompt.json）
 * 的读写，以及世界设定集列表/目录解析（canonical 实现——config.ts 的 listWorldSets/
 * resolveWorldDir 委托到此处，消除两份实现的漂移）。
 *
 * 全部函数显式接收目录参数（组成根经 UserDirectories 注入），本模块不 import config。
 * 结构校验（CharacterManifest/PromptTemplate zod schema 在 agents/compile，本层不可依赖）
 * 留在 server 路由层；本层只做路径计算与文件 IO。领域错误抛 WorldRepositoryError。
 */
import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import { safeSegment } from "../shared/safeSegment.js";
import { LoreEntrySchema, type LoreEntry } from "../types.js";

/** 仓储错误码（HTTP 映射：WORLD_SET_NOT_FOUND/CHARACTER_NOT_FOUND→404，INVALID_WORLD_SET→400）。 */
export type WorldErrorCode = "WORLD_SET_NOT_FOUND" | "INVALID_WORLD_SET" | "CHARACTER_NOT_FOUND";

export class WorldRepositoryError extends Error {
  constructor(
    public readonly code: WorldErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "WorldRepositoryError";
  }
}

// ---------------------------------------------------------------------------
// 世界设定集目录
// ---------------------------------------------------------------------------

/** 列出可选世界设定集（worldsDir 下的目录名，按字典序，确定性）。 */
export function listWorldSets(worldsDir: string): string[] {
  if (!fs.existsSync(worldsDir)) return [];
  return fs
    .readdirSync(worldsDir, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => d.name)
    .sort((a, b) => a.localeCompare(b));
}

/**
 * 解析世界设定集目录。setId 省略/空串 = 缺省（defaultSetId）。
 * 非法名 → INVALID_WORLD_SET；不存在/非目录 → WORLD_SET_NOT_FOUND。
 */
export function resolveWorldDir(worldsDir: string, setId: string | undefined, defaultSetId: string): string {
  const id = setId === undefined || setId === "" ? defaultSetId : setId;
  if (!/^[\w-]+$/.test(id)) {
    throw new WorldRepositoryError("INVALID_WORLD_SET", `非法世界设定集名: ${JSON.stringify(id)}`);
  }
  const dir = path.join(worldsDir, id);
  if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) {
    throw new WorldRepositoryError(
      "WORLD_SET_NOT_FOUND",
      `世界设定集不存在: ${id}（可选：${listWorldSets(worldsDir).join(", ") || "无"}）`,
    );
  }
  return dir;
}

// ---------------------------------------------------------------------------
// 世界三文件
// ---------------------------------------------------------------------------

export const WORLD_FILES = {
  setting: "setting.md",
  "tone-card": "tone-card.md",
  lorebook: "lorebook.json",
} as const;
export type WorldFileName = keyof typeof WORLD_FILES;

export function isWorldFileName(name: string): name is WorldFileName {
  return name in WORLD_FILES;
}

/** 读世界文件全文（缺失/损坏 → 原生 fs 错误，HTTP 层映射 500）。 */
export function readWorldFile(worldDir: string, name: WorldFileName): string {
  return fs.readFileSync(path.join(worldDir, WORLD_FILES[name]), "utf8");
}

/** 写世界文件（原样覆盖）。 */
export function writeWorldFile(worldDir: string, name: WorldFileName, content: string): void {
  fs.writeFileSync(path.join(worldDir, WORLD_FILES[name]), content, "utf8");
}

/** 校验 lorebook 条目数组（PUT /api/world/lorebook 前置闸），ID 重复即拒。 */
export function validateLorebookPayload(raw: unknown): LoreEntry[] {
  const entries = z.array(LoreEntrySchema).parse(raw);
  const seen = new Set<string>();
  for (const e of entries) {
    if (seen.has(e.id)) throw new Error(`lorebook 条目 ID 重复: ${e.id}`);
    seen.add(e.id);
  }
  return entries;
}

// ---------------------------------------------------------------------------
// 角色 manifest（结构校验在 server 路由层——schema 属 agents/character）
// ---------------------------------------------------------------------------

/** 角色 manifest 文件路径：C0 → player.json，其余 → characters/{id}.json。 */
export function characterManifestFile(worldDir: string, id: string): string {
  const safe = safeSegment(id);
  return safe === "C0" ? path.join(worldDir, "player.json") : path.join(worldDir, "characters", `${safe}.json`);
}

/** 列出全部角色 manifest（C0/player.json 在前；JSON 损坏 → 原生解析错误，HTTP 层 500）。 */
export function listCharacterManifests(worldDir: string): { id: string; manifest: unknown }[] {
  const dir = path.join(worldDir, "characters");
  const files = fs.existsSync(dir) ? fs.readdirSync(dir).filter((file) => file.endsWith(".json")) : [];
  const all = ["C0", ...files.map((file) => file.slice(0, -".json".length))];
  return all.map((id) => ({
    id,
    manifest: JSON.parse(fs.readFileSync(characterManifestFile(worldDir, id), "utf8")) as unknown,
  }));
}

/** 读单个角色 manifest（文件缺失 → CHARACTER_NOT_FOUND）。 */
export function readCharacterManifest(worldDir: string, id: string): unknown {
  const file = characterManifestFile(worldDir, id);
  if (!fs.existsSync(file)) {
    throw new WorldRepositoryError("CHARACTER_NOT_FOUND", `角色不存在: ${id}`);
  }
  return JSON.parse(fs.readFileSync(file, "utf8")) as unknown;
}

/** 写单个角色 manifest（调用方已完成结构校验）。 */
export function writeCharacterManifest(worldDir: string, id: string, manifest: unknown): void {
  fs.writeFileSync(characterManifestFile(worldDir, id), JSON.stringify(manifest, null, 2) + "\n", "utf8");
}

// ---------------------------------------------------------------------------
// 提示词模板文件（promptsDir/{agent}.prompt.json；结构校验在 server 路由层）
// ---------------------------------------------------------------------------

/** 读模板文件全文（缺失 → 原生 fs 错误，HTTP 层 500）。 */
export function readPromptFile(promptsDir: string, agent: string): string {
  return fs.readFileSync(path.join(promptsDir, `${safeSegment(agent)}.prompt.json`), "utf8");
}

/** 写模板文件（调用方已完成结构 + 占位符校验）。 */
export function writePromptFile(promptsDir: string, agent: string, content: string): void {
  fs.writeFileSync(path.join(promptsDir, `${safeSegment(agent)}.prompt.json`), content, "utf8");
}
