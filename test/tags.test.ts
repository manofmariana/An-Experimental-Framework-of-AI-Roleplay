import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  FORCE_OMNISCIENT_TAG,
  OMNISCIENT_TAG,
  parseTagRegistry,
  type TagRegistry,
} from "../src/tags/registry.js";
import {
  evalCondition,
  evaluateTagFilter,
  type MountedTag,
  type ReaderScope,
} from "../src/tags/evaluate.js";

// ---------------------------------------------------------------------------
// 测试基建
// ---------------------------------------------------------------------------

/** 最小注册表：纯名称条目 + condition 条目 + 类别声明。 */
const REGISTRY: TagRegistry = parseTagRegistry({
  aud: { name: "aud", system: true },
  vis: { name: "vis", system: true },
  A: { name: "A", system: true },
  V: { name: "V", system: true },
  全知: { name: "全知", system: true },
  强制全知: { name: "强制全知", system: true },
  魔法师: { name: "魔法师" },
  暗语: { name: "暗语" },
  密探: { name: "密探" },
  王室: { name: "王室" },
  感知门槛: { name: "感知门槛", condition: { path: "characters.self.感知", op: "ge", value: 5 } },
  感知区间: { name: "感知区间", condition: { path: "characters.self.感知", op: "between", value: [3, 7] } },
  中毒状态: { name: "中毒状态", condition: { path: "characters.self.状态", op: "contains", value: "中毒" } },
  类别cid: { name: "类别cid", category: "cid" },
  类别channel: { name: "类别channel", category: "channel" },
  类别location: { name: "类别location", category: "location" },
});

function reader(tags: string[], extra?: Partial<ReaderScope>): ReaderScope {
  return { tags: new Set(tags), ...extra };
}

function mount(...tags: Array<[string, number]>): MountedTag[] {
  return tags.map(([name, level]) => ({ name, level }));
}

// ---------------------------------------------------------------------------
// 注册表校验
// ---------------------------------------------------------------------------

describe("parseTagRegistry", () => {
  it("接受合法注册表", () => {
    assert.equal(REGISTRY["魔法师"]?.name, "魔法师");
    assert.equal(REGISTRY["感知门槛"]?.condition?.op, "ge");
  });

  it("键名必须等于条目名", () => {
    assert.throws(() => parseTagRegistry({ x: { name: "y" } }), /键名不一致/);
  });

  it("system: true 必须在代码常量内", () => {
    assert.throws(() => parseTagRegistry({ x: { name: "x", system: true } }), /不在代码常量内/);
  });

  it("程序化 TAG 名称不得被非 system 条目占用", () => {
    assert.throws(() => parseTagRegistry({ aud: { name: "aud" } }), /占用/);
  });

  it("类别声明唯一", () => {
    assert.throws(
      () =>
        parseTagRegistry({
          a: { name: "a", category: "cid" },
          b: { name: "b", category: "cid" },
        }),
      /重复声明/,
    );
  });

  it("between 的 value 必须是数值二元组，其余 op 禁止数组 value", () => {
    assert.throws(() =>
      parseTagRegistry({ x: { name: "x", condition: { path: "p", op: "between", value: 5 } } }),
    );
    assert.throws(() =>
      parseTagRegistry({ x: { name: "x", condition: { path: "p", op: "eq", value: [1, 2] } } }),
    );
    assert.doesNotThrow(() =>
      parseTagRegistry({ x: { name: "x", condition: { path: "p", op: "between", value: [1, 2] } } }),
    );
  });
});

// ---------------------------------------------------------------------------
// 等级表达式：T =（一级 ∨）∧ … ∧（七级 ∨）
// ---------------------------------------------------------------------------

