import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { AdjudicationPackageSchema, DecisionPackageSchema, MarkerSchema, spanToMinutes } from "../src/types.js";

describe("SpanSchema 仅供 GM durations", () => {
  it("按 y=365d、m=30d 换算并钳制负总量", () => {
    assert.equal(spanToMinutes({ y: 1, m: 1, d: 1, h: 1, min: 1 }), (365 + 30 + 1) * 1440 + 61);
    assert.equal(spanToMinutes({ h: -2 }), 0);
  });
  it("DecisionPackage 必填 inner，action 可选且与 dialogue 至少其一，可选非空 relations，拒绝 intent/span", () => {
    const pkg = DecisionPackageSchema.parse({ action: "下山", inner: "得快些", dialogue: "我去去就回。" });
    assert.equal(pkg.action, "下山");
    // action 可省略（纯台词轮）；dialogue 可省略（纯行动轮）
    assert.equal(DecisionPackageSchema.parse({ inner: "x", dialogue: "台词" }).action, undefined);
    assert.equal(DecisionPackageSchema.parse({ inner: "x", action: "行动" }).dialogue, undefined);
    // dialogue 与 action 皆无 → refine 拒绝（只有内心不构成一轮言行）
    assert.throws(() => DecisionPackageSchema.parse({ inner: "x" }), /dialogue 与 action 至少其一/);
    for (const bad of [
      { action: "", inner: "x" },
      { inner: "x", dialogue: "" },
      { inner: "" , action: "x" },
      { inner: "x", action: "x", relations: [] },
    ]) assert.throws(() => DecisionPackageSchema.parse(bad));
    // strict：intent 已删除（语义并入 inner），多余字段一律拒绝
    assert.throws(() => DecisionPackageSchema.parse({ action: "x", inner: "x", intent: "x" }));
    assert.throws(() => DecisionPackageSchema.parse({ action: "x", inner: "x", span: { h: 1 } }));
  });
});

describe("AdjudicationPackageSchema", () => {
  it("durations span 与 world delta 合法", () => {
    const pkg = AdjudicationPackageSchema.parse({ events: [{ text: "@C0 下山", tags: ["known_by:C0"] }], narrativity: "full", deltas: [{ path: "weather", op: "=", value: "fog" }], durations: [{ cid: "C0", span: { min: 5 } }], location: [] });
    assert.equal(pkg.durations[0]!.span.min, 5);
  });
});

describe("MarkerSchema（五标记）", () => {
  const base = { action: "x", inner: "x" };

  it("五种标记各自合法；markers 可省略", () => {
    for (const marker of [
      { type: "gm_request" },
      { type: "leave" },
      { type: "recall", target: "C1001" },
      { type: "recall", target: "@C0" },
      { type: "contact", channel: "电话", targets: ["C1001", "@C1002"] },
      { type: "confirm" },
    ]) {
      const pkg = DecisionPackageSchema.parse({ ...base, markers: [marker] });
      assert.equal(pkg.markers!.length, 1);
    }
    assert.equal(DecisionPackageSchema.parse(base).markers, undefined);
  });

  it("gm_request 与 leave 互斥；同类型重复不互斥", () => {
    assert.throws(
      () => DecisionPackageSchema.parse({ ...base, markers: [{ type: "gm_request" }, { type: "leave" }] }),
      /互斥/,
    );
    assert.throws(
      () => DecisionPackageSchema.parse({ ...base, markers: [{ type: "leave" }, { type: "gm_request" }] }),
      /互斥/,
    );
    const ok = DecisionPackageSchema.parse({ ...base, markers: [{ type: "recall", target: "C1001" }, { type: "recall", target: "C1002" }] });
    assert.equal(ok.markers!.length, 2);
  });

  it("target/targets 只接受可选 @ 前缀的严格 CID", () => {
    for (const target of ["C", "C-1", "C01", "player", "@C1x", "c1001"]) {
      assert.throws(() => MarkerSchema.parse({ type: "recall", target }));
      assert.throws(() => MarkerSchema.parse({ type: "contact", channel: "电话", targets: [target] }));
    }
  });

  it("contact 必须含非空途径与至少一个目标；空 markers 数组拒绝", () => {
    assert.throws(() => MarkerSchema.parse({ type: "contact", channel: "", targets: ["C1001"] }));
    assert.throws(() => MarkerSchema.parse({ type: "contact", channel: "电话", targets: [] }));
    assert.throws(() => DecisionPackageSchema.parse({ ...base, markers: [] }));
  });

  it("未知标记类型与多余字段拒绝（strict）", () => {
    assert.throws(() => MarkerSchema.parse({ type: "shout" }));
    assert.throws(() => MarkerSchema.parse({ type: "leave", reason: "累了" }));
    assert.throws(() => MarkerSchema.parse({ type: "recall" }));
  });
});
