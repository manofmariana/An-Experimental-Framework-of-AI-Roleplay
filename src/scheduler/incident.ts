/**
 * 突发事件（Incident）求值编排层（纯逻辑，禁 IO/LLM/server/truth）。
 *
 * 目的 = 激活长期休眠的组——让角色不长期待在与自身 level 数量级错位过大的位置。
 * 标定 v1；**公式结构（表达式）与参数的唯一出处均为世界包 incident.json**，
 * 本文件只有求值编排与变量面约定。各公式可用变量（包作者与代码之间的契约）：
 *
 *   d.log_ratio / d.absolute_diff   L_loc（地点 level）/ L_geo（组内 level 几何平均）/ L_avg（算术平均）
 *   f              D（错位度 = d 公式结果，method 选择算法）
 *   g              T（剩余休眠分钟；T ≤ 0 短路为 0，ln 定义域保护，不求值表达式）
 *   p_hit          f / g（前两公式结果）
 *   p_malign       D
 *   severity       f / D；可含骰子项（现投现注入，按表达式从左到右逐骰消费）
 *
 * 各公式可另声明 consts（键名即表达式内引用的标识符；不得与可用变量同名）。
 */
import { z } from "zod";
import { rollDice, type DicePort } from "../ports.js";
import { compileFormula, type CompiledFormula } from "../shared/formula.js";

// ---------------------------------------------------------------------------
// 世界包 incident.json 契约（schema 唯一出处；加载在 application/sessionFactory）
// ---------------------------------------------------------------------------

/** 单条公式的世界包写法：表达式 + 可选常量表。 */
const FormulaSpecSchema = z.object({
  expr: z.string().min(1),
  consts: z.record(z.string(), z.number()).optional(),
});

const IncidentConfigShapeSchema = z.object({
  d: z.object({
    /** D 算法选择：log_ratio = 数量级比值（默认）；absolute_diff = 绝对差值（备用，见世界包注记） */
    method: z.enum(["log_ratio", "absolute_diff"]),
    log_ratio: FormulaSpecSchema,
    absolute_diff: FormulaSpecSchema,
  }),
  f: FormulaSpecSchema,
  g: FormulaSpecSchema,
  p_hit: FormulaSpecSchema,
  p_malign: FormulaSpecSchema,
  severity: FormulaSpecSchema,
});

/** 编译后的单条公式（consts 已并入求值 scope）。 */
interface CompiledSpec {
  readonly expr: string;
  evaluate(scope: Record<string, number>, roll?: DicePort): number;
}

/** 编译后的突发配置（对外函数签名不变，内部按编译后公式求值）。 */
export interface IncidentConfig {
  readonly d: {
    readonly method: "log_ratio" | "absolute_diff";
    readonly log_ratio: CompiledSpec;
    readonly absolute_diff: CompiledSpec;
  };
  readonly f: CompiledSpec;
  readonly g: CompiledSpec;
  readonly p_hit: CompiledSpec;
  readonly p_malign: CompiledSpec;
  readonly severity: CompiledSpec;
}

/** 各公式的注入变量面（闭包校验基准；文件头契约的代码形态）。 */
const FORMULA_VARS = {
  d: ["L_loc", "L_geo", "L_avg"],
  f: ["D"],
  g: ["T"],
  p_hit: ["f", "g"],
  p_malign: ["D"],
  severity: ["f", "D"],
} as const;

/** 编译单条公式并做变量闭包校验（引用变量必须 ∈ 注入变量 ∪ consts 键）。 */
function compileSpec(name: string, raw: unknown, vars: readonly string[]): CompiledSpec {
  const spec = FormulaSpecSchema.parse(raw);
  const consts = spec.consts ?? {};
  for (const key of Object.keys(consts)) {
    if (vars.includes(key)) {
      throw new Error(`incident.json 公式 ${name}：consts 键 "${key}" 与注入变量同名`);
    }
  }
  const compiled: CompiledFormula = compileFormula(spec.expr);
  for (const v of compiled.variables) {
    if (!vars.includes(v) && !Object.hasOwn(consts, v)) {
      throw new Error(`incident.json 公式 ${name} 引用了未声明的变量 "${v}"（可用：${[...vars, ...Object.keys(consts)].join(", ")}）`);
    }
  }
  return { expr: compiled.expr, evaluate: (scope, roll) => compiled.evaluate({ ...consts, ...scope }, roll) };
}

/** zod 形状校验 + 编译全部表达式 + 变量闭包校验（失败即拒装，无代码内缺省）。 */
export function compileIncidentConfig(raw: unknown): IncidentConfig {
  const shape = IncidentConfigShapeSchema.parse(raw);
  return {
    d: {
      method: shape.d.method,
      log_ratio: compileSpec("d.log_ratio", shape.d.log_ratio, FORMULA_VARS.d),
      absolute_diff: compileSpec("d.absolute_diff", shape.d.absolute_diff, FORMULA_VARS.d),
    },
    f: compileSpec("f", shape.f, FORMULA_VARS.f),
    g: compileSpec("g", shape.g, FORMULA_VARS.g),
    p_hit: compileSpec("p_hit", shape.p_hit, FORMULA_VARS.p_hit),
    p_malign: compileSpec("p_malign", shape.p_malign, FORMULA_VARS.p_malign),
    severity: compileSpec("severity", shape.severity, FORMULA_VARS.severity),
  };
}

