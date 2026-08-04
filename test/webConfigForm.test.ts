/**
 * web/views/config-form.js 单元测试（unit 层）：
 * 零 IO 纯逻辑——patch/payload 构造语义：
 * - settings patch：留空字段不出现（保持不变）、非法值（非整数/越界）拒构造；
 * - 掩码防呆：形如服务端掩码（"****3456" / 含 "…"）的值一律拒构造抛错；
 * - preset payload：必填校验、jsonMode 三态（留空省略/true/false）、secretId 留空省略、
 *   编辑模式携带 id；
 * - agent 绑定 patch：agentPresets 整体替换（未选 key 不出现 = 解绑）。
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  buildAgentPresetsPatch,
  buildPresetPayload,
  buildSecretRenameBody,
  buildSecretWriteBody,
  buildSettingsPatch,
  isMaskedValue,
} from "../web/views/config-form.js";

describe("isMaskedValue 掩码特征判定", () => {
  it("识别服务端掩码形状与放宽特征", () => {
    assert.equal(isMaskedValue("****3456"), true); // 服务端掩码
    assert.equal(isMaskedValue("****"), true); // 短值整体掩码
    assert.equal(isMaskedValue("sk-…9f"), true); // 省略号特征
    assert.equal(isMaskedValue("abcdef****xx"), true); // 任意位置的连续 4 星
    assert.equal(isMaskedValue("sk-realkey1234567890"), false);
    assert.equal(isMaskedValue("a***b"), false); // 3 星不算
    assert.equal(isMaskedValue(""), false);
    assert.equal(isMaskedValue(undefined), false);
    assert.equal(isMaskedValue(42), false);
  });
});

describe("buildSecretWriteBody 新增密钥", () => {
  it("构造 {kind, value, label}，kind 缺省 deepseek", () => {
    assert.deepEqual(buildSecretWriteBody({ label: " 主力 ", value: " sk-abc " }), {
      kind: "deepseek",
      value: "sk-abc",
      label: "主力",
    });
  });

  it("掩码值拒构造（防止把公共视图的掩码写回成新 key）", () => {
    assert.throws(() => buildSecretWriteBody({ label: "x", value: "****3456" }), /掩码/);
    assert.throws(() => buildSecretWriteBody({ label: "x", value: "sk-…9f" }), /掩码/);
  });

  it("空值/空标签拒构造", () => {
    assert.throws(() => buildSecretWriteBody({ label: "x", value: "  " }), /密钥值不能为空/);
    assert.throws(() => buildSecretWriteBody({ label: " ", value: "sk-abc" }), /密钥标签不能为空/);
  });
});

describe("buildSecretRenameBody 重命名", () => {
  it("构造 {label}；空标签拒构造", () => {
    assert.deepEqual(buildSecretRenameBody({ label: " 备用 key " }), { label: "备用 key" });
    assert.throws(() => buildSecretRenameBody({ label: "" }), /密钥标签不能为空/);
  });
});

describe("buildPresetPayload 预设表单 → payload", () => {
  const base = {
    name: "ds-chat",
    provider: "deepseek",
    baseUrl: "https://api.deepseek.com",
    model: "deepseek-chat",
  };

  it("新建：id/secretId/jsonMode/reasoningEffort 留空一律省略", () => {
    const payload = buildPresetPayload({ ...base, secretId: "", jsonMode: "", reasoningEffort: " " });
    assert.deepEqual(payload, { ...base, secretKind: "deepseek" });
  });

  it("编辑模式携带 id；secretId/jsonMode/reasoningEffort 有值即带上", () => {
    const payload = buildPresetPayload({
      ...base,
      id: "p1",
      secretId: "s9",
      jsonMode: "true",
      reasoningEffort: "high",
    });
    assert.deepEqual(payload, {
      ...base,
      id: "p1",
      secretKind: "deepseek",
      secretId: "s9",
      jsonMode: true,
      reasoningEffort: "high",
    });
  });

  it("jsonMode 三态：留空省略 / true 开 / false 显式关", () => {
    assert.equal(buildPresetPayload({ ...base, jsonMode: "" }).jsonMode, undefined);
    assert.equal(buildPresetPayload({ ...base, jsonMode: "true" }).jsonMode, true);
    assert.equal(buildPresetPayload({ ...base, jsonMode: "false" }).jsonMode, false);
    assert.equal(buildPresetPayload({ ...base, jsonMode: true }).jsonMode, true);
    assert.equal(buildPresetPayload({ ...base, jsonMode: false }).jsonMode, false);
  });

  it("必填字段为空拒构造", () => {
    for (const key of ["name", "provider", "baseUrl", "model"]) {
      assert.throws(() => buildPresetPayload({ ...base, [key]: " " }), /不能为空/);
    }
  });

  it("掩码值出现在任意字段即拒构造", () => {
    assert.throws(() => buildPresetPayload({ ...base, baseUrl: "https://****" }), /掩码/);
    assert.throws(() => buildPresetPayload({ ...base, secretId: "****3456" }), /掩码/);
    assert.throws(() => buildPresetPayload({ ...base, reasoningEffort: "h…" }), /掩码/);
  });
});

describe("buildAgentPresetsPatch 绑定 patch", () => {
  it("只带选中的 activation；整体替换语义（未选 = 解绑）", () => {
    assert.deepEqual(buildAgentPresetsPatch({ character: "p1", gm: "", prose: "p2" }), {
      agentPresets: { character: "p1", prose: "p2" },
    });
  });

  it("全部未选 → agentPresets 空表（全解绑）", () => {
    assert.deepEqual(buildAgentPresetsPatch({ character: "", gm: "", prose: "" }), {
      agentPresets: {},
    });
  });
});

describe("buildSettingsPatch 运行设置 patch", () => {
  it("留空字段不出现（保持不变）", () => {
    assert.deepEqual(buildSettingsPatch({ proseWindowTurns: "", gmIntervalCycles: " " }), {});
    assert.deepEqual(buildSettingsPatch({ proseWindowTurns: "8", gmIntervalCycles: "" }), {
      proseWindowTurns: 8,
    });
    assert.deepEqual(buildSettingsPatch({ proseWindowTurns: "0", gmIntervalCycles: "3" }), {
      proseWindowTurns: 0,
      gmIntervalCycles: 3,
    });
  });

  it("非法值拒构造（对齐旧页校验：gm_interval ≥1 整数）", () => {
    assert.throws(() => buildSettingsPatch({ gmIntervalCycles: "0" }), /GM 强制间隔必须是 ≥1 的整数/);
    assert.throws(() => buildSettingsPatch({ gmIntervalCycles: "1.5" }), /GM 强制间隔/);
    assert.throws(() => buildSettingsPatch({ gmIntervalCycles: "abc" }), /GM 强制间隔/);
    assert.throws(() => buildSettingsPatch({ proseWindowTurns: "-1" }), /正文滑窗轮数必须是 ≥0 的整数/);
    assert.throws(() => buildSettingsPatch({ proseWindowTurns: "2.5" }), /正文滑窗轮数/);
  });
});
