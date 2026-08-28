import assert from "node:assert/strict";
import path from "node:path";
import { describe, it } from "node:test";
import { resolveWorldDir } from "../src/config.js";
import { Lorebook } from "../src/truth/lorebook.js";
import { buildLoreEntry } from "./builders/index.js";

describe("Lorebook（条目容器：ID 唯一 + 确定性排序；TAG 过滤在引擎）", () => {
  it("按 ID 取条目：返回按 ID 字典序排序（与传入顺序无关）", () => {
    const book = new Lorebook([
      buildLoreEntry("b", "乙"),
      buildLoreEntry("a", "甲"),
      buildLoreEntry("c", "丙"),
    ]);
    assert.deepEqual(
      book.getByIds(["c", "a"]).map((e) => e.id.value),
      ["a", "c"],
    );
    assert.throws(() => book.getByIds(["zz"]), /不存在/);
  });

  it("ID 重复拒装；all() 按 ID 排序", () => {
    assert.throws(
      () =>
        new Lorebook([
          buildLoreEntry("a", "甲"),
          buildLoreEntry("a", " duplicate"),
        ]),
      /重复/,
    );
    const book = new Lorebook([buildLoreEntry("b", "乙"), buildLoreEntry("a", "甲")]);
    assert.deepEqual(
      book.all().map((e) => e.id.value),
      ["a", "b"],
    );
  });

  it("出厂世界包 lores.json 可加载（末端外壳：tags 全部落在 content 末端）", () => {
    const book = Lorebook.load(path.join(resolveWorldDir("baitan"), "lores.json"));
    assert.ok(book.all().length >= 3);
    const entry = book.getByIds(["loc_baitan"])[0]!;
    assert.equal(entry.content.value.startsWith("白滩镇"), true);
    assert.deepEqual(entry.content.tags, [{ name: "白滩镇：常识", level: 1 }]);
  });
});
