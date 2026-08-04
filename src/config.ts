import path from "node:path";
import { fileURLToPath } from "node:url";
import { resolveUserDirectories } from "./resources/userDirectories.js";
import {
  listWorldSets as listWorldSetsIn,
  resolveWorldDir as resolveWorldDirIn,
} from "./resources/worldRepository.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/** 项目根目录（src/ 的上一级） */
export const PROJECT_ROOT = path.resolve(__dirname, "..");

export const DATA_DIR = path.join(PROJECT_ROOT, "data");

/** 默认用户资源目录（阶段 A4：路径常量唯一真相在 resources/userDirectories） */
const DEFAULT_DIRS = resolveUserDirectories();

/** 世界资产根目录：data/assets/{setId}/（世界包 = setting/tone-card/lorebook/time/player/characters/ + 包内 prompts/） */
export const ASSETS_DIR = DEFAULT_DIRS.assetsDir;
/** 存档根目录：data/users/{username}/save/{runId}/（原项目根 runs/ 改名迁入户内） */
export const SAVE_DIR = DEFAULT_DIRS.saveDir;

/** 缺省世界设定集（存档 meta.json 未记录时回落）。 */
export const DEFAULT_WORLD_SET = "baitan";

/**
 * 旧用户配置文件（E2 起下线：唯一消费方 = configService 迁移闸，首次读取自动迁移为
 * data/users/{username}/ 下三资源并改名 .migrated.bak；迁移通道长期保留供旧版升级）
 */
export const CONFIG_FILE = path.join(PROJECT_ROOT, "config.json");

export interface LLMConfig {
  apiKey: string;
  baseURL: string;
  model: string;
  /** JSON 模式：请求带 response_format: { type: "json_object" }（默认 false） */
  jsonMode: boolean;
  /** 思考强度（DeepSeek reasoning_effort，如 "low"/"medium"/"high"）；原样透传，不锁枚举 */
  reasoningEffort?: string | undefined;
}

/** 三类 agent（每 agent 独立 OpenAI adapter；文件形状契约见 contracts/config.ts） */
export type AgentKind = "character" | "gm" | "prose";
export const AGENT_KINDS: readonly AgentKind[] = ["character", "gm", "prose"];

/** 本轮存档目录：data/users/{username}/save/{runId}/ */
export function runDir(runId: string): string {
  return path.join(SAVE_DIR, runId);
}

// ---------------------------------------------------------------------------
// 世界设定集（data/assets/{setId}/，存档创建时可选）
// ---------------------------------------------------------------------------

/** 列出可选世界设定集（data/assets 下的目录名，按字典序，确定性）。实现唯一出处 = resources/worldRepository。 */
export function listWorldSets(): string[] {
  return listWorldSetsIn(ASSETS_DIR);
}

/**
 * 解析世界设定集目录。setId 省略/空串 = 缺省（DEFAULT_WORLD_SET）。
 * 拒绝路径穿越与不存在/缺文件的设定集（WorldRepositoryError，HTTP 层映射 400/404）。
 */
export function resolveWorldDir(setId?: string): string {
  return resolveWorldDirIn(ASSETS_DIR, setId, DEFAULT_WORLD_SET);
}

// ---------------------------------------------------------------------------
// 运行设置缺省值（生产路径由 settings.json 提供，缺省回落此处常量）
// ---------------------------------------------------------------------------

/** 正文滑窗大小缺省（轮）；0 = 不注入正文回顾 */
export const DEFAULT_PROSE_WINDOW_TURNS = 5;

/** GM 硬保险间隔缺省（行动周期数） */
export const DEFAULT_GM_INTERVAL_CYCLES = 3;
