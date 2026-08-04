/**
 * config.json → 三资源迁移闸端到端测试（contract 层：临时目录真实文件系统）。
 *
 * 覆盖迁移语义：
 * - 幂等迁移闸：config.json 存在且 secrets.json 不存在 → 原子写三资源 + 改名 .migrated.bak；
 *   二次进入不重复迁移；secrets.json 已存在时 config.json 原样保留（不迁移）。
 * - 失败安全：非法 config.json 在任何写入前抛出，原文件与资源目录不动。
 * - 等价性：迁移后 resolved ≡ 旧 resolveAgentConfigs（test/harness/legacyConfigResolver，
 *   无 env 逐字段对照）；旧模板形状（任意层级 "_" 注释键，FileConfigSchema 顶层
 *   passthrough + 迁移闸递归剔除）迁移等价。
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { describe, it } from "node:test";
import {
  loadConfigState,
  MIGRATED_BAK_SUFFIX,
  type ConfigServiceDeps,
} from "../src/application/configService.js";
import { validateFileConfig } from "../src/contracts/config.js";
import { readSecretsFile } from "../src/resources/secretsRepository.js";
import { listPresets } from "../src/resources/presetsRepository.js";
import { readSettings } from "../src/resources/settingsRepository.js";
import type { UserDirectories } from "../src/resources/userDirectories.js";
import { resolveAgentConfigs } from "./harness/legacyConfigResolver.js";
import { tempDir } from "./harness/tempDir.js";

const NO_ENV: Record<string, string | undefined> = {};

/** 临时根上的 ConfigServiceDeps（三资源 + legacyConfigFile 全部入临时目录）。 */
function makeDeps(root: string, env: Record<string, string | undefined> = NO_ENV): ConfigServiceDeps {
  const dirs: UserDirectories = {
    username: "test_user",
    root,
    assetsDir: path.join(root, "assets"),
    saveDir: path.join(root, "save"),
    presetsDir: path.join(root, "api-presets"),
    secretsFile: path.join(root, "secrets.json"),
    settingsFile: path.join(root, "settings.json"),
  };
  return { dirs, env, legacyConfigFile: path.join(root, "config.json") };
}

const LEGACY = {
  _说明: "注释字段（passthrough 容忍）",
  api_key: "sk-top-key-1111",
  base_url: "https://api.example.com",
  model: "m-top",
  reasoning_effort: "medium",
  agents: {
    character: { model: "m-char" },
    gm: { api_key: "sk-gm-own-2222", reasoning_effort: "high" },
  },
  memory: { prose_window_turns: 7 },
  gm_interval_cycles: 4,
};

