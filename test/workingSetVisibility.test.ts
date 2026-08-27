import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { PlaceholderCatalog } from "../src/compile/placeholders.js";
import { renderPrompt } from "../src/compile/render.js";
import type { PromptTemplate } from "../src/compile/template.js";
import type { TruthStores } from "../src/truth/stores.js";
import type { WorkingSetEntry } from "../src/truth/workingSet.js";
import { buildCharacterState, buildProjectionHost, buildTruthStores } from "./builders/index.js";

// ---------------------------------------------------------------------------
// 频道三档可见域集成测试（P2-3 出口，测试夹具占位符）：
// 言行条目可见域字段（A = 只对同频道 / B = 只对同地 / 缺省 = 组内全体）× 三类读者
// （频道内 / 同地不在频道 / 失聪），挂载 = 程序按焊死映射渲染时派生：
// 发言 {aud@1, vis@1}（同级取或）、字段 A 追加 频道@2 + {A@3, V@3}、字段 B 追加 地点@2。
// 读者有效 TAG 集 = 落盘池 ∪ 自身 cid ∪ 地点名 ∪ 频道编号 ∪ 工具 AV 临时挂载。
// ---------------------------------------------------------------------------

const DEFAULT_SPEECH = "大家都能听到的话。";
const CHANNEL_SPEECH = "只对频道说的话。";
const LOCAL_ACTION = "只对同地做的动作。";

/** 测试夹具占位符目录：scene = 三档可见域（含失聪降级分支）；scene_fallback = 不放行侧保底渲染。 */
const CATALOG: PlaceholderCatalog = {
  scene: {
    description: "当前场景（三档可见域 + 失聪降级）",
    source: "working_set",
    segments: [
      {
        kind: "entry",
        pass: {
          template: "{_content}",
          branches: [{ tokens: ["vis"], template: "【失聪】只看见 @C1001 嘴唇在动，听不清内容。" }],
        },
      },
    ],
  },
  scene_fallback: {
    description: "当前场景（不放行侧保底渲染演示）",
    source: "working_set",
    segments: [
      {
        kind: "entry",
        pass: { template: "{_content}" },
        fail: { template: "【感知到一阵动静，但无从得知内容】" },
      },
    ],
  },
};

const TEMPLATE: PromptTemplate = {
  id: "t",
  modules: [
    { key: "m1", role: "user", content: "{{scene}}" },
    { key: "m2", role: "user", content: "{{scene_fallback}}" },
  ],
};

/** 场景：C1001（loc_A，频道 5）三条可见域各异的言行；读者 = 频道内（异地）/同地不在频道/失聪。 */
function makeTruth(): TruthStores {
  const truth = buildTruthStores({
    characters: {
      C0: buildCharacterState({
        isPlayer: true,
        appearance: true,
        location: { name: "loc_A", level: 1 },
        vars: { tags: { value: ["aud", "vis"], tags: [] } },
      }),
      C1001: buildCharacterState({
        appearance: true,
        location: { name: "loc_A", level: 1 },
        channel: 5,
        vars: { tags: { value: ["aud", "vis"], tags: [] } },
      }),
      C1002: buildCharacterState({
        appearance: true,
        location: { name: "loc_B", level: 1 },
        channel: 5,
        vars: { tags: { value: ["aud", "vis"], tags: [] } },
      }),
      C1003: buildCharacterState({
        appearance: true,
        location: { name: "loc_A", level: 1 },
        vars: { tags: { value: ["aud", "vis"], tags: [] } },
      }),
      // 失聪读者：落盘池只持 vis（同地、不在频道）
      C1004: buildCharacterState({
        appearance: true,
        location: { name: "loc_A", level: 1 },
        vars: { tags: { value: ["vis"], tags: [] } },
      }),
    },
  });
  const entries: WorkingSetEntry[] = [
    { cid: "C1001", decision: { inner: "内心", dialogue: DEFAULT_SPEECH } },
    { cid: "C1001", decision: { inner: "内心", dialogue: CHANNEL_SPEECH, visibility: "A" } },
    { cid: "C1001", decision: { inner: "内心", action: LOCAL_ACTION, visibility: "B" } },
  ];
  truth.world.setPipeline({ working_set: entries });
  return truth;
}

function renderModules(cid: string): string[] {
  const host = buildProjectionHost({ kind: "character", cid }, makeTruth());
  return renderPrompt(TEMPLATE, CATALOG, host).map((message) => message.content);
}

describe("频道三档可见域：字段 A/B/默认 × 频道内/同地/失聪读者", () => {
  it("频道内读者（持频道 + 工具 AV）：默认与字段 A 可见，字段 B（异地）不可见", () => {
    const out = renderModules("C1002").join("\n");
    assert.ok(out.includes(DEFAULT_SPEECH), "默认域 = 组内全体可见");
    assert.ok(out.includes(CHANNEL_SPEECH), "字段 A = 只对频道内可见");
    assert.ok(!out.includes(LOCAL_ACTION), "字段 B = 只对同地，异地频道成员不可见");
  });

  it("同地不在频道读者：默认与字段 B 可见；字段 A 不放行、保底渲染归不放行侧", () => {
    const [scene, fallback] = renderModules("C1003");
    assert.ok(scene!.includes(DEFAULT_SPEECH));
    assert.ok(scene!.includes(LOCAL_ACTION), "字段 B = 同地可见（地点 TAG 命中归一化 location 记号）");
    assert.ok(!scene!.includes(CHANNEL_SPEECH), "无频道者对字段 A 条目 = 不放行侧");
    assert.ok(fallback!.includes("【感知到一阵动静，但无从得知内容】"), "不放行侧保底渲染生效");
    assert.ok(!fallback!.includes(CHANNEL_SPEECH), "不放行侧路径调用给空，内容不泄露");
  });

  it("失聪读者（只持 vis）：发言条目 OR 放行、matched=[vis] 精确命中降级分支，内容不泄露", () => {
    const [scene] = renderModules("C1004");
    assert.ok(scene!.includes("【失聪】只看见 @C1001 嘴唇在动，听不清内容。"), "同级取或：看到即可，走降级文案");
    assert.ok(!scene!.includes(DEFAULT_SPEECH), "降级分支不含发言原文");
    assert.ok(scene!.includes(LOCAL_ACTION), "字段 B（纯视觉行为 + 同地）失聪读者正常可见");
  });
});
