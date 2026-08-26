/**
 * 双根 deltas 应用编排 + 档内 `_sys` 严格解析（truth 层；纯内存变异）。
 *
 * 路由：`world.…` → world 域；`characters.{cid}.…` → 角色域（cid 必须存在）。
 * 拒写：`world.time`（时间只能由调度器推进）/`world._sys`/`world.pipeline`（程序分支）、
 * 角色系统分支（vars 下首段命中系统声明分支键（name/timer/location 等）即拒——系统
 * 字段走 durations/location 等白名单专用通道，GM deltas 只可写 vars 作者子树；系统
 * 末端 tags 侧车本轮不开放 GM 写通道）、从动末端（带 formula，由程序维护）。
 *
 * 校验：路径必须在档内模板中可解析（resolvePath，无声明 = 抛错拒绝该条）；
 * 写末端 = 写 value（`=` 全量替换，值按 valueType 校验，外壳 tags 保留；`+=`/`-=` 仅
 * number 末端且当前值与增量均数值）；写容器 = `=` 整体对象（经 normalizeInstance 校验）；
 * attachtags（string_list 纯名集合）写值过 validateTagNamesWrite、tag_list 末端写值过
 * validateTagListWrite（名称校验 = 档内注册名集合 + 开放类别声明，deps 注入；cid 类别
 * 实例集 = 调用方注入的现存角色 CID 集合）。
 *
 * 落地：经 store 低层写入口（writeRaw）写入，产出真相根路径 VarChange。每写落一条
 * delta 后对该根做整根从动级联：按依赖图拓扑序重算全部从动末端（expr 公式 +
 * union_attach，含实例携带 formula 与类型容器 "*" 段实例枚举），值变则写回并追加
 * 该末端的 VarChange（级联写回是程序内部写，不走 GM 拒写闸）。
 *
 * `_sys` 程序分支 = {tagRegistry, varsTemplate, varsTags, cycles_since_gm, gm_trigger,
 * gm_trigger_batch}：文件 codec 层只验对象存在（worldStore.WorldSysSchema），本模块的
 * parseWorldSys 是严格解析唯一出口（装配/续档/直编共用），并在此做一次从动依赖
 * 成环闸（模板双根各建一次计划，成环即拒装/拒写）。
 */
import { z } from "zod";
import { parseTagRegistry, type TagCategory, type TagRegistry } from "../tags/registry.js";
import type { StateDelta } from "../types.js";
import { buildDerivedPlan, buildRootDerivedPlan, evalDerivedTarget } from "../vars/derived.js";
import { SYSTEM_CHAR_KEYS } from "../vars/systemChar.js";
import {
  parseVarsTags,
  parseVarsTemplate,
  type DeclNode,
  type VarsTagsNode,
  type VarsTemplate,
} from "../vars/template.js";
import {
  isTerminalInstance,
  normalizeInstance,
  resolvePath,
  validateTagListWrite,
  validateTagNamesWrite,
  type InstanceNode,
  type TerminalInstance,
} from "../vars/tree.js";
import { getByPath, type VarChange } from "./varChanges.js";
import type { CharactersStore } from "./charactersStore.js";
import type { WorldStore } from "./worldStore.js";

// ---------------------------------------------------------------------------
// `_sys` 严格解析
// ---------------------------------------------------------------------------

/** `_sys` 形状闸（内容校验分派：registry/template/varsTags 各自的 parse）。 */
const WorldSysStrictSchema = z.object({
  tagRegistry: z.unknown(),
  varsTemplate: z.unknown(),
  varsTags: z.object({ world: z.unknown(), character: z.unknown() }).strict(),
  cycles_since_gm: z.number(),
  gm_trigger: z.boolean(),
  gm_trigger_batch: z.number().nullable(),
});

/** 解析后的 `_sys` 程序分支。 */
export interface ParsedWorldSys {
  tagRegistry: TagRegistry;
  template: VarsTemplate;
  varsTags: { world: VarsTagsNode; character: VarsTagsNode };
  cycles_since_gm: number;
  gm_trigger: boolean;
  gm_trigger_batch: number | null;
}

/** 严格解析 `_sys`：形状闸 + 注册表/模板/附加文件各自 parse + 从动依赖成环闸（任何违规 = 抛错）。 */
export function parseWorldSys(raw: unknown): ParsedWorldSys {
  const parsed = WorldSysStrictSchema.parse(raw);
  const tagRegistry = parseTagRegistry(parsed.tagRegistry);
  const template = parseVarsTemplate(parsed.varsTemplate);
  // 成环闸：双根各建一次从动计划，成环即拒（装配/续档/直编共用本出口）
  buildDerivedPlan(template.world);
  buildDerivedPlan(template.character);
  return {
    tagRegistry,
    template,
    varsTags: {
      world: parseVarsTags(parsed.varsTags.world, template.world),
      character: parseVarsTags(parsed.varsTags.character, template.character),
    },
    cycles_since_gm: parsed.cycles_since_gm,
    gm_trigger: parsed.gm_trigger,
    gm_trigger_batch: parsed.gm_trigger_batch,
  };
}

