/**
 * 阶段 A4 契约与路径工具单测（unit：零 IO 纯逻辑）。
 * 覆盖：safeSegment（shared）、resolveUserDirectories（resources）、
 * 配置/Secrets/Preset/脱敏视图 zod 契约（contracts）。
 */
import assert from "node:assert/strict";
import path from "node:path";
import { describe, it } from "node:test";
import {
  PROJECT_ROOT,
  PROMPTS_DIR,
  RUNS_DIR,
  WORLDS_DIR,
  runDir,
} from "../src/config.js";
import {
  ApiPresetSchema,
  PublicConfigViewSchema,
  ResolvedAgentConfigSchema,
  ServerConfigSchema,
  toPublicConfigView,
  UserSettingsSchema,
} from "../src/contracts/config.js";
import {
  maskSecret,
  MaskedSecretSchema,
  SecretMutationSchema,
  SecretsFileSchema,
} from "../src/contracts/secrets.js";
import {
  DEFAULT_USERNAME,
  resolveUserDirectories,
} from "../src/resources/userDirectories.js";
import { safeSegment } from "../src/shared/safeSegment.js";

describe("safeSegment（shared 唯一出处）", () => {
  it("拒绝目录穿越与非法段", () => {
    for (const bad of ["", "..", "../x", "a/b", "a\\b", ".hidden", "a..b", "a b"]) {
      assert.throws(() => safeSegment(bad), /非法名称/, `应拒绝: ${JSON.stringify(bad)}`);
    }
  });
  it("合法段原样返回", () => {
    assert.equal(safeSegment("run-2026-07-26"), "run-2026-07-26");
    assert.equal(safeSegment("default_user"), "default_user");
  });
});

describe("resolveUserDirectories（default_user，legacy 映射）", () => {
  it("缺省用户名 = default_user（常量唯一出处）", () => {
    assert.equal(DEFAULT_USERNAME, "default_user");
    assert.equal(resolveUserDirectories().username, "default_user");
  });

  it("legacy 路径与 config.ts 常量值等价（单一真相）", () => {
    const dirs = resolveUserDirectories();
    assert.equal(dirs.worldsDir, WORLDS_DIR);
    assert.equal(dirs.runsDir, RUNS_DIR);
    assert.equal(dirs.promptsDir, PROMPTS_DIR);
    assert.equal(runDir("some-run"), path.join(dirs.runsDir, "some-run"));
    assert.equal(path.join(dirs.worldsDir, "baitan"), path.join(WORLDS_DIR, "baitan"));
  });

  it("PROJECT_ROOT 与 config.ts 一致；未来位置在 data/default_user/ 下（仅定义不创建）", () => {
    const dirs = resolveUserDirectories();
    assert.equal(dirs.root, path.join(PROJECT_ROOT, "data", "default_user"));
    assert.equal(dirs.presetsDir, path.join(dirs.root, "api-presets"));
    assert.equal(dirs.secretsFile, path.join(dirs.root, "secrets.json"));
    assert.equal(dirs.settingsFile, path.join(dirs.root, "settings.json"));
  });

  it("自定义 handle 可用；非法 handle 拒绝", () => {
    assert.equal(resolveUserDirectories("alice-2").username, "alice-2");
    assert.equal(resolveUserDirectories("alice-2").root, path.join(PROJECT_ROOT, "data", "alice-2"));
    for (const bad of ["", "..", "../x", "a/b", "a.b", ".x", "a b"]) {
      assert.throws(() => resolveUserDirectories(bad), /非法/, `应拒绝: ${JSON.stringify(bad)}`);
    }
  });
});

describe("ResolvedAgentConfigSchema（对齐 LLMConfig）", () => {
  it("合法解析结果通过（含/不含 reasoningEffort）", () => {
    ResolvedAgentConfigSchema.parse({
      apiKey: "sk-x",
      baseURL: "https://a.example",
      model: "m",
      jsonMode: false,
    });
    ResolvedAgentConfigSchema.parse({
      apiKey: "sk-x",
      baseURL: "https://a.example",
      model: "m",
      jsonMode: true,
      reasoningEffort: "high",
    });
  });
  it("空 key / 缺字段 / 类型错误拒绝", () => {
    assert.throws(() =>
      ResolvedAgentConfigSchema.parse({ apiKey: "", baseURL: "b", model: "m", jsonMode: false }),
    );
    assert.throws(() =>
      ResolvedAgentConfigSchema.parse({ apiKey: "sk", baseURL: "b", model: "m" }),
    );
    assert.throws(() =>
      ResolvedAgentConfigSchema.parse({ apiKey: "sk", baseURL: "b", model: "m", jsonMode: "yes" }),
    );
  });
});

