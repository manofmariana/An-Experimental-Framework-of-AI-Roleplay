/**
 * 配置事务测试（application 层：临时目录真实文件系统 + 注入 applyResolved 热应用回调）。
 *
 * 覆盖「配置事务」全流程：
 * - patch → 解析三 activation → 原子保存 → 同一 resolved 对象热应用 → 返回新 configRevision；
 * - baseConfigRevision 不符 → CONFIG_REVISION_CONFLICT（HTTP 409 语义），零副作用；
 * - 解析失败（CONFIG_INVALID）→ 零落盘；
 * - 热应用抛错 → 回写旧资源文件 + CONFIG_APPLY_FAILED（不声称已生效）；
 * - secret/preset 各 mutation 经事务落盘；preset 被绑定拒删（PRESET_IN_USE）；
 * - configRevision 与游戏 Generation revision 完全分离（settings.json 顶层自增）。
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { describe, it } from "node:test";
import {
  applyConfigMutation,
  ConfigRevisionConflictError,
  ConfigServiceError,
  loadConfigState,
  type ConfigServiceDeps,
} from "../src/application/configService.js";
import type { AgentKind } from "../src/configResolver.js";
import type { ResolvedAgentConfig, UserSettings } from "../src/contracts/config.js";
import {
  SecretsRepositoryError,
  readSecretsFile,
  writeSecretsFile,
} from "../src/resources/secretsRepository.js";
import { listPresets, savePreset } from "../src/resources/presetsRepository.js";
import { readSettings, writeSettings } from "../src/resources/settingsRepository.js";
import type { UserDirectories } from "../src/resources/userDirectories.js";
import { tempDir } from "./harness/tempDir.js";

const NO_ENV: Record<string, string | undefined> = {};

interface Harness {
  deps: ConfigServiceDeps;
  applied: { resolved: Record<AgentKind, ResolvedAgentConfig>; settings: UserSettings }[];
}

/** 造一个已就位的配置基线：两条 secret（s1 active）+ p1（三 agent 绑定）/p2（未绑定）。 */
function makeHarness(options?: { throwOnApply?: boolean }): Harness {
  const root = tempDir("airp-cfgsvc-");
  const dirs: UserDirectories = {
    username: "test_user",
    root,
    assetsDir: path.join(root, "assets"),
    saveDir: path.join(root, "save"),
    presetsDir: path.join(root, "api-presets"),
    secretsFile: path.join(root, "secrets.json"),
    settingsFile: path.join(root, "settings.json"),
  };
  writeSecretsFile(dirs.secretsFile, {
    deepseek: [
      { id: "s1", value: "sk-live-0001", label: "主", active: true },
      { id: "s2", value: "sk-backup-0002", label: "备", active: false },
    ],
  });
  const preset = {
    name: "主预设",
    provider: "deepseek",
    baseUrl: "https://api.deepseek.com",
    model: "deepseek-chat",
    secretKind: "deepseek",
  };
  savePreset(dirs.presetsDir, { id: "p1", ...preset });
  savePreset(dirs.presetsDir, { id: "p2", ...preset, name: "备用预设", model: "m-backup" });
  writeSettings(dirs.settingsFile, {
    configRevision: 0,
    agentPresets: { character: "p1", gm: "p1", prose: "p1" },
    proseWindowTurns: 5,
  });

  const applied: Harness["applied"] = [];
  let idCounter = 0;
  const deps: ConfigServiceDeps = {
    dirs,
    env: NO_ENV,
    legacyConfigFile: path.join(root, "config.json"), // 不存在：无迁移
    generateId: () => `gen-${++idCounter}`,
    applyResolved: (resolved, settings) => {
      if (options?.throwOnApply === true) throw new Error("注入的热应用故障");
      applied.push({ resolved, settings });
    },
  };
  return { deps, applied };
}

/** 当前磁盘整态快照（回滚/零落盘断言用）。 */
function diskSnapshot(deps: ConfigServiceDeps): string {
  return JSON.stringify({
    secrets: fs.readFileSync(deps.dirs.secretsFile, "utf8"),
    settings: fs.readFileSync(deps.dirs.settingsFile, "utf8"),
    presets: fs
      .readdirSync(deps.dirs.presetsDir)
      .sort()
      .map((f) => [f, fs.readFileSync(path.join(deps.dirs.presetsDir, f), "utf8")]),
  });
}

