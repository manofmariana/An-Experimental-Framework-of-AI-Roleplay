/**
 * 变量模板与 TAG 附加文件契约（纯逻辑，禁 IO/LLM/server/truth/application，审计守护）。
 *
 * 变量模板（vars-template.json）= {world, character, types?} 三棵声明树：容器/结构化
 * 数组/末端三类节点，末端是唯一可携带 TAG、可被路径调用的单元。节点按字段判别：字符串
 * 简写 = valueType 末端；{valueType, formula?} = 末端完整形；{children} = 容器；
 * {array: 元素声明} = 结构化数组（元素 = {type} 引用 types 结构别名或 {children} 内联
 * 对象结构；元素根不得又是数组）。容器子键禁用 value/tags/formula（消除实例简写二义性）
 * 且不得含 "[" / "]"（与路径下标语法冲突）与 "."（与路径分段冲突）。types = 纯结构别名注册表（每个类型只能是
 * {children} 形态）：类型引用必须可解析且无环（成环 = 加载拒绝），解析期把被引用类型
 * 声明内联进数组元素，此后路径解析无需类型注册表。
 *
 * 路径语法：段 = 键，数组层用 `键[数字]`（精确下标）或 `键[*]`（通配）——
 * 如 items[0].name / items[*].name；解析期统一拆为段序列（splitVarPath）。
 *
 * 末端可带 formula：{expr, binds?} = 数值公式（compileFormula 编译 + 变量闭包校验，
 * binds 值 = 同根模板路径、须解析到 number 末端）；{op: "union_attach", paths} =
 * 内置算子（paths = 同根模板路径、须解析到容器/数组声明；空数组 = 仅自身 attachtags）。
 * expr 只允许挂在 number 末端，union_attach 只允许挂在 string_list 末端。数组内联元素
 * 内的 formula 以元素结构根为基准声明（与 types 类型内 formula 同口径）。
 *
 * character 根保留名：attachtags（普通 string_list 末端，无 formula；对象侧 TAG 纯名
 * 集合）与 tags（string_list 末端，formula 必须是 union_attach）。world 根无要求。
 *
 * 系统声明分支（src/vars/systemChar.ts，代码持有常量）：解析时并入 character 根
 * （relations 的系统类型 relation 并入 types），与世界作者声明同名 = 拒装（冲突
 * 报错带名）。模板暴露两个 character 视图：character = 并入后的完整根（路径解析/
 * 附加文件对拍/投影用），characterVars = 世界作者声明子树（实例 normalize 用，
 * 系统分支键不接受实例）。
 *
 * TAG 附加文件（vars-tags.json）与模板同构：节点 = {tags?, children?} 或
 * {tags?, array}（数组整型挂载：array = 元素类型名，内联元素为 "*"），TagEntry =
 * {name, level} | {category, level}（恰居其一，level ∈ 1-7 整数）。parseVarsTags 做
 * 同构校验（每条路径须在模板中存在且容器/数组/末端位置对应）；resolveAttachTags 把条目
 * 解析为 末端路径 → {name, level}[]：节点级条目扇出到其下全部末端（数组层路径以
 * `[*]` 占位），末端级条目只挂本末端。tags 只存在于末端——数组节点与数组元素对象
 * 自身没有挂载位，指向它们的条目一律扇出到末端。{category} 条目：category 须在
 * 调用方注入的开放类别集合内；cid 类按属主分发（提供 ownerCid → {name: ownerCid}，
 * 未提供 = 报错，world 根解析不传 ownerCid），其余类别归一化为类别名记号。
 */
import { z } from "zod";
import { compileFormula, type CompiledFormula } from "../shared/formula.js";
import { SYSTEM_CHAR_CHILDREN, SYSTEM_CHAR_KEYS, SYSTEM_CHAR_TYPES } from "./systemChar.js";

// ---------------------------------------------------------------------------
// 声明树类型（编译产物）
// ---------------------------------------------------------------------------