describe("等级表达式求值", () => {
  const content = mount(["魔法师", 1], ["暗语", 1], ["密探", 2]);

  it("同级取或、跨级取与", () => {
    // 只中一级 → 二级组不满足 → fail
    assert.equal(evaluateTagFilter({ content: "x", tags: content }, reader(["魔法师"]), REGISTRY).status, "fail");
    // 只中二级 → fail
    assert.equal(evaluateTagFilter({ content: "x", tags: content }, reader(["密探"]), REGISTRY).status, "fail");
    // 两组各中其一 → pass
    assert.equal(evaluateTagFilter({ content: "x", tags: content }, reader(["魔法师", "密探"]), REGISTRY).status, "pass");
    assert.equal(evaluateTagFilter({ content: "x", tags: content }, reader(["暗语", "密探"]), REGISTRY).status, "pass");
  });

  it("多级与运算：分挂三级的 A/B/C 必须全部持有", () => {
    const abc = mount(["魔法师", 1], ["密探", 2], ["王室", 3]);
    assert.equal(
      evaluateTagFilter({ content: 1, tags: abc }, reader(["魔法师", "密探", "王室"]), REGISTRY).status,
      "pass",
    );
    assert.equal(
      evaluateTagFilter({ content: 1, tags: abc }, reader(["魔法师", "密探"]), REGISTRY).status,
      "fail",
    );
  });

  it("无 TAG = 恒通过，matched 为空（含空内容合法放行）", () => {
    const r = evaluateTagFilter({ content: null, tags: [] }, reader([]), REGISTRY);
    assert.equal(r.status, "pass");
    assert.equal(r.content, null);
    assert.deepEqual(r.matched, []);
  });

  it("空等级组无约束：只挂一级时其余级不参与判定", () => {
    const r = evaluateTagFilter({ content: "x", tags: mount(["魔法师", 1]) }, reader(["魔法师"]), REGISTRY);
    assert.equal(r.status, "pass");
  });

  it("pass 原样返回 content 引用，fail 返回 null", () => {
    const value = { hp: 50 };
    const ok = evaluateTagFilter({ content: value, tags: mount(["魔法师", 1]) }, reader(["魔法师"]), REGISTRY);
    assert.equal(ok.content, value);
    const no = evaluateTagFilter({ content: value, tags: mount(["魔法师", 1]) }, reader([]), REGISTRY);
    assert.equal(no.status, "fail");
    assert.equal(no.content, null);
  });

  it("等级越界拒绝（1-7 封闭）", () => {
    assert.throws(
      () => evaluateTagFilter({ content: 1, tags: mount(["魔法师", 8]) }, reader(["魔法师"]), REGISTRY),
      RangeError,
    );
    assert.throws(
      () => evaluateTagFilter({ content: 1, tags: mount(["魔法师", 0]) }, reader(["魔法师"]), REGISTRY),
      RangeError,
    );
  });
});

// ---------------------------------------------------------------------------
// 全知权重 + 虚拟挂载
// ---------------------------------------------------------------------------

