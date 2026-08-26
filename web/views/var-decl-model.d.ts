/**
 * web/views/var-decl-model.js 的类型声明（供 TS 测试 import；权威运行时行为见 var-decl-model.js）。
 */

export const VALUE_TYPES: readonly string[];

export type ValueType = "number" | "string" | "boolean" | "string_list" | "tag_list";

/** formula 结构化视图（expr 公式 / union_attach 内置算子）。 */
export type FormulaView =
  | { kind: "expr"; expr: string; binds: Record<string, string> }
  | { kind: "unionAttach"; paths: string[] };

/** formula 写入形状（null = 清空）。 */
export type FormulaSpec =
  | { expr: string; binds?: Record<string, string> }
  | { op: "union_attach"; paths: string[] };

interface NodeBase {
  key: string;
  path: string;
}

/** 声明末端节点（valueType + 结构化 formula 视图；canDelete 含 character 根必需声明保护；system = 系统声明分支节点，全部操作禁用）。 */
export interface DeclTerminalNode extends NodeBase {
  kind: "declTerminal";
  valueType: ValueType;
  derived: boolean;
  formula: FormulaView | null;
  canDelete: boolean;
  system: boolean;
}

/** 声明容器节点（可递归新增子声明；system = 系统分支容器，新增/删除全禁，子节点同禁）。 */
export interface DeclContainerNode extends NodeBase {
  kind: "declContainer";
  children: VarDeclNode[];
  canDelete: boolean;
  system: boolean;
}

/** 声明类型容器节点（只显示类型引用；字段到类型区编辑；system = 系统分支节点）。 */
export interface DeclTypeContainerNode extends NodeBase {
  kind: "declTypeContainer";
  typeName: string;
  canDelete: boolean;
  system: boolean;
}

/** 不可判别声明节点（只读呈现）。 */
export interface DeclUnknownNode extends NodeBase {
  kind: "unknown";
  display: string;
}

/** 类型区类型根节点：children = 声明字段。 */
export interface TypeRootNode extends NodeBase {
  kind: "typeRoot";
  children: VarDeclNode[];
}

/** 类型声明末端字段（derived/formula = 结构化 formula 视图；binds/paths 以类型根为基准）。 */
export interface TypeDeclTerminalNode extends NodeBase {
  kind: "typeDeclTerminal";
  typeName: string;
  valueType: ValueType;
  derived: boolean;
  formula: FormulaView | null;
}

/** 类型声明容器字段（可递归加子字段）。 */
export interface TypeDeclContainerNode extends NodeBase {
  kind: "typeDeclContainer";
  typeName: string;
  children: VarDeclNode[];
}

/** 类型声明内的 {type} 引用字段。 */
export interface TypeDeclTypeRefNode extends NodeBase {
  kind: "typeDeclTypeRef";
  typeName: string;
  refTypeName: string;
}

export type VarDeclNode =
  | DeclTerminalNode
  | DeclContainerNode
  | DeclTypeContainerNode
  | DeclUnknownNode
  | TypeRootNode
  | TypeDeclTerminalNode
  | TypeDeclContainerNode
  | TypeDeclTypeRefNode;

export interface VarDeclView {
  root?: string;
  children: VarDeclNode[];
}

export interface VarDeclRoot {
  id: string;
  label: string;
}

/** 结构新增规格（kind 缺省 = terminal；只动声明，无实例联动）。 */
export interface AddSpec {
  name: string;
  kind?: "terminal" | "struct" | "typeContainer";
  valueType?: ValueType;
  typeName?: string;
}

export interface VarDeclModel {
  listRoots(): VarDeclRoot[];
  listTypeNames(): string[];
  buildRootView(root: string): VarDeclView;
  buildTypesView(): VarDeclView;
  addDecl(root: string, containerPath: string, spec: AddSpec): void;
  deleteDecl(root: string, path: string): void;
  addType(name: string): void;
  deleteType(name: string): void;
  addTypeField(typeName: string, containerPath: string, spec: AddSpec): void;
  removeTypeField(typeName: string, path: string): void;
  setDeclFormula(root: string, path: string, formula: FormulaSpec | null): void;
  setTypeDeclFormula(typeName: string, path: string, formula: FormulaSpec | null): void;
  getTemplate(): any;
}

export function isPlainObject(v: unknown): boolean;
export function classifyRawDecl(raw: unknown): any;
export function defaultValueFor(valueType: ValueType): unknown;
export function validateBaseName(name: string): void;
export function formulaViewOf(raw: unknown): FormulaView | null;
export function collectTypeRefs(raw: unknown, out: string[]): void;

export function createVarDeclModel(deps: { template: any }): VarDeclModel;
