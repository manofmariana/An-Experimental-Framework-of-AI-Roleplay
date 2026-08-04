import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  AGENT_KINDS,
  DEFAULT_WORLD_SET,
  listWorldSets,
  resolveWorldDir,
} from "../src/config.js";
import { resolveAgentConfigs } from "./harness/legacyConfigResolver.js";

const NO_ENV: NodeJS.ProcessEnv = {};

describe("resolveAgentConfigs（旧 config.json 分层解析语义，迁移对拍基准）", () => {
  it("无 agents 块时三个 agent 全部回落到顶层", () => {
    const configs = resolveAgentConfigs(
      { api_key: "sk-top", base_url: "https://a.example", model: "m-top" },
      NO_ENV,
    )!;
    for (const kind of AGENT_KINDS) {
      assert.deepEqual(configs[kind], {
        apiKey: "sk-top",
        baseURL: "https://a.example",
        model: "m-top",
        jsonMode: false,
      });
    }
  });

  it("agent 块逐字段覆盖，缺省字段回落顶层", () => {
    const configs = resolveAgentConfigs(
      {
        api_key: "sk-top",
        base_url: "https://a.example",
        model: "m-top",
        agents: {
          character: { model: "m-char" },
          gm: { api_key: "sk-gm", base_url: "https://gm.example", model: "m-gm" },
          prose: {},
        },
      },
      NO_ENV,
    )!;
    assert.deepEqual(configs.character, {
      apiKey: "sk-top",
      baseURL: "https://a.example",
      model: "m-char",
      jsonMode: false,
    });
    assert.deepEqual(configs.gm, {
      apiKey: "sk-gm",
      baseURL: "https://gm.example",
      model: "m-gm",
      jsonMode: false,
    });
    assert.deepEqual(configs.prose, {
      apiKey: "sk-top",
      baseURL: "https://a.example",
      model: "m-top",
      jsonMode: false,
    });
  });

  it("环境变量覆盖顶层（无独立 key 的 agent 用 env 的 key）", () => {
    const configs = resolveAgentConfigs(
      { api_key: "sk-file", model: "m-file", agents: { gm: { model: "m-gm" } } },
      { DEEPSEEK_API_KEY: "sk-env", DEEPSEEK_MODEL: "m-env" },
    )!;
    assert.equal(configs.character.apiKey, "sk-env");
    assert.equal(configs.gm.apiKey, "sk-env");
    // model：agent 块优先；其余 agent 用 env 覆盖后的顶层
    assert.equal(configs.gm.model, "m-gm");
    assert.equal(configs.character.model, "m-env");
  });

  it("agent 块自己的 key 不受环境变量影响", () => {
    const configs = resolveAgentConfigs(
      { api_key: "sk-file", agents: { gm: { api_key: "sk-gm-own" } } },
      { DEEPSEEK_API_KEY: "sk-env" },
    )!;
    assert.equal(configs.gm.apiKey, "sk-gm-own");
    assert.equal(configs.character.apiKey, "sk-env");
    assert.equal(configs.prose.apiKey, "sk-env");
  });

  it("base_url / model 缺省值", () => {
    const configs = resolveAgentConfigs({ api_key: "sk-x" }, NO_ENV)!;
    for (const kind of AGENT_KINDS) {
      assert.equal(configs[kind].baseURL, "https://api.deepseek.com");
      assert.equal(configs[kind].model, "deepseek-chat");
    }
  });

  it("任何来源都没有 api key 时返回 null", () => {
    assert.equal(resolveAgentConfigs({}, NO_ENV), null);
    assert.equal(resolveAgentConfigs({ model: "m" }, NO_ENV), null);
  });
});

describe("json_mode / reasoning_effort 分层解析（DeepSeek 场景）", () => {
  it("缺省：jsonMode=false，reasoningEffort 缺省不显式出现", () => {
    const configs = resolveAgentConfigs({ api_key: "sk-x" }, NO_ENV)!;
    for (const kind of AGENT_KINDS) {
      assert.equal(configs[kind].jsonMode, false);
      assert.equal("reasoningEffort" in configs[kind], false);
    }
  });

  it("顶层默认：三个 agent 都继承顶层 json_mode / reasoning_effort", () => {
    const configs = resolveAgentConfigs(
      { api_key: "sk-x", json_mode: true, reasoning_effort: "high" },
      NO_ENV,
    )!;
    for (const kind of AGENT_KINDS) {
      assert.equal(configs[kind].jsonMode, true);
      assert.equal(configs[kind].reasoningEffort, "high");
    }
  });

  it("agent 块覆盖优先，缺省字段回落顶层；reasoning_effort 原样透传不锁枚举", () => {
    const configs = resolveAgentConfigs(
      {
        api_key: "sk-x",
        json_mode: true,
        reasoning_effort: "medium",
        agents: {
          character: { json_mode: false },
          gm: { reasoning_effort: "minimal" },
          prose: { json_mode: false, reasoning_effort: "high" },
        },
      },
      NO_ENV,
    )!;
    assert.equal(configs.character.jsonMode, false);
    assert.equal(configs.character.reasoningEffort, "medium");
    assert.equal(configs.gm.jsonMode, true);
    assert.equal(configs.gm.reasoningEffort, "minimal");
    assert.equal(configs.prose.jsonMode, false);
    assert.equal(configs.prose.reasoningEffort, "high");
  });
});

describe("世界设定集（data/assets）", () => {
  it("listWorldSets 含示例集 baitan", () => {
    assert.ok(listWorldSets().includes("baitan"));
  });

  it("resolveWorldDir：缺省回落默认集；非法/不存在拒绝", () => {
    assert.ok(resolveWorldDir().endsWith(DEFAULT_WORLD_SET));
    assert.ok(resolveWorldDir("baitan").endsWith("baitan"));
    assert.throws(() => resolveWorldDir("../etc"), /非法/);
    assert.throws(() => resolveWorldDir("no-such-set"), /不存在/);
  });
});
