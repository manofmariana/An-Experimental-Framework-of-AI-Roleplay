/**
 * 配置解析纯函数。
 *
 * 零 IO。两个入口：
 * - resolveEffectiveAgentConfigs：settings（agent 绑定）+ presets + secrets + env →
 *   三 activation 的 ResolvedAgentConfig。key 解析优先级（固定）：
 *     preset 显式 secretId 指向的 key（豁免 env）> 环境变量 > 该 kind 的 active secret。
 *   base_url/model 上 env（DEEPSEEK_BASE_URL/OPENAI_BASE_URL/DEEPSEEK_MODEL）是部署级
 *   覆盖，恒优先于 preset——与 src/config.ts 的顶层 env 语义对齐（差异见下）。
 *   解析不出（未绑定 preset / preset 不存在 / 显式 secretId 不存在 / 无 active secret
 *   且无 env 兜底）返回 null，不抛。
 * - mapLegacyConfig：旧 FileConfig → {secrets, presets, settings} 迁移映射。
 *   api_key 按 value 去重（同 value 共用一条，label "migrated"，id = migrated-<n>，
 *   顺序稳定：顶层 → character → gm → prose）；顶层 key 的记录为 active（同 kind 至多
 *   一条 active 的不变量；顶层无 key 时无任何 active，与旧「无顶层 key 即解析不出」对齐）。
 *   顶层 → preset migrated-default（不绑 secretId，env 保持旧优先权）；agents.* 有覆盖
 *   的按旧 resolveAgentConfigs 回落规则物化完整有效配置 → preset migrated-{kind}，
 *   仅当覆盖块自带 api_key 时显式绑 secretId（旧语义 override.api_key 本就连 env 都压过，
 *   显式绑定恰好等价；不自带 key 的覆盖块不绑，env 兜底行为逐字段保持）。
 *
 * 与旧语义的已知差异（有 env 时才可观察）：旧 agents.*.base_url/model 覆盖优先于 env，
 * 迁移后 env 恒优先于 preset（env 定位为部署级覆盖）。无 env 时逐字段等价。
 *
 * 依赖方向：configResolver → contracts（不依赖 config.ts；AgentKind/AGENT_KINDS 唯一定义在
 * contracts/config.ts，此处 re-export 保持既有 import 方；
 * 迁移等价性对拍基准在 test/harness/legacyConfigResolver）。
 */
import {
  AGENT_KINDS,
  ApiPresetSchema,
  ResolvedAgentConfigSchema,
  UserSettingsSchema,
  type AgentKind,
  type AgentPresetBindings,
  type ApiPreset,
  type FileConfigPayload,
  type ResolvedAgentConfig,
  type UserSettings,
} from "./contracts/config.js";
import { SecretsFileSchema, type SecretRecord, type SecretsFile } from "./contracts/secrets.js";

export { AGENT_KINDS } from "./contracts/config.js";
export type { AgentKind } from "./contracts/config.js";

/** 迁移映射使用的 secret 命名空间（旧 config.json 为 DeepSeek 兼容端点）。 */
export const MIGRATED_SECRET_KIND = "deepseek";
export const MIGRATED_DEFAULT_PRESET_ID = "migrated-default";

const DEFAULT_BASE_URL = "https://api.deepseek.com";
const DEFAULT_MODEL = "deepseek-chat";

export interface ResolveInput {
  settings: UserSettings;
  presets: readonly ApiPreset[];
  secrets: SecretsFile;
  /** 部署级环境变量覆盖（NodeJS.ProcessEnv 兼容）。 */
  env: Record<string, string | undefined>;
}

/**
 * 解析三个 activation 的有效配置。优先级见文件头注释；任一 agent 解析不出 → 整体 null。
 */
export function resolveEffectiveAgentConfigs(
  input: ResolveInput,
): Record<AgentKind, ResolvedAgentConfig> | null {
  const { settings, presets, secrets, env } = input;
  const out = {} as Record<AgentKind, ResolvedAgentConfig>;
  for (const kind of AGENT_KINDS) {
    const presetId = settings.agentPresets?.[kind];
    if (presetId === undefined) return null;
    const preset = presets.find((p) => p.id === presetId);
    if (preset === undefined) return null;

    // key：显式 secretId（豁免 env）> env > 该 kind 的 active secret
    let apiKey: string | undefined;
    if (preset.secretId !== undefined) {
      const record = (secrets[preset.secretKind] ?? []).find((r) => r.id === preset.secretId);
      if (record === undefined) return null;
      apiKey = record.value;
    } else {
      apiKey =
        env.DEEPSEEK_API_KEY ??
        env.OPENAI_API_KEY ??
        (secrets[preset.secretKind] ?? []).find((r) => r.active)?.value;
    }
    if (!apiKey) return null;

    const config: ResolvedAgentConfig = {
      apiKey,
      baseURL: env.DEEPSEEK_BASE_URL ?? env.OPENAI_BASE_URL ?? preset.baseUrl,
      model: env.DEEPSEEK_MODEL ?? preset.model,
      jsonMode: preset.jsonMode ?? false,
      // exactOptionalPropertyTypes：缺省不显式赋 undefined，用条件展开
      ...(preset.reasoningEffort !== undefined ? { reasoningEffort: preset.reasoningEffort } : {}),
    };
    ResolvedAgentConfigSchema.parse(config);
    out[kind] = config;
  }
  return out;
}

