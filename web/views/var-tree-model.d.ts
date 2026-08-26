/**
 * web/views/var-tree-model.js 的类型声明（供 TS 测试 import；权威运行时行为见 var-tree-model.js）。
 */

export const WORLD_SCOPE: "world";
export const VALUE_TYPES: readonly string[];
/** 角色系统只读字段（仅这五个，徽记「系统」；值走专用通道不开放编辑）。 */
export const CHAR_SYSTEM_FIELDS: readonly string[];

export type ValueType = "number" | "string" | "boolean" | "string_list" | "tag_list";

/** 单条内容侧 TAG 挂载：{TAG 名, 等级 1-7}（末端外壳 tags；对象侧池为 string[] 纯名集合）。 */
export interface TagMount {
  name: string;
  level: number;
}

/** formula 结构化只读标注（expr 公式 / union_attach 内置算子）。 */
export type FormulaView =
  | { kind: "expr"; expr: string; binds: Record<string, string> }
  | { kind: "unionAttach"; paths: string[] };

interface NodeBase {
  /** 显示名（容器/末端子键、实例名）。 */
  key: string;
  /** 根内点分路径（系统分支与 vars 树同一命名空间）。 */
  path: string;
}

/** 末端节点：按 valueType 分派控件；derived = 从动只读；system = 系统五字段只读徽记（tags 仍可编）。 */
export interface TerminalNode extends NodeBase {
  kind: "terminal";
  valueType: ValueType;
  hasInstance: boolean;
  value: unknown;
  tags: TagMount[];
  /** 附加来源 tags（vars-tags 读取期合并的只读展示，与实例 tags 按名去重；绝不写回工作副本/保存载荷）。 */
  attachTags: TagMount[];
  derived: boolean;
  system: boolean;
  formula: FormulaView | null;
  formulaText: string | null;
}

/** 普通容器节点（系统分支 location/initiative 同为容器；initiative null = 子末端皆无实例）。 */
export interface ContainerNode extends NodeBase {
  kind: "container";
  children: VarTreeNode[];
}

/** 类型容器节点：children = 各类型实例（系统分支 relations 同为类型容器）。 */
export interface TypeContainerNode extends NodeBase {
  kind: "typeContainer";
  typeName: string;
  children: VarTreeNode[];
}

/** 类型实例节点：canRemoveInstance = 可删实例（只动实例不动模板）。 */
export interface TypeInstanceNode extends NodeBase {
  kind: "typeInstance";
  children: VarTreeNode[];
  canRemoveInstance: boolean;
}

/** 实例侧未声明键只读呈现（正常态不存在；不静默隐藏数据）。 */
export interface UnknownNode extends NodeBase {
  kind: "unknown";
  display: string;
  /** 角色顶层未登记键标记（系统分支/vars/systemTags 之外）。 */
  fieldLevel?: boolean;
}

export type VarTreeNode =
  | TerminalNode
  | ContainerNode
  | TypeContainerNode
  | TypeInstanceNode
  | UnknownNode;

export interface VarTreeView {
  scope?: string;
  children: VarTreeNode[];
}

export interface VarTreeScope {
  id: string;
  label: string;
}

export interface VarTreeModel {
  listScopes(): VarTreeScope[];
  getTagNames(): string[];
  buildTree(scope: string): VarTreeView;
  writeTerminalValue(scope: string, path: string, value: unknown): void;
  writeTerminalTags(scope: string, path: string, tagList: TagMount[]): void;
  addRelationEntry(scope: string, entryKey: string): void;
  writeRelationField(scope: string, entryKey: string, fieldKey: string, value: string): void;
  removeRelationEntry(scope: string, entryKey: string): void;
  addTypeInstance(scope: string, containerPath: string, name: string): void;
  removeTypeInstance(scope: string, containerPath: string, name: string): void;
  getPayload(): { world: any; characters: any };
}

export function defaultValueFor(valueType: ValueType): unknown;

export function createVarTreeModel(working: { world: any; characters: any }): VarTreeModel;