describe("全知权重", () => {
  it("权重 N 覆盖每一级 ≤ N 的非空组；N+1 级即全知打破", () => {
    const low = mount(["魔法师", 1], ["密探", 2]);
    const high = mount(["王室", 3]);
    const w2 = reader([], { omniscienceWeight: 2 });
    assert.equal(evaluateTagFilter({ content: 1, tags: low }, w2, REGISTRY).status, "pass");
    assert.equal(evaluateTagFilter({ content: 1, tags: high }, w2, REGISTRY).status, "fail");
  });

  it("匹配扁平：多个等级组被覆盖，matched 中全知只出现一次", () => {
    const tags = mount(["魔法师", 1], ["密探", 2]);
    const r = evaluateTagFilter({ content: 1, tags }, reader([], { omniscienceWeight: 6 }), REGISTRY);
    assert.equal(r.status, "pass");
    assert.deepEqual(r.matched, [OMNISCIENT_TAG]);
  });

  it("GM 配置（权重 6 + 持强制全知）全集可见，matched = {全知, 强制全知}", () => {
    const tags = mount(["魔法师", 1], ["王室", 7]);
    const gm = reader([FORCE_OMNISCIENT_TAG], { omniscienceWeight: 6 });
    const r = evaluateTagFilter({ content: 1, tags }, gm, REGISTRY);
    assert.equal(r.status, "pass");
    assert.deepEqual(r.matched, [OMNISCIENT_TAG, FORCE_OMNISCIENT_TAG].sort());
  });

  it("强制全知只覆盖七级组：权重 6 不持强制全知 → 七级内容不可见", () => {
    const tags = mount(["王室", 7]);
    assert.equal(
      evaluateTagFilter({ content: 1, tags }, reader([], { omniscienceWeight: 6 }), REGISTRY).status,
      "fail",
    );
    // 强制全知对一至六级无覆盖（权重 0 + 持强制全知见不了低级组）
    assert.equal(
      evaluateTagFilter({ content: 1, tags: mount(["魔法师", 1]) }, reader([FORCE_OMNISCIENT_TAG]), REGISTRY).status,
      "fail",
    );
  });

  it("权重 0 = 常规角色；tags 集挂字面全知无覆盖效果", () => {
    const tags = mount(["魔法师", 1]);
    assert.equal(evaluateTagFilter({ content: 1, tags }, reader([]), REGISTRY).status, "fail");
    assert.equal(evaluateTagFilter({ content: 1, tags }, reader([OMNISCIENT_TAG]), REGISTRY).status, "fail");
  });

  it("无 TAG 内容不追加虚拟挂载，任何权重下恒通过且 matched 为空", () => {
    const r = evaluateTagFilter({ content: 1, tags: [] }, reader([], { omniscienceWeight: 6 }), REGISTRY);
    assert.equal(r.status, "pass");
    assert.deepEqual(r.matched, []);
  });

  it("权重越界拒绝（0-6 整数）", () => {
    assert.throws(
      () => evaluateTagFilter({ content: 1, tags: [] }, reader([], { omniscienceWeight: 7 }), REGISTRY),
      RangeError,
    );
    assert.throws(
      () => evaluateTagFilter({ content: 1, tags: [] }, reader([], { omniscienceWeight: 1.5 }), REGISTRY),
      RangeError,
    );
  });
});

// ---------------------------------------------------------------------------
// matched 归一化
// ---------------------------------------------------------------------------

describe("开放类别归一化", () => {
  const instances = {
    cid: new Set(["C01", "C02"]),
    channel: new Set(["ch-3"]),
    location: new Set(["酒馆"]),
  };

  it("类别实例命中报类别名记号，字面 TAG 报本名", () => {
    const tags = mount(["C01", 1], ["魔法师", 1]);
    const r = evaluateTagFilter({ content: 1, tags }, reader(["C01", "魔法师"], { categoryInstances: instances }), REGISTRY);
    assert.equal(r.status, "pass");
    assert.deepEqual(r.matched, ["cid", "魔法师"]);
  });

  it("channel / location 实例同样归一化", () => {
    const tags = mount(["ch-3", 1], ["酒馆", 2]);
    const r = evaluateTagFilter({ content: 1, tags }, reader(["ch-3", "酒馆"], { categoryInstances: instances }), REGISTRY);
    assert.deepEqual(r.matched, ["channel", "location"]);
  });

  it("未登记为实例的同名按字面 TAG 处理", () => {
    const tags = mount(["C99", 1]);
    const r = evaluateTagFilter({ content: 1, tags }, reader(["C99"], { categoryInstances: instances }), REGISTRY);
    assert.deepEqual(r.matched, ["C99"]);
  });

  it("matched 去重排序（同名多处命中只出一次）", () => {
    const tags = mount(["魔法师", 1], ["魔法师", 2]);
    const r = evaluateTagFilter({ content: 1, tags }, reader(["魔法师"]), REGISTRY);
    assert.deepEqual(r.matched, ["魔法师"]);
  });
});

// ---------------------------------------------------------------------------
// condition 求值
// ---------------------------------------------------------------------------

