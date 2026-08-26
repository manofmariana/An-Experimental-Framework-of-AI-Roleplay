/**
 * 变量实例树（纯逻辑，禁 IO/LLM/server/truth/application，审计守护）。
 *
 * 实例树与模板声明树同构：容器 = 嵌套对象，结构化数组 = 元素对象数组（元素字段为
 * 末端外壳/嵌套对象/嵌套数组；元素自身无 tags 挂载位），末端 = 外壳
 * {value, tags, formula?}（tags = {name, level 1-7}[]，原子值，元素不是树节点；
 * formula 与模板侧同 schema，允许实例覆盖/补充，校验规则相同）。原始值
 * （number/string/boolean）或扁平数组（string_list 等）= 末端简写，展开为
 * {value, tags: []}。
 *
 * normalizeInstance 做简写展开 + 模板对拍：无声明有实例 = 抛错拒绝（消息带路径）；
 * 有声明无实例 = 合法（跳过）；值类型按声明 valueType 校验（number = 有限数、
 * string_list = string[]、tag_list = {name, level 1-7}[]）；结构化数组实例必须是
 * 数组，逐元素按元素结构展开。
 *
 * 路径解析：resolvePath 解析声明树（容器查子键、数组层按 `键[数字]`/`键[*]` 下标
 * 穿越到元素结构、不得穿越末端）；readTerminal 读末端实例——裸路径默认取 value，
 * .tags 后缀 = 字段选择子取 tag_list，末端后还有段 = 抛错（该末端的 .tags 选择子
 * 除外）；路径必须解析到末端，有声明无实例 = 返回 undefined。
 *
 * validateTagListWrite = 内容侧挂载表（末端外壳 tags）写值校验：{name, level 1-7}[]
 * 形状合法 + 名称校验（见 TagWriteScope）。validateTagNamesWrite = 对象侧
 * 纯名集合（attachtags 等 string_list 保留名末端）写值校验：string[] 形状 + 逐条
 * 名称校验。两者别混淆：外壳 tags 保持 {name, level}[] 不动，只有 attachtags/
 * tags 池两个保留名末端是纯名数组（注册名集合与类别上下文由调用方注入，本模块
 * 不感知注册表）。
 *
 * validateSystemTags = 系统末端 tags 侧车校验：路径必须命中系统声明分支末端
 * （systemChar.ts 的键集 + character 根解析），条目按 validateTagListWrite 校验。
 */
import { z } from "zod";
import type { TagCategory } from "../tags/registry.js";
import {
  resolveDeclPath,
  splitVarPath,
  validateFormulaSpec,
  type ContainerDecl,
  type DeclNode,
  type RawFormula,
  type TagMount,
  type TerminalDecl,
  type ValueType,
} from "./template.js";
import { SYSTEM_CHAR_KEYS } from "./systemChar.js";

// ---------------------------------------------------------------------------
// 实例树类型
// ---------------------------------------------------------------------------

export type { TagMount } from "./template.js";

/** 末端值（按声明 valueType 分派）。 */
export type TerminalValue = number | string | boolean | string[] | TagMount[];

/** 末端外壳：value + tags + 可选 formula 覆盖。 */
export interface TerminalInstance {
  value: TerminalValue;
  tags: TagMount[];
  formula?: TerminalDecl["formula"];
}

/** 实例节点：末端外壳、嵌套容器对象或结构化数组（元素对象数组）。 */
export type InstanceNode = TerminalInstance | { [key: string]: InstanceNode } | InstanceNode[];

// ---------------------------------------------------------------------------
// 值形状校验
// ---------------------------------------------------------------------------

const TagLevelSchema = z.number().int().min(1).max(7);

/** 单条内容侧 TAG 挂载 schema（{name, level 1-7}；truth 层 zod 契约复用）。 */
export const TagMountSchema = z.object({ name: z.string().min(1), level: TagLevelSchema }).strict();

const TagListSchema = z.array(TagMountSchema);

/** 按声明 valueType 校验末端值（消息带路径与期望类型）。 */
function validateValue(value: unknown, valueType: ValueType, path: string): TerminalValue {
  const fail = (): never => {
    throw new Error(`实例值类型错配（路径 "${path}"，期望 ${valueType}）`);
  };
  switch (valueType) {
    case "number":
      if (typeof value !== "number" || !Number.isFinite(value)) fail();
      return value as number;
    case "string":
      if (typeof value !== "string") fail();
      return value as string;
    case "boolean":
      if (typeof value !== "boolean") fail();
      return value as boolean;
    case "string_list": {
      if (!Array.isArray(value) || value.some((v) => typeof v !== "string")) fail();
      return value as string[];
    }
    case "tag_list": {
      const parsed = TagListSchema.safeParse(value);
      if (!parsed.success) fail();
      return parsed.data as TagMount[];
    }
  }
}

