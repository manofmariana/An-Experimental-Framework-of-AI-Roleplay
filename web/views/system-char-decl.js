/**
 * 角色系统声明分支的 web 侧共享镜像（纯常量，零 DOM 零网络，node:test 可直接 import）。
 *
 * 本模块是服务端 src/vars/systemChar.ts 的镜像，变更需两侧同步。代码常量，不进世界包
 * 模板文件：var-tree-model（实例状态编辑器投影）与 var-decl-model / vars-tags-model
 * （世界页声明树/TAG 附加的并入显示）统一从这里取，消除双镜像漂移。
 *
 * SYSTEM_CHAR_DECLS = character 根系统声明子树的原始声明形态（字符串简写末端 /
 * {children} 容器 / {array} 结构化数组），键序 = 界面呈现序，位于作者声明之前；
 * SYSTEM_CHAR_TYPES = 系统类型声明（relations 数组元素引用 relation）。
 */

/**
 * character 根系统声明子树：name 等顶层字段 + 调度字段 acted/group/channel/timer/
 * isPlayer/appearance（值只读语义在 var-tree-model 的 CHAR_SYSTEM_FIELDS 收窄，呈现层徽记）。
 */
export const SYSTEM_CHAR_DECLS = {
  name: "string",
  gender: "string",
  age: "string",
  personality: "string",
  reaction: "number",
  level: "number",
  omniscience: "number",
  location: { children: { name: "string", level: "number" } },
  initiative: { children: { value: "number", group: "number" } },
  relations: { array: { type: "relation" } },
  long_term_memory: "string_list",
  acted: "boolean",
  group: "number",
  channel: "number",
  timer: "number",
  isPlayer: "boolean",
  appearance: "boolean",
};

/** 系统类型声明（relations 数组元素结构引用）。 */
export const SYSTEM_CHAR_TYPES = {
  relation: { children: { cid: "string", name: "string", impression: "string" } },
};

/** 系统分支键集（系统路径判定用）。 */
export const SYSTEM_CHAR_KEYS = new Set(Object.keys(SYSTEM_CHAR_DECLS));
