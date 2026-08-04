import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { PROSE_PLACEHOLDERS, type ProseContext } from "../src/agents/prose.js";
import { compilePrompt } from "../src/compile/compiler.js";
import { loadTemplate } from "../src/compile/template.js";
import { participantTags } from "../src/application/historyProjection.js";
import { Lorebook } from "../src/truth/lorebook.js";

describe("prose 输入", () => {
  const context: ProseContext = { toneCard: "基调", worldLore: "设定", recentEvents: [], cast: [{ cid: "C1001", name: "林雾" }], triggeredLore: "秘密", lastProse: "上一段", gmEvent: "{}", currentScene: "##@C1001\n  内心：警惕" };
  it("模板不含 GM 公共长期记忆与 voice anchors", () => {
    const template = loadTemplate("prose", Object.keys(PROSE_PLACEHOLDERS)); const text = compilePrompt(template, PROSE_PLACEHOLDERS, context).map((message) => message.content).join("\n");
    assert.ok(!text.includes("voice_anchor") && !text.includes("声纹锚点") && !("long_term_memory" in PROSE_PLACEHOLDERS));
  });
  it("provider 保持纯数据", () => assert.equal(PROSE_PLACEHOLDERS.gm_event!.provide(context), "{}"));
  it("参与者标签并集触发 lore", () => {
    const book = new Lorebook([{ id: "x", tags: ["秘密"], content: "S" }]);
    assert.deepEqual(book.getByTags(participantTags([{ tags: ["秘密"] }])).map((entry) => entry.id), ["x"]);
  });
});