/** 末端值类型封闭集。 */
export const VALUE_TYPES = ["number", "string", "boolean", "string_list", "tag_list"] as const;
export type ValueType = (typeof VALUE_TYPES)[number];

/** 单条 TAG 挂载：{TAG 名, 等级 1-7}。 */
export interface TagMount {
  name: string;
  level: number;
}

/** 编译后的公式声明（判别联合）。 */
export type FormulaDecl =
  | { kind: "expr"; expr: string; binds: Record<string, string>; compiled: CompiledFormula }
  | { kind: "unionAttach"; paths: readonly string[] };

export interface TerminalDecl {
  kind: "terminal";
  valueType: ValueType;
  formula?: FormulaDecl | undefined;
  /** 系统只读元数据（仅系统声明分支的五调度字段为 true；值走专用通道，不开放变量写）。 */
  system?: boolean | undefined;
}

export interface ContainerDecl {
  kind: "container";
  children: Record<string, DeclNode>;
}

/** 结构化数组：元素 = 对象结构（types 别名已内联，无环保证有限）；typeName = 元素类型引用名（内联元素无）。 */
export interface ArrayDecl {
  kind: "array";
  element: ContainerDecl;
  typeName?: string | undefined;
}

export type DeclNode = TerminalDecl | ContainerDecl | ArrayDecl;

/** 编译后的变量模板。 */
export interface VarsTemplate {
  readonly world: ContainerDecl;
  /** 并入系统声明分支后的完整 character 根（路径解析/附加文件对拍/投影用）。 */
  readonly character: ContainerDecl;
  /** 世界作者声明的 character 子树（实例 normalize 用；系统分支键不接受实例）。 */
  readonly characterVars: ContainerDecl;
  readonly types: Readonly<Record<string, ContainerDecl>>;
  /** 按根名 + 根内点分路径取声明节点（不可解析/穿越末端 = 抛错）。 */
  resolve(root: "world" | "character", dottedPath: string): DeclNode;
}

// ---------------------------------------------------------------------------
// 路径标记化（`键[数字]` / `键[*]` → 段序列；数字/`*` 段 = 数组层下标）
// ---------------------------------------------------------------------------

const SEG_RE = /^([^[\]]+?)(?:\[(\d+|\*)\])?$/;

/**
 * 路径拆段：`characters.C1001.items[0].name` → ["characters","C1001","items","0","name"]；
 * `items[*].name` → ["items","*","name"]。裸 `[…]` 段（无键）与非法括号 = 抛错。
 */
export function splitVarPath(path: string): string[] {
  const out: string[] = [];
  for (const raw of path.split(".")) {
    const m = SEG_RE.exec(raw);
    if (m === null) {
      throw new Error(`路径 "${path}" 含非法段 "${raw}"（下标语法：键[数字] / 键[*]）`);
    }
    out.push(m[1]!);
    if (m[2] !== undefined) out.push(m[2]);
  }
  return out;
}

/** 段 = 数组下标（精确数字或 `*` 通配）。 */
export function isIndexSegment(seg: string): boolean {
  return seg === "*" || /^\d+$/.test(seg);
}

// ---------------------------------------------------------------------------
// 原始形状 schema（zod）
// ---------------------------------------------------------------------------

/**
 * 缺省空模板：世界包缺 vars-template.json 时 GET 的缺省结构（PUT 创建同形文件）。
 * character 根 = 最小保留名声明（attachtags 普通 string_list 末端 + tags union_attach 从动池）。
 */
export const EMPTY_VARS_TEMPLATE: unknown = {
  world: { children: {} },
  character: {
    children: {
      attachtags: "string_list",
      tags: { valueType: "string_list", formula: { op: "union_attach", paths: [] } },
    },
  },
  types: {},
};

/** 缺省空 TAG 附加文件（世界包缺 vars-tags.json 时 GET 的缺省结构）。 */
export const EMPTY_VARS_TAGS: unknown = { world: {}, character: {} };

const ValueTypeSchema = z.enum(VALUE_TYPES);

