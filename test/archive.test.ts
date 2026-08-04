import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  ArchiveStore,
  buildArchiveEntry,
  type ArchiveEntry,
} from "../src/truth/archive.js";

describe("buildArchiveEntry（归档写入时机的纯函数核心）", () => {
  it("current 为 null（会话刚开始）→ 无可归档", () => {
    assert.equal(buildArchiveEntry(null), null);
  });

  it("组装 {seq, kind, result, changes}（setup/effects 分段）；edited 随归档传播", () => {
    const current = {
      seq: 5,
      kind: "gm",
      result: { raw: "…", adjudication: {} },
      changes: {
        setup: [{ path: "clock", before: 12, after: 22 }],
        effects: [{ path: "vars.hp", before: 7, after: 3 }],
      },
      edited: true,
    };
    const entry = buildArchiveEntry(current)!;
    assert.equal(entry.seq, 5);
    assert.equal(entry.kind, "gm");
    assert.deepEqual(entry.changes, current.changes);
    assert.equal(entry.edited, true);
    // 无 edited/changes 时：edited 缺省、changes 落空分段
    const plain = buildArchiveEntry({ seq: 1, kind: "player", result: { input: "x" } })!;
    assert.equal(plain.edited, undefined);
    assert.deepEqual(plain.changes, { setup: [], effects: [] });
  });
});

describe("ArchiveStore（纯内存容器；落盘归 GenerationRepository）", () => {
  it("append → saveData 回环读回；truncateToSeq", () => {
    const store = new ArchiveStore();
    const mk = (seq: number, kind: string): ArchiveEntry =>
      buildArchiveEntry({ seq, kind, result: {}, changes: { setup: [], effects: [] } })!;
    store.append(mk(1, "player"));
    store.append(mk(2, "character:C1001"));
    store.append(mk(3, "gm"));
    store.append(mk(4, "prose"));

    const reloaded = new ArchiveStore(store.saveData());
    assert.deepEqual(
      reloaded.readAll().map((e) => `${e.seq}:${e.kind}`),
      ["1:player", "2:character:C1001", "3:gm", "4:prose"],
    );

    reloaded.truncateToSeq(2);
    assert.deepEqual(
      new ArchiveStore(reloaded.saveData()).readAll().map((e) => e.seq),
      [1, 2],
    );
  });
});

describe("seq 计数约定（说明性断言）", () => {
  it("M1 固定顺序：一轮 = 4 个 seq（玩家轮也算一个 seq）", () => {
    // 总轮次计数 = 每次 API 调用 + 玩家输入。
    // 未来工具 Agent 调用【不计入】seq：工具 Agent 有独立计数器，与 seq 一一对应记录；
    // 回溯跨越含工具 Agent 结构变更的 seq 时强制绑定回滚。
    const store = new ArchiveStore();
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
