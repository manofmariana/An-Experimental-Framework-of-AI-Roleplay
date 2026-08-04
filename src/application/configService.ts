/**
 * 配置事务唯一编排口。
 *
 * 对外两个函数：
 * - loadConfigState：**幂等迁移闸**（config.json 存在且 secrets.json 不存在 → 读
 *   FileConfig（validateFileConfig 校验）→ mapLegacyConfig → 原子写三资源 → config.json
 *   改名 config.json.migrated.bak；再次进入不重复迁移。迁移在任何写入前先完整解析 +
 *   构造草稿，失败原样保留 config.json 不动）→ 读三资源 → resolveEffectiveAgentConfigs
 *   → 返回 {resolved, view(ConfigStateView 脱敏), configRevision}。
 * - applyConfigMutation：配置事务全流程——baseConfigRevision 乐观并发闸（不符 →
 *   ConfigRevisionConflictError，HTTP 映射 409）→ 草稿应用 mutation（SecretMutation /
 *   PresetMutation / SettingsPatch 判别联合，契约 = contracts/config.ts ConfigMutationSchema）
 *   → resolveEffectiveAgentConfigs 解析三 activation（null → CONFIG_INVALID，HTTP 400，
 *   **零落盘**）→ 原子保存（configRevision +1）→ 热应用：注入的 applyResolved 收到
 *   **同一份 resolved 对象**（运行中会话不自读文件）→ 热应用抛错 → **回写旧资源文件**
 *   + CONFIG_APPLY_FAILED（HTTP 500，不声称已生效）→ 成功返回 {configRevision, view}。
 *
 * configRevision 存 settings.json 顶层，每次事务 +1，与游戏 Generation revision 完全分离。
 * 路径全部经 deps.dirs（UserDirectories）+ deps.legacyConfigFile 注入，不硬编码。
 * 依赖方向：application → resources / configResolver / contracts（禁依赖 server，审计守护）。
 */
import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import {
  AGENT_KINDS,
  mapLegacyConfig,
  resolveEffectiveAgentConfigs,
  type AgentKind,
} from "../configResolver.js";
import {
  ApiPresetSchema,
  ConfigStateViewSchema,
  UserSettingsSchema,
  validateFileConfig,
  type ApiPreset,
  type ConfigMutation,
  type ConfigStateView,
  type PresetMutation,
  type ResolvedAgentConfig,
  type UserSettings,
} from "../contracts/config.js";
import type { SecretsFile } from "../contracts/secrets.js";
import {
  applySecretMutation,
  readSecretsFile,
  toSecretState,
  writeSecretsFile,
} from "../resources/secretsRepository.js";
import {
  listPresets,
  PresetsRepositoryError,
  savePreset,
} from "../resources/presetsRepository.js";
import { readSettings, writeSettings } from "../resources/settingsRepository.js";
import type { UserDirectories } from "../resources/userDirectories.js";
import { safeSegment } from "../shared/safeSegment.js";

/** 迁移完成后 config.json 的改名后缀。 */
export const MIGRATED_BAK_SUFFIX = ".migrated.bak";

/** 服务错误码（HTTP 映射：CONFIG_REVISION_CONFLICT/PRESET_IN_USE→409，CONFIG_INVALID→400，CONFIG_APPLY_FAILED→500）。 */
export type ConfigServiceErrorCode =
  | "CONFIG_REVISION_CONFLICT"
  | "PRESET_IN_USE"
  | "CONFIG_APPLY_FAILED"
  | "CONFIG_INVALID";

export class ConfigServiceError extends Error {
  constructor(
    public readonly code: ConfigServiceErrorCode,
    message: string,
    public readonly details?: unknown,
  ) {
    super(message);
    this.name = "ConfigServiceError";
  }
}

/** baseConfigRevision 乐观并发冲突（映射 409 CONFIG_REVISION_CONFLICT；details 附双值）。 */
export class ConfigRevisionConflictError extends ConfigServiceError {
  constructor(
    public readonly base: number,
    public readonly current: number,
  ) {
    super(
      "CONFIG_REVISION_CONFLICT",
      `配置版本冲突：base=${base}，当前=${current}（请刷新后重试）`,
      { baseConfigRevision: base, currentConfigRevision: current },
    );
    this.name = "ConfigRevisionConflictError";
  }
}

/** 配置服务依赖（组成根/index.ts、CLI、sessionFactory 注入；测试注入临时目录）。 */
export interface ConfigServiceDeps {
  /** 用户资源目录（secretsFile/presetsDir/settingsFile 三资源位置）。 */
  dirs: UserDirectories;
  /** 部署级环境变量覆盖（NodeJS.ProcessEnv 兼容）。 */
  env: Record<string, string | undefined>;
  /** 旧 config.json 路径（迁移闸读取源 + 改名目标）。 */
  legacyConfigFile: string;
  /**
   * 热应用回调：保存成功后以**同一份 resolved 对象**原地更新运行中会话
   * （server 装配 = Coordinator.applyResolvedConfig 转发；无会话时回调内部 no-op）。
   * 省略 = 只落盘不热应用（CLI 等无会话场景不调用 applyConfigMutation，本字段可省）。
   */
  applyResolved?: (
    resolved: Record<AgentKind, ResolvedAgentConfig>,
    settings: UserSettings,
  ) => void;
  /** id 生成（测试注入确定性；默认 crypto.randomUUID）。 */
  generateId?: () => string;
}

