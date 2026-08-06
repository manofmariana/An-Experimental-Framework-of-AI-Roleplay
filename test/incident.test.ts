import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  compileIncidentConfig,
  evaluateIncident,
  hitF,
  hitG,
  hitProbability,
  malignPercent,
  mismatchD,
  renderFortune,
  rollFortune,
  type IncidentConfig,
  type SleepingGroup,
} from "../src/scheduler/incident.js";

/** 标定 v1 原始配置（与 baitan incident.json 同形状同值；锚点断言的基准）。 */
const RAW = {
  d: {
    method: "log_ratio",
    log_ratio: { expr: "kappa * ln((L_loc + c) / (L_geo + c))", consts: { kappa: 33, c: 10 } },
    absolute_diff: { expr: "L_loc - L_avg" },
  },
  f: {
    expr: "(base + amp * tanh((D - shift) / densityScale) ^ 2) * (floor + (1 - floor) * sigmoid((D - shift) / compressScale))",
    consts: { base: 0.3, amp: 0.7, shift: 3, densityScale: 24, floor: 0.4, compressScale: 8 },
  },
  g: { expr: "sigmoid(a * ln(T) - b)", consts: { a: 0.4205, b: 4.1531 } },
  p_hit: { expr: "f * g" },
  p_malign: { expr: "clamp(D + offset, 0, 100)", consts: { offset: 50 } },
  severity: { expr: "f * scale + offset + (2d20 - 2) - (d20 - 1)", consts: { scale: 50, offset: 10 } },
} as const;

const CONFIG: IncidentConfig = compileIncidentConfig(RAW);

/** 队列骰子（依序消费，耗尽抛错）。 */
function queueDice(values: number[]): (face: number) => number {
  const q = [...values];
  return () => {
    const v = q.shift();
    if (v === undefined) throw new Error("骰子队列耗尽");
    return v;
  };
}

function group(overrides: Partial<SleepingGroup>): SleepingGroup {
  return {
    key: "sC1001",
    cids: ["C1001"],
    locationName: "loc",
    locationLevel: 1,
    memberLevels: [1],
    remainingMinutes: 43200,
    ...overrides,
  };
}

