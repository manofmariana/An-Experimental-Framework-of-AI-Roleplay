/**
 * applySecretMutation / toSecretState 纯逻辑（unit 层：严格零 IO）。
 * 覆盖 SecretMutation 判别联合全分支、delete active 继任规则、不变量保持与掩码形状。
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  SecretsFileSchema,
  type SecretsFile,
} from "../src/contracts/secrets.js";
import {
  applySecretMutation,
  SecretsRepositoryError,
  toSecretState,
} from "../src/resources/secretsRepository.js";

let idCounter = 0;
/** 确定性 id 生成器（sec-1, sec-2, ...）。 */
const genId = (): string => `sec-${++idCounter}`;

const baseFile = (): SecretsFile => ({
  deepseek: [
    { id: "a", value: "sk-aaaa1111", label: "主 key", active: true },
    { id: "b", value: "sk-bbbb2222", label: "备用", active: false },
    { id: "c", value: "skcc", label: "短 key", active: false },
  ],
  openai: [{ id: "x", value: "oa-123456", label: "oa", active: true }],
});

describe("applySecretMutation：write", () => {
  it("写入空 kind：新记录即 active；id 来自注入的 generateId", () => {
    const next = applySecretMutation(
      {},
      { type: "write", kind: "deepseek", value: "sk-new-0001", label: "新 key" },
      genId,
    );
    assert.deepEqual(next.deepseek, [
      { id: "sec-1", value: "sk-new-0001", label: "新 key", active: true },
    ]);
  });

  it("写入已有 kind：新记录 inactive，原 active 不动", () => {
    let n = 0;
    const next = applySecretMutation(
      baseFile(),
      { type: "write", kind: "deepseek", value: "sk-dddd3333", label: "第三把" },
      () => `w-${++n}`,
    );
    assert.equal(next.deepseek!.length, 4);
    assert.deepEqual(next.deepseek![3], {
      id: "w-1",
      value: "sk-dddd3333",
      label: "第三把",
      active: false,
    });
    assert.equal(next.deepseek![0]!.active, true);
  });

  it("不修改入参（纯函数）", () => {
    const file = baseFile();
    const snapshot = JSON.stringify(file);
    applySecretMutation(file, { type: "rename", kind: "deepseek", id: "a", label: "改名" });
    applySecretMutation(file, { type: "delete", kind: "deepseek", id: "a" });
    assert.equal(JSON.stringify(file), snapshot);
  });
});

describe("applySecretMutation：delete 与继任规则", () => {
  it("删除非 active：其余不动", () => {
    const next = applySecretMutation(baseFile(), { type: "delete", kind: "deepseek", id: "b" });
    assert.deepEqual(
      next.deepseek!.map((r) => r.id),
      ["a", "c"],
    );
    assert.equal(next.deepseek![0]!.active, true);
  });

  it("删除 active：剩余首条继任 active", () => {
    const next = applySecretMutation(baseFile(), { type: "delete", kind: "deepseek", id: "a" });
    assert.deepEqual(
      next.deepseek!.map((r) => [r.id, r.active]),
      [
        ["b", true],
        ["c", false],
      ],
    );
  });

  it("删除唯一记录：kind 整个移除，无 active", () => {
    const next = applySecretMutation(baseFile(), { type: "delete", kind: "openai", id: "x" });
    assert.equal(next.openai, undefined);
    assert.ok(next.deepseek!.length === 3);
  });

  it("删除不存在的 id → SECRET_NOT_FOUND", () => {
    assert.throws(
      () => applySecretMutation(baseFile(), { type: "delete", kind: "deepseek", id: "nope" }),
      (err: unknown) =>
        err instanceof SecretsRepositoryError && err.code === "SECRET_NOT_FOUND",
    );
  });
});

describe("applySecretMutation：activate / rotate / rename", () => {
  it("activate：直接激活指定记录，其余转 inactive", () => {
    const next = applySecretMutation(baseFile(), { type: "activate", kind: "deepseek", id: "c" });
    assert.deepEqual(
      next.deepseek!.map((r) => r.active),
      [false, false, true],
    );
  });

  it("rotate：激活给定 id 的下一条（循环）", () => {
    const next = applySecretMutation(baseFile(), { type: "rotate", kind: "deepseek", id: "a" });
    assert.deepEqual(
      next.deepseek!.map((r) => [r.id, r.active]),
      [
        ["a", false],
        ["b", true],
        ["c", false],
      ],
    );
    // 循环：末位的下一条 = 首条
    const wrapped = applySecretMutation(baseFile(), { type: "rotate", kind: "deepseek", id: "c" });
    assert.equal(wrapped.deepseek![0]!.active, true);
  });

  it("rotate/activate 不存在的 id → SECRET_NOT_FOUND", () => {
    for (const type of ["rotate", "activate"] as const) {
      assert.throws(
        () => applySecretMutation(baseFile(), { type, kind: "deepseek", id: "nope" }),
        (err: unknown) =>
          err instanceof SecretsRepositoryError && err.code === "SECRET_NOT_FOUND",
      );
    }
  });

  it("rename：改标签，active 状态不动", () => {
    const next = applySecretMutation(baseFile(), {
      type: "rename",
      kind: "deepseek",
      id: "a",
      label: "生产 key",
    });
    assert.equal(next.deepseek![0]!.label, "生产 key");
    assert.equal(next.deepseek![0]!.active, true);
  });
});

describe("不变量与掩码投影", () => {
  it("任意 mutation 序列后仍满足 SecretsFileSchema（同 kind 至多一条 active）", () => {
    let file = baseFile();
    file = applySecretMutation(file, { type: "write", kind: "deepseek", value: "k1", label: "l" }, genId);
    file = applySecretMutation(file, { type: "activate", kind: "deepseek", id: "b" });
    file = applySecretMutation(file, { type: "rotate", kind: "deepseek", id: "b" });
    file = applySecretMutation(file, { type: "delete", kind: "deepseek", id: "c" });
    file = applySecretMutation(file, { type: "rename", kind: "deepseek", id: "a", label: "z" });
    SecretsFileSchema.parse(file); // 不抛即保持
    assert.equal(file.deepseek!.filter((r) => r.active).length, 1);
  });

  it("toSecretState：掩码形状（≤4 整体掩码，否则仅末 4 位），不含明文", () => {
    const state = toSecretState(baseFile());
    assert.deepEqual(state.deepseek, [
      { id: "a", label: "主 key", active: true, maskedValue: "****1111" },
      { id: "b", label: "备用", active: false, maskedValue: "****2222" },
      { id: "c", label: "短 key", active: false, maskedValue: "****" },
    ]);
    assert.equal(JSON.stringify(state).includes("sk-aaaa1111"), false);
  });

  it("toSecretState：空文件 → 空 state", () => {
    assert.deepEqual(toSecretState({}), {});
  });
});