/** 三资源的一次性内存快照（事务草稿/回滚共用形状）。 */
interface ConfigResources {
  secrets: SecretsFile;
  presets: ApiPreset[];
  settings: UserSettings;
}

/** 读三资源（缺文件 = 仓储默认值：空 secrets / 空 presets / 默认 settings）。 */
function readResources(deps: ConfigServiceDeps): ConfigResources {
  return {
    secrets: readSecretsFile(deps.dirs.secretsFile),
    presets: listPresets(deps.dirs.presetsDir),
    settings: readSettings(deps.dirs.settingsFile),
  };
}

/**
 * 原子保存三资源：先整体预校验（任何非法形状零落盘），再 secrets → presets → settings
 * 逐文件 .tmp→rename（仓储原子写）。presets 为目录级同步：写快照内全部文件，
 * 删除目录中快照外的 .json（delete/duplicate 的落盘语义）。
 */
function saveResources(deps: ConfigServiceDeps, resources: ConfigResources): void {
  // 预校验：id 必须同时过契约与安全段（防目录穿越在任何删除/写入之前暴露）
  for (const preset of resources.presets) {
    ApiPresetSchema.parse(preset);
    safeSegment(preset.id);
  }
  writeSecretsFile(deps.dirs.secretsFile, resources.secrets);
  // presets 目录同步：先写后删（写失败时已删文件最少——删除放最后）
  for (const preset of resources.presets) savePreset(deps.dirs.presetsDir, preset);
  if (fs.existsSync(deps.dirs.presetsDir)) {
    const keep = new Set(resources.presets.map((p) => `${p.id}.json`));
    for (const f of fs.readdirSync(deps.dirs.presetsDir)) {
      if (f.endsWith(".json") && !keep.has(f)) fs.rmSync(path.join(deps.dirs.presetsDir, f));
    }
  }
  writeSettings(deps.dirs.settingsFile, resources.settings);
}

/** 三资源 → 脱敏公共视图（secrets 只出掩码态）。 */
function buildView(resources: ConfigResources): ConfigStateView {
  return ConfigStateViewSchema.parse({
    secrets: toSecretState(resources.secrets),
    presets: resources.presets,
    settings: resources.settings,
  });
}

/** 迁移宽容化：递归剔除 "_" 前缀注释字段（旧 config.json 约定允许任意层级的注释键）。 */
function stripLegacyComments(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stripLegacyComments);
  if (typeof value === "object" && value !== null) {
    return Object.fromEntries(
      Object.entries(value)
        .filter(([key]) => !key.startsWith("_"))
        .map(([key, v]) => [key, stripLegacyComments(v)]),
    );
  }
  return value;
}

/**
 * 幂等迁移闸：config.json 存在且 secrets.json 不存在 → 一次性迁移。
 * 任何解析/校验失败在写入之前抛出，config.json 原样保留（下次进入重试同一迁移）；
 * 三资源落盘成功后才把 config.json 改名 .migrated.bak。
 */
function migrateLegacyConfigIfNeeded(deps: ConfigServiceDeps): void {
  if (!fs.existsSync(deps.legacyConfigFile)) return;
  if (fs.existsSync(deps.dirs.secretsFile)) return; // 已迁移（闸）
  const raw: unknown = JSON.parse(fs.readFileSync(deps.legacyConfigFile, "utf8"));
  const file = validateFileConfig(stripLegacyComments(raw));
  const migration = mapLegacyConfig(file);
  saveResources(deps, {
    secrets: migration.secrets,
    presets: migration.presets,
    settings: migration.settings,
  });
  fs.renameSync(deps.legacyConfigFile, `${deps.legacyConfigFile}${MIGRATED_BAK_SUFFIX}`);
}

/** loadConfigState 返回：解析结果（不可解析 = null）+ 脱敏视图 + 当前配置版本。 */
export interface ConfigState {
  resolved: Record<AgentKind, ResolvedAgentConfig> | null;
  view: ConfigStateView;
  configRevision: number;
}

/** 读配置状态（含迁移闸；CLI/sessionFactory/server GET 共用入口）。 */
export function loadConfigState(deps: ConfigServiceDeps): ConfigState {
  migrateLegacyConfigIfNeeded(deps);
  const resources = readResources(deps);
  const resolved = resolveEffectiveAgentConfigs({
    settings: resources.settings,
    presets: resources.presets,
    secrets: resources.secrets,
    env: deps.env,
  });
  return { resolved, view: buildView(resources), configRevision: resources.settings.configRevision };
}

