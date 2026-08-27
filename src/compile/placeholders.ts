/**
 * 占位符目录契约与编辑期机检（纯逻辑；compile → vars/tags 为合法边，审计守护）。
 *
 * 占位符全声明式、定义读者无关：条目 = {description, source, segments[]}，取数范围由
 * 投影层按读者供给（同一占位符跨对象复用）。source = 内容源封闭枚举（投影层清单）。
 * 段两类：静态段 {kind:"static", text} 原样输出；条目段 {kind:"entry", pass, fail?,
 * order?, separator?, merge?}——pass/fail 各 = {template, branches?}（该侧缺省注入 +
 * "匹配记号集 → 模板"精确匹配分支，未命中走该侧缺省兜底；fail 缺省 = 空模板），
 * order = 前置（默认，条目轴独立滚完再进下一条目）/ 置后（与同首位轴的置后条目融合为
 * 逐实例组；同一占位符内全部置后条目首位轴必须一致，机检）。
 *
 * 条目段模板的路径调用 = 单花括号 {路径}（字符集 [A-Za-z0-9_.[\]*]，单花括号 JSON 示例
 * 不含该字符集子串，不会被误捕）：
 * - 扁平源（vars 以外）：只允许伪路径 {_content}（投影层已组装的扁平文本）与
 *   {_owner}（属主 CID，无属主 = 空串）；
 * - vars 源：只允许全路由链路径——根 = world / characters（characters 下一段 = cid
 *   字面量或 [*] 轴），链内数组层 `键[数字]` / `键[*]`；必须解析到末端（tag_list 原子
 *   即止，不得穿越末端；`.tags` 字段选择子取 tag_list）。
 *
 * 遍历结构 = 引擎沿路由链找差异点自动归并（无独立轴声明）：条目内全部路径的路由链
 * 合并为一棵遍历树，公共前缀共享、[*] 差异点产生子循环；多路径兼容性机检 = 最前差异点
 * 规则（任意两条链的首个不同段必须至少一侧是 [*] 轴，否则拒绝）。
 *
 * 分支键 = 条目匹配记号集（pass+fail 两缺省模板全部路径的 matched 并集，排序去重）
 * 精确匹配；记号合法性机检 = 注册表条目名（含全知/强制全知与开放类别同名 system 条目，
 * 归一化类别记号即类别名本身）。加载时机检（装配/续档）与包基线校验同一函数双口径。
 */
import { z } from "zod";
import type { TagRegistry } from "../tags/registry.js";
import { resolveDeclPath, splitVarPath, type VarsTemplate } from "../vars/template.js";

// ---------------------------------------------------------------------------
// 内容源封闭枚举（投影层清单；收编四注册表全部 provider 归纳得出）
// ---------------------------------------------------------------------------

export const PLACEHOLDER_SOURCES = [
  "setting",
  "tone_card",
  "lore",
  "events",
  "working_set",
  "prose_window",
  "last_prose",
  "clock",
  "cast",
  "contacts",
  "departure_notices",
  "incoming_contact",
  "timers",
  "fortune",
  "gm_event",
  "incident_target",
  "world_snapshot",
  "snapshot",
  "group_members",
  "long_term_memory",
  "self_name",
  "self_cid",
  "location",
  "vars",
] as const;
export type PlaceholderSource = (typeof PLACEHOLDER_SOURCES)[number];

// ---------------------------------------------------------------------------
// 目录 schema（placeholders.json = 占位符名 → 条目；单文件全对象共享）
// ---------------------------------------------------------------------------

/** 分支：匹配记号集（排序后的记号数组，空数组 = 空集）→ 模板。 */
const BranchSchema = z
  .object({
    tokens: z.array(z.string().min(1)),
    template: z.string(),
  })
  .strict();
export type PlaceholderBranch = z.infer<typeof BranchSchema>;

/** 条目段一侧（放行/不放行）：缺省注入模板 + 精确匹配分支。 */
const SideSchema = z
  .object({
    template: z.string(),
    branches: z.array(BranchSchema).optional(),
  })
  .strict();