describe("applyConfigMutation：正常事务", () => {
  it("settings patch → 保存 → 热应用收到同一份 resolved/settings → configRevision+1", () => {
    const { deps, applied } = makeHarness();
    const result = applyConfigMutation(
      deps,
      { domain: "settings", patch: { proseWindowTurns: 9 } },
      0,
    );
    assert.equal(result.configRevision, 1);
    assert.equal(result.view.settings.proseWindowTurns, 9);
    assert.equal(result.view.settings.configRevision, 1);

    // 落盘
    assert.equal(readSettings(deps.dirs.settingsFile).configRevision, 1);
    assert.equal(readSettings(deps.dirs.settingsFile).proseWindowTurns, 9);

    // 热应用恰一次，resolved 内容 = 落盘后再解析（同一份对象的语义：事务只解析一次）
    assert.equal(applied.length, 1);
    assert.equal(applied[0]!.settings.configRevision, 1);
    assert.equal(applied[0]!.resolved.character.apiKey, "sk-live-0001");
    assert.deepEqual(applied[0]!.resolved, loadConfigState(deps).resolved);
  });

  it("secret rotate 经事务：active 切换，热应用收到新 key，视图只出掩码", () => {
    const { deps, applied } = makeHarness();
    const result = applyConfigMutation(
      deps,
      { domain: "secret", mutation: { type: "rotate", kind: "deepseek", id: "s1" } },
      0,
    );
    assert.equal(result.configRevision, 1);
    const records = result.view.secrets["deepseek"]!;
    assert.equal(records.find((r) => r.id === "s2")!.active, true);
    assert.equal(records.find((r) => r.id === "s2")!.maskedValue, "****0002");
    assert.ok(!JSON.stringify(result.view).includes("sk-backup-0002"));
    assert.equal(applied[0]!.resolved.gm.apiKey, "sk-backup-0002"); // p1 无 secretId → 跟 active
  });

  it("preset duplicate/save/delete 经事务；删除未绑定 preset 成功", () => {
    const { deps } = makeHarness();
    const dup = applyConfigMutation(deps, { domain: "preset", mutation: { type: "duplicate", id: "p2" } }, 0);
    assert.equal(dup.configRevision, 1);
    const copy = dup.view.presets.find((p) => p.id === "gen-1")!;
    assert.equal(copy.name, "备用预设 (副本)");
    assert.ok(fs.existsSync(path.join(deps.dirs.presetsDir, "gen-1.json")));

    // save upsert：改 p2 的 model
    const saved = applyConfigMutation(
      deps,
      { domain: "preset", mutation: { type: "save", preset: { ...copy, id: "p2", model: "m-new" } } },
      1,
    );
    assert.equal(saved.view.presets.find((p) => p.id === "p2")!.model, "m-new");

    // 删除未绑定的副本
    const after = applyConfigMutation(deps, { domain: "preset", mutation: { type: "delete", id: "gen-1" } }, 2);
    assert.ok(!after.view.presets.some((p) => p.id === "gen-1"));
    assert.ok(!fs.existsSync(path.join(deps.dirs.presetsDir, "gen-1.json")));
  });
});

