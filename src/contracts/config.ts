/**
 * 配置契约（优化阶段 A4，docs/optimization-review.md §8「配置事务与共享契约」）。
 *
 * 消除 src/config.ts 手写 interface、server 手工字段表、前端字段数组三份定义漂移
 * 的第一步：共享 zod schema 先行。运行行为不变——消费方见：
 * ① src/config.ts resolveAgentConfigs 输出经 ResolvedAgentConfigSchema 校验后返回；
 * ② PublicConfigViewSchema/toPublicConfigView 为 config GET 脱敏视图（见该处注释）。
 * contracts/ 不依赖 truth / agents / server / llm / loop（依赖审计守护）。
 */
import { z } from "zod";
import { MaskedSecretSchema, maskSecret, SecretKindSchema } from "./secrets.js";

// ---------------------------------------------------------------------------
// config.json 文件形状（优化阶段 D3：取代 server 手工字段表，三份定义收敛为一份）
// 顶层 passthrough——未知字段（如 "_说明" 注释）原样保留；agents/memory 块 strict——
// 未知 agent / 块内未知字段即拒（与原手工表口径一致）。
// ---------------------------------------------------------------------------

/** 顶层与 agents 块同规的覆盖块（json_mode 布尔、reasoning_effort 字符串原样透传）。 */
export const AgentOverrideBlockSchema = z
  .object({
    api_key: z.string().optional(),
    base_url: z.string().optional(),
    model: z.string().optional(),
    json_mode: z.boolean().optional(),
    reasoning_effort: z.string().optional(),
  })
  .strict();
export type AgentOverrideBlock = z.infer<typeof AgentOverrideBlockSchema>;

export const FileConfigSchema = z
  .object({
    api_key: z.string().optional(),
    base_url: z.string().optional(),
    model: z.string().optional(),
    json_mode: z.boolean().optional(),
    reasoning_effort: z.string().optional(),
    agents: z
      .object({
        character: AgentOverrideBlockSchema.optional(),
        gm: AgentOverrideBlockSchema.optional(),
        prose: AgentOverrideBlockSchema.optional(),
      })
      .strict()
      .optional(),
    memory: z
      .object({ prose_window_turns: z.number().int().min(0).optional() })
      .strict()
      .optional(),
    gm_interval_cycles: z.number().int().min(1).optional(),
  })
  .passthrough();
export type FileConfigPayload = z.infer<typeof FileConfigSchema>;

/**
 * 校验 config.json 结构（PUT /api/config 前置闸；取代 api.ts 手工字段表）。
 * 未知顶层字段（注释）原样保留；结构非法抛 Error（消息 = 逐 issue 路径 + 原因）。
 */
export function validateFileConfig(raw: unknown): FileConfigPayload {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new Error("配置必须是 JSON 对象");
  }
  const result = FileConfigSchema.safeParse(raw);
  if (!result.success) {
    const issues = result.error.issues
      .map((issue) => `${issue.path.join(".") || "(顶层)"}: ${issue.message}`)
      .join("；");
    throw new Error(`配置校验失败：${issues}`);
  }
  return result.data;
}

// ---------------------------------------------------------------------------
// 服务端/部署配置（最小骨架；docs §8「服务端配置」的字段在阶段 E 逐项填充）
// ---------------------------------------------------------------------------
export const ServerConfigSchema = z.object({
  listen: z
    .object({
      host: z.string().min(1).optional(),
      port: z.number().int().min(0).max(65535).optional(),
    })
    .optional(),
  /** 明文密钥暴露开关：仅服务端配置可持有，普通 Secrets API 不得自行修改 */
  allowKeysExposure: z.boolean().optional(),
});
export type ServerConfig = z.infer<typeof ServerConfigSchema>;

// ---------------------------------------------------------------------------
// 用户设置（data/<username>/settings.json，最小骨架，optional 为主）
// ---------------------------------------------------------------------------
export const UserSettingsSchema = z.object({
  proseWindowTurns: z.number().int().min(0).optional(),
  gmIntervalCycles: z.number().int().min(1).optional(),
  pauseOptions: z
    .object({
      everyStep: z.boolean().optional(),
      beforeGm: z.boolean().optional(),
      afterGm: z.boolean().optional(),
      afterProse: z.boolean().optional(),
    })
    .optional(),
});
export type UserSettings = z.infer<typeof UserSettingsSchema>;

