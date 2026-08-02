import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import { LoreStore, rollbackLore, type LoreFile } from "../src/truth/loreStore.js";
import { SAVE_SCHEMA_VERSION } from "../src/truth/saveSchema.js";
import type { LoreEntry } from "../src/types.js";

const e = (id: string, content = `${id}内容`): LoreEntry => ({ id, tags: [], content });

describe("LoreStore（存档 v2 文件 2：lore.json 档内副本 + changelog 回滚）", () => {
  it("initFrom 拷入世界 lorebook（只动副本）", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "airp-lore-"));
    const store = LoreStore.initFrom("t1", [e("a"), e("b")], dir);
    assert.deepEqual(
      store.book().all().map((x) => x.id),
      ["a", "b"],
    );
    // 档内变更不影响传入数组
    store.applyChange({ seq: 3, op: "delete", before: e("a"), after: null });
    assert.deepEqual(
      LoreStore.load("t1", dir).book().all().map((x) => x.id),
      ["b"],
    );
  });

  it("applyChange：add/delete/update 均带 before/after + seq 锚", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "airp-lore-"));
    const store = LoreStore.initFrom("t1", [e("a")], dir);
    store.applyChange({ seq: 4, op: "add", before: null, after: e("b") });
    store.applyChange({ seq: 8, op: "update", before: e("b"), after: e("b", "b改后") });
    store.applyChange({ seq: 12, op: "delete", before: e("a"), after: null });

    const book = LoreStore.load("t1", dir).book();
    assert.equal(book.getByIds(["b"])[0]!.content, "b改后");
    assert.throws(() => book.getByIds(["a"]), /不存在/);
  });

  it("rollbackLore 纯函数：逐轮反向回滚到指定 seq", () => {
    const file: LoreFile = {
      schema_version: SAVE_SCHEMA_VERSION,
      entries: [e("b", "b改后")],
      changelog: [
        { seq: 4, op: "add", before: null, after: e("b") },
        { seq: 8, op: "update", before: e("b"), after: e("b", "b改后") },
        { seq: 12, op: "delete", before: e("a"), after: null },
      ],
    };
    // 回滚到 seq 8：撤销 delete → a 复原；b 保持改后
    const r8 = rollbackLore(file, 8);
    assert.deepEqual(
      r8.entries.map((x) => x.id).sort(),
      ["a", "b"],
    );
    assert.equal(r8.changelog.length, 2);
    // 回滚到 seq 4：再撤销 update → b 回原文
    const r4 = rollbackLore(file, 4);
    assert.equal(r4.entries.find((x) => x.id === "b")!.content, "b内容");
    // 回滚到 seq 0：再撤销 add → 只剩基线的 a
    assert.deepEqual(
      rollbackLore(file, 0).entries.map((x) => x.id),
      ["a"],
    );
  });

  it("rollbackToSeq 落盘", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "airp-lore-"));
    const store = LoreStore.initFrom("t1", [e("a")], dir);
    store.applyChange({ seq: 5, op: "delete", before: e("a"), after: null });
    store.rollbackToSeq(3);
    assert.deepEqual(
      LoreStore.load("t1", dir).book().all().map((x) => x.id),
      ["a"],
    );
  });
});