describe("applyConfigMutation：失败路径", () => {
  it("baseConfigRevision 不符 → CONFIG_REVISION_CONFLICT（附双值），零副作用", () => {
    const { deps, applied } = makeHarness();
    const before = diskSnapshot(deps);
    assert.throws(
      () => applyConfigMutation(deps, { domain: "settings", patch: { proseWindowTurns: 9 } }, 5),
      (err: unknown) => {
        assert.ok(err instanceof ConfigRevisionConflictError);
        assert.equal(err.code, "CONFIG_REVISION_CONFLICT");
        assert.deepEqual(err.details, { baseConfigRevision: 5, currentConfigRevision: 0 });
        return true;
      },
    );
    assert.equal(applied.length, 0);
    assert.equal(diskSnapshot(deps), before);
  });

  it("解析失败（绑定不存在的 preset）→ CONFIG_INVALID，零落盘", () => {
    const { deps, applied } = makeHarness();
    const before = diskSnapshot(deps);
    assert.throws(
      () =>
        applyConfigMutation(
          deps,
          { domain: "settings", patch: { agentPresets: { character: "p1", gm: "nope", prose: "p1" } } },
          0,
        ),
      (err: unknown) => err instanceof ConfigServiceError && err.code === "CONFIG_INVALID",
    );
    assert.equal(applied.length, 0);
    assert.equal(diskSnapshot(deps), before);
  });

  it("解析失败（删除最后一把 key）→ CONFIG_INVALID，secrets.json 原样", () => {
    const { deps, applied } = makeHarness();
    applyConfigMutation(deps, { domain: "secret", mutation: { type: "delete", kind: "deepseek", id: "s1" } }, 0);
    const before = diskSnapshot(deps);
    assert.throws(
      () => applyConfigMutation(deps, { domain: "secret", mutation: { type: "delete", kind: "deepseek", id: "s2" } }, 1),
      (err: unknown) => err instanceof ConfigServiceError && err.code === "CONFIG_INVALID",
    );
    assert.equal(applied.length, 1); // 仅第一次成功事务热应用过
    assert.equal(diskSnapshot(deps), before);
  });

  it("热应用抛错 → 回写旧资源文件 + CONFIG_APPLY_FAILED（不声称已生效）", () => {
    const { deps } = makeHarness({ throwOnApply: true });
    const before = diskSnapshot(deps);
    assert.throws(
      () => applyConfigMutation(deps, { domain: "settings", patch: { proseWindowTurns: 9 } }, 0),
      (err: unknown) => {
        assert.ok(err instanceof ConfigServiceError);
        assert.equal(err.code, "CONFIG_APPLY_FAILED");
        assert.match(err.message, /热应用失败/);
        assert.match(err.message, /注入的热应用故障/);
        return true;
      },
    );
    assert.equal(diskSnapshot(deps), before, "资源文件必须回滚到事务前");
    assert.equal(loadConfigState(deps).configRevision, 0);
  });

  it("被任一 agent 绑定的 preset 拒删 → PRESET_IN_USE；不存在的 preset → PRESET_NOT_FOUND", () => {
    const { deps } = makeHarness();
    const before = diskSnapshot(deps);
    assert.throws(
      () => applyConfigMutation(deps, { domain: "preset", mutation: { type: "delete", id: "p1" } }, 0),
      (err: unknown) => err instanceof ConfigServiceError && err.code === "PRESET_IN_USE",
    );
    assert.throws(
      () => applyConfigMutation(deps, { domain: "preset", mutation: { type: "delete", id: "nope" } }, 0),
      /preset 不存在/,
    );
    assert.equal(diskSnapshot(deps), before);
  });

  it("不存在的 secret → SECRET_NOT_FOUND（仓储错误透传，HTTP 层映射 404）", () => {
    const { deps } = makeHarness();
    assert.throws(
      () => applyConfigMutation(deps, { domain: "secret", mutation: { type: "activate", kind: "deepseek", id: "nope" } }, 0),
      (err: unknown) => err instanceof SecretsRepositoryError && err.code === "SECRET_NOT_FOUND",
    );
  });
});

describe("loadConfigState：无迁移直入", () => {
  it("读三资源 → resolved + 脱敏视图 + configRevision；secrets.json 存在时 legacyConfigFile 不动", () => {
    const { deps } = makeHarness();
    fs.writeFileSync(deps.legacyConfigFile, JSON.stringify({ api_key: "sk-legacy" }), "utf8");
    const state = loadConfigState(deps);
    assert.equal(state.configRevision, 0);
    assert.equal(state.resolved!.prose.apiKey, "sk-live-0001");
    assert.ok(fs.existsSync(deps.legacyConfigFile), "secrets.json 已存在 → 不触发迁移");
    // 视图与磁盘一致（掩码态）
    assert.deepEqual(
      Object.keys(state.view.secrets),
      Object.keys(readSecretsFile(deps.dirs.secretsFile)),
    );
    assert.equal(state.view.presets.length, listPresets(deps.dirs.presetsDir).length);
  });
});
