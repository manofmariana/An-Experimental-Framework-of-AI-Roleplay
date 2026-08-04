/**
 * 旧 config.json 分层解析语义的对拍基准。
 *
 * 唯一用途：迁移等价性测试的对拍——mapLegacyConfig + resolveEffectiveAgentConfigs
 * 的迁移结果必须与旧语义逐字段一致（test/configResolver.test.ts /
 * test/configMigration.test.ts），以及 pin 住旧语义本身的单测（test/config.test.ts）。
 * 运行链路不消费本文件；纯函数零 IO。
 */
import { AGENT_KINDS, type AgentKind, type LLMConfig } from "../../src/config.js";
import {
  ResolvedAgentConfigSchema,
  type FileConfigPayload,
} from "../../src/contracts/config.js";

/**
 * 旧分层解析：
 *  - 顶层：环境变量（DEEPSEEK_API_KEY 等）优先于 config.json 顶层字段；
 *  - agents.{character|gm|prose} 块逐字段覆盖顶层，缺省回落顶层。
 * 任一 agent 最终没有 api key 时整体返回 null。
 */
export function resolveAgentConfigs(
  file: FileConfigPayload,
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
    // 契约校验：纯增强，不改动解析值；非法形状在边界处即暴露
    ResolvedAgentConfigSchema.parse(config);
    out[kind] = config;
  }
  return out;
}
