/**
 * web/views/vars-tags-model.js 的类型声明（供 TS 测试 import；权威运行时行为见 vars-tags-model.js）。
 */

export type ValueType = "number" | "string" | "boolean" | "string_list" | "tag_list";

/** 附加条目：{name, level} | {category, level}（恰居其一，level 1-7 整数）。 */
export type AttachEntry = { name: string; level: number } | { category: string; level: number };

interface NodeBase {
  key: string;
  path: string;
}

/** 附加编辑末端节点。 */
export interface TagsTerminalNode extends NodeBase {
  kind: "tagsTerminal";
  valueType: ValueType;
  entries: AttachEntry[];
}

/** 附加编辑容器节点（节点级条目向下级联到后代末端）。 */
export interface TagsContainerNode extends NodeBase {
  kind: "tagsContainer";
  entries: AttachEntry[];
  children: VarsTagsNodeView[];
}

/** 附加编辑类型容器节点（整型 {tags, type} 挂载；hasInstanceForm = 存在实例名形态，整型挂载被拒）。 */
export interface TagsTypeContainerNode extends NodeBase {
  kind: "tagsTypeContainer";
  typeName: string;
  entries: AttachEntry[];
  hasInstanceForm: boolean;
}

/** 不可判别声明节点（只读呈现）。 */
export interface TagsUnknownNode extends NodeBase {
  kind: "unknown";
  display: string;
}

export type VarsTagsNodeView = TagsTerminalNode | TagsContainerNode | TagsTypeContainerNode | TagsUnknownNode;

export interface VarsTagsView {
  root?: string;
  /** 根节点自身条目（根挂 = 级联到该根全部末端）。 */
  rootEntries: AttachEntry[];
  children: VarsTagsNodeView[];
}

export interface VarsTagsRoot {
  id: string;
  label: string;
}

export interface VarsTagsModel {
  listRoots(): VarsTagsRoot[];
  buildRootView(root: string): VarsTagsView;
  setNodeTags(root: string, path: string, entries: AttachEntry[]): void;
  getPayload(): any;
}

export function createVarsTagsModel(deps: { template: any; varsTags: any }): VarsTagsModel;
