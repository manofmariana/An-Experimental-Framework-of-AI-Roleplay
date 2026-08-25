/**
 * TAG 等级表达式求值器（纯逻辑，禁 IO/LLM/server/truth）。
 *
 * 判定式纯内容侧：T =（一级组 ∨）∧（二级组 ∨）∧ … ∧（七级组 ∨）；空等级组
 * 无约束；无 TAG = 恒通过。等级是内容侧挂载处的属性，与 TAG 身份解绑；对象侧 =
 * 纯名称集合。全知 = 全知权重（0-6，唯一语义来源）+ 虚拟挂载（不落盘）：权重 N
 * 覆盖每一级 ≤ N 的非空组（虚拟"全知"）；强制全知只覆盖七级组、仅 GM 持有。
 * 匹配扁平：等级只参与判定式，matched 从对象侧持有出发取交集。
 * 对象有效 TAG 集（落盘 ∪ 派生）与开放类别实例集由调用方注入，合并不在本层。
 */
import {
  FORCE_OMNISCIENT_TAG,
  OMNISCIENT_TAG,
  type TagCategory,
  type TagCondition,
  type TagRegistry,
} from "./registry.js";

export const MIN_TAG_LEVEL = 1;
export const MAX_TAG_LEVEL = 7;
/** 全知权重值域 0-6：0 = 常规角色；7 无意义（不存在 8 级可打破），强制全知 = 持 TAG */
export const MAX_OMNISCIENCE_WEIGHT = 6;

/** 内容侧单条挂载：{TAG 名, 等级}。 */
export interface MountedTag {
  name: string;
  /** 等级 1-7：同级取 ∨、跨级取 ∧ */
  level: number;
}

/** 读者侧求值 scope（全部由调用方注入）。 */
export interface ReaderScope {
  /** 对象有效 TAG 集（落盘 ∪ 程序派生，调用方合并后的纯名称集合） */
  tags: ReadonlySet<string>;
  /** 全知权重 0-6（默认 0 = 常规角色）；覆盖面的唯一语义来源，tags 集无需挂字面"全知" */
  omniscienceWeight?: number;
  /** 开放类别实例集（cid = 演员表 / channel = 活跃频道 / location = 当前地点名） */
  categoryInstances?: Partial<Record<TagCategory, ReadonlySet<string>>>;
  /** 读者变量树读取（condition 求真用；缺失时 condition 判不成立） */
  varReader?: (path: string) => unknown;
}

export interface FilterInput {
  /** 抓取层取到的末端值，放行时原样返回 */
  content: unknown;
  /** 末端 tags 属性（内容侧挂载集合） */
  tags: readonly MountedTag[];
}

export type FilterStatus = "pass" | "fail";

export interface FilterResult {
  status: FilterStatus;
  /** pass → 原 content；fail → null */
  content: unknown;
  /** 双侧共同持有记号集（含虚拟挂载；开放类别命中归一化为类别名），去重排序 */
  matched: string[];
}

/**
 * condition 求真（fail-closed）：无 varReader、路径取不到值（undefined）、
 * 类型错配一律不成立。between = 闭区间；contains 服务列表包含与字符串子串。
 */
export function evalCondition(cond: TagCondition, varReader?: (path: string) => unknown): boolean {
  if (!varReader) return false;
  const v = varReader(cond.path);
  if (v === undefined) return false;
  const { op, value } = cond;
  switch (op) {
    case "eq":
      return v === value;
    case "ne":
      return v !== value;
    case "lt":
      return typeof v === "number" && typeof value === "number" && v < value;
    case "le":
      return typeof v === "number" && typeof value === "number" && v <= value;
    case "gt":
      return typeof v === "number" && typeof value === "number" && v > value;
    case "ge":
      return typeof v === "number" && typeof value === "number" && v >= value;
    case "between": {
      if (typeof v !== "number" || !Array.isArray(value)) return false;
      const [lo, hi] = value;
      return lo <= v && v <= hi;
    }
    case "contains":
      if (Array.isArray(v)) return v.includes(value as string | number | boolean);
      return typeof v === "string" && typeof value === "string" && v.includes(value);
  }
}

/** 记号归一化：开放类别实例命中报类别名，其余报 TAG 名本身。 */
function tokenOf(name: string, instances: Partial<Record<TagCategory, ReadonlySet<string>>>): string {
  for (const [category, set] of Object.entries(instances)) {
    if (set?.has(name)) return category;
  }
  return name;
}

/**
 * 逐末端过滤求值。matched 必须完整（分支键 = 记号集精确匹配），因此：
 * 直接持有与虚拟挂载恒记录；condition 逐条求真并计入 matched——唯一例外是
 * 该组被虚拟挂载覆盖（全知权重 / 强制全知）时跳过整组 condition 求值
 * （全知读者不触发变量读取）。
 */
export function evaluateTagFilter(
  input: FilterInput,
  reader: ReaderScope,
  registry: TagRegistry,
): FilterResult {
  const weight = reader.omniscienceWeight ?? 0;
  if (!Number.isInteger(weight) || weight < 0 || weight > MAX_OMNISCIENCE_WEIGHT) {
    throw new RangeError(`全知权重必须是 0-${MAX_OMNISCIENCE_WEIGHT} 的整数，收到 ${weight}`);
  }

  // 按等级分组（同级取 ∨、跨级取 ∧）
  const byLevel = new Map<number, string[]>();
  for (const t of input.tags) {
    if (!Number.isInteger(t.level) || t.level < MIN_TAG_LEVEL || t.level > MAX_TAG_LEVEL) {
      throw new RangeError(`TAG 等级必须是 ${MIN_TAG_LEVEL}-${MAX_TAG_LEVEL} 的整数："${t.name}" 收到 ${t.level}`);
    }
    const list = byLevel.get(t.level);
    if (list) list.push(t.name);
    else byLevel.set(t.level, [t.name]);
  }

  const instances = reader.categoryInstances ?? {};
  const forceOmniscient = reader.tags.has(FORCE_OMNISCIENT_TAG);
  const matched = new Set<string>();
  let pass = true;

  for (const [level, members] of [...byLevel.entries()].sort((a, b) => a[0] - b[0])) {
    let satisfied = false;
    // 虚拟挂载：全知权重覆盖 ≤N 级组，强制全知只覆盖七级组
    const byWeight = level <= weight;
    const byForce = level === MAX_TAG_LEVEL && forceOmniscient;
    if (byWeight) {
      matched.add(OMNISCIENT_TAG);
      satisfied = true;
    } else if (byForce) {
      matched.add(FORCE_OMNISCIENT_TAG);
      satisfied = true;
    }
    const covered = byWeight || byForce;
    for (const name of members) {
      if (reader.tags.has(name)) {
        matched.add(tokenOf(name, instances));
        satisfied = true;
        continue;
      }
      const cond = registry[name]?.condition;
      if (cond && !covered && evalCondition(cond, reader.varReader)) {
        matched.add(tokenOf(name, instances));
        satisfied = true;
      }
    }
    if (!satisfied) pass = false;
  }

  return {
    status: pass ? "pass" : "fail",
    content: pass ? input.content : null,
    matched: [...matched].sort(),
  };
}
