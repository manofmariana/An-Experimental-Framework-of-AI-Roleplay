/**
 * TAG 注册表契约与校验（纯逻辑，禁 IO/LLM/server/truth）。
 *
 * 注册表 = 世界变量 `_sys.tagRegistry` 的 schema 唯一出处：名称即键，条目
 * {name, description?, condition?, category?, system?}。category = 封闭枚举
 * {cid, channel, location}——带 category 的条目 = 该类别的声明（实例合法性由
 * 程序判定、实例值不重复登记），无类别按名称登记。system 条目 = 程序化 TAG 的
 * 只读参考，与下方代码常量双向一致（任何层不得占用同名）；三个开放类别各有一条
 * 同名 system 类别条目（system + category 同现），加载时要求三条齐备。
 */
import { z } from "zod";

/** 开放类别封闭枚举：命中归一化为类别名记号。 */
export const TAG_CATEGORIES = ["cid", "channel", "location"] as const;
export type TagCategory = (typeof TAG_CATEGORIES)[number];

/** 程序化 TAG 代码常量（注册表 system 条目的校验基准；末三条 = 开放类别同名条目）。 */
export const SYSTEM_TAG_NAMES = ["aud", "vis", "A", "V", "全知", "强制全知", ...TAG_CATEGORIES] as const;

/** 虚拟全知挂载记号（求值时按非空等级组追加，不落盘）。 */
export const OMNISCIENT_TAG = "全知";
export const FORCE_OMNISCIENT_TAG = "强制全知";

const ConditionOpSchema = z.enum(["eq", "ne", "lt", "le", "gt", "ge", "between", "contains"]);

const ConditionSchema = z
  .object({
    /** 读者变量树模板路径 */
    path: z.string().min(1),
    op: ConditionOpSchema,
    /** between = [下限, 上限]（闭区间）；其余 = 原始值 */
    value: z.union([z.string(), z.number(), z.boolean(), z.tuple([z.number(), z.number()])]),
  })
  .superRefine((c, ctx) => {
    const isTuple = Array.isArray(c.value);
    if (c.op === "between" && !isTuple) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: "between 的 value 必须是 [下限, 上限]" });
    }
    if (c.op !== "between" && isTuple) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: "仅 between 允许数组 value" });
    }
  });

const TagEntrySchema = z.object({
  name: z.string().min(1),
  description: z.string().optional(),
  condition: ConditionSchema.optional(),
  category: z.enum(TAG_CATEGORIES).optional(),
  system: z.literal(true).optional(),
});

const TagRegistrySchema = z.record(z.string(), TagEntrySchema);

export type ConditionOp = z.infer<typeof ConditionOpSchema>;
export type TagCondition = z.infer<typeof ConditionSchema>;
export type TagRegistryEntry = z.infer<typeof TagEntrySchema>;
export type TagRegistry = Record<string, TagRegistryEntry>;

/**
 * 解析并校验注册表：键名 = 条目名、system 条目与代码常量双向一致
 * （system: true 必须在常量内；常量名不得被非 system 条目占用）、类别声明唯一、
 * 三个开放类别的同名 system 类别条目齐备（cid/channel/location 各一，缺一则拒装）。
 */
export function parseTagRegistry(data: unknown): TagRegistry {
  const raw = TagRegistrySchema.parse(data);
  const systemNames = new Set<string>(SYSTEM_TAG_NAMES);
  const seenCategories = new Set<string>();
  for (const [key, entry] of Object.entries(raw)) {
    if (key !== entry.name) {
      throw new Error(`TAG 注册表键名不一致：键 "${key}" ≠ 名称 "${entry.name}"`);
    }
    const isSystemName = systemNames.has(entry.name);
    if (entry.system === true && !isSystemName) {
      throw new Error(`未知 system TAG："${entry.name}" 不在代码常量内`);
    }
    if (entry.system !== true && isSystemName) {
      throw new Error(`程序化 TAG 名称被非 system 条目占用："${entry.name}"`);
    }
    if (entry.category !== undefined) {
      if (seenCategories.has(entry.category)) {
        throw new Error(`TAG 类别重复声明："${entry.category}"`);
      }
      seenCategories.add(entry.category);
    }
  }
  for (const category of TAG_CATEGORIES) {
    const entry = raw[category];
    if (entry === undefined || entry.system !== true || entry.category !== category) {
      throw new Error(`TAG 注册表缺 system 类别条目："${category}"`);
    }
  }
  return raw;
}