describe("突发公式层（标定 v1 锚点）", () => {
  it("错位度 D：log_ratio 数量级比值（几何平均）", () => {
    // 单人 level 1 vs 地点 100：(100+10)/(1+10) = 10 → D = 33·ln(10) ≈ 75.99
    assert.ok(Math.abs(mismatchD(CONFIG, 100, [1]) - 33 * Math.log(10)) < 1e-9);
    // 组内几何平均：levels [1, 100] → L̄ = 10 → D = 33·ln(110/20) = 33·ln(5.5)
    assert.ok(Math.abs(mismatchD(CONFIG, 100, [1, 100]) - 33 * Math.log(5.5)) < 1e-9);
    // 匹配（同 level）→ D = 0
    assert.equal(mismatchD(CONFIG, 5, [5, 5]), 0);
  });

  it("错位度 D：absolute_diff 备用算法（算术平均绝对差值）", () => {
    const cfg: IncidentConfig = compileIncidentConfig({ ...RAW, d: { ...RAW.d, method: "absolute_diff" } });
    assert.equal(mismatchD(cfg, 50, [10, 20]), 35);
    assert.equal(mismatchD(cfg, 5, [50]), -45);
  });

  it("compileIncidentConfig：变量闭包校验指出公式与变量", () => {
    assert.throws(
      () => compileIncidentConfig({ ...RAW, f: { expr: "D + nope" } }),
      /公式 f 引用了未声明的变量 "nope"/,
    );
    // consts 键与注入变量同名 → 拒装
    assert.throws(
      () => compileIncidentConfig({ ...RAW, f: { expr: "D * k", consts: { D: 1, k: 2 } } }),
      /consts 键 "D" 与注入变量同名/,
    );
  });

  it("f(D)：min ≈ 20% @ D≈0，负 D 高原 40%，正 D 饱和 100%", () => {
    assert.ok(Math.abs(hitF(CONFIG, 0) - 0.2) < 0.005, `f(0)=${hitF(CONFIG, 0)}`);
    assert.ok(Math.abs(hitF(CONFIG, -99) - 0.4) < 0.005, `f(-99)=${hitF(CONFIG, -99)}`);
    assert.ok(Math.abs(hitF(CONFIG, 99) - 1) < 0.005, `f(99)=${hitF(CONFIG, 99)}`);
    // 极值点在 D≈0 附近（shift=3 校准）：f(0) 低于 f(±30)
    assert.ok(hitF(CONFIG, 0) < hitF(CONFIG, 30) && hitF(CONFIG, 0) < hitF(CONFIG, -30));
  });

  it("g(T)：锚点 12h→20%、1年→80%，T≤0 → 0", () => {
    assert.ok(Math.abs(hitG(CONFIG, 720) - 0.2) < 0.001, `g(12h)=${hitG(CONFIG, 720)}`);
    assert.ok(Math.abs(hitG(CONFIG, 525600) - 0.8) < 0.001, `g(1年)=${hitG(CONFIG, 525600)}`);
    assert.equal(hitG(CONFIG, 0), 0);
    assert.equal(hitG(CONFIG, -10), 0);
    // 单调递增：休眠越久概率越高
    assert.ok(hitG(CONFIG, 43200) > hitG(CONFIG, 720));
  });

  it("p_命中 = f·g；p_恶性 = clamp(D+50, 0, 100)", () => {
    assert.ok(Math.abs(hitProbability(CONFIG, 0, 43200) - hitF(CONFIG, 0) * hitG(CONFIG, 43200)) < 1e-12);
    assert.equal(malignPercent(CONFIG, 0), 50);
    assert.equal(malignPercent(CONFIG, 10), 60);
    assert.equal(malignPercent(CONFIG, 60), 100);
    assert.equal(malignPercent(CONFIG, -60), 0);
  });

  it("rollFortune：d100 ≤ p恶性 即恶性；程度 = f·50+10+(2d20−2)−(d20−1)", () => {
    // D=0：p恶性=50 → 50 命中恶性；骰序：d100、2d20、d20
    const fortune = rollFortune(CONFIG, 0, queueDice([50, 10, 10, 5]));
    assert.equal(fortune.malignant, true);
    assert.ok(Math.abs(fortune.severity - (hitF(CONFIG, 0) * 50 + 10 + 18 - 4)) < 1e-9);
    assert.equal(fortune.D, 0);
    // 51 > 50 → 良性
    assert.equal(rollFortune(CONFIG, 0, queueDice([51, 10, 10, 5])).malignant, false);
    // 渲染取整
    assert.match(renderFortune(fortune), /^良恶判定：恶性；程度 \d+（1–100）$/);
  });

  it("severity 骰子从左到右消费：2d20 两骰后 d20 一骰", () => {
    // 队列：d100=1（≤50 恶性）→ 2d20=[3,7] → d20=[12]
    const faces: number[] = [];
    const values = [1, 3, 7, 12];
    const fortune = rollFortune(CONFIG, 0, (face) => {
      faces.push(face);
      return values[faces.length - 1]!;
    });
    assert.deepEqual(faces, [100, 20, 20, 20]);
    assert.ok(Math.abs(fortune.severity - (hitF(CONFIG, 0) * 50 + 10 + (3 + 7 - 2) - (12 - 1))) < 1e-9);
  });

  it("evaluateIncident：逐组投 d100，多组命中只取 p 最高者", () => {
    const low = group({ key: "g1", locationLevel: 1, memberLevels: [1] }); // D=0，p≈0.117
    const high = group({ key: "g2", cids: ["C1002"], locationLevel: 100, memberLevels: [1] }); // D≈76，p≈0.578
    // 按 key 序消费：g1（5 ≤ 11.7 命中）、g2（50 ≤ 57.8 命中）→ g2 p 高胜出
    const hit = evaluateIncident([low, high], CONFIG, queueDice([5, 50]));
    assert.ok(hit !== null);
    assert.equal(hit.group.key, "g2");
    assert.ok(Math.abs(hit.D - 33 * Math.log(10)) < 1e-9);
    // 只有低 p 组命中 → 激活低 p 组
    const onlyLow = evaluateIncident([low, high], CONFIG, queueDice([5, 100]));
    assert.equal(onlyLow?.group.key, "g1");
    // 全未命中 → null
    assert.equal(evaluateIncident([low, high], CONFIG, queueDice([100, 100])), null);
  });

  it("evaluateIncident：同 p 按组 key 字典序决胜（确定性）", () => {
    const a = group({ key: "g1" });
    const b = group({ key: "g2", cids: ["C1002"] });
    const hit = evaluateIncident([b, a], CONFIG, queueDice([5, 5]));
    assert.equal(hit?.group.key, "g1");
  });
});