/** 原始公式声明（模板与实例外壳共用 schema）。 */
export type RawFormula =
  | { expr: string; binds?: Record<string, string> | undefined }
  | { op: "union_attach"; paths: string[] };

/** 数组元素声明：{type} 引用 types 结构别名 / {children} 内联对象结构（元素根不得又是数组——schema 无 array 键保证）。 */
type RawElement = { type: string } | { children: Record<string, RawNode> };

type RawNode =
  | ValueType
  | { valueType: ValueType; formula?: RawFormula | undefined }
  | { children: Record<string, RawNode> }
  | { array: RawElement };

const FormulaSpecSchema: z.ZodType<RawFormula> = z.union([
  z.object({ expr: z.string().min(1), binds: z.record(z.string(), z.string().min(1)).optional() }).strict(),
  z.object({ op: z.literal("union_attach"), paths: z.array(z.string().min(1)) }).strict(),
]);

const NodeSchema: z.ZodType<RawNode> = z.lazy(() =>
  z.union([
    ValueTypeSchema,
    z.object({ valueType: ValueTypeSchema, formula: FormulaSpecSchema.optional() }).strict(),
    z.object({ children: z.record(z.string(), NodeSchema) }).strict(),
    z.object({
      array: z.union([
        z.object({ type: z.string().min(1) }).strict(),
        z.object({ children: z.record(z.string(), NodeSchema) }).strict(),
      ]),
    }).strict(),
  ]),
);

const TemplateRootSchema = z
  .object({
    world: NodeSchema,
    character: NodeSchema,
    types: z.record(z.string(), NodeSchema).optional(),
  })
  .strict();

/** 容器子键保留名（消除实例简写二义性；character 根的保留名 tags 是唯一豁免）。 */
const RESERVED_CHILD_KEYS = new Set(["value", "tags", "formula"]);

// ---------------------------------------------------------------------------
// 路径解析（声明树上；数组层按下标段（数字/`*`）穿越到元素结构）
// ---------------------------------------------------------------------------

/** 解析根内点分路径到声明节点；不存在/穿越末端/数组层缺下标 = 抛错（消息带路径）。 */
export function resolveDeclPath(root: DeclNode, dottedPath: string): DeclNode {
  let node = root;
  for (const seg of splitVarPath(dottedPath)) {
    if (node.kind === "terminal") {
      throw new Error(`模板路径 "${dottedPath}" 穿越末端（段 "${seg}"）`);
    }
    if (node.kind === "container") {
      const child = node.children[seg];
      if (child === undefined) {
        throw new Error(`模板路径 "${dottedPath}" 不可解析：容器缺子键 "${seg}"`);
      }
      node = child;
    } else {
      if (!isIndexSegment(seg)) {
        throw new Error(`模板路径 "${dottedPath}" 的数组层需要 [数字] 或 [*] 下标（段 "${seg}"）`);
      }
      node = node.element;
    }
  }
  return node;
}

// ---------------------------------------------------------------------------
// 公式声明校验（模板解析与实例外壳共用）
// ---------------------------------------------------------------------------

/**
 * 校验并编译一份原始公式声明：expr = 编译 + 闭包校验（引用标识符 ⊆ binds 键集）
 * + binds 路径可解析且指向 number 末端；union_attach = paths 可解析且指向容器/数组声明。
 * rootDecl = 同根声明树（binds/paths 的解析基准；数组内联元素内公式以元素结构根为基准）；
 * atPath 仅用于报错定位。
 */