/** deltas 应用所需依赖：档内模板 + TAG 写值名称校验上下文（注册名集合 + 开放类别声明）。 */
export interface VarWriteDeps {
  template: VarsTemplate;
  /** 档内注册表条目名集合。 */
  registeredNames: ReadonlySet<string>;
  /** 开放类别声明：键 = 注册表已声明该类别；cid 的值 = 现存角色 CID 集合（channel/location 已声明即放行）。 */
  categories: Partial<Record<TagCategory, ReadonlySet<string>>>;
}

/**
 * 从 `_sys` 解析产物构建写值依赖：registeredNames = 注册表条目名；categories = 注册表
 * 声明的开放类别（cid 类别的实例集 = cidInstances，调用方注入当前角色表键集；缺省 =
 * 空集，即 cid 实例名一律不放行）。
 */
export function varWriteDepsOf(sys: ParsedWorldSys, cidInstances?: ReadonlySet<string>): VarWriteDeps {
  const categories: Partial<Record<TagCategory, ReadonlySet<string>>> = {};
  for (const entry of Object.values(sys.tagRegistry)) {
    if (entry.category === undefined) continue;
    categories[entry.category] = entry.category === "cid" ? (cidInstances ?? new Set<string>()) : new Set<string>();
  }
  return { template: sys.template, registeredNames: new Set(Object.keys(sys.tagRegistry)), categories };
}

/** 写入目标（六 Store 视图的最小面；WorldStore/CharactersStore 直接满足）。 */
export interface VarWriteStores {
  world: WorldStore;
  characters: CharactersStore;
}

// ---------------------------------------------------------------------------
// 从动级联
// ---------------------------------------------------------------------------

/**
 * 整根从动级联：按该根依赖图拓扑序重算全部从动末端（expr 公式 + union_attach，
 * 含实例携带 formula 与类型容器 "*" 段实例枚举），值变则写回并追加该末端的
 * VarChange（真相根路径）；值不变/依赖末端无实例（跳过重算）不产生记录。
 * 从动集合小，不做细粒度失效分析——任一根写落后整根全量重算。
 */
export function cascadeDerived(
  stores: VarWriteStores,
  root: { kind: "world" } | { kind: "character"; cid: string },
  deps: VarWriteDeps,
): VarChange[] {
  const declRoot = root.kind === "world" ? deps.template.world : deps.template.characterVars;
  let instanceRoot: InstanceNode;
  if (root.kind === "world") {
    instanceRoot = stores.world.world as InstanceNode;
  } else {
    const state = stores.characters.all()[root.cid];
    if (state === undefined) throw new Error(`未知角色 CID: ${root.cid}`);
    instanceRoot = state.vars as InstanceNode;
  }
  const changes: VarChange[] = [];
  // 逐目标求值并立即写回：下游从动末端读到上游的新值（拓扑序保证）
  for (const target of buildRootDerivedPlan(declRoot, instanceRoot)) {
    const value = evalDerivedTarget(target, declRoot, instanceRoot);
    if (value === undefined) continue;
    const existing = getByPath(instanceRoot, target.path);
    const shell = isTerminalInstance(existing) ? existing : undefined;
    if (JSON.stringify(shell?.value) === JSON.stringify(value)) continue;
    const next: TerminalInstance = {
      value: value as TerminalInstance["value"],
      tags: shell?.tags ?? [],
      ...(shell?.formula !== undefined ? { formula: shell.formula } : {}),
    };
    changes.push(
      root.kind === "world"
        ? stores.world.writeRaw(target.path, next)
        : stores.characters.writeRaw(root.cid, `vars.${target.path}`, next),
    );
  }
  return changes;
}

