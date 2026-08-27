import assert from "node:assert/strict";
import path from "node:path";
import { describe, it } from "node:test";
import { resolveWorldDir } from "../src/config.js";
import { Lorebook } from "../src/truth/lorebook.js";

describe("Lorebook（激活制条目库，统一标签）", () => {
  it("getByIds 按 ID 排序返回（与传入顺序无关）且去重", () => {
    const book = new Lorebook([
      { id: "b", tags: [], content: "B" },
      { id: "a", tags: [], content: "A" },
      { id: "c", tags: [], content: "C" },
    ]);
    const entries = book.getByIds(["c", "a", "c", "b"]);
    assert.deepEqual(
      entries.map((e) => e.id),
      ["a", "b", "c"],
    );
  });

  it("未知 ID 抛错", () => {
    const book = new Lorebook([{ id: "a", tags: [], content: "A" }]);
    assert.throws(() => book.getByIds(["nope"]), /不存在/);
  });

  it("重复 ID 的条目库拒绝加载", () => {
    assert.throws(
      () =>
        new Lorebook([
          { id: "a", tags: [], content: "1" },
          { id: "a", tags: [], content: "2" },
        ]),
      /重复/,
    );
  });

  it("getByTags：逐条目求值——读者持有任一同级 TAG 即收录（一级组取或 ≡ 旧命中任一），返回按 ID 排序", () => {
    const m = (name: string): { name: string; level: number } => ({ name, level: 1 });
    const book = new Lorebook([
      { id: "b", tags: [m("白滩镇：常识")], content: "B" },
      { id: "a", tags: [m("白滩镇：常识"), m("灯塔")], content: "A" },
      { id: "c", tags: [m("灯塔：秘密")], content: "C" },
    ]);
    assert.deepEqual(
      book.getByTags({ tags: new Set(["白滩镇：常识"]) }, {}).map((e) => e.id),
      ["a", "b"],
    );
    assert.deepEqual(
      book.getByTags({ tags: new Set(["白滩镇：常识", "灯塔：秘密"]) }, {}).map((e) => e.id),
      ["a", "b", "c"],
    );
    assert.deepEqual(book.getByTags({ tags: new Set(["不存在的标签"]) }, {}), []);
  });

  it("getByTags：无挂载条目恒通过（广播）；跨级 = 与；权重 6 全知恒见", () => {
    const book = new Lorebook([
      { id: "a", tags: [], content: "A" },
      {
        id: "b",
        tags: [
          { name: "白滩镇：常识", level: 1 },
          { name: "灯塔：秘密", level: 2 },
        ],
        content: "B",
      },
    ]);
    // 权重 0 只持其一：跨级与不满足 → 只见广播条目
    assert.deepEqual(book.getByTags({ tags: new Set(["白滩镇：常识"]) }, {}).map((e) => e.id), ["a"]);
    // 两者皆持 → 全见
    assert.deepEqual(
      book.getByTags({ tags: new Set(["白滩镇：常识", "灯塔：秘密"]) }, {}).map((e) => e.id),
      ["a", "b"],
    );
    // 权重 6 全知：虚拟挂载覆盖 ≤6 级组恒见
    assert.deepEqual(
      book.getByTags({ tags: new Set<string>(), omniscienceWeight: 6 }, {}).map((e) => e.id),
      ["a", "b"],
    );
  });

  it("示例世界设定集可加载且条目按 ID 有序", () => {
    const book = Lorebook.load(path.join(resolveWorldDir("baitan"), "lorebook.json"));
    const ids = book.all().map((e) => e.id);
    assert.deepEqual(ids, [...ids].sort((x, y) => x.localeCompare(y)));
    assert.ok(ids.length >= 3 && ids.length <= 5, "示例数据应为 3-5 条 lore");
    // 角色固定标签自动激活：示例角色 tags = ["白滩镇：常识", "灯塔"]
    const activated = book.getByTags({ tags: new Set(["白滩镇：常识", "灯塔"]) }, {});
    assert.ok(activated.length >= 2, "固定标签应激活多条 lore");
    assert.ok(
      activated.every((e) => e.tags.some((t) => t.name === "白滩镇：常识" || t.name === "灯塔")),
    );
  });
});