export function validateFormulaSpec(
  raw: RawFormula,
  valueType: ValueType,
  rootDecl: DeclNode,
  atPath: string,
): FormulaDecl {
  if ("op" in raw) {
    if (valueType !== "string_list") {
      throw new Error(`公式 union_attach 只能挂在 string_list 末端（${atPath} 为 ${valueType}）`);
    }
    for (const p of raw.paths) {
      const target = resolveDeclPath(rootDecl, p);
      if (target.kind === "terminal") {
        throw new Error(`union_attach 子树路径 "${p}" 必须解析到容器/数组声明（${atPath}）`);
      }
    }
    return { kind: "unionAttach", paths: [...raw.paths] };
  }
  if (valueType !== "number") {
    throw new Error(`数值公式只能挂在 number 末端（${atPath} 为 ${valueType}）`);
  }
  const compiled = compileFormula(raw.expr);
  const binds = raw.binds ?? {};
  for (const v of compiled.variables) {
    if (!Object.hasOwn(binds, v)) {
      throw new Error(`公式引用了未声明的标识符 "${v}"（${atPath}，表达式：${raw.expr}）`);
    }
  }
  for (const [key, p] of Object.entries(binds)) {
    const target = resolveDeclPath(rootDecl, p);
    if (target.kind !== "terminal" || target.valueType !== "number") {
      throw new Error(`公式绑定 "${key}" 的路径 "${p}" 必须解析到 number 末端（${atPath}）`);
    }
  }
  return { kind: "expr", expr: compiled.expr, binds: { ...binds }, compiled };
}

// ---------------------------------------------------------------------------
// 模板解析
// ---------------------------------------------------------------------------

/** 收集原始子树内全部类型引用名（类型引用图建边用；数组元素 {type} 引用同样建边）。 */
function collectTypeRefs(raw: RawNode, out: string[]): void {
  if (typeof raw === "string") return;
  if ("array" in raw) {
    if ("type" in raw.array) out.push(raw.array.type);
    else for (const child of Object.values(raw.array.children)) collectTypeRefs(child, out);
    return;
  }
  if ("children" in raw) {
    for (const child of Object.values(raw.children)) collectTypeRefs(child, out);
  }
}

/** 类型引用图成环检测（DFS，消息带环路径）；引用未声明类型 = 抛错。直接与间接递归都拒。 */
function checkTypeRefs(types: Record<string, RawNode>): void {
  const refs = new Map<string, string[]>();
  for (const [name, raw] of Object.entries(types)) {
    const list: string[] = [];
    collectTypeRefs(raw, list);
    refs.set(name, list);
  }
  for (const [name, list] of refs) {
    for (const ref of list) {
      if (!Object.hasOwn(types, ref)) {
        throw new Error(`类型 "${name}" 引用了未声明的类型 "${ref}"`);
      }
    }
  }
  const state = new Map<string, "visiting" | "done">();
  const visit = (name: string, chain: string[]): void => {
    const s = state.get(name);
    if (s === "done") return;
    if (s === "visiting") {
      const cycle = [...chain.slice(chain.indexOf(name)), name];
      throw new Error(`类型引用成环：${cycle.join(" -> ")}`);
    }
    state.set(name, "visiting");
    for (const ref of refs.get(name) ?? []) visit(ref, [...chain, ref]);
    state.set(name, "done");
  };
  for (const name of refs.keys()) visit(name, [name]);
}

interface ConvertCtx {
  /** 按名取内联后的类型结构（成环已预先拒绝，递归安全）。 */
  resolveType: (name: string) => ContainerDecl;
  /** 待校验公式的末端（解析期暂存原始声明，根建成后再编译）。 */
  pendingFormulas: Array<{ decl: TerminalDecl; spec: RawFormula; path: string }>;
}

