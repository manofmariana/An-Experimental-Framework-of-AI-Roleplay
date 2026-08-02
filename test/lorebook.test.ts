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

  it("getByTags：命中任一标签即收录，返回按 ID 排序", () => {
    const book = new Lorebook([
      { id: "b", tags: ["白滩镇：常识"], content: "B" },
      { id: "a", tags: ["白滩镇：常识", "灯塔"], content: "A" },
      { id: "c", tags: ["灯塔：秘密"], content: "C" },
    ]);
    assert.deepEqual(
      book.getByTags(["白滩镇：常识"]).map((e) => e.id),
      ["a", "b"],
    );
    assert.deepEqual(
      book.getByTags(["白滩镇：常识", "灯塔：秘密"]).map((e) => e.id),
      ["a", "b", "c"],
    );
    assert.deepEqual(book.getByTags(["不存在的标签"]), []);
  });

  it("示例世界设定集可加载且条目按 ID 有序", () => {
    const book = Lorebook.load(path.join(resolveWorldDir("baitan"), "lorebook.json"));
    const ids = book.all().map((e) => e.id);
    assert.deepEqual(ids, [...ids].sort((x, y) => x.localeCompare(y)));
    assert.ok(ids.length >= 3 && ids.length <= 5, "示例数据应为 3-5 条 lore");
    // 角色固定标签自动激活：示例角色 tags = ["白滩镇：常识", "灯塔"]
    const activated = book.getByTags(["白滩镇：常识", "灯塔"]);
    assert.ok(activated.length >= 2, "固定标签应激活多条 lore");
    assert.ok(
      activated.every((e) => e.tags.includes("白滩镇：常识") || e.tags.includes("灯塔")),
    );
  });
});
