import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { scanEventWatermark } from "../src/truth/events.js";
import { buildEvent } from "./builders/index.js";

// ---------------------------------------------------------------------------
// scanEventWatermark（事件 ID 水位）：纯函数表驱动。
// 语义：evt_(\d+) 最大数字后缀；无匹配归 0；非标准格式 id 忽略。
// 新事件 ID 由水位分配而非数组长度——删中段/直编事件表后长度失真，水位不失真。
// ---------------------------------------------------------------------------

describe("scanEventWatermark（事件 ID 水位）", () => {
  it("空数组 → 0", () => {
    assert.equal(scanEventWatermark([]), 0);
  });

  it("取 evt_ 数字后缀最大值（乱序；补零与非补零混合按数值比较）", () => {
    const events = [buildEvent({ id: "evt_0003" }), buildEvent({ id: "evt_0007" }), buildEvent({ id: "evt_0001" })];
    assert.equal(scanEventWatermark(events), 7);
    assert.equal(scanEventWatermark([buildEvent({ id: "evt_10" }), buildEvent({ id: "evt_0009" })]), 10);
  });

  it("删中段后仍取最大（长度 2 < 水位 3，长度推导会分配冲突 ID）", () => {
    const events = [buildEvent({ id: "evt_0001" }), buildEvent({ id: "evt_0003" })]; // evt_0002 已删
    assert.equal(scanEventWatermark(events), 3);
  });

  it("非标准格式 id 忽略（直编手工 id 不抬水位）", () => {
    const events = [
      buildEvent({ id: "evt_0002" }),
      buildEvent({ id: "manual-edit" }),
      buildEvent({ id: "evt_x" }),
      buildEvent({ id: "evt_" }),
      buildEvent({ id: "prefix_evt_0009" }),
    ];
    assert.equal(scanEventWatermark(events), 2);
    assert.equal(scanEventWatermark([buildEvent({ id: "custom" })]), 0);
  });
});