function convertNode(raw: RawNode, ctx: ConvertCtx, path: string, allowTagsChild = false): DeclNode {
  if (typeof raw === "string") {
    return { kind: "terminal", valueType: raw };
  }
  if ("array" in raw) {
    if ("type" in raw.array) {
      return { kind: "array", element: ctx.resolveType(raw.array.type), typeName: raw.array.type };
    }
    // 内联元素结构：作为独立子根转换（内部 formula 以元素结构根为基准校验）
    const pending: ConvertCtx["pendingFormulas"] = [];
    const element = convertNode({ children: raw.array.children }, { ...ctx, pendingFormulas: pending }, `${path}[*]`);
    if (element.kind !== "container") {
      throw new Error(`数组元素必须是对象结构（${path}）`);
    }
    compilePendingFormulas(element, pending);
    return { kind: "array", element };
  }
  if ("children" in raw) {
    const children: Record<string, DeclNode> = {};
    for (const [key, child] of Object.entries(raw.children)) {
      if (RESERVED_CHILD_KEYS.has(key) && !(allowTagsChild && key === "tags")) {
        throw new Error(`容器子键名 "${key}" 为保留名（${path}）`);
      }
      if (key.includes("[") || key.includes("]")) {
        throw new Error(`容器子键名 "${key}" 不得含 "[" / "]"（与下标语法冲突）（${path}）`);
      }
      if (key.includes(".")) {
        throw new Error(`容器子键名 "${key}" 不得含 "."（与路径分段冲突）（${path}）`);
      }
      children[key] = convertNode(child, ctx, path === "" ? key : `${path}.${key}`);
    }
    return { kind: "container", children };
  }
  const decl: TerminalDecl = { kind: "terminal", valueType: raw.valueType };
  if (raw.formula !== undefined) {
    ctx.pendingFormulas.push({ decl, spec: raw.formula, path });
  }
  return decl;
}

/** 编译根下全部待校验公式并回填末端声明。 */
function compilePendingFormulas(root: DeclNode, pending: ConvertCtx["pendingFormulas"]): void {
  for (const { decl, spec, path } of pending) {
    decl.formula = validateFormulaSpec(spec, decl.valueType, root, path || "<根>");
  }
}

/**
 * 解析并校验变量模板：zod 形状校验 + 语义校验（类型引用可解析且无环、类型只能是
 * {children} 结构别名、容器子键保留名、公式闭包/路径校验、character 根保留名规则）。
 * 任何违规 = 抛错拒装。
 */
export function parseVarsTemplate(raw: unknown): VarsTemplate {
  const parsed = TemplateRootSchema.parse(raw);
  const rawTypes = parsed.types ?? {};
  checkTypeRefs(rawTypes);

  // 类型别名按需转换并内联（memo；无环保证递归终止）
  const typeDecls = new Map<string, ContainerDecl>();
  const resolveType = (name: string): ContainerDecl => {
    const hit = typeDecls.get(name);
    if (hit !== undefined) return hit;
    const rawType = rawTypes[name];
    if (rawType === undefined) {
      throw new Error(`引用了未声明的类型 "${name}"`);
    }
    const pending: ConvertCtx["pendingFormulas"] = [];
    const decl = convertNode(rawType, { resolveType, pendingFormulas: pending }, name);
    if (decl.kind !== "container") {
      throw new Error(`类型 "${name}" 必须是 {children} 结构别名`);
    }
    typeDecls.set(name, decl);
    compilePendingFormulas(decl, pending);
    return decl;
  };

  const worldPending: ConvertCtx["pendingFormulas"] = [];
  const world = convertNode(parsed.world, { resolveType, pendingFormulas: worldPending }, "world");
  if (world.kind !== "container") {
    throw new Error("world 根必须是容器节点");
  }
  compilePendingFormulas(world, worldPending);

  const charPending: ConvertCtx["pendingFormulas"] = [];
  const characterVars = convertNode(parsed.character, { resolveType, pendingFormulas: charPending }, "character", true);
  if (characterVars.kind !== "container") {
    throw new Error("character 根必须是容器节点");
  }
  compilePendingFormulas(characterVars, charPending);

  // character 根保留名：attachtags = 普通 string_list 末端；tags = union_attach 从动末端
  const attachtags = characterVars.children["attachtags"];
  if (
    attachtags === undefined ||
    attachtags.kind !== "terminal" ||
    attachtags.valueType !== "string_list" ||
    attachtags.formula !== undefined
  ) {
    throw new Error(`character 根必须声明 attachtags 为无 formula 的 string_list 末端`);
  }
  const tags = characterVars.children["tags"];
  if (
    tags === undefined ||
    tags.kind !== "terminal" ||
    tags.valueType !== "string_list" ||
    tags.formula?.kind !== "unionAttach"
  ) {
    throw new Error(`character 根必须声明 tags 为 union_attach 公式的 string_list 末端`);
  }

  // 系统声明分支并入（与世界作者声明同名 = 拒装，冲突报错带名）
  for (const key of SYSTEM_CHAR_KEYS) {
    if (Object.hasOwn(characterVars.children, key)) {
      throw new Error(`character 根声明 "${key}" 与系统声明分支同名冲突`);
    }
  }
  const character: ContainerDecl = {
    kind: "container",
    children: { ...SYSTEM_CHAR_CHILDREN, ...characterVars.children },
  };

  const types: Record<string, ContainerDecl> = {};
  for (const sysType of Object.keys(SYSTEM_CHAR_TYPES)) {
    if (Object.hasOwn(rawTypes, sysType)) {
      throw new Error(`类型 "${sysType}" 与系统声明分支类型同名冲突`);
    }
  }
  for (const name of Object.keys(rawTypes)) types[name] = resolveType(name);

  return {
    world,
    character,
    characterVars,
    types: { ...SYSTEM_CHAR_TYPES, ...types },
    resolve: (root, dottedPath) => resolveDeclPath(root === "world" ? world : character, dottedPath),
  };
}

