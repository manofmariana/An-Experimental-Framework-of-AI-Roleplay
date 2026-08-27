import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { CharacterActivation } from "../src/agents/character.js";
import { buildCast, ProjectionBuilder } from "../src/application/activationContexts.js";
import { ArchiveStore } from "../src/truth/archive.js";
import { CharactersStore, type CharacterState } from "../src/truth/charactersStore.js";
import { EventsStore } from "../src/truth/events.js";
import { LoreStore } from "../src/truth/loreStore.js";
import { SAVE_SCHEMA_VERSION } from "../src/truth/saveSchema.js";
import type { TruthStores } from "../src/truth/stores.js";
import { TimeStore, worldTimeToMinutes } from "../src/truth/timeStore.js";
import { WorldStore } from "../src/truth/worldStore.js";
import { buildManifest, buildPromptsStore, buildVarsTemplate, buildWorldSysRaw } from "./builders/index.js";

const DECL = buildVarsTemplate().characterVars;
import { ScriptedChatPort } from "./fakes/chatPort.js";
import { factoryPromptsStore } from "./harness/session.js";

// ---------------------------------------------------------------------------
// 内容源投影层：
// ① 连续两次 activation 用不同投影，第二次 prompt 不含第一次独有内容；
// ② cast 现建（改名后下一次投影直接读到最新）；
// ③ lore 逐次渲染（改 loreStore 后 GM 投影的 lore 反映新内容）。
// 零服务零存档：七 Store 全内存构造 + fake ChatPort（decide 读档内 PromptsStore 模板）。
// ---------------------------------------------------------------------------

const START = { y: 0, m: 1, d: 1, h: 8, min: 0 };
const STATICS = { setting: "测试设定", toneCard: "测试基调" };

/** 出厂模板档内副本（activation 构造注入）。 */
const FACTORY_PROMPTS = factoryPromptsStore();

/** 全内存七真相 Store（与 sessionFactory 新档装配同序：NPC manifests → ensurePlayer）。 */
function makeTruth(options?: { visibleEvent?: string }): TruthStores {
  const start = worldTimeToMinutes(START);
  const world = WorldStore.initial({ time: START }, buildWorldSysRaw());
  const characters = CharactersStore.fromManifests(
    // 固有 TAG「旧闻」写在 vars.attachtags（角色根保留名末端，string_list 纯名集合；tags 池由 fromManifest 物化）
    [buildManifest({ id: "C1001", name: "林雾", vars: { attachtags: ["旧闻"] } })],
    start,
    DECL,
  );
  characters.ensurePlayer(buildManifest({ id: "C0", name: "玩家", isPlayer: true }), start, DECL);
  const events = new EventsStore();
  if (options?.visibleEvent !== undefined) {
    events.append({ id: "evt_0001", t: start, seq: 1, kind: "world", tags: [{ name: "C1001", level: 1 }], payload: options.visibleEvent });
  }
  const loreStore = LoreStore.initFrom([{ id: "lore_a", tags: [{ name: "旧闻", level: 1 }], content: "灯塔旧事A" }]);
  const timeStore = new TimeStore({
    schema_version: SAVE_SCHEMA_VERSION,
    start: START,
    periods: [{ key: "白天", from: 0, to: 24 }],
  });
  const archive = new ArchiveStore();
  const promptsStore = buildPromptsStore();
  return { world, characters, events, archive, loreStore, timeStore, promptsStore };
}

const signal = () => new AbortController().signal;

