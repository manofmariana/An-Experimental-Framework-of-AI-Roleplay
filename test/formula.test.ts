import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { compileFormula } from "../src/shared/formula.js";

/** 队列骰子（依序消费并记录 face，耗尽抛错）。 */
function queueDice(values: number[]): { roll: (face: number) => number; faces: number[] } {
  const q = [...values];
  const faces: number[] = [];
  return {
    faces,
    roll: (face) => {
      const v = q.shift();
      if (v === undefined) throw new Error("骰子队列耗尽");
      faces.push(face);
      return v;
    },
  };
}

const noRoll = (): number => {
  throw new Error("不该投骰");
};

describe("公式求值器", () => {
  it("四则优先级与括号", () => {
    assert.equal(compileFormula("1 + 2 * 3 - 8 / 4").evaluate({}, noRoll), 5);
    assert.equal(compileFormula("(1 + 2) * (3 - 8) / 4").evaluate({}, noRoll), -3.75);
  });

  it("^ 右结合且高于 * /", () => {
    assert.equal(compileFormula("2 ^ 3 ^ 2").evaluate({}, noRoll), 512); // 2^(3^2)
    assert.equal(compileFormula("2 * 3 ^ 2").evaluate({}, noRoll), 18);
  });

  it("一元负号：-x^2 = -(x^2)，右操作数允许 2^-2", () => {
    assert.equal(compileFormula("-2 ^ 2").evaluate({}, noRoll), -4);
    assert.equal(compileFormula("(-2) ^ 2").evaluate({}, noRoll), 4);
    assert.equal(compileFormula("2 ^ -2").evaluate({}, noRoll), 0.25);
    assert.equal(compileFormula("- -3").evaluate({}, noRoll), 3);
    assert.equal(compileFormula("-(1 + 2) * 2").evaluate({}, noRoll), -6);
  });

  it("函数库：ln/exp/sqrt/abs/tanh/sigmoid/clamp/min/max", () => {
    const ev = (s: string): number => compileFormula(s).evaluate({}, noRoll);
    assert.ok(Math.abs(ev("ln(exp(2))") - 2) < 1e-12);
    assert.equal(ev("sqrt(9)"), 3);
    assert.equal(ev("abs(-3)"), 3);
    assert.ok(Math.abs(ev("tanh(0)")) < 1e-12);
    assert.equal(ev("sigmoid(0)"), 0.5);
    assert.equal(ev("clamp(5, 0, 3)"), 3);
    assert.equal(ev("clamp(-5, 0, 3)"), 0);
    assert.equal(ev("min(3, 1, 2)"), 1);
    assert.equal(ev("max(3, 1, 2)"), 3);
    assert.equal(ev("min(7)"), 7);
  });

  it("变量：variables 去重按首次出现序；scope 注入", () => {
    const f = compileFormula("b + a * b - a");
    assert.deepEqual(f.variables, ["b", "a"]);
    assert.equal(f.evaluate({ a: 2, b: 5 }, noRoll), 5 + 10 - 2);
  });

  it("骰子项：NdM 与 dM 从左到右逐骰消费", () => {
    // (2d20 − 2) − (d20 − 1)：先 2d20 两骰，再 d20 一骰
    const { roll, faces } = queueDice([3, 7, 12]);
    assert.equal(compileFormula("(2d20 - 2) - (d20 - 1)").evaluate({}, roll), (3 + 7 - 2) - (12 - 1));
    assert.deepEqual(faces, [20, 20, 20]);
    // dM 省略 N = 1 骰
    const single = queueDice([4]);
    assert.equal(compileFormula("d6 + 1").evaluate({}, single.roll), 5);
    assert.deepEqual(single.faces, [6]);
  });

  it("含骰子项但未给骰子端口 → 求值期报错", () => {
    assert.throws(() => compileFormula("2d6").evaluate({}), /骰子项 2d6 需要骰子端口/);
  });

  it("语法错误解析期抛出（消息带表达式原文）", () => {
    assert.throws(() => compileFormula("1 +"), (e: Error) => e.message.includes("1 +"));
    assert.throws(() => compileFormula("(1 + 2"), /期望/);
    assert.throws(() => compileFormula("1 2"), /多余内容/);
    assert.throws(() => compileFormula("1 & 2"), /无法识别的字符/);
  });

  it("未知函数/参数个数错误解析期抛出", () => {
    assert.throws(() => compileFormula("foo(1)"), /未知函数 "foo"/);
    assert.throws(() => compileFormula("ln(1, 2)"), /函数 ln 需要 1 个参数/);
    assert.throws(() => compileFormula("min()"), /至少需要 1 个参数/);
  });

  it("未知变量求值期抛出（消息带变量名）", () => {
    assert.throws(() => compileFormula("a + 1").evaluate({}, noRoll), /变量 "a" 未提供/);
  });
});
