import path from "node:path";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import { ResolvedAgentConfigSchema, type FileConfigPayload } from "./contracts/config.js";
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

/** 提示词模板目录：data/prompts/{agent}.prompt.json（模块化模板，Web 可编辑） */
export const PROMPTS_DIR = DEFAULT_DIRS.promptsDir;
export const RUNS_DIR = DEFAULT_DIRS.runsDir;

/** 世界设定集根目录：data/worlds/{setId}/（setting.md / tone-card.md / lorebook.json / characters/） */
export const WORLDS_DIR = DEFAULT_DIRS.worldsDir;
/** 缺省世界设定集（存档 meta.json 未记录时回落）。 */
export const DEFAULT_WORLD_SET = "baitan";

/** 用户配置文件（含密钥，已 gitignore；模板见 config.example.json） */
export const CONFIG_FILE = path.join(PROJECT_ROOT, "config.json");

export interface LLMConfig {
  apiKey: string;
  baseURL: string;
  model: string;
  /** JSON 模式：请求带 response_format: { type: "json_object" }（默认 false） */
  jsonMode: boolean;
  /** 思考强度（DeepSeek reasoning_effort，如 "low"/"medium"/"high"）；原样透传，不锁枚举 */
  reasoningEffort?: string;
}

/** 三类 agent（对应 config.json 的 agents 块与每 agent 独立 OpenAI adapter） */
export type AgentKind = "character" | "gm" | "prose";
export const AGENT_KINDS: readonly AgentKind[] = ["character", "gm", "prose"];

/**
 * config.json 的文件形状（顶层 + 每 agent 可选覆盖块 + memory 块；"_"-前缀字段为注释，忽略）。
 * D3 起类型唯一出处 = contracts/config.ts FileConfigSchema（zod infer；原手写 interface 与
 * server 手工字段表、前端字段数组三份定义漂移已收敛为一份契约）。
 */
export type FileConfig = FileConfigPayload;

function readFileConfig(): FileConfig {
  if (!fs.existsSync(CONFIG_FILE)) return {};
  try {
    return JSON.parse(fs.readFileSync(CONFIG_FILE, "utf8")) as FileConfig;
  } catch (err) {
    throw new Error(`config.json 解析失败：${(err as Error).message}`);
  }
}

/**
 * 分层解析（纯函数，可单测）：
 *  - 顶层：环境变量（DEEPSEEK_API_KEY 等）优先于 config.json 顶层字段；
 *  - agents.{character|gm|prose} 块逐字段覆盖顶层，缺省回落顶层。
 * 任一 agent 最终没有 api key 时整体返回 null（由 CLI 给出清晰提示）。
 */
export function resolveAgentConfigs(
  file: FileConfig,
  env: NodeJS.ProcessEnv = process.env,
): Record<AgentKind, LLMConfig> | null {
  const topKey = env.DEEPSEEK_API_KEY ?? env.OPENAI_API_KEY ?? file.api_key ?? "";
  const topBase =
    env.DEEPSEEK_BASE_URL ?? env.OPENAI_BASE_URL ?? file.base_url ?? "https://api.deepseek.com";
  const topModel = env.DEEPSEEK_MODEL ?? file.model ?? "deepseek-chat";
  const topJsonMode = file.json_mode ?? false;

  const out = {} as Record<AgentKind, LLMConfig>;
  for (const kind of AGENT_KINDS) {
    const override = file.agents?.[kind] ?? {};
    const reasoningEffort = override.reasoning_effort ?? file.reasoning_effort;
    const config: LLMConfig = {
      apiKey: override.api_key ?? topKey,
      baseURL: override.base_url ?? topBase,
      model: override.model ?? topModel,
      jsonMode: override.json_mode ?? topJsonMode,
      // exactOptionalPropertyTypes：缺省不显式赋 undefined，用条件展开
      ...(reasoningEffort !== undefined ? { reasoningEffort } : {}),
    };
    if (!config.apiKey) return null;
    // 契约校验（阶段 A4：纯增强，不改动解析值；非法形状在边界处即暴露）
    ResolvedAgentConfigSchema.parse(config);
    out[kind] = config;
  }
  return out;
}

/** 读 config.json + 环境变量，解析三个 agent 各自的 LLM 配置。 */
export function loadAgentConfigs(
  env: NodeJS.ProcessEnv = process.env,
): Record<AgentKind, LLMConfig> | null {
  return resolveAgentConfigs(readFileConfig(), env);
}

/** 本轮运行目录：runs/{runId}/ */
export function runDir(runId: string): string {
  return path.join(RUNS_DIR, runId);
}

// ---------------------------------------------------------------------------
// 世界设定集（data/worlds/{setId}/，§10 工程决定：存档创建时可选）
// ---------------------------------------------------------------------------

/** 列出可选世界设定集（data/worlds 下的目录名，按字典序，确定性）。实现唯一出处 = resources/worldRepository。 */
export function listWorldSets(): string[] {
  return listWorldSetsIn(WORLDS_DIR);
}

/**
 * 解析世界设定集目录。setId 省略/空串 = 缺省（DEFAULT_WORLD_SET）。
 * 拒绝路径穿越与不存在/缺文件的设定集（WorldRepositoryError，HTTP 层映射 400/404）。
 */
export function resolveWorldDir(setId?: string): string {
  return resolveWorldDirIn(WORLDS_DIR, setId, DEFAULT_WORLD_SET);
}

// ---------------------------------------------------------------------------
// 记忆配置（memory 块）
// ---------------------------------------------------------------------------

export const DEFAULT_PROSE_WINDOW_TURNS = 5;

export interface MemoryConfig {
  /** 正文滑窗大小（轮）；0 = 不注入正文回顾 */
  proseWindowTurns: number;
}

/** 解析 memory 块（纯函数，可单测）：非法/缺省值回落默认 5。 */
export function resolveMemoryConfig(file: FileConfig): MemoryConfig {
  const n = file.memory?.prose_window_turns;
  return {
    proseWindowTurns:
      typeof n === "number" && Number.isInteger(n) && n >= 0 ? n : DEFAULT_PROSE_WINDOW_TURNS,
  };
}

/** 读 config.json 的 memory 块。 */
export function loadMemoryConfig(): MemoryConfig {
  return resolveMemoryConfig(readFileConfig());
}

// ---------------------------------------------------------------------------
// GM 硬保险间隔（gm_interval_cycles，行动周期数）
// ---------------------------------------------------------------------------

export const DEFAULT_GM_INTERVAL_CYCLES = 3;

/** 解析 gm_interval_cycles（纯函数，可单测）：非法/缺省值回落默认 3。 */
export function resolveGmIntervalCycles(file: FileConfig): number {
  const n = file.gm_interval_cycles;
  return typeof n === "number" && Number.isInteger(n) && n >= 1 ? n : DEFAULT_GM_INTERVAL_CYCLES;
}

/** 读 config.json 的 gm_interval_cycles。 */
export function loadGmIntervalCycles(): number {
  return resolveGmIntervalCycles(readFileConfig());
}