// ---------------------------------------------------------------------------
// 单条 delta 应用
// ---------------------------------------------------------------------------

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** 计算写入值（末端 = 外壳整体，容器 = normalize 后的子树）。 */
function computeWriteValue(
  decl: DeclNode,
  before: unknown,
  delta: StateDelta,
  atPath: string,
  deps: VarWriteDeps,
): unknown {
  if (decl.kind !== "terminal") {
    if (delta.op !== "=") throw new Error(`${delta.op} 只能用于 number 末端（${atPath} 为容器）`);
    return normalizeInstance(delta.value, decl, atPath, deps);
  }
  if (decl.formula !== undefined) {
    throw new Error(`从动末端拒写（${atPath} 由程序按 formula 维护）`);
  }
  const existingTags = isTerminalInstance(before) ? before.tags : [];
  if (delta.op === "=") {
    if (decl.valueType === "tag_list") {
      return { value: validateTagListWrite(delta.value, deps), tags: existingTags };
    }
    // attachtags = 对象侧纯名集合（string_list 保留名末端）：名称校验
    if (decl.valueType === "string_list" && atPath.split(".").at(-1) === "attachtags") {
      return { value: validateTagNamesWrite(delta.value, deps), tags: existingTags };
    }
    if (isPlainObject(delta.value)) {
      throw new Error(`末端写值必须是原始值而非外壳对象（${atPath}，声明类型 ${decl.valueType}）`);
    }
    const shell = normalizeInstance(delta.value, decl, atPath, deps) as TerminalInstance;
    return { value: shell.value, tags: existingTags };
  }
  if (decl.valueType !== "number") {
    throw new Error(`${delta.op} 仅支持 number 末端（${atPath} 为 ${decl.valueType}）`);
  }
  const current = isTerminalInstance(before) ? before.value : undefined;
  if (typeof current !== "number" || typeof delta.value !== "number") {
    throw new Error(`${delta.op} 需要当前值与增量均为数值（${atPath}，当前 ${JSON.stringify(current ?? null)}）`);
  }
  return { value: delta.op === "+=" ? current + delta.value : current - delta.value, tags: existingTags };
}

/** world 域：拒写 time/_sys/pipeline 程序分支，其余按 world 模板校验落账；写后整根级联。 */
function applyWorldDelta(stores: VarWriteStores, delta: StateDelta, deps: VarWriteDeps): VarChange[] {
  const rest = delta.path.slice("world.".length);
  const head = rest.split(".")[0]!;
  if (head === "") throw new Error(`变量路径不完整：${delta.path}`);
  if (head === "time") {
    throw new Error(`GM deltas 不得修改 world.time；时间只能由调度器推进：${delta.path}`);
  }
  if (head === "_sys" || head === "pipeline") {
    throw new Error(`GM deltas 不得写程序分支 world.${head}：${delta.path}`);
  }
  const decl = resolvePath(deps.template.world, rest);
  const before = getByPath(stores.world.world, rest);
  const change = stores.world.writeRaw(rest, computeWriteValue(decl, before, delta, delta.path, deps));
  return [change, ...cascadeDerived(stores, { kind: "world" }, deps)];
}

/** 角色域：cid 必须存在，只可写 vars 子树；写后整根级联。 */
function applyCharacterDelta(stores: VarWriteStores, delta: StateDelta, deps: VarWriteDeps): VarChange[] {
  const rest = delta.path.slice("characters.".length);
  const dot = rest.indexOf(".");
  const cid = dot < 0 ? rest : rest.slice(0, dot);
  const inner = dot < 0 ? "" : rest.slice(dot + 1);
  const state = stores.characters.all()[cid];
  if (state === undefined) throw new Error(`deltas 指向未知角色 ${cid}：${delta.path}`);
  const head = inner.split(".")[0]!;
  if (head !== "vars") {
    throw new Error(
      `角色系统字段走白名单专用通道（durations/location 等裁决包字段），GM deltas 只可写 vars 子树：${delta.path}`,
    );
  }
  const rel = inner.slice("vars".length).replace(/^\./, "");
  // 系统分支先查：vars 下首段命中系统声明分支键 = 拒写（系统字段走白名单专用通道）
  const relHead = rel.split(".")[0]!;
  if (SYSTEM_CHAR_KEYS.has(relHead)) {
    throw new Error(
      `系统字段走白名单专用通道（durations/location 等裁决包字段），GM deltas 拒写系统分支：${delta.path}`,
    );
  }
  const decl = rel === "" ? deps.template.characterVars : resolvePath(deps.template.characterVars, rel);
  const before = rel === "" ? state.vars : getByPath(state.vars, rel);
  const storePath = rel === "" ? "vars" : `vars.${rel}`;
  const change = stores.characters.writeRaw(cid, storePath, computeWriteValue(decl, before, delta, delta.path, deps));
  return [change, ...cascadeDerived(stores, { kind: "character", cid }, deps)];
}

/**
 * 双根 deltas 应用（GM 裁决包/突发包统一写入通道）：路由 → 模板校验 → 落账 → 该根
 * 从动级联，任一 delta 非法即抛错（调用方丢弃整个 draft/步）。返回按序产出的
 * VarChange 列表。
 */
export function applyVarDeltas(
  stores: VarWriteStores,
  deltas: readonly StateDelta[],
  deps: VarWriteDeps,
): VarChange[] {
  const changes: VarChange[] = [];
  for (const delta of deltas) {
    if (delta.path.startsWith("world.")) {
      changes.push(...applyWorldDelta(stores, delta, deps));
    } else if (delta.path.startsWith("characters.")) {
      changes.push(...applyCharacterDelta(stores, delta, deps));
    } else {
      throw new Error(
        `变量路径必须使用双根语法：以 "world." 或 "characters.{cid}." 开头（${delta.path}）`,
      );
    }
  }
  return changes;
}
