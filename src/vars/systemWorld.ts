/**
 * world 根系统声明分支与结构化时间纯函数（镜像 systemChar 先例；对 template/tree 仅
 * type-import，保持零运行时出边——template.ts 解析期并入本模块常量，反向会成环）。
 *
 * time 容器 = 世界时间唯一出处（变量树内，档内随 world.json）：y/m/d/h/min number 末端
 * （时间锚，调度器经 WorldStore.setClock 专用通道推进；GM deltas 拒写 world.time）+
 * periods 结构化数组（时段表 {key, from, to}，from/to = 小时界，服务 clock 占位符的
 * 机械渲染）。初始实例 = 代码缺省（世界包不再携带时间配置；世界作者经状态直编调整，
 * 档内随 world.json 存续）。全部末端带 system 元数据（呈现层徽记）。
 *
 * 时间口径：y 0 基（允许 0 年开局），m/d 1 基（30 日/月、12 月/年），h/min 常规 0 基。
 */
import { z } from "zod";
import type { ArrayDecl, ContainerDecl, DeclNode, TerminalDecl, ValueType } from "./template.js";

// ---------------------------------------------------------------------------
// 系统声明分支（编译形态常量）
// ---------------------------------------------------------------------------

function terminal(valueType: ValueType): TerminalDecl {
  return { kind: "terminal", valueType, system: true };
}

function container(children: Record<string, DeclNode>): ContainerDecl {
  return { kind: "container", children };
}

/** world 根系统声明子树（time 容器：时间锚五末端 + periods 时段表）。 */
export const SYSTEM_WORLD_CHILDREN: Readonly<Record<string, DeclNode>> = {
  time: container({
    y: terminal("number"),
    m: terminal("number"),
    d: terminal("number"),
    h: terminal("number"),
    min: terminal("number"),
    periods: {
      kind: "array",
      element: container({ key: terminal("string"), from: terminal("number"), to: terminal("number") }),
    } satisfies ArrayDecl,
  }),
};

/** 系统分支键集（同名冲突拒装与 UI 保留名判定用）。 */
export const SYSTEM_WORLD_KEYS: ReadonlySet<string> = new Set(Object.keys(SYSTEM_WORLD_CHILDREN));

// ---------------------------------------------------------------------------
// 类型化时间（schema + 纯函数）
// ---------------------------------------------------------------------------

export const TimeAnchorSchema = z.object({
  y: z.number().int().min(0), m: z.number().int().min(1).max(12), d: z.number().int().min(1).max(35),
  h: z.number().int().min(0).max(23), min: z.number().int().min(0).max(59),
});
export type TimeAnchor = z.infer<typeof TimeAnchorSchema>;
export const TimePeriodSchema = z.object({ key: z.string(), from: z.number(), to: z.number() });
export type TimePeriod = z.infer<typeof TimePeriodSchema>;

/** 初始时间实例缺省（新档 world.time 锚与时段表；世界作者经状态直编调整）。原点开局（y0 元旦 00:00 = 绝对分钟 0）。 */
export const DEFAULT_TIME_ANCHOR: TimeAnchor = { y: 0, m: 1, d: 1, h: 0, min: 0 };
export const DEFAULT_TIME_PERIODS: TimePeriod[] = [
  { key: "白天", from: 6, to: 18 },
  { key: "夜晚", from: 18, to: 6 },
];

/** 新档 world.time 初始实例（末端外壳树，tags 全空）。 */
export function defaultWorldTimeInstance(): Record<string, unknown> {
  const shell = (value: number | string): unknown => ({ value, tags: [] });
  return {
    y: shell(DEFAULT_TIME_ANCHOR.y),
    m: shell(DEFAULT_TIME_ANCHOR.m),
    d: shell(DEFAULT_TIME_ANCHOR.d),
    h: shell(DEFAULT_TIME_ANCHOR.h),
    min: shell(DEFAULT_TIME_ANCHOR.min),
    periods: DEFAULT_TIME_PERIODS.map((p) => ({ key: shell(p.key), from: shell(p.from), to: shell(p.to) })),
  };
}

export function worldTimeToMinutes(time: TimeAnchor): number {
  return ((((time.y * 365 + (time.m - 1) * 30 + (time.d - 1)) * 24 + time.h) * 60) + time.min);
}

export function minutesToWorldTime(totalMinutes: number): TimeAnchor {
  let value = Math.max(0, Math.floor(totalMinutes));
  const min = value % 60; value = Math.floor(value / 60);
  const h = value % 24; value = Math.floor(value / 24);
  const y = Math.floor(value / 365);
  const dayOfYear = value % 365;
  // 每年 12 月承接 30 日月制余下的 5 天，避免产生第 13 月。
  const m = Math.min(12, Math.floor(dayOfYear / 30) + 1);
  const d = dayOfYear - (m - 1) * 30 + 1;
  return { y, m, d, h, min };
}

/** 结构时间机械渲染（clock 占位符注入用）：日期 + 命中时段（无命中 = 仅日期）。 */
export function renderTimeHeader(time: TimeAnchor, periods: readonly TimePeriod[]): string {
  const hour = time.h + time.min / 60;
  const period = periods.find((p) => p.from <= p.to ? hour >= p.from && hour < p.to : hour >= p.from || hour < p.to);
  const date = `${time.y}年${time.m}月${time.d}日`;
  return period === undefined ? date : `${date}·${period.key}`;
}

// ---------------------------------------------------------------------------
// 外壳树 → 类型化时间（读取回认；缺失/畸形 = 抛错——time 是必备系统分支）
// ---------------------------------------------------------------------------

function readNumber(node: unknown, path: string): number {
  const value = (node as { value?: unknown } | null)?.value;
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error(`world.time 末端缺失或畸形（${path}）`);
  }
  return value;
}

function readString(node: unknown, path: string): string {
  const value = (node as { value?: unknown } | null)?.value;
  if (typeof value !== "string") throw new Error(`world.time 末端缺失或畸形（${path}）`);
  return value;
}

/** 从 world 变量树读回类型化时间（锚 + 时段表）；time 分支缺失/畸形 = 抛错。 */
export function readWorldTime(world: Record<string, unknown>): { anchor: TimeAnchor; periods: TimePeriod[] } {
  const time = (world as Record<string, unknown>)["time"] as Record<string, unknown> | undefined;
  if (typeof time !== "object" || time === null || Array.isArray(time)) {
    throw new Error("world.time 系统分支缺失（时间锚是必备结构）");
  }
  const anchor = TimeAnchorSchema.parse({
    y: readNumber(time["y"], "time.y"),
    m: readNumber(time["m"], "time.m"),
    d: readNumber(time["d"], "time.d"),
    h: readNumber(time["h"], "time.h"),
    min: readNumber(time["min"], "time.min"),
  });
  const rawPeriods = time["periods"];
  if (!Array.isArray(rawPeriods)) throw new Error("world.time.periods 时段表缺失或畸形");
  const periods = rawPeriods.map((p, i) =>
    TimePeriodSchema.parse({
      key: readString((p as Record<string, unknown>)["key"], `time.periods[${i}].key`),
      from: readNumber((p as Record<string, unknown>)["from"], `time.periods[${i}].from`),
      to: readNumber((p as Record<string, unknown>)["to"], `time.periods[${i}].to`),
    }),
  );
  return { anchor, periods };
}
