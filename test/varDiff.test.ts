import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { diffStateTrees } from "../src/truth/varDiff.js";

// ---------------------------------------------------------------------------
// diffStateTrees 纯函数单测：值变化 / 路径新增（before_exists=false）/
// 路径删除（after_exists=false）/ 嵌套 / 数组按索引（长度差 = 尾部新增/删除）。
// 路径约定与 var_changes 一致：world 域 "world.x"、characters 域空前缀 "C1001.x"。
// ---------------------------------------------------------------------------

describe("diffStateTrees（状态树叶级 diff）", () => {
  it("无差异 → 空数组（含深度相等的嵌套与数组）", () => {
    const tree = { a: 1, b: { c: "x", d: [1, 2, { e: null }] }, f: false };
    const copy = JSON.parse(JSON.stringify(tree)) as unknown;
    assert.deepEqual(diffStateTrees(tree, copy, "world"), []);
  });

  it("值变化：标量叶产出 {before, after}", () => {
    assert.deepEqual(diffStateTrees({ a: 1 }, { a: 2 }, "world"), [
      { path: "world.a", before: 1, after: 2 },
    ]);
    // null ↔ 值、类型替换（记录 ↔ 标量）都按叶级值变化整体记录
    assert.deepEqual(diffStateTrees({ a: null }, { a: "x" }, "world"), [
      { path: "world.a", before: null, after: "x" },
    ]);
    assert.deepEqual(diffStateTrees({ a: { b: 1 } }, { a: 5 }, "world"), [
      { path: "world.a", before: { b: 1 }, after: 5 },
    ]);
  });

  it("路径新增：before=null + before_exists=false（嵌套键与新子树）", () => {
    assert.deepEqual(diffStateTrees({}, { region: { harbor: { fog: true } } }, "world"), [
      { path: "world.region", before: null, after: { harbor: { fog: true } }, before_exists: false },
    ]);
    assert.deepEqual(
      diffStateTrees({ region: { harbor: {} } }, { region: { harbor: { fog: true } } }, "world"),
      [{ path: "world.region.harbor.fog", before: null, after: true, before_exists: false }],
    );
  });

  it("路径删除：before 保留原值 + after=null + after_exists=false（差异子树根一条记录）", () => {
    assert.deepEqual(diffStateTrees({ region: { harbor: { fog: true } } }, {}, "world"), [
      { path: "world.region", before: { harbor: { fog: true } }, after: null, after_exists: false },
    ]);
    assert.deepEqual(
      diffStateTrees({ region: { harbor: { fog: true } } }, { region: { harbor: {} } }, "world"),
      [{ path: "world.region.harbor.fog", before: true, after: null, after_exists: false }],
    );
  });

  it("嵌套混合：变化 / 新增 / 删除同趟产出，顺序确定（先旧树键序、后新树新增键）", () => {
    const oldTree = { keep: 1, chg: { x: 1 }, del: { y: 2 } };
    const newTree = { keep: 1, chg: { x: 2 }, add: 3 };
    assert.deepEqual(diffStateTrees(oldTree, newTree, "world"), [
      { path: "world.chg.x", before: 1, after: 2 },
      { path: "world.del", before: { y: 2 }, after: null, after_exists: false },
      { path: "world.add", before: null, after: 3, before_exists: false },
    ]);
  });

  it("数组按索引：同位变化走叶级 diff；长度差在尾部产出新增/删除", () => {
    // 同位元素变化
    assert.deepEqual(diffStateTrees({ arr: ["a", "b", "c"] }, { arr: ["a", "B", "c"] }, "w"), [
      { path: "w.arr.1", before: "b", after: "B" },
    ]);
    // 增长：尾部新增 before_exists=false
    assert.deepEqual(diffStateTrees({ arr: ["a"] }, { arr: ["a", "b", "c"] }, "w"), [
      { path: "w.arr.1", before: null, after: "b", before_exists: false },
      { path: "w.arr.2", before: null, after: "c", before_exists: false },
    ]);
    // 缩短：尾部删除 before 保留原值 + after_exists=false
    assert.deepEqual(diffStateTrees({ arr: ["a", "b", "c"] }, { arr: ["a"] }, "w"), [
      { path: "w.arr.1", before: "b", after: null, after_exists: false },
      { path: "w.arr.2", before: "c", after: null, after_exists: false },
    ]);
    // 中间删除（错位）按索引语义：同位变化 + 尾部删除
    assert.deepEqual(diffStateTrees({ arr: ["a", "b", "c"] }, { arr: ["a", "c"] }, "w"), [
      { path: "w.arr.1", before: "b", after: "c" },
      { path: "w.arr.2", before: "c", after: null, after_exists: false },
    ]);
    // 数组元素是对象：递归到叶
    assert.deepEqual(diffStateTrees({ arr: [{ hp: 1 }] }, { arr: [{ hp: 2 }] }, "w"), [
      { path: "w.arr.0.hp", before: 1, after: 2 },
    ]);
  });

  it("characters 域空前缀：首段即 CID（C1001.timer 约定）", () => {
    const oldChars = { C1001: { timer: 10, vars: { hp: 1 } } };
    const newChars = { C1001: { timer: 20, vars: { hp: 1, mp: 3 } } };
    assert.deepEqual(diffStateTrees(oldChars, newChars, ""), [
      { path: "C1001.timer", before: 10, after: 20 },
      { path: "C1001.vars.mp", before: null, after: 3, before_exists: false },
    ]);
  });

  it("纯函数：不改入参", () => {
    const oldTree = { a: { b: [1, 2] } };
    const newTree = { a: { b: [1, 3], c: true } };
    const oldFrozen = JSON.stringify(oldTree);
    const newFrozen = JSON.stringify(newTree);
    diffStateTrees(oldTree, newTree, "world");
    assert.equal(JSON.stringify(oldTree), oldFrozen);
    assert.equal(JSON.stringify(newTree), newFrozen);
  });
});
