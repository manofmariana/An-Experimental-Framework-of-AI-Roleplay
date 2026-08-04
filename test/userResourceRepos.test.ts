/**
 * 用户资源仓储文件 codec（contract 层：临时目录文件 IO，不起服务）。
 * 三仓储：secrets/settings 单文件原子读写 + presets 逐文件 CRUD/duplicate；
 * 缺文件默认、损坏 JSON 类型化错误、preset id 路径穿越拒绝。
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { describe, it } from "node:test";
import type { ApiPreset } from "../src/contracts/config.js";
import {
  PresetsRepositoryError,
  deletePreset,
  duplicatePreset,
  listPresets,
  loadPreset,
  savePreset,
} from "../src/resources/presetsRepository.js";
import {
  SecretsRepositoryError,
  readSecretsFile,
  writeSecretsFile,
} from "../src/resources/secretsRepository.js";
import {
  SettingsRepositoryError,
  readSettings,
  writeSettings,
} from "../src/resources/settingsRepository.js";
import { tempDir } from "./harness/tempDir.js";

const preset = (id: string, over: Partial<ApiPreset> = {}): ApiPreset => ({
  id,
  name: `预设 ${id}`,
  provider: "deepseek",
  baseUrl: "https://example.com/v1",
  model: "model-x",
  secretKind: "deepseek",
  ...over,
});

describe("secretsRepository：secrets.json 文件 codec", () => {
  it("缺文件 = 空 SecretsFile", () => {
    const dir = tempDir("airp-secrets-");
    assert.deepEqual(readSecretsFile(path.join(dir, "secrets.json")), {});
  });

  it("写读回环；原子写不留 .tmp 残留；父目录自动创建", () => {
    const dir = tempDir("airp-secrets-");
    const file = path.join(dir, "nested", "secrets.json");
    const data = {
      deepseek: [{ id: "a", value: "sk-123456", label: "主", active: true }],
    };
    writeSecretsFile(file, data);
    assert.deepEqual(readSecretsFile(file), data);
    assert.equal(fs.existsSync(`${file}.tmp`), false);
  });

  it("损坏 JSON / 契约不符（多条 active）→ SECRETS_CORRUPT", () => {
    const dir = tempDir("airp-secrets-");
    const file = path.join(dir, "secrets.json");
    fs.writeFileSync(file, "{not json", "utf8");
    assert.throws(
      () => readSecretsFile(file),
      (err: unknown) => err instanceof SecretsRepositoryError && err.code === "SECRETS_CORRUPT",
    );
    fs.writeFileSync(
      file,
      JSON.stringify({
        deepseek: [
          { id: "a", value: "v1", label: "l", active: true },
          { id: "b", value: "v2", label: "l", active: true },
        ],
      }),
      "utf8",
    );
    assert.throws(
      () => readSecretsFile(file),
      (err: unknown) => err instanceof SecretsRepositoryError && err.code === "SECRETS_CORRUPT",
    );
  });
});

describe("presetsRepository：api-presets/{id}.json 逐文件", () => {
  it("list：目录不存在 = 空；按 id 字典序", () => {
    const dir = tempDir("airp-presets-");
    assert.deepEqual(listPresets(path.join(dir, "api-presets")), []);
    savePreset(path.join(dir, "api-presets"), preset("b"));
    savePreset(path.join(dir, "api-presets"), preset("a"));
    assert.deepEqual(
      listPresets(path.join(dir, "api-presets")).map((p) => p.id),
      ["a", "b"],
    );
  });

  it("save/load/delete 回环；原子写不留 .tmp", () => {
    const dir = tempDir("airp-presets-");
    const dirP = path.join(dir, "api-presets");
    savePreset(dirP, preset("p1", { jsonMode: true, reasoningEffort: "high" }));
    const loaded = loadPreset(dirP, "p1");
    assert.equal(loaded.jsonMode, true);
    assert.equal(loaded.reasoningEffort, "high");
    assert.equal(fs.existsSync(path.join(dirP, "p1.json.tmp")), false);
    deletePreset(dirP, "p1");
    assert.throws(
      () => loadPreset(dirP, "p1"),
      (err: unknown) => err instanceof PresetsRepositoryError && err.code === "PRESET_NOT_FOUND",
    );
    assert.throws(
      () => deletePreset(dirP, "p1"),
      (err: unknown) => err instanceof PresetsRepositoryError && err.code === "PRESET_NOT_FOUND",
    );
  });

  it("损坏 JSON / 文件内 id 与文件名不一致 → PRESET_CORRUPT", () => {
    const dir = tempDir("airp-presets-");
    const dirP = path.join(dir, "api-presets");
    fs.mkdirSync(dirP, { recursive: true });
    fs.writeFileSync(path.join(dirP, "bad.json"), "{not json", "utf8");
    assert.throws(
      () => loadPreset(dirP, "bad"),
      (err: unknown) => err instanceof PresetsRepositoryError && err.code === "PRESET_CORRUPT",
    );
    fs.writeFileSync(
      path.join(dirP, "mismatch.json"),
      JSON.stringify(preset("other-id")),
      "utf8",
    );
    assert.throws(
      () => listPresets(dirP),
      (err: unknown) => err instanceof PresetsRepositoryError && err.code === "PRESET_CORRUPT",
    );
  });

  it("路径穿越 id 一律拒绝（load/save/delete）→ INVALID_PRESET_ID", () => {
    const dir = tempDir("airp-presets-");
    const dirP = path.join(dir, "api-presets");
    for (const bad of ["../escape", "a/b", "..", ".hidden", ""]) {
      assert.throws(
        () => loadPreset(dirP, bad),
        (err: unknown) =>
          err instanceof PresetsRepositoryError && err.code === "INVALID_PRESET_ID",
      );
      assert.throws(
        () => savePreset(dirP, preset(bad)),
        (err: unknown) =>
          err instanceof PresetsRepositoryError && err.code === "INVALID_PRESET_ID",
      );
      assert.throws(
        () => deletePreset(dirP, bad),
        (err: unknown) =>
          err instanceof PresetsRepositoryError && err.code === "INVALID_PRESET_ID",
      );
    }
    // 穿越尝试不触及目录外
    assert.equal(fs.existsSync(path.join(dir, "escape.json")), false);
  });

  it("save 载荷契约不符 → INVALID_PRESET（不落盘）", () => {
    const dir = tempDir("airp-presets-");
    const dirP = path.join(dir, "api-presets");
    assert.throws(
      () => savePreset(dirP, { ...preset("p1"), model: "" }),
      (err: unknown) => err instanceof PresetsRepositoryError && err.code === "INVALID_PRESET",
    );
    assert.equal(fs.existsSync(path.join(dirP, "p1.json")), false);
  });

  it("duplicate：新 id + 名称加「 (副本)」，其余字段原样，可立即 load", () => {
    const dir = tempDir("airp-presets-");
    const dirP = path.join(dir, "api-presets");
    savePreset(dirP, preset("p1", { secretId: "s1", parameters: { temperature: 0.7 } }));
    let n = 0;
    const copy = duplicatePreset(dirP, "p1", () => `copy-${++n}`);
    assert.equal(copy.id, "copy-1");
    assert.equal(copy.name, "预设 p1 (副本)");
    assert.equal(copy.secretId, "s1");
    assert.deepEqual(copy.parameters, { temperature: 0.7 });
    assert.deepEqual(loadPreset(dirP, "copy-1"), copy);
    assert.throws(
      () => duplicatePreset(dirP, "nope"),
      (err: unknown) => err instanceof PresetsRepositoryError && err.code === "PRESET_NOT_FOUND",
    );
  });
});

describe("settingsRepository：settings.json 文件 codec", () => {
  it("缺文件 = 默认空设置（configRevision 0）", () => {
    const dir = tempDir("airp-settings-");
    assert.deepEqual(readSettings(path.join(dir, "settings.json")), { configRevision: 0 });
  });

  it("写读回环（agentPresets/pauseOptions/configRevision）", () => {
    const dir = tempDir("airp-settings-");
    const file = path.join(dir, "settings.json");
    const data = {
      configRevision: 3,
      proseWindowTurns: 8,
      gmIntervalCycles: 2,
      pauseOptions: { beforeGm: true },
      agentPresets: { character: "p1", gm: "p2", prose: "p1" },
    };
    writeSettings(file, data);
    assert.deepEqual(readSettings(file), data);
    assert.equal(fs.existsSync(`${file}.tmp`), false);
  });

  it("损坏 JSON / 契约不符（负 configRevision）→ SETTINGS_CORRUPT", () => {
    const dir = tempDir("airp-settings-");
    const file = path.join(dir, "settings.json");
    fs.writeFileSync(file, "{not json", "utf8");
    assert.throws(
      () => readSettings(file),
      (err: unknown) =>
        err instanceof SettingsRepositoryError && err.code === "SETTINGS_CORRUPT",
    );
    fs.writeFileSync(file, JSON.stringify({ configRevision: -1 }), "utf8");
    assert.throws(
      () => readSettings(file),
      (err: unknown) =>
        err instanceof SettingsRepositoryError && err.code === "SETTINGS_CORRUPT",
    );
  });
});
