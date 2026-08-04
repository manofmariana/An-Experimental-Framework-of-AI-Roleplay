import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { rollDice, type DicePort } from "../src/ports.js";

// ---------------------------------------------------------------------------
// rollDice 语义单测：脚本化 port 喂确定性队列。
// 语义硬约束：每次投掷 = dice 个 face 面骰全部投出求和；共投 times 次；
// 从 times 个总和中取 keep 侧的一次（不是逐骰取优再相加）。
// ---------------------------------------------------------------------------

function queue(values: number[]): DicePort {
  return () => {
    const v = values.shift();
    if (v === undefined) throw new Error("骰子队列耗尽");
    return v;
  };
}

describe("rollDice（统一投掷：按次求和后取优，非逐骰取优）", () => {
  it("keep=high：两次总和取高（逐骰取优再相加会得到 11，必须不是 11）", () => {
    // 第一次 6+1=7，第二次 2+5=7 → 7；若逐骰取优则 6+5=11
    assert.equal(rollDice(queue([6, 1, 2, 5]), 6, 2, 2, "high"), 7);
    // 高低分明：第一次 6+1=7，第二次 5+5=10 → 取 10
    assert.equal(rollDice(queue([6, 1, 5, 5]), 6, 2, 2, "high"), 10);
  });

  it("keep=low：两次总和取低（与 high 对称）", () => {
    // 第一次 6+1=7，第二次 2+5=7 → 7；若逐骰取低则 1+2=3
    assert.equal(rollDice(queue([6, 1, 2, 5]), 6, 2, 2, "low"), 7);
    // 高低分明：第一次 6+1=7，第二次 5+5=10 → 取 7
    assert.equal(rollDice(queue([6, 1, 5, 5]), 6, 2, 2, "low"), 7);
  });

  it("默认参数：单骰单次直通", () => {
    assert.equal(rollDice(queue([13]), 20), 13);
  });

  it("face/dice/times 非正整数 → 抛错", () => {
    for (const args of [
      [0, 1, 1],
      [-6, 1, 1],
      [1.5, 1, 1],
      [6, 0, 1],
      [6, 2, 0],
      [6, 1, -1],
      [6, 1, 0.5],
    ] as const) {
      assert.throws(() => rollDice(queue([]), args[0], args[1], args[2]));
    }
  });
});
