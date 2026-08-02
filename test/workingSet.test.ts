import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { renderScene, renderSpeech, WorkingSetEntrySchema, type WorkingSetEntry } from "../src/truth/workingSet.js";

const entries: WorkingSetEntry[] = [
  { cid: "C0", input: "你好" },
  { cid: "C1001", decision: { action: "点头", inner: "先观察", dialogue: "雾大，路滑。" } },
];
describe("working set 新决策字段", () => {
  it("GM 场景含 action/inner 与真实 dialogue（intent 已并入 inner）", () => {
    const text = renderScene(entries);
    assert.ok(text.includes("行动：点头") && text.includes("内心：先观察") && text.includes("发言：雾大"));
    assert.ok(!text.includes("意图："));
    assert.doesNotThrow(() => WorkingSetEntrySchema.parse(entries[1]));
  });
  it("action 缺省时不渲染行动段（纯台词轮）", () => {
    const text = renderScene([{ cid: "C1001", decision: { inner: "警觉", dialogue: "谁？" } }]);
    assert.ok(text.includes("发言：谁？") && text.includes("内心：警觉"));
    assert.ok(!text.includes("行动："));
  });
  it("正文只含台词与内心，不含 action", () => {
    const text = renderSpeech(entries);
    assert.ok(text.includes("发言：") && text.includes("内心："));
    assert.ok(!text.includes("行动：") && !text.includes("意图："));
  });
  it("角色视角：他人条目隐藏内心，本人条目保留", () => {
    const text = renderScene(entries, "C0");
    assert.ok(text.includes("言行：你好"));
    assert.ok(text.includes("行动：点头") && text.includes("发言：雾大"));
    assert.ok(!text.includes("内心：先观察"));
    const self = renderScene(entries, "C1001");
    assert.ok(self.includes("内心：先观察"));
  });
});
