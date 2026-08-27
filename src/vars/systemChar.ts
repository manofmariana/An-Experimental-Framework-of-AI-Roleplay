/**
 * 角色系统声明分支与实例投影（纯逻辑；对 template/tree 仅 type-import，保持零运行时
 * 出边——template.ts 解析期并入本模块常量，反向运行时会成环）。
 *
 * 角色顶层字段（name/gender/age/personality/reaction/level/omniscience/location/
 * initiative/relations/long_term_memory + 调度字段 acted/group/channel/timer/isPlayer/appearance）
 * 与 vars 树呈现为同一棵树的标准末端：本模块持有系统声明子树（代码常量，不进世界包
 * 模板文件），parseVarsTemplate 解析时并入 character 根（与世界作者声明同名 = 拒装），
 * 物理布局不变（调度器继续消费类型化字段）。调度字段的声明节点带 system 元数据
 * （值只读语义，呈现层徽记）；relations = 结构化数组（元素 = 系统类型 relation
 * {cid, name, impression}，消费侧按元素的 cid 字段匹配）。appearance = 在场位
 * （组弹出前台/入组 = true、结算进后台/离组 = false），程序维护、结构编辑只展示。
 *
 * projectCharacterTree = 投影：系统分支的值从类型化字段读出（timer/channel 可 null——
 * 系统分支特判，null 原样呈现不走 valueType 校验；initiative null = 容器无实例；
 * relations 数组按下标投影为元素对象），vars 树原样并入，合成一棵实例树。系统分支各
 * 末端 = {value, tags} 外壳，tags 来自 systemTags 侧车（系统分支末端路径 →
 * {name, level}[]，只经直编修改；数组层路径用 `键[下标]` 语法，如 relations[0].name；
 * 侧车校验 validateSystemTags 在 tree.ts）。
 */
import type { ArrayDecl, ContainerDecl, DeclNode, TerminalDecl, ValueType } from "./template.js";
import type { InstanceNode, TagMount, TerminalInstance } from "./tree.js";

// ---------------------------------------------------------------------------
// 系统声明分支（编译形态常量）
// ---------------------------------------------------------------------------

function terminal(valueType: ValueType, system = false): TerminalDecl {
  const decl: TerminalDecl = { kind: "terminal", valueType };
  if (system) decl.system = true;
  return decl;
}

function container(children: Record<string, DeclNode>): ContainerDecl {
  return { kind: "container", children };
}

/** 系统类型 relation 的声明（relations 数组元素结构，同时并入模板 types）。 */
export const SYSTEM_CHAR_TYPES: Readonly<Record<string, ContainerDecl>> = {
  relation: container({ cid: terminal("string"), name: terminal("string"), impression: terminal("string") }),
};

/** character 根系统声明子树（键序 = 投影呈现序；调度字段带 system 元数据）。 */
export const SYSTEM_CHAR_CHILDREN: Readonly<Record<string, DeclNode>> = {
  name: terminal("string"),
  gender: terminal("string"),
  age: terminal("string"),
  personality: terminal("string"),
  reaction: terminal("number"),
  level: terminal("number"),
  omniscience: terminal("number"),
  location: container({ name: terminal("string"), level: terminal("number") }),
  initiative: container({ value: terminal("number"), group: terminal("number") }),
  relations: {
    kind: "array",
    element: SYSTEM_CHAR_TYPES["relation"]!,
    typeName: "relation",
  } satisfies ArrayDecl,
  long_term_memory: terminal("string_list"),
  acted: terminal("boolean", true),
  group: terminal("number", true),
  channel: terminal("number", true),
  timer: terminal("number", true),
  isPlayer: terminal("boolean", true),
  appearance: terminal("boolean", true),
};

/** 系统分支键集（实例 normalize 拒收、varWrite 拒写判定、侧车路径判定用）。 */
export const SYSTEM_CHAR_KEYS: ReadonlySet<string> = new Set(Object.keys(SYSTEM_CHAR_CHILDREN));

// ---------------------------------------------------------------------------
// 投影
// ---------------------------------------------------------------------------

/** 投影输入（CharacterState 的结构化最小面；vars 层自定义以避免反向依赖；兼容深只读查询出口）。 */
export interface CharacterProjectionInput {
  name: string;
  gender: string;
  age: string;
  personality: string;
  reaction: number;
  level: number;
  omniscience: number;
  location: { name: string; level: number };
  initiative: { value: number; group: number } | null;
  relations: ReadonlyArray<{ cid: string; name?: string | undefined; impression?: string | undefined }>;
  long_term_memory: readonly string[];
  acted: boolean;
  group: number;
  channel: number | null;
  timer: number | null;
  isPlayer: boolean;
  /** 在场位（程序维护：组弹出前台/入组 = true，结算进后台/离组 = false；默认 false） */
  appearance: boolean;
  vars: Readonly<Record<string, unknown>>;
  /** 系统末端内容侧 TAG 侧车（系统分支末端路径 → 挂载表） */
  systemTags?: Readonly<Record<string, readonly TagMount[]>> | undefined;
}

/**
 * 角色状态 → 单棵实例树投影：系统分支值从类型化字段读出（timer/channel null 原样
 * 呈现，不走 valueType 校验；initiative null = 容器无实例；relations 数组按下标
 * 投影），vars 树原样并入。系统分支各末端 = {value, tags} 外壳，tags 取自 systemTags
 * 侧车（缺省空表）。
 */
export function projectCharacterTree(state: CharacterProjectionInput): InstanceNode {
  const tagsOf = (path: string): TagMount[] => [...(state.systemTags?.[path] ?? [])];
  const shell = (value: TerminalInstance["value"] | null, path: string): TerminalInstance => ({
    value: value as TerminalInstance["value"],
    tags: tagsOf(path),
  });
  const out: Record<string, InstanceNode> = {
    name: shell(state.name, "name"),
    gender: shell(state.gender, "gender"),
    age: shell(state.age, "age"),
    personality: shell(state.personality, "personality"),
    reaction: shell(state.reaction, "reaction"),
    level: shell(state.level, "level"),
    omniscience: shell(state.omniscience, "omniscience"),
    location: {
      name: shell(state.location.name, "location.name"),
      level: shell(state.location.level, "location.level"),
    },
    relations: state.relations.map((entry, i) => ({
      cid: shell(entry.cid, `relations[${i}].cid`),
      name: shell(entry.name ?? "", `relations[${i}].name`),
      impression: shell(entry.impression ?? "", `relations[${i}].impression`),
    })),
    long_term_memory: shell([...state.long_term_memory], "long_term_memory"),
    acted: shell(state.acted, "acted"),
    group: shell(state.group, "group"),
    channel: shell(state.channel, "channel"),
    timer: shell(state.timer, "timer"),
    isPlayer: shell(state.isPlayer, "isPlayer"),
    appearance: shell(state.appearance, "appearance"),
  };
  if (state.initiative !== null) {
    out["initiative"] = {
      value: shell(state.initiative.value, "initiative.value"),
      group: shell(state.initiative.group, "initiative.group"),
    };
  }
  return { ...out, ...(state.vars as Record<string, InstanceNode>) };
}