export type PlaceholderSide = z.infer<typeof SideSchema>;

const StaticSegmentSchema = z.object({ kind: z.literal("static"), text: z.string() }).strict();
const EntrySegmentSchema = z
  .object({
    kind: z.literal("entry"),
    pass: SideSchema,
    /** 不放行侧（缺省 = 空模板） */
    fail: SideSchema.optional(),
    /** 遍历序：pre = 前置（默认）；post = 置后（同首位轴融合） */
    order: z.enum(["pre", "post"]).optional(),
    /** 最外层实例（首位轴/条目轴）之间的拼接串（缺省 "\n"） */
    separator: z.string().optional(),
    /** 更深轴实例之间的拼接串（缺省 = separator） */
    merge: z.string().optional(),
  })
  .strict();

export const PlaceholderSegmentSchema = z.discriminatedUnion("kind", [StaticSegmentSchema, EntrySegmentSchema]);
export type PlaceholderSegment = z.infer<typeof PlaceholderSegmentSchema>;
export type PlaceholderEntrySegment = z.infer<typeof EntrySegmentSchema>;

const PlaceholderEntrySchema = z
  .object({
    description: z.string(),
    source: z.enum(PLACEHOLDER_SOURCES),
    segments: z.array(PlaceholderSegmentSchema).min(1),
  })
  .strict();
export type PlaceholderEntry = z.infer<typeof PlaceholderEntrySchema>;

/** 占位符名（{{name}} 引用语法 \w+）。 */
const PlaceholderNameSchema = z.string().regex(/^\w+$/, "占位符名必须是 \\w+");

export const PlaceholderCatalogSchema = z.record(PlaceholderNameSchema, PlaceholderEntrySchema);
export type PlaceholderCatalog = z.infer<typeof PlaceholderCatalogSchema>;

/** 分支记号集规范化（排序去重，原地；规范化后重复的分支键 = 抛错拒装）。 */
export function normalizeBranches(catalog: PlaceholderCatalog): PlaceholderCatalog {
  for (const [name, entry] of Object.entries(catalog)) {
    for (const segment of entry.segments) {
      if (segment.kind !== "entry") continue;
      for (const [sideLabel, side] of [
        ["pass", segment.pass],
        ["fail", segment.fail],
      ] as const) {
        if (side === undefined) continue;
        const seen = new Set<string>();
        for (const branch of side.branches ?? []) {
          const normalized = [...new Set(branch.tokens)].sort();
          branch.tokens = normalized;
          const key = normalized.join("");
          if (seen.has(key)) {
            throw new Error(`占位符 "${name}" ${sideLabel} 侧存在重复分支键：[${normalized.join(", ")}]`);
          }
          seen.add(key);
        }
      }
    }
  }
  return catalog;
}

/** 解析占位符目录（zod 形状校验 + 分支记号集规范化）。 */
export function parsePlaceholders(data: unknown): PlaceholderCatalog {
  return normalizeBranches(PlaceholderCatalogSchema.parse(data));
}

// ---------------------------------------------------------------------------
// 路径调用（条目段模板内的单花括号调用）
// ---------------------------------------------------------------------------

/** 路径调用词法：{标识符/路由链}（字符集不含引号/冒号/空格——JSON 示例不会被误捕）。 */
const PATH_CALL_RE = /\{([A-Za-z_][\w.\[\]*]*)\}/g;

/** 扁平源伪路径：{_content} = 条目扁平文本；{_owner} = 属主 CID。 */
export const PSEUDO_PATHS = ["_content", "_owner"] as const;

/** 提取模板文本内全部路径调用（去重，按出现顺序）。 */
export function extractPathCalls(text: string): string[] {
  const out: string[] = [];
  for (const m of text.matchAll(PATH_CALL_RE)) {
    if (!out.includes(m[1]!)) out.push(m[1]!);
  }
  return out;
}

// ---------------------------------------------------------------------------
// 路由链（vars 源）
// ---------------------------------------------------------------------------

