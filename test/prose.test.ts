import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { loadPackPlaceholders, loadPackPrompts } from "../src/application/sessionFactory.js";
import { participantTags } from "../src/application/historyProjection.js";
import { renderPrompt, type RenderHost } from "../src/compile/render.js";
import { extractPlaceholders } from "../src/compile/template.js";
import { resolveWorldDir } from "../src/config.js";
import { Lorebook } from "../src/truth/lorebook.js";
import type { AdjudicationPackage } from "../src/types.js";
import { buildCharacterState, buildProjectionHost, buildTruthStores } from "./builders/index.js";

/** 出厂世界包目录（data/assets/baitan/）。 */
const FACTORY_WORLD_DIR = resolveWorldDir();

const ADJUDICATION: AdjudicationPackage = {
  events: [],
  narrativity: "skip",
  deltas: [],
  durations: [],
  location: [],
};

function proseHost(): RenderHost {
  const truth = buildTruthStores({ characters: { C1001: buildCharacterState({ name: "林雾" }) } });
  return buildProjectionHost(
    { kind: "prose" },
    truth,
    { adjudication: ADJUDICATION, currentScene: "##@C1001\n  内心：警惕", participantCids: ["C1001"] },
  );
}

describe("prose 输入", () => {
  it("模板不含 GM 公共长期记忆与 voice anchors", () => {
    const catalog = loadPackPlaceholders(FACTORY_WORLD_DIR);
    const template = loadPackPrompts(FACTORY_WORLD_DIR, catalog).find((tpl) => tpl.id === "prose")!;
    const text = renderPrompt(template, catalog, proseHost()).map((message) => message.content).join("\n");
    assert.ok(!text.includes("voice_anchor") && !text.includes("声纹锚点"));
    const used = template.modules.flatMap((mod) => extractPlaceholders(mod.content));
    assert.ok(!used.includes("long_term_memory"), "prose 模板不引用长期记忆占位符");
  });
  it("gm_event 投影保持纯数据（events + narrativity 的 JSON）", () => {
    assert.equal(
      proseHost().entries("gm_event")[0]!.content,
      JSON.stringify({ events: [], narrativity: "skip" }),
    );
  });
  it("参与者标签并集触发 lore", () => {
    const book = new Lorebook([{ id: "x", tags: [{ name: "秘密", level: 1 }], content: "S" }]);
    assert.deepEqual(
      book.getByTags({ tags: new Set(participantTags([["秘密"]])) }, {}).map((entry) => entry.id),
      ["x"],
    );
  });
});