// ---------------------------------------------------------------------------
// 公式一：命中概率 p = p_hit(f(D), g(T))
// ---------------------------------------------------------------------------

/**
 * 错位度 D（公式自变量；两种算法由 config.d.method 选择）：
 * - log_ratio：数量级比值，level 无上限世界观下保持自由度（L̄_geo = 几何平均）；
 * - absolute_diff：绝对差值（L̄_avg = 算术平均）——旧版设计，备用留档。
 * 几何/算术平均在代码内现算（组内聚合不是表达式能力），结果作为 L_geo/L_avg 注入。
 */
export function mismatchD(config: IncidentConfig, locationLevel: number, memberLevels: readonly number[]): number {
  if (memberLevels.length === 0) throw new Error("mismatchD：组内至少一名成员");
  const scope = {
    L_loc: locationLevel,
    L_geo: Math.exp(memberLevels.reduce((s, l) => s + Math.log(l), 0) / memberLevels.length),
    L_avg: memberLevels.reduce((s, l) => s + l, 0) / memberLevels.length,
  };
  return config.d.method === "absolute_diff"
    ? config.d.absolute_diff.evaluate(scope)
    : config.d.log_ratio.evaluate(scope);
}

/** f(D)：错位度 → 基准触发率（形状由世界包表达式决定）。 */
export function hitF(config: IncidentConfig, D: number): number {
  return config.f.evaluate({ D });
}

/** g(T)：剩余休眠分钟 → 时间稀释。T ≤ 0 短路为 0：ln 定义域保护，不进入表达式求值。 */
export function hitG(config: IncidentConfig, tMinutes: number): number {
  if (tMinutes <= 0) return 0;
  return config.g.evaluate({ T: tMinutes });
}

/** 单次评估命中概率（世界包 p_hit 表达式，默认 f·g）。 */
export function hitProbability(config: IncidentConfig, D: number, tMinutes: number): number {
  return config.p_hit.evaluate({ f: hitF(config, D), g: hitG(config, tMinutes) });
}

// ---------------------------------------------------------------------------
// 公式二/三：良恶与程度（所有 GM 激活前的固定判定，现投现注入，重跑自然重投）
// ---------------------------------------------------------------------------

/** p_恶性（百分制；世界包 p_malign 表达式，默认 clamp(D + offset, 0, 100)）。 */
export function malignPercent(config: IncidentConfig, D: number): number {
  return config.p_malign.evaluate({ D });
}

/** 良恶/程度判定结果（注入文本经 renderFortune 机械渲染，LLM 不自由算）。 */
export interface FortuneRoll {
  /** 错位度（判定自变量，快照记录用） */
  D: number;
  /** d100 ≤ p恶性 即恶性 */
  malignant: boolean;
  /** 程度（世界包 severity 表达式；标定 v1 理论区间约 [1, 98]） */
  severity: number;
}

/** 投良恶/程度（每次 GM 激活前一次：先 1×d100 良恶，再 severity 表达式内骰子从左到右消费）。 */
export function rollFortune(config: IncidentConfig, D: number, roll: DicePort): FortuneRoll {
  const malignant = rollDice(roll, 100) <= malignPercent(config, D);
  const severity = config.severity.evaluate({ f: hitF(config, D), D }, roll);
  return { D, malignant, severity };
}

/** 判定结果的机械渲染（占位符注入文本；程度取整显示）。 */
export function renderFortune(fortune: FortuneRoll): string {
  return `良恶判定：${fortune.malignant ? "恶性" : "良性"}；程度 ${Math.round(fortune.severity)}（1–100）`;
}

// ---------------------------------------------------------------------------
// 命中评估：休眠组逐组投骰，多组命中只激活 p 最高者
// ---------------------------------------------------------------------------

/** 休眠组视图（命中评估输入；由 application 层从真相现组——评估不读 Store）。 */
export interface SleepingGroup {
  /** 组标识（`g{组编号}` / `s{cid}` 单人；快照记录与同 p 决胜用） */
  key: string;
  cids: string[];
  locationName: string;
  locationLevel: number;
  memberLevels: number[];
  /** 剩余休眠分钟（组内最小 timer − 时钟；> 0） */
  remainingMinutes: number;
}

/** 命中结果（incident 步归档的判定快照；重跑不重投的凭据）。 */
export interface IncidentHit {
  group: SleepingGroup;
  D: number;
  /** 单次评估概率 p_hit(f(D), g(T)) */
  p: number;
}

/**
 * 命中评估（常规 GM 步及其正文步结束后的标准动作；incident 步后不评估）：
 * 逐组投 d100 ≤ p·100 即命中（骰子按组 key 字典序消费，确定性）；
 * 多组命中只取 p 最高者（同 p 按 key 字典序）；无命中 → null。
 */
export function evaluateIncident(
  groups: readonly SleepingGroup[],
  config: IncidentConfig,
  roll: DicePort,
): IncidentHit | null {
  let best: IncidentHit | null = null;
  for (const group of [...groups].sort((a, b) => a.key.localeCompare(b.key))) {
    const D = mismatchD(config, group.locationLevel, group.memberLevels);
    const p = hitProbability(config, D, group.remainingMinutes);
    if (rollDice(roll, 100) > p * 100) continue;
    if (best === null || p > best.p || (p === best.p && group.key < best.group.key)) {
      best = { group, D, p };
    }
  }
  return best;
}