// ---------------------------------------------------------------------------
// TAG 附加文件（vars-tags.json）
// ---------------------------------------------------------------------------

const TagLevelSchema = z.number().int().min(1).max(7);

/** 附加条目原始形状：{name, level} | {category, level}（恰居其一，strict 保证）。 */
export type AttachTagEntry = { name: string; level: number } | { category: string; level: number };

const AttachTagEntrySchema: z.ZodType<AttachTagEntry> = z.union([
  z.object({ name: z.string().min(1), level: TagLevelSchema }).strict(),
  z.object({ category: z.string().min(1), level: TagLevelSchema }).strict(),
]);

/**
 * 附加文件节点：{tags?, children?} 或 {tags?, array}（数组整型挂载：array = 元素类型名，
 * 内联元素为 "*"）。数组不支持 children 形态（实例键已废弃，按元素逐挂没有意义）。
 */
export interface VarsTagsNode {
  tags?: AttachTagEntry[] | undefined;
  children?: Record<string, VarsTagsNode> | undefined;
  array?: string | undefined;
}

const VarsTagsNodeSchema: z.ZodType<VarsTagsNode> = z.lazy(() =>
  z.union([
    z.object({ tags: z.array(AttachTagEntrySchema).optional(), array: z.string().min(1) }).strict(),
    z
      .object({
        tags: z.array(AttachTagEntrySchema).optional(),
        children: z.record(z.string(), VarsTagsNodeSchema).optional(),
      })
      .strict(),
  ]),
);

/** 同构校验：附加文件每条路径必须在模板中存在且容器/数组/末端位置对应。 */
function checkIsomorphic(node: VarsTagsNode, decl: DeclNode, path: string): void {
  if (decl.kind === "terminal") {
    if (node.children !== undefined || node.array !== undefined) {
      throw new Error(`TAG 附加文件路径 "${path}" 在模板中为末端，不得带 children/array`);
    }
    return;
  }
  if (decl.kind === "array") {
    if (node.array === undefined) {
      throw new Error(`TAG 附加文件路径 "${path}" 在模板中为结构化数组，整型挂载须带 array 键`);
    }
    const expected = decl.typeName ?? "*";
    if (node.array !== expected) {
      throw new Error(`TAG 附加文件路径 "${path}" 的 array "${node.array}" 与模板元素结构 "${expected}" 不符`);
    }
    return;
  }
  if (node.array !== undefined) {
    throw new Error(`TAG 附加文件路径 "${path}" 在模板中为普通容器，不得带 array`);
  }
  for (const [key, child] of Object.entries(node.children ?? {})) {
    const childDecl = decl.children[key];
    if (childDecl === undefined) {
      throw new Error(`TAG 附加文件路径 "${path === "" ? key : `${path}.${key}`}" 在模板中不存在`);
    }
    checkIsomorphic(child, childDecl, path === "" ? key : `${path}.${key}`);
  }
}

