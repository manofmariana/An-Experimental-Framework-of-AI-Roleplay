import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  ArchiveStore,
  buildArchiveEntry,
  type ArchiveEntry,
} from "../src/truth/archive.js";
import { tempDir } from "./harness/tempDir.js";

describe("buildArchiveEntry（归档写入时机的纯函数核心）", () => {
  it("current 为 null（会话刚开始）→ 无可归档", () => {
    assert.equal(buildArchiveEntry(null), null);
  });

  it("组装 {seq, kind, result, var_changes}；edited 随归档传播", () => {
    const current = {
      seq: 5,
      kind: "gm",
      result: { raw: "…", adjudication: {} },
      var_changes: [
        { path: "vars.hp", before: 7, after: 3 },
        { path: "clock", before: 12, after: 22 },
      ],
      edited: true,
    };
    const entry = buildArchiveEntry(current)!;
    assert.equal(entry.seq, 5);
    assert.equal(entry.kind, "gm");
    assert.deepEqual(entry.var_changes, current.var_changes);
    assert.equal(entry.edited, true);
    // 无 edited/var_changes 时缺省
    const plain = buildArchiveEntry({ seq: 1, kind: "player", result: { input: "x" } })!;
    assert.equal(plain.edited, undefined);
    assert.deepEqual(plain.var_changes, []);
  });
});

describe("ArchiveStore（存档 v2 文件 5：archive.json）", () => {
  it("append 落盘 → 重载读回；truncateToSeq", () => {
    const dir = tempDir("airp-arch-");
    const store = new ArchiveStore("t1", dir);
    const mk = (seq: number, kind: string): ArchiveEntry =>
      buildArchiveEntry({ seq, kind, result: {}, var_changes: [] })!;
    store.append(mk(1, "player"));
    store.append(mk(2, "character:C1001"));
    store.append(mk(3, "gm"));
    store.append(mk(4, "prose"));

    const reloaded = new ArchiveStore("t1", dir);
    assert.deepEqual(
      reloaded.readAll().map((e) => `${e.seq}:${e.kind}`),
      ["1:player", "2:character:C1001", "3:gm", "4:prose"],
    );

    reloaded.truncateToSeq(2);
    assert.deepEqual(
      new ArchiveStore("t1", dir).readAll().map((e) => e.seq),
      [1, 2],
    );
  });
});

describe("seq 计数约定（说明性断言）", () => {
  it("M1 固定顺序：一轮 = 4 个 seq（玩家轮也算一个 seq）", () => {
    // 总轮次计数 = 每次 API 调用 + 玩家输入。
    // 未来工具 Agent 调用【不计入】seq：工具 Agent 有独立计数器，与 seq 一一对应记录；
    // 回溯跨越含工具 Agent 结构变更的 seq 时强制绑定回滚（P2+，DESIGN-P1 §10.2）。
    const dir = tempDir("airp-arch-");
    const store = new ArchiveStore("t1", dir);
    const kinds = ["player", "character:C1001", "gm", "prose"];
    kinds.forEach((kind, i) =>
      store.append(buildArchiveEntry({ seq: i + 1, kind, result: {} })!),
    );
    assert.deepEqual(
      store.readAll().map((e) => [e.seq, e.kind]),
      [
        [1, "player"],
        [2, "character:C1001"],
        [3, "gm"],
        [4, "prose"],
      ],
    );
  });
});