/** preset 草稿变换（纯函数；delete 的被绑定闸在本层——409 PRESET_IN_USE 语义）。 */
function applyPresetMutation(
  current: ConfigResources,
  mutation: PresetMutation,
  generateId: () => string,
): ApiPreset[] {
  switch (mutation.type) {
    case "save": {
      const preset = ApiPresetSchema.parse({
        ...mutation.preset,
        id: mutation.preset.id ?? generateId(),
      });
      const next = [...current.presets];
      const index = next.findIndex((p) => p.id === preset.id);
      if (index >= 0) next[index] = preset;
      else next.push(preset);
      return next;
    }
    case "delete": {
      const usedBy = AGENT_KINDS.filter((k) => current.settings.agentPresets?.[k] === mutation.id);
      if (usedBy.length > 0) {
        throw new ConfigServiceError(
          "PRESET_IN_USE",
          `preset 正被 agent 绑定（${usedBy.join("/")}），不能删除: ${mutation.id}`,
        );
      }
      if (!current.presets.some((p) => p.id === mutation.id)) {
        throw new PresetsRepositoryError("PRESET_NOT_FOUND", `preset 不存在: ${mutation.id}`);
      }
      return current.presets.filter((p) => p.id !== mutation.id);
    }
    case "duplicate": {
      const source = current.presets.find((p) => p.id === mutation.id);
      if (source === undefined) {
        throw new PresetsRepositoryError("PRESET_NOT_FOUND", `preset 不存在: ${mutation.id}`);
      }
      return [...current.presets, { ...source, id: generateId(), name: `${source.name} (副本)` }];
    }
  }
}

/** applyConfigMutation 返回：新配置版本 + 脱敏视图（热应用已成功才返回）。 */
export interface ConfigMutationResult {
  configRevision: number;
  view: ConfigStateView;
}

/**
 * 配置事务全流程（读版本 → 草稿 patch → 解析三 activation → 原子保存 →
 * 同一 resolved 热应用 → 返回新 configRevision 与脱敏视图）。
 * 解析失败（CONFIG_INVALID，含 zod 校验抛错）零落盘；热应用失败回写旧资源文件后抛
 * CONFIG_APPLY_FAILED（不声称已生效）。
 */
export function applyConfigMutation(
  deps: ConfigServiceDeps,
  mutation: ConfigMutation,
  baseConfigRevision: number,
): ConfigMutationResult {
  migrateLegacyConfigIfNeeded(deps);
  const current = readResources(deps);
  if (baseConfigRevision !== current.settings.configRevision) {
    throw new ConfigRevisionConflictError(baseConfigRevision, current.settings.configRevision);
  }

  // 草稿应用 mutation（不触碰磁盘）
  const draft: ConfigResources = { ...current };
  switch (mutation.domain) {
    case "secret":
      draft.secrets = applySecretMutation(current.secrets, mutation.mutation, deps.generateId ?? randomUUID);
      break;
    case "preset":
      draft.presets = applyPresetMutation(current, mutation.mutation, deps.generateId ?? randomUUID);
      break;
    case "settings":
      draft.settings = UserSettingsSchema.parse({ ...current.settings, ...mutation.patch });
      break;
  }

  // 解析三 activation：失败零落盘（CONFIG_INVALID → 400；zod 抛错 → 400 VALIDATION_ERROR）
  const resolved = resolveEffectiveAgentConfigs({
    settings: draft.settings,
    presets: draft.presets,
    secrets: draft.secrets,
    env: deps.env,
  });
  if (resolved === null) {
    throw new ConfigServiceError(
      "CONFIG_INVALID",
      "变更后三个 activation 的有效配置解析不出（未绑定 preset / preset 或显式 secretId 不存在 / 无 active secret 且无环境变量兜底），未落盘",
    );
  }

  // 原子保存（configRevision +1，与游戏 Generation revision 分离）
  draft.settings = { ...draft.settings, configRevision: current.settings.configRevision + 1 };
  saveResources(deps, draft);

  // 热应用：同一份 resolved 对象交给运行中会话；失败回写旧资源文件，不声称已生效
  try {
    deps.applyResolved?.(resolved, draft.settings);
  } catch (err) {
    let rollbackNote = "";
    try {
      saveResources(deps, current);
    } catch (rollbackErr) {
      rollbackNote = `；回滚资源文件也失败: ${rollbackErr instanceof Error ? rollbackErr.message : String(rollbackErr)}`;
    }
    throw new ConfigServiceError(
      "CONFIG_APPLY_FAILED",
      `配置热应用失败，已回滚资源文件（未生效）：${err instanceof Error ? err.message : String(err)}${rollbackNote}`,
    );
  }

  return { configRevision: draft.settings.configRevision, view: buildView(draft) };
}