// ---------------------------------------------------------------------------
// API 预设（docs §8「API 预设」：引用 secret，不复制 key）
// ---------------------------------------------------------------------------
export const ApiPresetSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  provider: z.string().min(1),
  baseUrl: z.string().min(1),
  model: z.string().min(1),
  secretKind: SecretKindSchema,
  /** 省略时使用该 kind 的 active secret */
  secretId: z.string().min(1).optional(),
  jsonMode: z.boolean().optional(),
  reasoningEffort: z.string().optional(),
  parameters: z.record(z.unknown()).optional(),
});
export type ApiPreset = z.infer<typeof ApiPresetSchema>;

// ---------------------------------------------------------------------------
// 解析后的单 agent 调用配置（对齐 src/config.ts 的 LLMConfig）
// ---------------------------------------------------------------------------
export const ResolvedAgentConfigSchema = z.object({
  apiKey: z.string().min(1),
  baseURL: z.string().min(1),
  model: z.string().min(1),
  jsonMode: z.boolean(),
  reasoningEffort: z.string().optional(),
});
export type ResolvedAgentConfig = z.infer<typeof ResolvedAgentConfigSchema>;

// ---------------------------------------------------------------------------
// 公共脱敏视图（GET /api/config 的目标形状：密钥只出现掩码，不出现明文）
// ---------------------------------------------------------------------------

/** 单个配置块（顶层或 agents.*）的脱敏形状；未设置的字段不出现。 */
export const PublicAgentBlockSchema = z.object({
  api_key: MaskedSecretSchema.optional(),
  base_url: z.string().optional(),
  model: z.string().optional(),
  json_mode: z.boolean().optional(),
  reasoning_effort: z.string().optional(),
});
export type PublicAgentBlock = z.infer<typeof PublicAgentBlockSchema>;

export const PublicConfigViewSchema = z.object({
  api_key: MaskedSecretSchema.optional(),
  base_url: z.string().optional(),
  model: z.string().optional(),
  json_mode: z.boolean().optional(),
  reasoning_effort: z.string().optional(),
  agents: z
    .object({
      character: PublicAgentBlockSchema.optional(),
      gm: PublicAgentBlockSchema.optional(),
      prose: PublicAgentBlockSchema.optional(),
    })
    .optional(),
  memory: z.object({ prose_window_turns: z.number().int().min(0).optional() }).optional(),
  gm_interval_cycles: z.number().int().min(1).optional(),
});
export type PublicConfigView = z.infer<typeof PublicConfigViewSchema>;

/** toPublicConfigView 的输入：config.json 文件形状的结构子集（与 src/config.ts FileConfig 对齐，避免反向依赖）。 */
export interface FileConfigLike {
  api_key?: string;
  base_url?: string;
  model?: string;
  json_mode?: boolean;
  reasoning_effort?: string;
  agents?: Partial<Record<"character" | "gm" | "prose", FileConfigLike>>;
  memory?: { prose_window_turns?: number };
  gm_interval_cycles?: number;
}

function maskBlock(block: FileConfigLike): PublicAgentBlock {
  const out: PublicAgentBlock = {};
  if (block.api_key !== undefined) out.api_key = maskSecret(block.api_key);
  if (block.base_url !== undefined) out.base_url = block.base_url;
  if (block.model !== undefined) out.model = block.model;
  if (block.json_mode !== undefined) out.json_mode = block.json_mode;
  if (block.reasoning_effort !== undefined) out.reasoning_effort = block.reasoning_effort;
  return out;
}

/**
 * config.json 形状 → 脱敏公共视图（api_key 一律掩码，其余字段原样）。
 * 注：当前 GET /api/config 仍返回原文——前端设置页（web/pages/config.js）依赖
 * 明文回填且留空=删除，直接改脱敏会把掩码当真值写回。本构建器与 schema 先行，
 * 接线待前端改为「留空 = 保持不变」语义后进行（docs §8 脱敏方向）。
 */
export function toPublicConfigView(file: FileConfigLike): PublicConfigView {
  const view: PublicConfigView = maskBlock(file);
  if (file.agents !== undefined) {
    const agents: NonNullable<PublicConfigView["agents"]> = {};
    for (const kind of ["character", "gm", "prose"] as const) {
      const block = file.agents[kind];
      if (block !== undefined) agents[kind] = maskBlock(block);
    }
    view.agents = agents;
  }
  if (file.memory !== undefined) view.memory = file.memory;
  if (file.gm_interval_cycles !== undefined) view.gm_interval_cycles = file.gm_interval_cycles;
  return PublicConfigViewSchema.parse(view);
}