/** 解析 TAG 附加文件（对拍单个模板根；world/character 根分别调用）。 */
export function parseVarsTags(raw: unknown, template: DeclNode): VarsTagsNode {
  const node = VarsTagsNodeSchema.parse(raw);
  checkIsomorphic(node, template, "");
  return node;
}

export interface ResolveAttachTagsOptions {
  /** 开放类别集合（调用方注入；category 条目必须命中） */
  categories: ReadonlySet<string>;
  /** cid 类别分发目标（character 根解析时传入；world 根不传，遇 cid 条目报错） */
  ownerCid?: string | undefined;
}

/**
 * 把附加条目解析为 末端路径 → {name, level}[]：节点级条目扇出到其下全部末端，
 * 末端级条目只挂本末端；同名去重（先取者胜）。数组层无实例可枚举，路径以 `[*]`
 * 占位（运行期按下标通配匹配）。tags 只落在末端路径上——数组节点与元素对象自身
 * 没有挂载位。
 */
export function resolveAttachTags(
  varsTags: VarsTagsNode,
  template: DeclNode,
  opts: ResolveAttachTagsOptions,
): Map<string, TagMount[]> {
  const result = new Map<string, TagMount[]>();
  const seen = new Map<string, Set<string>>();

  const entryToMounts = (entry: AttachTagEntry, path: string): TagMount[] => {
    if ("name" in entry) return [{ name: entry.name, level: entry.level }];
    if (!opts.categories.has(entry.category)) {
      throw new Error(`未知 TAG 类别 "${entry.category}"（路径 "${path}"）`);
    }
    if (entry.category === "cid") {
      if (opts.ownerCid === undefined) {
        throw new Error(`cid 类附加条目需要属主 cid（路径 "${path}"）`);
      }
      return [{ name: opts.ownerCid, level: entry.level }];
    }
    return [{ name: entry.category, level: entry.level }];
  };

  const attach = (path: string, mounts: readonly TagMount[]): void => {
    if (mounts.length === 0) return;
    let names = seen.get(path);
    if (names === undefined) {
      names = new Set();
      seen.set(path, names);
    }
    const list = result.get(path) ?? [];
    for (const m of mounts) {
      if (names.has(m.name)) continue;
      names.add(m.name);
      list.push(m);
    }
    result.set(path, list);
  };

  /** 把级联条目挂到声明子树的全部后代末端（path = 子树根路径；数组层以 `[*]` 占位）。 */
  const cascadeDecl = (decl: DeclNode, path: string, inherited: readonly TagMount[]): void => {
    if (decl.kind === "terminal") {
      attach(path, inherited);
      return;
    }
    if (decl.kind === "array") {
      cascadeDecl(decl.element, `${path}[*]`, inherited);
      return;
    }
    for (const [key, child] of Object.entries(decl.children)) {
      cascadeDecl(child, path === "" ? key : `${path}.${key}`, inherited);
    }
  };

  const walk = (node: VarsTagsNode, decl: DeclNode, path: string, inherited: readonly TagMount[]): void => {
    const own = (node.tags ?? []).flatMap((e) => entryToMounts(e, path));
    const mounts = [...inherited, ...own];
    if (decl.kind === "terminal") {
      attach(path, mounts);
      return;
    }
    if (decl.kind === "array") {
      // 数组整型挂载：扇出到元素结构全部末端（同构校验已保证 node.array 形态）
      cascadeDecl(decl.element, `${path}[*]`, mounts);
      return;
    }
    // 普通容器：本节点条目级联到未显式出现的后代末端，显式子键继承后继续下行
    const explicit = new Set(Object.keys(node.children ?? {}));
    for (const [key, childDecl] of Object.entries(decl.children)) {
      const childPath = path === "" ? key : `${path}.${key}`;
      const childNode = node.children?.[key];
      if (explicit.has(key) && childNode !== undefined) {
        walk(childNode, childDecl, childPath, mounts);
      } else {
        cascadeDecl(childDecl, childPath, mounts);
      }
    }
  };

  walk(varsTags, template, "", []);
  return result;
}