/**
 * TAG 写值名称校验上下文（调用方注入，本模块不感知注册表）：
 * - registeredNames = 注册表条目名集合（省略 = 不做名称校验，只验形状）；
 * - categories = 开放类别声明：键存在 = 该类别已声明；cid 的值 = 现存角色 CID 集合
 *   （实例合法性程序判定）。
 * 名称合法 = ∈ registeredNames ∪（cid 已声明 ∧ ∈ 其 CID 集合）∪（channel/location
 * 已声明——实例集运行期派生（活跃频道号/当前地点名），不做写时校验，声明即放行）。
 * 例外：CID 形态名（C 开头 + 数字）是 cid 类别候选，未知 CID = 手误，始终拒绝
 * （防手误优先于 channel/location 放行）。
 */
export interface TagWriteScope {
  registeredNames?: ReadonlySet<string>;
  categories?: Partial<Record<TagCategory, ReadonlySet<string>>>;
}

/** CID 形态名（与 truth/identity 的 @CID 占位同形；vars 层禁依赖 truth，本地持有）。 */
const CID_SHAPE = /^C\d+$/;

/** 名称校验：scope 缺省/无注册名集合 = 不校验；否则按 TagWriteScope 口径判定。 */
function assertTagNameLegal(name: string, scope: TagWriteScope | undefined, what: string): void {
  if (scope?.registeredNames === undefined) return;
  if (scope.registeredNames.has(name)) return;
  const cats = scope.categories;
  if (cats !== undefined) {
    if (cats.cid !== undefined && cats.cid.has(name)) return;
    // channel/location 类别实例集运行期派生，不做写时校验：类别已声明即放行
    // （CID 形态名除外——它是 cid 类别候选，未知 CID = 手误，拒绝）
    if (!CID_SHAPE.test(name) && ("channel" in cats || "location" in cats)) return;
  }
  throw new Error(`${what}含未注册 TAG 名 "${name}"`);
}

/** tag_list 写值校验：形状合法 + 提供名称校验上下文时每条 name 必须命中（见 assertTagNameLegal）。 */
export function validateTagListWrite(value: unknown, scope?: TagWriteScope): TagMount[] {
  const parsed = TagListSchema.safeParse(value);
  if (!parsed.success) {
    throw new Error("tag_list 写值形状非法：期望 {name, level 1-7 整数}[]");
  }
  for (const item of parsed.data) {
    assertTagNameLegal(item.name, scope, "tag_list 写值");
  }
  return parsed.data;
}

/** 对象侧纯名集合写值校验（attachtags 等 string_list 保留名末端）：string[] + 逐条名称校验。 */
export function validateTagNamesWrite(value: unknown, scope?: TagWriteScope): string[] {
  if (!Array.isArray(value) || value.some((v) => typeof v !== "string")) {
    throw new Error("TAG 名集合写值形状非法：期望 string[]");
  }
  for (const name of value) {
    assertTagNameLegal(name, scope, "TAG 名集合写值");
  }
  return value as string[];
}

/**
 * 系统末端 tags 侧车校验：每条路径必须在系统声明分支内并解析到末端
 * （characterDecl = 并入系统分支后的 character 根），条目按 validateTagListWrite 校验
 * （level 1-7 + 名称校验上下文注入）。通过即原样返回。
 */
export function validateSystemTags(
  systemTags: Record<string, unknown>,
  characterDecl: ContainerDecl,
  scope?: TagWriteScope,
): Record<string, TagMount[]> {
  const out: Record<string, TagMount[]> = {};
  for (const [path, value] of Object.entries(systemTags)) {
    let head = "";
    try {
      head = splitVarPath(path)[0] ?? "";
    } catch {
      throw new Error(`systemTags 路径 "${path}" 在系统分支中不可解析`);
    }
    if (!SYSTEM_CHAR_KEYS.has(head)) {
      throw new Error(`systemTags 路径 "${path}" 不在系统分支内`);
    }
    let decl: DeclNode;
    try {
      decl = resolveDeclPath(characterDecl, path);
    } catch {
      throw new Error(`systemTags 路径 "${path}" 在系统分支中不可解析`);
    }
    if (decl.kind !== "terminal") {
      throw new Error(`systemTags 路径 "${path}" 必须解析到末端`);
    }
    out[path] = validateTagListWrite(value, scope);
  }
  return out;
}

// ---------------------------------------------------------------------------
// 简写展开 + 模板对拍
// ---------------------------------------------------------------------------

