/**
 * web/views/placeholder-path-model.js 的类型声明（供 TS 测试 import；权威运行时行为见 placeholder-path-model.js）。
 */

/** 落盘四根（路径首段即根）。 */
export const DISK_ROOTS: readonly ["events", "lores", "characters", "world"];

/** events 根数组元素结构镜像（原始声明形态）。 */
export const EVENTS_ELEMENT_RAW: Record<string, unknown>;
/** lores 根数组元素结构镜像（原始声明形态）。 */
export const LORES_ELEMENT_RAW: Record<string, unknown>;
/** world 根系统声明子树镜像（原始声明形态）。 */
export const SYSTEM_WORLD_RAW: Record<string, unknown>;

/** 末端项：选定即插入 {path}。 */
export interface RefMenuEndpoint {
  kind: "endpoint";
  label: string;
  path: string;
}
/** 容器项：逐级展开。 */
export interface RefMenuBranch {
  kind: "branch";
  label: string;
  children: RefMenuNode[];
}
/** 数组层项：expandArray 按 [*]/下标/cid 段展开。 */
export interface RefMenuArray {
  kind: "array";
  label: string;
  /** bracket = `前缀[seg]`；dot = `前缀.seg`（characters 根 cid 轴）。 */
  join: "bracket" | "dot";
  /** index = 数字下标；cid = characters 根实例轴。 */
  axis: "index" | "cid";
  prefix: string;
  elementChildren: Record<string, unknown>;
  types: Record<string, unknown>;
  typeStack: string[];
}
export type RefMenuNode = RefMenuEndpoint | RefMenuBranch | RefMenuArray;

/**
 * 引用寻路菜单根级项：顶层两大类——「路径」（落盘四根逐级树；varsTemplate 为
 * characters/world 两根展开基准，null 降级为仅系统分支）与「程序」（sources 枚举
 * 逐源展开 content/owner 两末端）。
 */
export function buildRefMenu(varsTemplate: unknown, sources: readonly string[]): RefMenuNode[];

/** 展开数组层节点：seg = "*" / 数字下标 / cid 字面量。 */
export function expandArray(node: RefMenuArray, seg: string): RefMenuNode[];

/**
 * 占位符 source 推导（编辑器保存口径）：组装类路径全同一 source 且不混落盘根路径，
 * 否则抛错；纯落盘根路径/无路径 = undefined。
 */
export function deriveEntrySource(segments: readonly unknown[], sources: readonly string[]): string | undefined;

export interface PathToken {
  type: "text" | "path";
  value: string;
}

/** 模板文本 → token 序列（path 值不含花括号，按出现顺序）。 */
export function splitPathCalls(text: string): PathToken[];

/** token 序列 → 模板文本（splitPathCalls 的逆，往返恒等）。 */
export function joinPathTokens(tokens: readonly PathToken[]): string;