/** 解析后的路由链：根 + 段序列（characters 根的 cid/`*` 段含在 segs 内）+ .tags 选择子。 */
export interface RoutingChain {
  root: "world" | "characters";
  segs: string[];
  /** .tags 字段选择子（取末端 tag_list；裸路径 = value） */
  tagsSelector: boolean;
  /** 原文（报错定位用） */
  raw: string;
}

/** 解析路由链文本（剥 .tags 后缀、拆段、根校验）；非法即抛错（消息带路径）。 */
export function parseRoutingChain(raw: string): RoutingChain {
  let path = raw;
  let tagsSelector = false;
  if (path.endsWith(".tags")) {
    tagsSelector = true;
    path = path.slice(0, -".tags".length);
  }
  const segs = splitVarPath(path);
  const root = segs[0];
  if (root !== "world" && root !== "characters") {
    throw new Error(`路径 "${raw}" 的根必须是 world / characters`);
  }
  if (root === "characters") {
    const cidSeg = segs[1];
    if (cidSeg === undefined || (cidSeg !== "*" && !/^C\d+$/.test(cidSeg))) {
      throw new Error(`路径 "${raw}" 的 characters 根下一段必须是 cid 字面量或 [*] 轴`);
    }
  }
  return { root, segs, tagsSelector, raw };
}

/** 链内全部 [*] 轴（按从左到右顺序；id = root:到该轴为止的段序列，段间用 "." 连接）。 */
export interface ChainAxis {
  id: string;
  root: "world" | "characters";
  /** 到该轴为止的段序列（含轴段 "*"） */
  prefix: string[];
}

export function axesOfChain(chain: RoutingChain): ChainAxis[] {
  const out: ChainAxis[] = [];
  for (let i = 0; i < chain.segs.length; i++) {
    if (chain.segs[i] === "*") {
      const prefix = chain.segs.slice(0, i + 1);
      out.push({ id: `${chain.root}:${prefix.join(".")}`, root: chain.root, prefix });
    }
  }
  return out;
}

/** 条目段的首位轴 id（全部路径按收集序的首个 [*] 轴；无轴 = ""；扁平源条目轴 = "E"）。 */
export function firstAxisId(chains: readonly RoutingChain[]): string {
  for (const chain of chains) {
    const axes = axesOfChain(chain);
    if (axes.length > 0) return axes[0]!.id;
  }
  return "";
}

/** 声明侧解析：路由链必须解析到末端（tag_list 原子即止；穿越末端/不可解析 = 抛错）。 */
function resolveChainDecl(chain: RoutingChain, template: VarsTemplate): void {
  const rest = chain.root === "world" ? chain.segs.slice(1) : chain.segs.slice(2);
  if (rest.length === 0) {
    throw new Error(`路径 "${chain.raw}" 必须解析到末端（当前为根容器）`);
  }
  const declRoot = chain.root === "world" ? template.world : template.character;
  const decl = resolveDeclPath(declRoot, rest.join("."));
  if (decl.kind !== "terminal") {
    throw new Error(`路径 "${chain.raw}" 必须解析到末端（当前为容器/数组）`);
  }
}

/**
 * 多路径路由链兼容性（最前差异点规则）：任意两条链的首个不同段（root 视为第 0 段）
 * 必须满足二者之一——① 至少一侧是 [*] 轴（差异点本身是轴）；② 差异点之前的公共前缀
 * 已含 [*] 轴（分叉发生在共享轴的子树内，归并后只是兄弟叶）。静态前缀上的分叉
 * （尚未进入任何轴即分道扬镳，如 world.* 混 characters.*）无法归并为单一遍历树 = 拒绝。
 * 一链是另一链前缀 = 允许（到末端机检另管）。
 */
