import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { CharacterActivation } from "../src/agents/character.js";
import { ActivationContextBuilder, buildCast } from "../src/application/activationContexts.js";
import { resolveWorldDir } from "../src/config.js";
import { packPromptsDir } from "../src/resources/worldRepository.js";
import { ArchiveStore } from "../src/truth/archive.js";
import { CharactersStore, type CharacterState } from "../src/truth/charactersStore.js";
import { EventsStore } from "../src/truth/events.js";
import { LoreStore } from "../src/truth/loreStore.js";
import { SAVE_SCHEMA_VERSION } from "../src/truth/saveSchema.js";
import type { TruthStores } from "../src/truth/stores.js";
import { TimeStore, worldTimeToMinutes } from "../src/truth/timeStore.js";
import { WorldStore } from "../src/truth/worldStore.js";
import { buildManifest } from "./builders/index.js";
import { ScriptedChatPort } from "./fakes/chatPort.js";

// ---------------------------------------------------------------------------
// activation 上下文构建器：
// ① 连续两次 activation 用不同 Context，第二次 prompt 不含第一次独有内容；
// ② cast 现建（改名后下一次调用直接读到最新）；
// ③ lore 逐调用渲染（改 loreStore 后 GM ctx 的 loreFull 反映新内容）。
// 零服务零存档：六 Store 全内存构造 + fake ChatPort（decide 热加载默认包内 prompts/ 模板）。
// ---------------------------------------------------------------------------

const START = { y: 0, m: 1, d: 1, h: 8, min: 0 };
const STATICS = { setting: "测试设定", toneCard: "测试基调" };

/** 出厂模板目录 = 默认世界包内 prompts/（activation 构造注入）。 */
const FACTORY_PROMPTS_DIR = packPromptsDir(resolveWorldDir());

/** 全内存六真相 Store（与 sessionFactory 新档装配同序：NPC manifests → ensurePlayer）。 */
function makeTruth(options?: { visibleEvent?: string }): TruthStores {
  const start = worldTimeToMinutes(START);
  const world = WorldStore.initial({ time: START });
  const characters = CharactersStore.fromManifests(
    [buildManifest({ id: "C1001", name: "林雾", tags: ["旧闻"] })],
    start,
  );
  characters.ensurePlayer(buildManifest({ id: "C0", name: "玩家", isPlayer: true }), start);
  const events = new EventsStore();
  if (options?.visibleEvent !== undefined) {
    events.append({ id: "evt_0001", t: start, seq: 1, kind: "world", tags: ["known_by:C1001"], payload: options.visibleEvent });
  }
  const loreStore = LoreStore.initFrom([{ id: "lore_a", tags: ["旧闻"], content: "灯塔旧事A" }]);
  const timeStore = new TimeStore({
    schema_version: SAVE_SCHEMA_VERSION,
    start: START,
    periods: [{ key: "白天", from: 0, to: 24 }],
  });
  const archive = new ArchiveStore();
  return { world, characters, events, archive, loreStore, timeStore };
}

const signal = () => new AbortController().signal;

describe("activationContexts", () => {
  it("连续两次 activation 用不同 Context：第二次 prompt 不含第一次独有内容", async () => {
    const port = new ScriptedChatPort(() => ({
      text: JSON.stringify({ action: "环顾", inner: "警惕。", dialogue: "谁？" }),
      reasoning: "",
      usage: { hit: 0, miss: 0, output: 0 },
    }));
    const activation = new CharacterActivation(port, FACTORY_PROMPTS_DIR);
    const builder = new ActivationContextBuilder(STATICS);

    // 第一次：真相 A（含独有事件 + 角色名「林雾」）
    const truthA = makeTruth({ visibleEvent: "旧档独有事件Alpha" });
    await activation.decide(builder.character({ truth: truthA, cid: "C1001", proseWindowTurns: 5 }), 1, signal());

    // 第二次：真相 B（无该事件，角色已改名「周砚」）——模拟另一存档/改名后的全新调用
    const truthB = makeTruth();
    const renamed = JSON.parse(JSON.stringify(truthB.characters.saveData())) as Record<string, CharacterState>;
    renamed["C1001"]!.name = "周砚";
    truthB.characters.restoreSnapshot({ schema_version: SAVE_SCHEMA_VERSION, characters: renamed });
    await activation.decide(builder.character({ truth: truthB, cid: "C1001", proseWindowTurns: 5 }), 2, signal());

    assert.equal(port.calls.length, 2);
    const first = port.calls[0]!.messages.map((m) => m.content).join("\n");
    const second = port.calls[1]!.messages.map((m) => m.content).join("\n");
    assert.ok(first.includes("旧档独有事件Alpha") && first.includes("林雾"), "第一次 prompt 含第一次 Context 内容");
    assert.ok(!second.includes("旧档独有事件Alpha"), "第二次 prompt 不含第一次独有事件");
    assert.ok(!second.includes("林雾"), "第二次 prompt 不含第一次独有角色名");
    assert.ok(second.includes("周砚"), "第二次 prompt 反映最新真相");
  });

  it("cast 现建：改角色名后下一次 ctx 的 cast 反映新名", () => {
    const truth = makeTruth();
    const builder = new ActivationContextBuilder(STATICS);
    const before = builder.character({ truth, cid: "C1001", proseWindowTurns: 5 });
    assert.deepEqual(buildCast(truth), [
      { cid: "C0", name: "玩家" },
      { cid: "C1001", name: "林雾" },
    ]);
    assert.ok(before.cast.some((m) => m.cid === "C1001" && m.name === "林雾"));

    const renamed = JSON.parse(JSON.stringify(truth.characters.saveData())) as Record<string, CharacterState>;
    renamed["C1001"]!.name = "新名字";
    truth.characters.restoreSnapshot({ schema_version: SAVE_SCHEMA_VERSION, characters: renamed });

    const after = builder.character({ truth, cid: "C1001", proseWindowTurns: 5 });
    assert.ok(after.cast.some((m) => m.cid === "C1001" && m.name === "新名字"), "改名后 cast 立即反映");
    assert.ok(!after.cast.some((m) => m.name === "林雾"));
  });

  it("lore 逐调用渲染：改 loreStore 后 GM ctx 的 loreFull 反映新内容", () => {
    const truth = makeTruth();
    const builder = new ActivationContextBuilder(STATICS);
    const gmInput = { truth, proseWindowTurns: 5, sceneText: "", roundScenes: {} };

    const before = builder.gm(gmInput);
    assert.ok(before.loreFull.includes("[lore_a]（标签：旧闻）\n灯塔旧事A"), "GM loreFull 全量渲染档内副本");

    truth.loreStore.applyChange({
      seq: 1,
      op: "update",
      before: { id: "lore_a", tags: ["旧闻"], content: "灯塔旧事A" },
      after: { id: "lore_a", tags: ["旧闻"], content: "灯塔旧事B" },
    });

    const after = builder.gm(gmInput);
    assert.ok(after.loreFull.includes("灯塔旧事B"), "lore 编辑后下一次 GM ctx 即读新内容");
    assert.ok(!after.loreFull.includes("灯塔旧事A"));

    // 角色 activatedLore 同样逐调用按 tags 匹配档内副本
    const charCtx = builder.character({ truth, cid: "C1001", proseWindowTurns: 5 });
    assert.ok(charCtx.activatedLore.includes("灯塔旧事B"), "角色标签激活 lore 逐调用渲染");
  });
});
