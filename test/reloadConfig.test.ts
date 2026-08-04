import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { OpenAIChatAdapter } from "../src/llm/openaiChatAdapter.js";
import { createGameSession } from "../src/application/sessionFactory.js";
import type { LLMConfig } from "../src/config.js";
import { SessionHarness } from "./harness/session.js";

// ---------------------------------------------------------------------------
// reloadConfig 链路：OpenAIChatAdapter.updateConfig + GameSession.applyResolvedConfigs
// （reloadConfig() 本身只负责读全局 CONFIG_FILE 后调注入方法，故测注入方法）
// 基建 = SessionHarness（临时世界设定集）；会话走真实 adapter 路径——
// sessionOptions 基座显式 delete chatPorts（注入 fake 会跳过 OpenAIChatAdapter 构造）。
// ---------------------------------------------------------------------------

const h = new SessionHarness("airp-reload-config-");

const cfgA: LLMConfig = { apiKey: "sk-a", baseURL: "http://127.0.0.1:9/a", model: "m-a", jsonMode: false };
const cfgB: LLMConfig = {
  apiKey: "sk-b",
  baseURL: "http://127.0.0.1:9/b",
  model: "m-b",
  jsonMode: true,
  reasoningEffort: "high",
};

/** 私有字段读取（测试专用收窄，模式同 abort.test.ts）。 */
function priv<T>(obj: unknown, key: string): T {
  return (obj as never as Record<string, T>)[key]!;
}

describe("OpenAIChatAdapter.updateConfig（热更新：原地换配置）", () => {
  it("apiKey/baseURL/model/jsonMode/reasoningEffort 全部换到新值", () => {
    const adapter = new OpenAIChatAdapter(cfgA);
    assert.equal(priv<LLMConfig>(adapter, "config").model, "m-a");
    adapter.updateConfig(cfgB);
    const config = priv<LLMConfig>(adapter, "config");
    assert.deepEqual(config, cfgB);
    // 底层 OpenAI 实例已重建（baseURL 跟随新配置）
    assert.equal(priv<{ baseURL: string }>(adapter, "openai").baseURL, "http://127.0.0.1:9/b");
  });
});

describe("GameSession.applyResolvedConfigs（设置页保存即生效的可注入核心）", () => {
  it("三个 OpenAI adapter 换配置；proseWindowTurns / gmIntervalCycles 字段更新", () => {
    const worldId = `w-reload-${process.pid}`;
    h.setupWorld(worldId, [
      { id: "C0", name: "玩家", location: "灯塔", timer: null, isPlayer: true },
      { id: "C1001", name: "甲", location: "灯塔", timer: 5 },
    ]);
    const runId = `test-reload-${process.pid}`;
    const options = h.sessionOptions(runId, { gmIntervalCycles: 3, rollDice: () => 10 });
    delete options.chatPorts; // 真实 adapter 路径：不注入 fake ChatPort
    const session = createGameSession(
      { character: cfgA, gm: cfgA, prose: cfgA },
      runId,
      undefined,
      worldId,
      options,
    );
    assert.equal(priv<number>(session, "proseWindowTurns"), 5);
    assert.equal(priv<number>(session, "gmIntervalCycles"), 3);

    session.applyResolvedConfigs(
      { character: cfgB, gm: cfgB, prose: cfgB },
      { proseWindowTurns: 9 },
      7,
    );

    const adapters = priv<Record<string, OpenAIChatAdapter>>(session, "adapters");
    for (const kind of ["character", "gm", "prose"]) {
      assert.deepEqual(priv<LLMConfig>(adapters[kind]!, "config"), cfgB);
    }
    assert.equal(priv<number>(session, "proseWindowTurns"), 9);
    assert.equal(priv<number>(session, "gmIntervalCycles"), 7);
  });
});