function checkChainCompat(chains: readonly RoutingChain[], at: string): void {
  for (let a = 0; a < chains.length; a++) {
    for (let b = a + 1; b < chains.length; b++) {
      const sa = chains[a]!.segs;
      const sb = chains[b]!.segs;
      const len = Math.min(sa.length, sb.length);
      let i = 0;
      while (i < len && sa[i] === sb[i]) i++;
      if (i === len) continue; // 前缀关系
      const prefixHasAxis = sa.slice(0, i).includes("*");
      if (sa[i] !== "*" && sb[i] !== "*" && !prefixHasAxis) {
        throw new Error(
          `${at}路由链不兼容："${chains[a]!.raw}" 与 "${chains[b]!.raw}" 的最前差异点（段 "${sa[i]}" ≠ "${sb[i]}"）不在 [*] 轴上或共享轴子树内`,
        );
      }
    }
  }
}

// ---------------------------------------------------------------------------
// 编辑期机检（加载与包基线校验双口径，同一函数）
// ---------------------------------------------------------------------------

export interface ValidatePlaceholdersDeps {
  /** 档内变量模板（vars 源路径解析基准） */
  template: VarsTemplate;
  /** 档内 TAG 注册表（分支记号合法性基准；全知/强制全知/开放类别 = 同名 system 条目） */
  registry: TagRegistry;
}

/**
 * 占位符目录语义机检（任何违规 = 抛错拒装，消息带占位符名）：
 * ① 扁平源条目段只允许 {_content}/{_owner} 伪路径；vars 源只允许路由链路径且至少一条；
 * ② vars 路径必须解析到末端（tag_list 原子即止，不得穿越末端）；
 * ③ 条目内多路径路由链兼容性（最前差异点规则）；
 * ④ 置后条目首位轴一致（同一占位符内全部 order=post 条目段）；
 * ⑤ branches 记号合法性（注册表条目名——全知/强制全知/开放类别为同名 system 条目）。
 */
export function validatePlaceholders(catalog: PlaceholderCatalog, deps: ValidatePlaceholdersDeps): void {
  for (const [name, entry] of Object.entries(catalog)) {
    const at = `占位符 "${name}"：`;
    const postAxes: string[] = [];
    for (const segment of entry.segments) {
      if (segment.kind !== "entry") continue;
      const texts = [segment.pass.template, segment.fail?.template ?? ""];
      for (const side of [segment.pass, segment.fail] as const) {
        for (const branch of side?.branches ?? []) texts.push(branch.template);
      }
      const paths = [...new Set(texts.flatMap(extractPathCalls))];
      const pseudo = paths.filter((p) => (PSEUDO_PATHS as readonly string[]).includes(p));
      const chains = paths.filter((p) => !(PSEUDO_PATHS as readonly string[]).includes(p));

      if (entry.source === "vars") {
        if (pseudo.length > 0) {
          throw new Error(`${at}vars 源条目段不允许伪路径 {${pseudo.join("}、{")}}`);
        }
        if (chains.length === 0) {
          throw new Error(`${at}vars 源条目段必须至少有一条路由链路径`);
        }
        const parsed = chains.map(parseRoutingChain);
        for (const chain of parsed) {
          try {
            resolveChainDecl(chain, deps.template);
          } catch (err) {
            throw new Error(`${at}${(err as Error).message}`);
          }
        }
        checkChainCompat(parsed, at);
        if (segment.order === "post") postAxes.push(firstAxisId(parsed));
      } else {
        if (chains.length > 0) {
          throw new Error(`${at}扁平源（${entry.source}）条目段只允许 {_content}/{_owner} 伪路径，收到 {${chains.join("}、{")}}`);
        }
        if (segment.order === "post") postAxes.push("E");
      }

      // branches 记号合法性（两側；加载期已规范化排序）
      for (const side of [segment.pass, segment.fail] as const) {
        for (const branch of side?.branches ?? []) {
          for (const token of branch.tokens) {
            if (deps.registry[token] === undefined) {
              throw new Error(`${at}分支键含未登记记号 "${token}"（须为 TAG 注册表条目名）`);
            }
          }
        }
      }
    }
    if (postAxes.length > 0 && !postAxes.every((axis) => axis === postAxes[0])) {
      throw new Error(`${at}全部置后（order=post）条目的首位轴必须一致（收到 ${postAxes.map((a) => (a === "" ? "无轴" : a)).join("、")}）`);
    }
  }
}