describe("PublicConfigViewSchema / toPublicConfigView（脱敏视图）", () => {
  it("拒绝含明文 key 的对象", () => {
    assert.throws(() => PublicConfigViewSchema.parse({ api_key: "sk-abcdef123456" }));
    assert.throws(() =>
      PublicConfigViewSchema.parse({ agents: { gm: { api_key: "sk-plaintext-key" } } }),
    );
    assert.throws(() => MaskedSecretSchema.parse("sk-abcdef123456"));
  });

  it("掩码视图通过；toPublicConfigView 把明文掩码、其余字段原样", () => {
    const view = toPublicConfigView({
      api_key: "sk-abcdef123456",
      base_url: "https://api.deepseek.com",
      model: "deepseek-chat",
      json_mode: false,
      reasoning_effort: "medium",
      agents: { gm: { api_key: "sk-gm-own-9999", reasoning_effort: "high" } },
      memory: { prose_window_turns: 5 },
      gm_interval_cycles: 3,
    });
    assert.equal(view.api_key, "****3456");
    assert.equal(view.agents?.gm?.api_key, "****9999");
    assert.equal(view.base_url, "https://api.deepseek.com");
    assert.equal(view.agents?.gm?.reasoning_effort, "high");
    assert.equal(view.gm_interval_cycles, 3);
    // 视图内不存在任何明文
    assert.ok(!JSON.stringify(view).includes("sk-"));
  });

  it("maskSecret：短值整体掩码，长值仅留末 4 位", () => {
    assert.equal(maskSecret("abcd"), "****");
    assert.equal(maskSecret("sk-abcdef123456"), "****3456");
  });
});

describe("Server/UserSettings/ApiPreset 契约骨架", () => {
  it("ServerConfigSchema：最小骨架，optional 为主", () => {
    ServerConfigSchema.parse({});
    ServerConfigSchema.parse({ listen: { host: "127.0.0.1", port: 8787 }, allowKeysExposure: false });
    assert.throws(() => ServerConfigSchema.parse({ listen: { port: 70000 } }));
    assert.throws(() => ServerConfigSchema.parse({ allowKeysExposure: "yes" }));
  });

  it("UserSettingsSchema：非法值拒绝", () => {
    UserSettingsSchema.parse({});
    UserSettingsSchema.parse({ proseWindowTurns: 5, pauseOptions: { beforeGm: true } });
    assert.throws(() => UserSettingsSchema.parse({ gmIntervalCycles: 0 }));
  });

  it("ApiPresetSchema：引用 secret 不复制 key", () => {
    ApiPresetSchema.parse({
      id: "p1",
      name: "DeepSeek 主",
      provider: "deepseek",
      baseUrl: "https://api.deepseek.com",
      model: "deepseek-chat",
      secretKind: "deepseek",
    });
    assert.throws(() =>
      ApiPresetSchema.parse({ id: "p", name: "n", provider: "p", baseUrl: "b", model: "m", secretKind: "bad kind" }),
    );
  });
});

describe("Secrets 契约", () => {
  it("SecretsFileSchema：同 kind 至多一条 active；id 不得重复", () => {
    SecretsFileSchema.parse({
      deepseek: [
        { id: "s1", value: "sk-a", label: "主", active: true },
        { id: "s2", value: "sk-b", label: "备", active: false },
      ],
    });
    assert.throws(() =>
      SecretsFileSchema.parse({
        deepseek: [
          { id: "s1", value: "sk-a", label: "一", active: true },
          { id: "s2", value: "sk-b", label: "二", active: true },
        ],
      }),
    );
    assert.throws(() =>
      SecretsFileSchema.parse({
        deepseek: [
          { id: "s1", value: "sk-a", label: "一", active: true },
          { id: "s1", value: "sk-b", label: "二", active: false },
        ],
      }),
    );
  });

  it("SecretMutationSchema：各分支合法 fixture", () => {
    SecretMutationSchema.parse({ type: "write", kind: "deepseek", value: "sk-x", label: "主" });
    SecretMutationSchema.parse({ type: "delete", kind: "deepseek", id: "s1" });
    SecretMutationSchema.parse({ type: "activate", kind: "deepseek", id: "s1" });
    SecretMutationSchema.parse({ type: "rotate", kind: "deepseek", id: "s1" });
    SecretMutationSchema.parse({ type: "rename", kind: "deepseek", id: "s1", label: "新名" });
  });

  it("SecretMutationSchema：非法 fixture 拒绝", () => {
    assert.throws(() => SecretMutationSchema.parse({ type: "write", kind: "deepseek", value: "", label: "主" }));
    assert.throws(() => SecretMutationSchema.parse({ type: "delete", kind: "deepseek" }));
    assert.throws(() => SecretMutationSchema.parse({ type: "rename", kind: "deepseek", id: "s1" }));
    assert.throws(() => SecretMutationSchema.parse({ type: "wipe", kind: "deepseek", id: "s1" }));
    assert.throws(() => SecretMutationSchema.parse({ type: "activate", kind: "bad kind", id: "s1" }));
  });
});