describe("activationContexts（内容源投影层）", () => {
  it("连续两次 activation 用不同投影：第二次 prompt 不含第一次独有内容", async () => {
    const port = new ScriptedChatPort(() => ({
      text: JSON.stringify({ action: "环顾", inner: "警惕。", dialogue: "谁？" }),
      reasoning: "",
      usage: { hit: 0, miss: 0, output: 0 },
    }));
    const activation = new CharacterActivation(port, FACTORY_PROMPTS);
    const builder = new ProjectionBuilder(STATICS);

    // 第一次：真相 A（含独有事件 + 角色名「林雾」）
    const truthA = makeTruth({ visibleEvent: "旧档独有事件Alpha" });
    await activation.decide(
      builder.for({ kind: "character", cid: "C1001" }, { truth: truthA, proseWindowTurns: 5 }),
      1,
      signal(),
    );

    // 第二次：真相 B（无该事件，角色已改名「周砚」）——模拟另一存档/改名后的全新调用
    const truthB = makeTruth();
    const renamed = JSON.parse(JSON.stringify(truthB.characters.saveData())) as Record<string, CharacterState>;
    renamed["C1001"]!.name = "周砚";
    truthB.characters.restoreSnapshot({ schema_version: SAVE_SCHEMA_VERSION, characters: renamed });
    await activation.decide(
      builder.for({ kind: "character", cid: "C1001" }, { truth: truthB, proseWindowTurns: 5 }),
      2,
      signal(),
    );

    assert.equal(port.calls.length, 2);
    const first = port.calls[0]!.messages.map((m) => m.content).join("\n");
    const second = port.calls[1]!.messages.map((m) => m.content).join("\n");
    assert.ok(first.includes("旧档独有事件Alpha") && first.includes("林雾"), "第一次 prompt 含第一次投影内容");
    assert.ok(!second.includes("旧档独有事件Alpha"), "第二次 prompt 不含第一次独有事件");
    assert.ok(!second.includes("林雾"), "第二次 prompt 不含第一次独有角色名");
    assert.ok(second.includes("周砚"), "第二次 prompt 反映最新真相");
  });

  it("cast 现建：改角色名后下一次投影的 cast 反映新名", () => {
    const truth = makeTruth();
    const builder = new ProjectionBuilder(STATICS);
    const castText = (host: { entries(source: "cast"): { content: string }[] }) =>
      host.entries("cast").map((entry) => entry.content).join("\n");
    const before = builder.for({ kind: "character", cid: "C1001" }, { truth, proseWindowTurns: 5 });
    assert.deepEqual(buildCast(truth), [
      { cid: "C0", name: "玩家" },
      { cid: "C1001", name: "林雾" },
    ]);
    assert.ok(castText(before).includes("@C1001 = 我（林雾）"), "角色读者 cast 自身标「我」");

    const renamed = JSON.parse(JSON.stringify(truth.characters.saveData())) as Record<string, CharacterState>;
    renamed["C1001"]!.name = "新名字";
    truth.characters.restoreSnapshot({ schema_version: SAVE_SCHEMA_VERSION, characters: renamed });

    const after = builder.for({ kind: "character", cid: "C1001" }, { truth, proseWindowTurns: 5 });
    assert.ok(castText(after).includes("新名字"), "改名后 cast 立即反映");
    assert.ok(!castText(after).includes("林雾"));
  });

  it("lore 逐次渲染：改 loreStore 后 GM 投影的 lore 反映新内容", () => {
    const truth = makeTruth();
    const builder = new ProjectionBuilder(STATICS);
    const gmHost = () =>
      builder.for(
        { kind: "gm" },
        { truth, proseWindowTurns: 5, sceneText: "", roundScenes: {}, fortune: "良恶判定：良性；程度 30（1–100）" },
      );

    const before = gmHost().entries("lore")[0]!.content;
    assert.ok(before.includes("[lore_a]（标签：旧闻(1)）\n灯塔旧事A"), "GM lore 全量渲染档内副本");

    truth.loreStore.applyChange({
      seq: 1,
      op: "update",
      before: { id: "lore_a", tags: [{ name: "旧闻", level: 1 }], content: "灯塔旧事A" },
      after: { id: "lore_a", tags: [{ name: "旧闻", level: 1 }], content: "灯塔旧事B" },
    });

    const after = gmHost().entries("lore")[0]!.content;
    assert.ok(after.includes("灯塔旧事B"), "lore 编辑后下一次 GM 投影即读新内容");
    assert.ok(!after.includes("灯塔旧事A"));

    // 角色激活 lore 同样逐次按 tags 匹配档内副本
    const charLore = builder.for({ kind: "character", cid: "C1001" }, { truth, proseWindowTurns: 5 }).entries("lore")[0]!
      .content;
    assert.ok(charLore.includes("灯塔旧事B"), "角色标签激活 lore 逐次渲染");
  });
});
