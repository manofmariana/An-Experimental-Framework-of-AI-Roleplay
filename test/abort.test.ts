import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { CharacterActivation, type CharacterContext, type CharacterManifest } from "../src/agents/character.js";
import { GmActivation, validateAdjudicationRound, type GmContext } from "../src/agents/gm.js";
import { resolveWorldDir } from "../src/config.js";
import { LLMAbortedError } from "../src/llm/chatPort.js";
import { OpenAIChatAdapter } from "../src/llm/openaiChatAdapter.js";
import { packPromptsDir } from "../src/resources/worldRepository.js";
import { CharactersStore } from "../src/truth/charactersStore.js";

/** 出厂模板目录 = 默认世界包内 prompts/（activation 构造注入，热加载即读它）。 */
const FACTORY_PROMPTS_DIR = packPromptsDir(resolveWorldDir());

const manifest: CharacterManifest = {
  id: "C1001", name: "林雾", gender: "女", age: "26", personality: "谨慎。",
  initial_memories: ["记忆一"], location: { name: "loc_lighthouse", level: 1 }, tags: [], reaction: 5,
  timer: null, group: 0, initiative: null, channel: null, acted: false, level: 1, isPlayer: false,
  relations: {}, vars: {},
};

/** 计数的 fake LLM：永远抛指定错误。 */
function failingLlm(err: Error) {
  const state = { calls: 0 };
  return {
    state,
    chat: async () => {
      state.calls += 1;
      throw err;
    },
  };
}

/** 最小角色上下文（无状态 activation：上下文逐调用传入，测试就地构造）。 */
function characterCtx(): CharacterContext {
  const store = CharactersStore.fromManifests([manifest], 0);
  return {
    selfCid: "C1001", states: store.all(), cast: [], worldSnapshot: "{}", activatedLore: "",
    recentEvents: [], proseWindow: [], currentScene: "", timeHeader: "", clock: 0,
  };
}

/** 最小 GM 上下文。 */
function gmCtx(): GmContext {
  const store = CharactersStore.fromManifests([manifest], 0);
  return {
    setting: "设定", cast: [], loreFull: "", events: [], proseWindow: [], currentScene: "场景",
    worldSnapshot: "{}", states: store.all(), clock: 0, timeHeader: "",
  };
}

describe("abort 不触发重试（停止 ≠ 可重试的失败）", () => {
  it("OpenAIChatAdapter 流式：abort 后流「正常结束」也抛 LLMAbortedError（根因修复）", async () => {
    // 真实根因：abort 不保证从 SDK 流里抛错——流可能正常收尾，
    // 若无显式检查，部分文本会被当成成功返回，下游误判解析失败并重试。
    const adapter = new OpenAIChatAdapter(
      { apiKey: "x", baseURL: "http://127.0.0.1:9", model: "m", jsonMode: false },
    );
    const openai = (adapter as never as { openai: { chat: { completions: { create: unknown } } } }).openai;
    openai.chat.completions.create = async () => ({
      async *[Symbol.asyncIterator]() {
        yield { choices: [{ delta: { content: "半截" } }] };
        // 流"正常"结束（模拟 abort 不抛错的时序）
      },
    });
    const controller = new AbortController();
    await assert.rejects(
      () =>
        adapter.chat(
          {
            agent: "character:C1001",
            seq: 1,
            messages: [{ role: "system", content: "x" }],
            onDelta: () => controller.abort(), // 第一个 chunk 到达即停止
          },
          controller.signal,
        ),
      (err: Error) => err instanceof LLMAbortedError && err.partialText === "半截",
    );
  });

  it("character.decide：LLMAbortedError 直接向上传播，只调用一次", async () => {
    const llm = failingLlm(new LLMAbortedError("半截", ""));
    const activation = new CharacterActivation(llm as never, FACTORY_PROMPTS_DIR);
    await assert.rejects(() => activation.decide(characterCtx(), 1, new AbortController().signal), LLMAbortedError);
    assert.equal(llm.state.calls, 1);
  });

  it("gm.adjudicate：LLMAbortedError 直接向上传播，只调用一次", async () => {
    const llm = failingLlm(new LLMAbortedError("", ""));
    const gm = new GmActivation(llm as never, FACTORY_PROMPTS_DIR);
    await assert.rejects(() => gm.adjudicate(gmCtx(), 1, ["C1001"], new AbortController().signal), LLMAbortedError);
    assert.equal(llm.state.calls, 1);
  });

  it("GM 轮次边界校验拒绝跨组 timer/location，并在同一次重试机制内重试", async () => {
    const state = { calls: 0 };
    const llm = {
      chat: async () => {
        state.calls += 1;
        const pkg = state.calls === 1
          ? {
              events: [], narrativity: "skip", deltas: [],
              durations: [{ cid: "C1001", span: { min: 1 } }, { cid: "C1002", span: { min: 1 } }],
              location: [{ cid: "C1002", location: { name: "越界地点", level: 1 } }],
            }
          : {
              events: [], narrativity: "skip", deltas: [],
              durations: [{ cid: "C1001", span: { min: 1 } }],
              location: [{ cid: "C1001", location: { name: "合法地点", level: 1 } }],
            };
        return { text: JSON.stringify(pkg), reasoning: "" };
      },
    };
    const gm = new GmActivation(llm as never, FACTORY_PROMPTS_DIR);
    const { pkg } = await gm.adjudicate(gmCtx(), 1, ["C1001"], new AbortController().signal);
    assert.equal(state.calls, 2);
    assert.deepEqual(pkg.durations.map((item) => item.cid), ["C1001"]);
    assert.doesNotThrow(() => validateAdjudicationRound(pkg, ["C1001"]));
    assert.throws(
      () => validateAdjudicationRound({ ...pkg, location: [{ cid: "C1002", location: { name: "越界", level: 1 } }] }, ["C1001"]),
      /location cid 只能是不重复的上述集合子集/,
    );
  });

  it("对照：解析失败仍重试 1 次（重试机制本身未被误伤）", async () => {
    const state = { calls: 0 };
    const llm = {
      chat: async () => {
        state.calls += 1;
        if (state.calls === 1) return { text: '{"bad": 1}', reasoning: "" }; // 解析失败
        return { text: '{"action": "点头", "inner": "先看看。", "dialogue": "好。"}', reasoning: "" };
      },
    };
    const activation = new CharacterActivation(llm as never, FACTORY_PROMPTS_DIR);
    const { pkg } = await activation.decide(characterCtx(), 1, new AbortController().signal);
    assert.equal(state.calls, 2);
    assert.equal(pkg.dialogue, "好。");
  });
});