/** mapLegacyConfig 的输出：三份用户资源（迁移目标形状，已过契约校验）。 */
export interface LegacyMigration {
  secrets: SecretsFile;
  presets: ApiPreset[];
  settings: UserSettings;
}

/**
 * 旧 config.json → secrets/presets/settings 迁移映射（纯函数；等价性论证见文件头注释）。
 * 返回的 preset id：migrated-default / migrated-{kind}；secret id：migrated-<n>。
 */
export function mapLegacyConfig(file: FileConfigPayload): LegacyMigration {
  // ① api_key 按 value 去重（顺序稳定：顶层 → character → gm → prose）
  const records: SecretRecord[] = [];
  const secretIdByValue = new Map<string, string>();
  const registerKey = (value: string | undefined): string | undefined => {
    if (value === undefined || value === "") return undefined;
    const existing = secretIdByValue.get(value);
    if (existing !== undefined) return existing;
    const id = `migrated-${records.length + 1}`;
    secretIdByValue.set(value, id);
    records.push({ id, value, label: "migrated", active: false });
    return id;
  };
  // 顶层 key 的记录为 active（不变量：同 kind 至多一条 active）
  const topKeyId = registerKey(file.api_key);
  if (topKeyId !== undefined) {
    records.find((r) => r.id === topKeyId)!.active = true;
  }

  // ② 顶层 → migrated-default（不绑 secretId：env 保持旧「env 优先于顶层 key」语义）
  const presets: ApiPreset[] = [
    {
      id: MIGRATED_DEFAULT_PRESET_ID,
      name: MIGRATED_DEFAULT_PRESET_ID,
      provider: MIGRATED_SECRET_KIND,
      baseUrl: file.base_url ?? DEFAULT_BASE_URL,
      model: file.model ?? DEFAULT_MODEL,
      secretKind: MIGRATED_SECRET_KIND,
      ...(file.json_mode !== undefined ? { jsonMode: file.json_mode } : {}),
      ...(file.reasoning_effort !== undefined
        ? { reasoningEffort: file.reasoning_effort }
        : {}),
    },
  ];

  // ③ agents.* 覆盖块 → 按旧回落规则物化完整有效配置 → migrated-{kind}
  const agentPresets: AgentPresetBindings = {};
  for (const kind of AGENT_KINDS) {
    const override = file.agents?.[kind];
    if (override === undefined || Object.keys(override).length === 0) {
      agentPresets[kind] = MIGRATED_DEFAULT_PRESET_ID;
      continue;
    }
    // 仅覆盖块自带 api_key 时显式绑 secretId（旧语义 override key 连 env 都压过）；
    // 不自带 key 的覆盖块不绑——env 兜底与旧行为逐字段一致。
    const secretId = override.api_key !== undefined ? registerKey(override.api_key) : undefined;
    const jsonMode = override.json_mode ?? file.json_mode;
    const reasoningEffort = override.reasoning_effort ?? file.reasoning_effort;
    presets.push({
      id: `migrated-${kind}`,
      name: `migrated-${kind}`,
      provider: MIGRATED_SECRET_KIND,
      baseUrl: override.base_url ?? file.base_url ?? DEFAULT_BASE_URL,
      model: override.model ?? file.model ?? DEFAULT_MODEL,
      secretKind: MIGRATED_SECRET_KIND,
      ...(secretId !== undefined ? { secretId } : {}),
      ...(jsonMode !== undefined ? { jsonMode } : {}),
      ...(reasoningEffort !== undefined ? { reasoningEffort } : {}),
    });
    agentPresets[kind] = `migrated-${kind}`;
  }

  // ④ 运行设置 → settings（configRevision 从 0 起）
  const settings: UserSettings = {
    configRevision: 0,
    agentPresets,
    ...(file.memory?.prose_window_turns !== undefined
      ? { proseWindowTurns: file.memory.prose_window_turns }
      : {}),
    ...(file.gm_interval_cycles !== undefined
      ? { gmIntervalCycles: file.gm_interval_cycles }
      : {}),
  };

  // 输出整体过契约（迁移产物必须满足目标形状，含「同 kind 至多一条 active」不变量）
  const secrets: SecretsFile =
    records.length > 0 ? { [MIGRATED_SECRET_KIND]: records } : {};
  return {
    secrets: SecretsFileSchema.parse(secrets),
    presets: presets.map((p) => ApiPresetSchema.parse(p)),
    settings: UserSettingsSchema.parse(settings),
  };
}