describe("condition", () => {
  const perception = (v: unknown) => (path: string) => (path === "characters.self.感知" ? v : undefined);
  const status = (v: unknown) => (path: string) => (path === "characters.self.状态" ? v : undefined);

  it("ge / between / contains 求真", () => {
    const ge = mount(["感知门槛", 1]);
    assert.equal(evaluateTagFilter({ content: 1, tags: ge }, reader([], { varReader: perception(6) }), REGISTRY).status, "pass");
    assert.equal(evaluateTagFilter({ content: 1, tags: ge }, reader([], { varReader: perception(4) }), REGISTRY).status, "fail");

    const between = mount(["感知区间", 1]);
    assert.equal(evaluateTagFilter({ content: 1, tags: between }, reader([], { varReader: perception(3) }), REGISTRY).status, "pass");
    assert.equal(evaluateTagFilter({ content: 1, tags: between }, reader([], { varReader: perception(8) }), REGISTRY).status, "fail");

    const contains = mount(["中毒状态", 1]);
    assert.equal(evaluateTagFilter({ content: 1, tags: contains }, reader([], { varReader: status(["中毒", "疲惫"]) }), REGISTRY).status, "pass");
    assert.equal(evaluateTagFilter({ content: 1, tags: contains }, reader([], { varReader: status(["疲惫"]) }), REGISTRY).status, "fail");
  });

  it("condition 为真计入 matched；直接持有同名 TAG 时不走 condition", () => {
    const tags = mount(["感知门槛", 1]);
    const byCond = evaluateTagFilter({ content: 1, tags }, reader([], { varReader: perception(9) }), REGISTRY);
    assert.deepEqual(byCond.matched, ["感知门槛"]);
    const byHold = evaluateTagFilter({ content: 1, tags }, reader(["感知门槛"], { varReader: perception(0) }), REGISTRY);
    assert.equal(byHold.status, "pass");
    assert.deepEqual(byHold.matched, ["感知门槛"]);
  });

  it("fail-closed：无 varReader / 路径取不到值 / 类型错配均不成立", () => {
    const tags = mount(["感知门槛", 1]);
    assert.equal(evaluateTagFilter({ content: 1, tags }, reader([]), REGISTRY).status, "fail");
    assert.equal(evaluateTagFilter({ content: 1, tags }, reader([], { varReader: () => undefined }), REGISTRY).status, "fail");
    assert.equal(evaluateTagFilter({ content: 1, tags }, reader([], { varReader: perception("高") }), REGISTRY).status, "fail");
  });

  it("组被全知权重覆盖时跳过 condition 求值（varReader 被调用即失败）", () => {
    const tags = mount(["感知门槛", 1]);
    const boom = () => {
      throw new Error("全知读者不应触发 varReader");
    };
    const r = evaluateTagFilter({ content: 1, tags }, reader([], { omniscienceWeight: 1, varReader: boom }), REGISTRY);
    assert.equal(r.status, "pass");
    assert.deepEqual(r.matched, [OMNISCIENT_TAG]);
  });

  it("evalCondition 全 op 直测", () => {
    const rd = (v: unknown) => () => v;
    assert.equal(evalCondition({ path: "p", op: "eq", value: 5 }, rd(5)), true);
    assert.equal(evalCondition({ path: "p", op: "ne", value: 5 }, rd(4)), true);
    assert.equal(evalCondition({ path: "p", op: "lt", value: 5 }, rd(4)), true);
    assert.equal(evalCondition({ path: "p", op: "le", value: 5 }, rd(5)), true);
    assert.equal(evalCondition({ path: "p", op: "gt", value: 5 }, rd(6)), true);
    assert.equal(evalCondition({ path: "p", op: "ge", value: 5 }, rd(5)), true);
    assert.equal(evalCondition({ path: "p", op: "between", value: [3, 7] }, rd(7)), true);
    assert.equal(evalCondition({ path: "p", op: "contains", value: "毒" }, rd("剧毒药膏")), true);
    assert.equal(evalCondition({ path: "p", op: "eq", value: 5 }, rd("5")), false);
  });
});
