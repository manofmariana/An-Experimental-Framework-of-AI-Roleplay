import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  appendNotices,
  isNoticeEntry,
  noticesOfMarkers,
  renderNoticeText,
  renderScene,
  renderSpeech,
  speechEntryTagsOf,
  WorkingSetEntrySchema,
  type WorkingSetEntry,
  type WorkingSetNoticeEntry,
} from "../src/truth/workingSet.js";

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

describe("通知条目与焊死映射挂载派生（纯函数）", () => {
  it("标记 → 通知条目：confirm 不生成；contact 载荷归一化 + tags = 感知/归属/手段三档", () => {
    const notices = noticesOfMarkers("C1001", [
      { type: "contact", channel: "视频", targets: ["@C1002", "C1001"] },
      { type: "confirm" },
    ]);
    assert.equal(notices.length, 1, "confirm 是应答本身不生成；目标含自己 = 剔除");
    assert.deepEqual(notices[0], {
      id: "notice:contact",
      author: "system",
      notice: { type: "contact", actor: "C1001", means: "视频", targets: ["C1002"] },
      tags: [
        { name: "aud", level: 1 },
        { name: "vis", level: 1 },
        { name: "C1002", level: 2 },
        { name: "A", level: 3 },
        { name: "V", level: 3 },
      ],
    });
    assert.ok(WorkingSetEntrySchema.parse(notices[0]) !== undefined, "通知条目过 codec");
  });

  it("appendNotices：同 ID 复用（先摘后附，后来者居上）；无通知 = 原样", () => {
    const speech: WorkingSetEntry = { cid: "C0", decision: { inner: "x", dialogue: "y" } };
    const n1 = noticesOfMarkers("C1001", [{ type: "leave" }]);
    const n2 = noticesOfMarkers("C1002", [{ type: "leave" }]);
    const merged = appendNotices(appendNotices([speech], n1), n2);
    assert.equal(merged.filter(isNoticeEntry).length, 1);
    assert.equal((merged[1] as WorkingSetNoticeEntry).notice.actor, "C1002");
    assert.deepEqual(appendNotices([speech], []), [speech]);
  });

  it("言行条目挂载派生：发言 {aud,vis}@1 / 行为 {vis}@1；字段 A 追加频道@2+{A,V}@3；字段 B 追加地点@2", () => {
    const actor = { channel: 5, location: { name: "旧灯塔" } };
    assert.deepEqual(speechEntryTagsOf({ cid: "C1", decision: { inner: "x", dialogue: "说" } }, actor), [
      { name: "aud", level: 1 },
      { name: "vis", level: 1 },
    ]);
    assert.deepEqual(speechEntryTagsOf({ cid: "C1", decision: { inner: "x", action: "做" } }, actor), [
      { name: "vis", level: 1 },
    ]);
    assert.deepEqual(
      speechEntryTagsOf({ cid: "C1", decision: { inner: "x", dialogue: "说", visibility: "A" } }, actor),
      [
        { name: "aud", level: 1 },
        { name: "vis", level: 1 },
        { name: "5", level: 2 },
        { name: "A", level: 3 },
        { name: "V", level: 3 },
      ],
    );
    assert.deepEqual(
      speechEntryTagsOf({ cid: "C1", decision: { inner: "x", dialogue: "说", visibility: "A" } }, { ...actor, channel: null }),
      [
        { name: "aud", level: 1 },
        { name: "vis", level: 1 },
        { name: "A", level: 3 },
        { name: "V", level: 3 },
      ],
      "无频道者输出字段 A：频道@2 无从挂载（契约违例边缘，不伪造归属）",
    );
    assert.deepEqual(
      speechEntryTagsOf({ cid: "C1", decision: { inner: "x", action: "做", visibility: "B" } }, actor),
      [
        { name: "vis", level: 1 },
        { name: "旧灯塔", level: 2 },
      ],
    );
  });

  it("渲染：renderScene 含通知机械文案（GM 恒见路径）；renderSpeech 跳过通知条目", () => {
    const withNotice: WorkingSetEntry[] = [
      ...entries,
      noticesOfMarkers("C1001", [{ type: "contact", channel: "电话", targets: ["C0"] }])[0]!,
    ];
    const scene = renderScene(withNotice);
    assert.ok(scene.includes("【系统通知】@C1001 通过「电话」联系 @C0"));
    const speech = renderSpeech(withNotice);
    assert.ok(!speech.includes("系统通知"), "正文取材不含系统通知");
    assert.equal(renderNoticeText({ type: "recall", actor: "C0", targets: ["C1001"] }), "【系统通知】@C0 召回了 @C1001");
  });
});
