/**
 * configResolver 纯逻辑（unit 层：严格零 IO）。
 * - resolveEffectiveAgentConfigs 优先级矩阵：显式 secretId（豁免 env）> env > active secret；
 *   env 对 base_url/model 恒为部署级覆盖；解析不出 → null。
 * - mapLegacyConfig 迁移映射：与旧 resolveAgentConfigs（test/harness/legacyConfigResolver）
 *   逐字段对照（无 env 时严格等价；有 env 时的唯一差异 = 旧 agents.*.base_url/model 覆盖
 *   env，新 env 恒优先）。
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { ApiPreset, FileConfigPayload, UserSettings } from "../src/contracts/config.js";
import type { SecretsFile } from "../src/contracts/secrets.js";
import {
  mapLegacyConfig,
  MIGRATED_DEFAULT_PRESET_ID,
  resolveEffectiveAgentConfigs,
} from "../src/configResolver.js";
import { resolveAgentConfigs } from "./harness/legacyConfigResolver.js";

const NO_ENV: Record<string, string | undefined> = {};

const secrets: SecretsFile = {
  deepseek: [
    { id: "s1", value: "sk-active-0001", label: "主", active: true },
    { id: "s2", value: "sk-pinned-0002", label: "备", active: false },
  ],
};

const preset = (over: Partial<ApiPreset> = {}): ApiPreset => ({
  id: "p1",
  name: "预设一",
  provider: "deepseek",
  baseUrl: "https://example.com/v1",
  model: "model-x",
  secretKind: "deepseek",
  ...over,
});

const settings = (agentPresets: UserSettings["agentPresets"]): UserSettings => ({
  configRevision: 0,
  agentPresets,
});

const allBound = { character: "p1", gm: "p1", prose: "p1" };

describe("resolveEffectiveAgentConfigs：key 优先级矩阵", () => {
  it("无 secretId 无 env：取该 kind 的 active secret", () => {
    const resolved = resolveEffectiveAgentConfigs({
      settings: settings(allBound),
      presets: [preset()],
      secrets,
      env: NO_ENV,
    });
    assert.ok(resolved);
    for (const kind of ["character", "gm", "prose"] as const) {
      assert.equal(resolved[kind].apiKey, "sk-active-0001");
      assert.equal(resolved[kind].baseURL, "https://example.com/v1");
      assert.equal(resolved[kind].model, "model-x");
      assert.equal(resolved[kind].jsonMode, false);
      assert.equal(resolved[kind].reasoningEffort, undefined);
    }
  });

  it("无 secretId：env 覆盖 key/base_url/model", () => {
    const resolved = resolveEffectiveAgentConfigs({
      settings: settings(allBound),
      presets: [preset()],
      secrets,
      env: {
        DEEPSEEK_API_KEY: "env-key",
        DEEPSEEK_BASE_URL: "https://env.example.com",
        DEEPSEEK_MODEL: "env-model",
      },
    });
    assert.ok(resolved);
    assert.equal(resolved.character.apiKey, "env-key");
    assert.equal(resolved.character.baseURL, "https://env.example.com");
    assert.equal(resolved.character.model, "env-model");
  });

  it("显式 secretId：key 豁免 env（env 只压 base_url/model）", () => {
    const resolved = resolveEffectiveAgentConfigs({
      settings: settings(allBound),
      presets: [preset({ secretId: "s2" })],
      secrets,
      env: { DEEPSEEK_API_KEY: "env-key", DEEPSEEK_BASE_URL: "https://env.example.com" },
    });
    assert.ok(resolved);
    assert.equal(resolved.gm.apiKey, "sk-pinned-0002"); // env key 被豁免
    assert.equal(resolved.gm.baseURL, "https://env.example.com"); // env 仍是部署级覆盖
  });

  it("显式 secretId 指向不存在的记录 → null", () => {
    assert.equal(
      resolveEffectiveAgentConfigs({
        settings: settings(allBound),
        presets: [preset({ secretId: "nope" })],
        secrets,
        env: NO_ENV,
      }),
      null,
    );
  });

  it("无 active secret 且无 env 兜底 → null；有 env key 兜底则可解析", () => {
    const noActive: SecretsFile = { deepseek: [{ id: "s2", value: "v", label: "l", active: false }] };
    assert.equal(
      resolveEffectiveAgentConfigs({
        settings: settings(allBound),
        presets: [preset()],
        secrets: noActive,
        env: NO_ENV,
      }),
      null,
    );
    assert.ok(
      resolveEffectiveAgentConfigs({
        settings: settings(allBound),
        presets: [preset()],
        secrets: noActive,
        env: { DEEPSEEK_API_KEY: "env-key" },
      }),
    );
  });

  it("preset 不存在 / agent 未绑定 → null", () => {
    assert.equal(
      resolveEffectiveAgentConfigs({
        settings: settings(allBound),
        presets: [],
        secrets,
        env: NO_ENV,
      }),
      null,
    );
    assert.equal(
      resolveEffectiveAgentConfigs({
        settings: settings({ character: "p1", gm: "p1" }), // prose 未绑定
        presets: [preset()],
        secrets,
        env: NO_ENV,
      }),
      null,
    );
  });

  it("逐 agent 不同 preset；jsonMode/reasoningEffort 逐 preset 自带", () => {
    const resolved = resolveEffectiveAgentConfigs({
      settings: settings({ character: "p1", gm: "p2", prose: "p1" }),
      presets: [
        preset(),
        preset({ id: "p2", model: "model-gm", jsonMode: true, reasoningEffort: "high" }),
      ],
      secrets,
      env: NO_ENV,
    });
    assert.ok(resolved);
    assert.equal(resolved.character.model, "model-x");
    assert.equal(resolved.gm.model, "model-gm");
    assert.equal(resolved.gm.jsonMode, true);
    assert.equal(resolved.gm.reasoningEffort, "high");
    assert.equal(resolved.character.reasoningEffort, undefined);
  });
});

describe("mapLegacyConfig：迁移映射", () => {
  it("仅顶层：单 preset migrated-default + 单 active secret；settings 全绑 default", () => {
    const m = mapLegacyConfig({
      api_key: "sk-top-1234",
      base_url: "https://a.com",
      model: "m1",
      json_mode: true,
      reasoning_effort: "low",
      memory: { prose_window_turns: 7 },
      gm_interval_cycles: 2,
    });
    assert.deepEqual(m.secrets, {
      deepseek: [{ id: "migrated-1", value: "sk-top-1234", label: "migrated", active: true }],
    });
    assert.deepEqual(m.presets, [
      {
        id: MIGRATED_DEFAULT_PRESET_ID,
        name: MIGRATED_DEFAULT_PRESET_ID,
        provider: "deepseek",
        baseUrl: "https://a.com",
        model: "m1",
        secretKind: "deepseek",
        jsonMode: true,
        reasoningEffort: "low",
      },
    ]);
    assert.deepEqual(m.settings, {
      configRevision: 0,
      agentPresets: {
        character: MIGRATED_DEFAULT_PRESET_ID,
        gm: MIGRATED_DEFAULT_PRESET_ID,
        prose: MIGRATED_DEFAULT_PRESET_ID,
      },
      proseWindowTurns: 7,
      gmIntervalCycles: 2,
    });
  });

  it("api_key 按 value 去重：顶层与覆盖块同值共用一条，id 稳定", () => {
    const m = mapLegacyConfig({
      api_key: "sk-same",
      agents: { gm: { api_key: "sk-same", model: "gm-model" } },
    });
    assert.equal(m.secrets.deepseek!.length, 1);
    assert.equal(m.secrets.deepseek![0]!.id, "migrated-1");
    // gm 覆盖块自带 key（同值）→ 仍显式绑定（等价于旧 override 压 env 语义）
    assert.equal(m.presets.find((p) => p.id === "migrated-gm")!.secretId, "migrated-1");
  });

  it("覆盖块物化完整有效配置；自带 api_key 才显式绑 secretId", () => {
    const m = mapLegacyConfig({
      api_key: "sk-top",
      base_url: "https://top.com",
      model: "top-model",
      reasoning_effort: "medium",
      agents: {
        character: { model: "char-model" }, // 不自带 key → 不绑 secretId
        gm: { api_key: "sk-gm-only", json_mode: true }, // 自带 key → 显式绑
      },
    });
    assert.equal(m.settings.agentPresets!.character, "migrated-character");
    assert.equal(m.settings.agentPresets!.prose, MIGRATED_DEFAULT_PRESET_ID);
    const charPreset = m.presets.find((p) => p.id === "migrated-character")!;
    assert.deepEqual(charPreset, {
      id: "migrated-character",
      name: "migrated-character",
      provider: "deepseek",
      baseUrl: "https://top.com", // 回落顶层
      model: "char-model",
      secretKind: "deepseek",
      reasoningEffort: "medium", // 回落顶层
    });
    const gmPreset = m.presets.find((p) => p.id === "migrated-gm")!;
    assert.equal(gmPreset.secretId, "migrated-2");
    assert.equal(gmPreset.jsonMode, true);
    assert.equal(gmPreset.baseUrl, "https://top.com"); // 回落顶层
    // 顶层 key active；gm 私有 key inactive（同 kind 至多一条 active）
    assert.deepEqual(
      m.secrets.deepseek!.map((r) => [r.id, r.active]),
      [
        ["migrated-1", true],
        ["migrated-2", false],
      ],
    );
  });

  it("无 key 的旧配置：secrets 为空、无 active，settings/presets 仍成形", () => {
    const m = mapLegacyConfig({ model: "m1" });
    assert.deepEqual(m.secrets, {});
    assert.equal(m.presets.length, 1);
    assert.equal(m.presets[0]!.secretId, undefined);
  });

  it("等价性对照：迁移后解析结果 ≡ 旧 resolveAgentConfigs（无 env）", () => {
    const cases: FileConfigPayload[] = [
      { api_key: "sk-only-top" },
      {
        api_key: "sk-top",
        base_url: "https://top.com",
        model: "top-model",
        json_mode: true,
        agents: { character: { model: "c-model" }, gm: { json_mode: false } },
      },
      {
        api_key: "sk-top",
        reasoning_effort: "high",
        agents: {
          character: { api_key: "sk-char", base_url: "https://c.com", reasoning_effort: "low" },
          prose: { api_key: "sk-prose", model: "p-model", json_mode: true },
        },
      },
    ];
    for (const file of cases) {
      const legacy = resolveAgentConfigs(file, NO_ENV);
      assert.ok(legacy, "旧解析应成功");
      const m = mapLegacyConfig(file);
      const migrated = resolveEffectiveAgentConfigs({
        settings: m.settings,
        presets: m.presets,
        secrets: m.secrets,
        env: NO_ENV,
      });
      assert.ok(migrated, "迁移后解析应成功");
      assert.deepEqual(migrated, legacy);
    }
  });

  it("等价性对照：env 对无显式绑定的 agent 保持旧优先权（key）", () => {
    const file: FileConfigPayload = { api_key: "sk-top", agents: { gm: { model: "gm-model" } } };
    const env = { DEEPSEEK_API_KEY: "env-key" };
    const legacy = resolveAgentConfigs(file, env);
    const m = mapLegacyConfig(file);
    const migrated = resolveEffectiveAgentConfigs({
      settings: m.settings,
      presets: m.presets,
      secrets: m.secrets,
      env,
    });
    assert.ok(legacy && migrated);
    assert.equal(migrated.character.apiKey, legacy.character.apiKey); // env-key
    assert.equal(migrated.gm.apiKey, legacy.gm.apiKey); // gm 不自带 key → env 仍生效
    assert.equal(migrated.gm.model, legacy.gm.model);
  });
});