const SHELL_KEYS = new Set(["value", "tags", "formula"]);

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function normalizeTerminal(
  raw: unknown,
  decl: TerminalDecl,
  path: string,
  rootDecl: DeclNode,
  scope?: TagWriteScope,
): TerminalInstance {
  // 原始值/数组 = 末端简写
  if (!isPlainObject(raw)) {
    return { value: validateValue(raw, decl.valueType, path), tags: [] };
  }
  // 对象 = 外壳形（仅 value/tags/formula 键，strict）
  for (const key of Object.keys(raw)) {
    if (!SHELL_KEYS.has(key)) {
      throw new Error(`末端实例外壳含非法键 "${key}"（路径 "${path}"）`);
    }
  }
  if (!Object.hasOwn(raw, "value")) {
    throw new Error(`末端实例外壳缺 value（路径 "${path}"）`);
  }
  const value = validateValue(raw["value"], decl.valueType, path);
  const tags = raw["tags"] === undefined ? [] : validateTagListWrite(raw["tags"], scope);
  const instance: TerminalInstance = { value, tags };
  if (raw["formula"] !== undefined) {
    instance.formula = validateFormulaSpec(raw["formula"] as RawFormula, decl.valueType, rootDecl, path);
  }
  return instance;
}

function normalize(raw: unknown, decl: DeclNode, path: string, rootDecl: DeclNode, scope?: TagWriteScope): InstanceNode {
  if (decl.kind === "terminal") {
    return normalizeTerminal(raw, decl, path, rootDecl, scope);
  }
  if (decl.kind === "array") {
    if (!Array.isArray(raw)) {
      throw new Error(`结构化数组实例必须是数组（路径 "${path}"）`);
    }
    return raw.map((el, i) => normalize(el, decl.element, `${path}[${i}]`, rootDecl, scope));
  }
  if (!isPlainObject(raw)) {
    throw new Error(`容器实例必须是对象（路径 "${path}"）`);
  }
  const out: Record<string, InstanceNode> = {};
  for (const [key, value] of Object.entries(raw)) {
    const childDecl = decl.children[key];
    if (childDecl === undefined) {
      throw new Error(`实例含未声明的键（路径 "${path === "" ? key : `${path}.${key}`}"）`);
    }
    out[key] = normalize(value, childDecl, path === "" ? key : `${path}.${key}`, rootDecl, scope);
  }
  return out;
}

/**
 * 简写展开 + 模板对拍：无声明有实例 = 抛错（消息带路径）；有声明无实例 = 合法
 * （跳过，不出现在产物中）。rootDecl 同时作为实例外壳 formula 的同根解析基准。
 * scope 提供时末端外壳 tags 顺带做名称校验（直编/容器整体写入通道；缺省 = 只验形状）。
 */
export function normalizeInstance(rawNode: unknown, declNode: DeclNode, path: string, scope?: TagWriteScope): InstanceNode {
  return normalize(rawNode, declNode, path, declNode, scope);
}

// ---------------------------------------------------------------------------
// 路径解析与末端读取
// ---------------------------------------------------------------------------

/** 解析声明树路径（容器查子键、数组层按下标段穿越到元素结构、不得穿越末端）。 */
export function resolvePath(declNode: DeclNode, dottedPath: string): DeclNode {
  return resolveDeclPath(declNode, dottedPath);
}

/** 末端外壳判定：含 value 键的平面对象。 */
export function isTerminalInstance(v: unknown): v is TerminalInstance {
  return isPlainObject(v) && Object.hasOwn(v, "value");
}

/**
 * 读取末端实例：裸路径默认取 value；.tags 后缀 = 字段选择子取 tag_list；路径不得
 * 穿越末端（末端后还有段 = 抛错，该末端的 .tags 选择子除外）。路径必须解析到末端
 * 声明；有声明无实例 = 返回 undefined。
 */
export function readTerminal(
  instanceRoot: unknown,
  declRoot: DeclNode,
  dottedPath: string,
  selector?: "value" | "tags",
): unknown {
  let path = dottedPath;
  let sel: "value" | "tags" = selector ?? "value";
  if (dottedPath.endsWith(".tags")) {
    if (selector !== undefined && selector !== "tags") {
      throw new Error(`路径 "${dottedPath}" 的 .tags 后缀与选择子 "${selector}" 冲突`);
    }
    path = dottedPath.slice(0, -".tags".length);
    sel = "tags";
  }

  // 声明侧全量解析：穿越末端/不可解析/非末端 = 抛错（与实例是否存在无关）
  const decl = resolveDeclPath(declRoot, path);
  if (decl.kind !== "terminal") {
    throw new Error(`路径 "${dottedPath}" 必须解析到末端（当前为容器/数组）`);
  }
  // 实例侧下行：有声明无实例 = undefined（数组层按数字字符串下标穿越）
  let inst: unknown = instanceRoot;
  for (const seg of splitVarPath(path)) {
    if ((!isPlainObject(inst) && !Array.isArray(inst)) || isTerminalInstance(inst)) {
      return undefined;
    }
    inst = (inst as Record<string, unknown>)[seg];
    if (inst === undefined) return undefined;
  }
  if (!isTerminalInstance(inst)) {
    throw new Error(`路径 "${dottedPath}" 的实例不是末端外壳`);
  }
  return sel === "tags" ? inst.tags : inst.value;
}
