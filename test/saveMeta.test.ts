import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { describe, it } from "node:test";
import { deleteRun, listRuns, validateAlias, writeAlias } from "../src/resources/runRepository.js";
import { tempDir } from "./harness/tempDir.js";

function mkRun(dir: string, id: string): void {
  fs.mkdirSync(path.join(dir, id), { recursive: true });
}

describe("validateAlias", () => {
  it("合法别名通过（去空白）", () => {
    assert.equal(validateAlias(" 灯塔之夜 "), "灯塔之夜");
    assert.equal(validateAlias("save 1"), "save 1");
  });

  it("非法别名拒绝", () => {
    assert.throws(() => validateAlias(""), /长度/);
    assert.throws(() => validateAlias("   "), /长度/);
    assert.throws(() => validateAlias("x".repeat(51)), /长度/);
    assert.throws(() => validateAlias("a/b"), /非法字符/);
    assert.throws(() => validateAlias(".."), /非法字符/);
    assert.throws(() => validateAlias(42), /字符串/);
  });
});

describe("writeAlias / deleteRun（路径安全）", () => {
  it("别名写入后 listRuns 带出；显示名回退 id", () => {
    const dir = tempDir("airp-save-");
    mkRun(dir, "run-a");
    mkRun(dir, "run-b");
    writeAlias(dir, "run-a", "灯塔之夜");

    const runs = listRuns(dir);
    const a = runs.find((r) => r.id === "run-a")!;
    const b = runs.find((r) => r.id === "run-b")!;
    assert.equal(a.alias, "灯塔之夜");
    assert.equal(b.alias, undefined);
  });

  it("writeAlias：不存在/穿越拒绝", () => {
    const dir = tempDir("airp-save-");
    assert.throws(() => writeAlias(dir, "nope", "x"), /不存在/);
    assert.throws(() => writeAlias(dir, "../etc", "x"), /非法名称/);
  });

  it("deleteRun：拒删活跃会话、拒穿越、拒不存在", () => {
    const dir = tempDir("airp-save-");
    mkRun(dir, "run-active");
    mkRun(dir, "run-old");

    assert.throws(() => deleteRun(dir, "run-active", "run-active"), /进行中/);
    assert.throws(() => deleteRun(dir, "../etc", null), /非法名称/);
    assert.throws(() => deleteRun(dir, "nope", null), /不存在/);

    deleteRun(dir, "run-old", "run-active");
    assert.ok(!fs.existsSync(path.join(dir, "run-old")));
    assert.ok(fs.existsSync(path.join(dir, "run-active")));
  });
});
