import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { PlaceholderCatalog } from "../src/compile/placeholders.js";
import { renderPrompt } from "../src/compile/render.js";
import type { PromptTemplate } from "../src/compile/template.js";
import { buildCharacterState, buildProjectionHost, buildTruthStores } from "./builders/index.js";

// ---------------------------------------------------------------------------
// 失聪降级集成测试（P2-3 出口）：内容侧同一末端挂 aud（1 级）+ vis（2 级）——
// 判定式 =（一级组 aud ∨）∧（二级组 vis ∨）。读者三档：全持 / 只持 vis（失聪）/ 皆无，
// 经占位符条目段的 matched 并集精确匹配分支出三档文案。测试夹具占位符，不扩 baitan 内容。
// ---------------------------------------------------------------------------

const SPEECH = "他说了一句至关重要的话。";

/** 测试夹具占位符目录：言行条目段，pass/fail 两侧各带精确匹配分支。 */
const CATALOG: PlaceholderCatalog = {
  scene: {
    description: "当前场景言行（失聪降级三档）",
    segments: [
      {
        kind: "entry",
        pass: {
          template: "【全感知】{characters.C1001.speech.text}",
          branches: [{ tokens: ["aud", "vis"], template: "【全感知】{characters.C1001.speech.text}" }],
        },
        fail: {
          template: "【无察觉】",
          branches: [{ tokens: ["vis"], template: "【失聪】只看见 @C1001 嘴唇在动，听不清内容。" }],
        },
      },
    ],
  },
};

const TEMPLATE: PromptTemplate = {
  id: "t",
  modules: [{ key: "m", role: "user", content: "{{scene}}" }],
};

function makeTruth() {
  return buildTruthStores({
    characters: {
      // 读者三档：全持 / 只持 vis（失聪）/ 皆无（tags 池 = 对象侧有效 TAG 纯名集）
      C0: buildCharacterState({ isPlayer: true, appearance: true, vars: { tags: { value: ["aud", "vis"], tags: [] } } }),
      C2: buildCharacterState({ appearance: true, vars: { tags: { value: ["vis"], tags: [] } } }),
      C3: buildCharacterState({ appearance: true, vars: { tags: { value: [], tags: [] } } }),
      // 内容侧：同一末端挂 aud 1 级 + vis 2 级（前台在场，无 fappear 虚拟挂载）
      C1001: buildCharacterState({
        appearance: true,
        vars: { speech: { text: { value: SPEECH, tags: [{ name: "aud", level: 1 }, { name: "vis", level: 2 }] } } },
      }),
    },
  });
}

function render(cid: string): string {
  const host = buildProjectionHost({ kind: "character", cid }, makeTruth());
  return renderPrompt(TEMPLATE, CATALOG, host)
    .map((message) => message.content)
    .join("\n");
}

describe("失聪降级：内容挂 aud 1 级 + vis 2 级，读者三档文案（matched 精确匹配分支）", () => {
  it("全持 aud+vis → 放行侧全感知文案（含内容值）", () => {
    assert.equal(render("C0"), `【全感知】${SPEECH}`);
  });

  it("只持 vis → 不放行侧失聪分支（matched=[vis] 精确命中，内容值不给）", () => {
    const out = render("C2");
    assert.equal(out, "【失聪】只看见 @C1001 嘴唇在动，听不清内容。");
    assert.ok(!out.includes(SPEECH), "不放行路径调用给空，内容值不得泄露");
  });

  it("皆无 → 不放行侧缺省兜底（空记号集，无分支命中）", () => {
    assert.equal(render("C3"), "【无察觉】");
  });
});
