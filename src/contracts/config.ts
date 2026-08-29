/**
 * 配置契约：共享 zod schema 唯一出处。GET /api/config 返回 ConfigStateView（脱敏，
 * secrets 只有掩码态）；FileConfigSchema/validateFileConfig 为迁移专用——唯一消费方是
 * configService 的一次性迁移闸（旧 config.json → 三资源），长期保留供旧版升级。
 * contracts/ 不依赖 truth / agents / server / llm / loop（依赖审计守护）。
 */
import { z } from "zod";
import { SecretKindSchema, SecretMutationSchema, SecretStateSchema } from "./secrets.js";

// ---------------------------------------------------------------------------
// activation 对象枚举（提示词矩阵对象轴）
// ---------------------------------------------------------------------------
/** 三类 activation（每类独立 adapter/preset 绑定）；唯一出处，config.ts 与 configResolver.ts re-export。 */
export const AGENT_KINDS = ["character", "gm", "prose"] as const;
export type AgentKind = (typeof AGENT_KINDS)[number];

// ---------------------------------------------------------------------------
// config.json 文件形状（迁移闸读取源）
// 顶层 passthrough——未知字段（如 "_说明" 注释）原样保留；agents/memory 块 strict——
// 未知 agent / 块内未知字段即拒。
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
 * 校验旧 config.json 结构（迁移专用：唯一消费方 = configService 迁移闸，长期保留供旧版升级）。
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
// 服务端/部署配置（server.json 文件形状）
// 只管部署面（listen/白名单/密钥暴露/认证/SSL/代理/广播），不承担用户 API
// preset/secret（那是 data/<username>/ 三资源）。顶层 passthrough——
// 未知字段（如 "_说明" 注释）原样保留；嵌套块 strict，笔误即拒。
// basicAuth/ssl/proxy/broadcast 四块接受配置但加载时 warn「未实现，忽略」
// （见 src/serverConfig.ts——不做半成品假安全）。
// ---------------------------------------------------------------------------
export const ServerConfigSchema = z
  .object({
    listen: z
      .object({
        host: z.string().min(1).optional(),
        port: z.number().int().min(0).max(65535).optional(),
      })
      .strict()
      .optional(),
    /** Host 头白名单（hostname 精确匹配，大小写不敏感；空 = 只放行监听地址/loopback 默认） */
    hostWhitelist: z.array(z.string().min(1)).optional(),
    /** 来源 IP 白名单（非空时 remoteAddress 必须命中；"::ffff:" 前缀归一后比较） */
    ipWhitelist: z.array(z.string().min(1)).optional(),
    /** 明文密钥暴露开关：仅服务端配置可持有，普通 Secrets API 不得自行修改 */
    allowKeysExposure: z.boolean().optional(),
    /** 未实现：浏览器 WS 无法携带 Authorization 头，凭证需 cookie/session 设计 */
    basicAuth: z
      .object({ username: z.string().min(1), password: z.string().min(1) })
      .strict()
      .optional(),
    /** 未实现：SSL 需 https server 分叉，超出本地应用可行性边界 */
    ssl: z
      .object({
        cert: z.string().min(1),
        key: z.string().min(1),
        passphrase: z.string().optional(),
      })
      .strict()
      .optional(),
    /** 未实现：出站请求代理 */
    proxy: z
      .object({ url: z.string().min(1), bypass: z.array(z.string().min(1)).optional() })
      .strict()
      .optional(),
    /** 未实现：局域网广播/发现 */
    broadcast: z.boolean().optional(),
  })
  .passthrough();
export type ServerConfig = z.infer<typeof ServerConfigSchema>;

// ---------------------------------------------------------------------------
// 用户设置（data/<username>/settings.json）
// agentPresets（三 activation → presetId 绑定）+ configRevision
// （配置乐观并发版本，与游戏 Generation revision 分离；缺省 0）。
// ---------------------------------------------------------------------------
/** 三 activation 的 preset 绑定（值 = presetId；缺省 = 未绑定，resolver 解析不出即 null）。 */
export const AgentPresetBindingsSchema = z.object({
  character: z.string().min(1).optional(),
  gm: z.string().min(1).optional(),
  prose: z.string().min(1).optional(),
});
export type AgentPresetBindings = z.infer<typeof AgentPresetBindingsSchema>;

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
  agentPresets: AgentPresetBindingsSchema.optional(),
  /** 配置事务版本号（mutation 携带 baseConfigRevision 防静默互覆；缺文件/旧文件 = 0）。 */
  configRevision: z.number().int().min(0).default(0),
});
export type UserSettings = z.infer<typeof UserSettingsSchema>;

// ---------------------------------------------------------------------------
// API 预设（引用 secret，不复制 key）
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

/** 预设列表状态（api-presets/ 目录的内存投影）。 */
export const PresetsStateSchema = z.array(ApiPresetSchema);
export type PresetsState = z.infer<typeof PresetsStateSchema>;

/**
 * 配置状态公共视图（GET /api/config 的返回形状）。
 * secrets 只有掩码 state（SecretState），绝不含明文；agent 绑定与 configRevision
 * 收在 settings 内（单一出处，不在视图顶层重复）。
 */
export const ConfigStateViewSchema = z.object({
  secrets: SecretStateSchema,
  presets: PresetsStateSchema,
  settings: UserSettingsSchema,
});
export type ConfigStateView = z.infer<typeof ConfigStateViewSchema>;

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
// 配置事务 mutation（applyConfigMutation 的唯一入参契约）
// ---------------------------------------------------------------------------

/** preset 变更（save = upsert，id 缺省由服务端生成；delete/duplicate 按 id）。 */
export const PresetMutationSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("save"),
    preset: ApiPresetSchema.extend({ id: z.string().min(1).optional() }),
  }),
  z.object({ type: z.literal("delete"), id: z.string().min(1) }),
  z.object({ type: z.literal("duplicate"), id: z.string().min(1) }),
]);
export type PresetMutation = z.infer<typeof PresetMutationSchema>;

/**
 * settings patch（运行设置与 agent 绑定修改；configRevision 由事务自增，不接受 patch）。
 * 各字段缺省 = 保持不变；agentPresets 携带时整体替换绑定表。
 */
export const SettingsPatchSchema = z
  .object({
    proseWindowTurns: z.number().int().min(0).optional(),
    gmIntervalCycles: z.number().int().min(1).optional(),
    pauseOptions: UserSettingsSchema.shape.pauseOptions,
    agentPresets: AgentPresetBindingsSchema.optional(),
  })
  .strict();
export type SettingsPatch = z.infer<typeof SettingsPatchSchema>;

/** PUT /api/config 请求体：settings patch + baseConfigRevision 乐观并发闸。 */
export const ConfigPutBodySchema = SettingsPatchSchema.extend({
  baseConfigRevision: z.number().int().min(0),
});
export type ConfigPutBody = z.infer<typeof ConfigPutBodySchema>;

/** 配置事务 mutation 判别联合（secret/preset/settings 三域）。 */
export const ConfigMutationSchema = z.discriminatedUnion("domain", [
  z.object({ domain: z.literal("secret"), mutation: SecretMutationSchema }),
  z.object({ domain: z.literal("preset"), mutation: PresetMutationSchema }),
  z.object({ domain: z.literal("settings"), patch: SettingsPatchSchema }),
]);
export type ConfigMutation = z.infer<typeof ConfigMutationSchema>;