describe("迁移闸：legacy config.json → 三资源", () => {
  it("首次进入迁移：三资源落盘 + .bak 存在 + 原文件消失 + resolved ≡ 旧解析", () => {
    const deps = makeDeps(tempDir("airp-mig-"));
    fs.writeFileSync(deps.legacyConfigFile, JSON.stringify(LEGACY, null, 2) + "\n", "utf8");

    const state = loadConfigState(deps);

    // 原文件消失，.bak 保留原文
    assert.ok(!fs.existsSync(deps.legacyConfigFile));
    const bak = `${deps.legacyConfigFile}${MIGRATED_BAK_SUFFIX}`;
    assert.ok(fs.existsSync(bak));
    assert.deepEqual(JSON.parse(fs.readFileSync(bak, "utf8")), LEGACY);

    // secrets：顶层 key active（migrated-1），gm 覆盖 key inactive（migrated-2），value 去重
    const secrets = readSecretsFile(deps.dirs.secretsFile);
    assert.deepEqual(secrets, {
      deepseek: [
        { id: "migrated-1", value: "sk-top-key-1111", label: "migrated", active: true },
        { id: "migrated-2", value: "sk-gm-own-2222", label: "migrated", active: false },
      ],
    });

    // presets：migrated-default + migrated-character + migrated-gm（prose 无覆盖 → 绑 default）
    const presets = listPresets(deps.dirs.presetsDir);
    assert.deepEqual(
      presets.map((p) => p.id),
      ["migrated-character", "migrated-default", "migrated-gm"],
    );
    const gmPreset = presets.find((p) => p.id === "migrated-gm")!;
    assert.equal(gmPreset.secretId, "migrated-2"); // 覆盖块自带 key → 显式绑定
    assert.equal(gmPreset.reasoningEffort, "high");
    assert.equal(presets.find((p) => p.id === "migrated-character")!.secretId, undefined);
    assert.equal(presets.find((p) => p.id === "migrated-default")!.reasoningEffort, "medium");

    // settings：绑定 + 运行设置迁移，configRevision 从 0 起
    const settings = readSettings(deps.dirs.settingsFile);
    assert.deepEqual(settings.agentPresets, {
      character: "migrated-character",
      gm: "migrated-gm",
      prose: "migrated-default",
    });
    assert.equal(settings.proseWindowTurns, 7);
    assert.equal(settings.gmIntervalCycles, 4);
    assert.equal(settings.configRevision, 0);
    assert.equal(state.configRevision, 0);

    // resolved ≡ 旧 resolveAgentConfigs（无 env 逐字段对照）
    const legacy = resolveAgentConfigs(validateFileConfig(LEGACY), {});
    assert.ok(legacy);
    assert.deepEqual(state.resolved, legacy);

    // 视图脱敏：明文 key 不出现在 view 的任何角落
    const viewText = JSON.stringify(state.view);
    assert.ok(!viewText.includes("sk-top-key-1111"));
    assert.ok(!viewText.includes("sk-gm-own-2222"));
    assert.equal(state.view.secrets["deepseek"]![0]!.maskedValue, "****1111");
  });

  it("幂等：二次进入不重复迁移（资源逐字节不变）", () => {
    const deps = makeDeps(tempDir("airp-mig-idem-"));
    fs.writeFileSync(deps.legacyConfigFile, JSON.stringify(LEGACY), "utf8");
    const first = loadConfigState(deps);
    const snapshot = {
      secrets: fs.readFileSync(deps.dirs.secretsFile, "utf8"),
      settings: fs.readFileSync(deps.dirs.settingsFile, "utf8"),
      presets: fs.readdirSync(deps.dirs.presetsDir).map((f) => fs.readFileSync(path.join(deps.dirs.presetsDir, f), "utf8")),
    };
    const second = loadConfigState(deps);
    assert.equal(second.configRevision, first.configRevision);
    assert.deepEqual(second.resolved, first.resolved);
    assert.equal(fs.readFileSync(deps.dirs.secretsFile, "utf8"), snapshot.secrets);
    assert.equal(fs.readFileSync(deps.dirs.settingsFile, "utf8"), snapshot.settings);
    assert.deepEqual(
      fs.readdirSync(deps.dirs.presetsDir).map((f) => fs.readFileSync(path.join(deps.dirs.presetsDir, f), "utf8")),
      snapshot.presets,
    );
  });

  it("闸：secrets.json 已存在时 config.json 原样保留（不迁移）", () => {
    const deps = makeDeps(tempDir("airp-mig-gate-"));
    fs.mkdirSync(path.dirname(deps.dirs.secretsFile), { recursive: true });
    fs.writeFileSync(deps.dirs.secretsFile, "{}\n", "utf8");
    fs.writeFileSync(deps.legacyConfigFile, JSON.stringify(LEGACY), "utf8");
    loadConfigState(deps);
    assert.ok(fs.existsSync(deps.legacyConfigFile), "config.json 不应被改名");
    assert.ok(!fs.existsSync(`${deps.legacyConfigFile}${MIGRATED_BAK_SUFFIX}`));
    assert.equal(fs.readFileSync(deps.dirs.secretsFile, "utf8"), "{}\n");
  });

  it("失败安全：非法 config.json 在任何写入前抛出，原文件与资源目录不动", () => {
    const deps = makeDeps(tempDir("airp-mig-bad-"));
    fs.writeFileSync(deps.legacyConfigFile, "{bad json", "utf8");
    assert.throws(() => loadConfigState(deps));
    assert.ok(fs.existsSync(deps.legacyConfigFile), "失败时 config.json 原样保留");
    assert.ok(!fs.existsSync(deps.dirs.secretsFile));
    assert.ok(!fs.existsSync(deps.dirs.settingsFile));
    assert.ok(!fs.existsSync(deps.dirs.presetsDir));

    // 契约非法（结构过了 JSON 但字段类型错）同样零落盘
    fs.writeFileSync(deps.legacyConfigFile, JSON.stringify({ gm_interval_cycles: 0 }), "utf8");
    assert.throws(() => loadConfigState(deps), /gm_interval_cycles/);
    assert.ok(fs.existsSync(deps.legacyConfigFile));
    assert.ok(!fs.existsSync(deps.dirs.secretsFile));
  });

  it("空 config.json（{}）照常迁移：资源落盘，resolved = null（无 key 来源）", () => {
    const deps = makeDeps(tempDir("airp-mig-empty-"));
    fs.writeFileSync(deps.legacyConfigFile, "{}\n", "utf8");
    const state = loadConfigState(deps);
    assert.equal(state.resolved, null);
    assert.ok(fs.existsSync(deps.dirs.secretsFile));
    assert.ok(!fs.existsSync(deps.legacyConfigFile));
    assert.deepEqual(state.view.settings.agentPresets, {
      character: "migrated-default",
      gm: "migrated-default",
      prose: "migrated-default",
    });
  });

  it("旧模板形状（任意层级「_」注释键）：迁移后 resolved ≡ 旧解析（注释 passthrough）", () => {
    // config.example.json 模板形状原样内联（含嵌套注释键，覆盖迁移闸递归剔除口径）
    const example = {
      _说明: "注释字段（passthrough 容忍）",
      _优先级: "环境变量优先于顶层字段；agents 块逐字段覆盖顶层",
      api_key: "sk-example-key-3333",
      base_url: "https://api.deepseek.com",
      model: "deepseek-chat",
      json_mode: false,
      reasoning_effort: "medium",
      agents: {
        character: { model: "deepseek-chat" },
        gm: { reasoning_effort: "high" },
        prose: { json_mode: false },
      },
      memory: {
        _prose_window_turns: "块内嵌套注释键",
        prose_window_turns: 5,
      },
      gm_interval_cycles: 3,
    };
    // 旧解析基准：剔除任意层级 "_" 注释键（迁移闸同口径）
    const strip = (v: unknown): unknown =>
      Array.isArray(v)
        ? v.map(strip)
        : typeof v === "object" && v !== null
          ? Object.fromEntries(
              Object.entries(v)
                .filter(([k]) => !k.startsWith("_"))
                .map(([k, vv]) => [k, strip(vv)]),
            )
          : v;
    const file = validateFileConfig(strip(example));
    const deps = makeDeps(tempDir("airp-mig-example-"));
    fs.writeFileSync(deps.legacyConfigFile, JSON.stringify(example), "utf8");
    const state = loadConfigState(deps);
    const legacy = resolveAgentConfigs(file, {});
    assert.ok(legacy, "模板自带示例 api_key，解析不应为 null");
    assert.deepEqual(state.resolved, legacy);
    assert.equal(state.resolved!.gm.reasoningEffort, "high"); // gm 覆盖高层级语义保持
    assert.equal(state.view.settings.proseWindowTurns, 5);
  });
});
