/**
 * 占位符引用寻路与 chip 序列化纯逻辑（零 DOM 零网络，node:test 可直接 import）。
 *
 * 三部分：
 * ① buildRefMenu = 「引用」级联菜单数据：顶层两大类——「路径」= 落盘四根
 *    events/lores/characters/world 逐级树（容器逐级展开，数组层经 expandArray 按 [*]/下标
 *    展开，characters 根下一段 = cid 字面量或 [*] 轴；tag_list 末端出 值/.tags 两个末端项，
 *    末端止步）；「程序」= 组装源列表 → content/owner 两末端。world/character 根并入系统
 *    声明分支（镜像取自 system-char-decl.js 与本文件 SYSTEM_WORLD_RAW），数组元素 {type}
 *    类型引用内联（成环护断：循环类型展开为空）。
 * ② deriveEntrySource = 占位符 source 推导（编辑器保存口径）：扫描条目全部路径调用，
 *    出现组装类路径（{<source>.content}/{<source>.owner}）→ 全部组装路径必须同属一个
 *    source 且不得与落盘根路径混用（违反 = 抛错不提交）；纯落盘根路径/无路径 → undefined
 *    （source 省略）。无法归类的路径不在此判非法，留给服务端机检。
 * ③ splitPathCalls / joinPathTokens = 模板文本 ↔ 文本/路径 token 序列（chip 序列化基准；
 *    PATH_CALL_RE 为 src/compile/placeholders.ts 同则镜像，存储/校验格式不变）。
 *
 * 镜像常量（原始声明形态，变更需与服务端两侧同步）：
 * - EVENTS_ELEMENT_RAW / LORES_ELEMENT_RAW 镜像 src/compile/placeholders.ts
 *   EVENTS_ROOT_DECL / LORES_ROOT_DECL 的数组元素结构（系统固定结构）；
 * - SYSTEM_WORLD_RAW 镜像 src/vars/systemWorld.ts SYSTEM_WORLD_CHILDREN（time 容器）。
 *
 * 菜单节点三态：
 * - {kind:"endpoint", label, path} 末端项，path = 不含花括号的路径文本（选定即插入 {path}）；
 * - {kind:"branch", label, children} 容器项；
 * - {kind:"array", label, join, axis, prefix, elementChildren, types} 数组层项——join =
 *   "bracket"（键[下标]，events/lores 与链内数组）| "dot"（characters 根 cid 轴）；
 *   axis = "index"（数字下标）| "cid"；展开 = expandArray(node, seg)，seg = "*" 或合法
 *   下标/cid 字面量。
 */
import { classifyRawDecl, isPlainObject } from "./var-decl-model.js";
import { SYSTEM_CHAR_DECLS, SYSTEM_CHAR_TYPES } from "./system-char-decl.js";

/** 落盘四根（路径首段即根）。 */
export const DISK_ROOTS = ["events", "lores", "characters", "world"];

/** events 根数组元素结构镜像（系统固定结构；原始声明形态）。 */
export const EVENTS_ELEMENT_RAW = {
  id: "string",
  t: "number",
  seq: "number",
  kind: "string",
  location: "string",
  content: "string",
};

/** lores 根数组元素结构镜像（系统固定结构；原始声明形态）。 */
export const LORES_ELEMENT_RAW = {
  id: "string",
  content: "string",
  enabled: "boolean",
};

/** world 根系统声明子树镜像（time 容器：时间锚五末端 + periods 时段表；原始声明形态）。 */
export const SYSTEM_WORLD_RAW = {
  time: {
    children: {
      y: "number",
      m: "number",
      d: "number",
      h: "number",
      min: "number",
      periods: { array: { children: { key: "string", from: "number", to: "number" } } },
    },
  },
};

// ---------------------------------------------------------------------------
// 级联菜单数据
// ---------------------------------------------------------------------------

/** 容器子键 → 菜单项序列（prefix = 到该容器为止的路径文本，不含根外花括号）。 */
function childrenItems(children, prefix, types, typeStack) {
  const items = [];
  for (const [key, raw] of Object.entries(children)) {
    const path = `${prefix}.${key}`;
    const cls = classifyRawDecl(raw);
    if (cls === null) continue;
    if (cls.kind === "terminal") {
      items.push({ kind: "endpoint", label: key, path });
      if (cls.valueType === "tag_list") {
        items.push({ kind: "endpoint", label: `${key}.tags`, path: `${path}.tags` });
      }
      continue;
    }
    if (cls.kind === "container") {
      items.push({ kind: "branch", label: key, children: childrenItems(cls.children, path, types, typeStack) });
      continue;
    }
    // 结构化数组：内联元素结构直接用；{type} 引用内联（成环护断 = 展开为空）
    let elementChildren = cls.elementChildren;
    if (cls.elementType !== undefined) {
      if (typeStack.includes(cls.elementType)) {
        elementChildren = {};
      } else {
        const typeRaw = types[cls.elementType];
        const typeCls = typeRaw !== undefined ? classifyRawDecl(typeRaw) : null;
        elementChildren = typeCls !== null && typeCls.kind === "container" ? typeCls.children : {};
      }
    }
    items.push({
      kind: "array",
      label: `${key}[…]`,
      join: "bracket",
      axis: "index",
      prefix: path,
      elementChildren,
      types,
      typeStack: cls.elementType !== undefined ? [...typeStack, cls.elementType] : typeStack,
    });
  }
  return items;
}

/** 从 varsTemplate 原始声明取容器子键（缺失/不可判别 = 空）。 */
function containerChildrenOf(raw) {
  const cls = isPlainObject(raw) ? classifyRawDecl(raw) : null;
  return cls !== null && cls.kind === "container" ? cls.children : {};
}

/**
 * 引用寻路菜单根级项：顶层两大类——「路径」（落盘四根逐级树，varsTemplate 为
 * characters/world 两根展开基准，null 降级为仅系统分支）与「程序」（组装源列表 →
 * content/owner 两末端）。
 * @param {object|null|undefined} varsTemplate 当前模式 vars-template 原始声明树
 * @param {readonly string[]} sources 程序组装类 source 封闭枚举（服务端供给）
 * @returns {Array<object>} 菜单节点（三态见文件头注释）
 */
export function buildRefMenu(varsTemplate, sources) {
  const template = isPlainObject(varsTemplate) ? varsTemplate : {};
  const types = { ...SYSTEM_CHAR_TYPES, ...(isPlainObject(template.types) ? template.types : {}) };
  const worldChildren = { ...SYSTEM_WORLD_RAW, ...containerChildrenOf(template.world) };
  const charChildren = { ...SYSTEM_CHAR_DECLS, ...containerChildrenOf(template.character) };
  const diskItems = [
    {
      kind: "array", label: "events 事件", join: "bracket", axis: "index",
      prefix: "events", elementChildren: EVENTS_ELEMENT_RAW, types, typeStack: [],
    },
    {
      kind: "array", label: "lores 世界书", join: "bracket", axis: "index",
      prefix: "lores", elementChildren: LORES_ELEMENT_RAW, types, typeStack: [],
    },
    {
      kind: "array", label: "characters 角色", join: "dot", axis: "cid",
      prefix: "characters", elementChildren: charChildren, types, typeStack: [],
    },
    { kind: "branch", label: "world 世界", children: childrenItems(worldChildren, "world", types, []) },
  ];
  const programItems = (Array.isArray(sources) ? sources : []).map((s) => ({
    kind: "branch",
    label: s,
    children: [
      { kind: "endpoint", label: "content", path: `${s}.content` },
      { kind: "endpoint", label: "owner", path: `${s}.owner` },
    ],
  }));
  return [
    { kind: "branch", label: "路径", children: diskItems },
    { kind: "branch", label: "程序", children: programItems },
  ];
}

/**
 * 展开数组层节点：按轴段（"*" / 数字下标 / cid 字面量）出元素结构子级。
 * 路径形态按 node.join：bracket = `前缀[seg]`（events[*].content）；dot = `前缀.seg`
 * （characters.C1001.name / characters.*.name）。
 */
export function expandArray(node, seg) {
  const prefix = node.join === "dot" ? `${node.prefix}.${seg}` : `${node.prefix}[${seg}]`;
  return childrenItems(node.elementChildren, prefix, node.types, node.typeStack ?? []);
}

// ---------------------------------------------------------------------------
// source 推导（编辑器保存口径：source 不再手选，由路径调用推得）
// ---------------------------------------------------------------------------

/** 组装类命名路径形态（{<source>.content} / {<source>.owner}）。 */
const ASSEMBLED_PATH_RE = /^([A-Za-z_]\w*)\.(content|owner)$/;

/**
 * 从条目段列推导占位符 source：扫描全部路径调用（pass/fail 缺省模板 + 各侧分支模板）——
 * 组装类路径全部同属一个 source 且不与落盘根路径混用（违反 = 抛错不提交）；
 * 纯落盘根路径/无路径 = undefined（source 省略）。无法归类的路径（首段既非组装源
 * 也非落盘四根）不在此判非法，留给服务端机检。
 *
 * @param {Array<object>} segments 占位符段列（编辑器读出器产物）
 * @param {readonly string[]} sources 程序组装类 source 封闭枚举
 * @returns {string|undefined}
 */
export function deriveEntrySource(segments, sources) {
  const sourceSet = new Set(Array.isArray(sources) ? sources : []);
  const found = new Set();
  let hasDisk = false;
  for (const seg of Array.isArray(segments) ? segments : []) {
    if (!isPlainObject(seg) || seg.kind !== "entry") continue;
    const texts = [];
    for (const side of [seg.pass, seg.fail]) {
      if (!isPlainObject(side)) continue;
      texts.push(typeof side.template === "string" ? side.template : "");
      for (const branch of Array.isArray(side.branches) ? side.branches : []) {
        texts.push(isPlainObject(branch) && typeof branch.template === "string" ? branch.template : "");
      }
    }
    for (const text of texts) {
      for (const token of splitPathCalls(text)) {
        if (token.type !== "path") continue;
        const m = ASSEMBLED_PATH_RE.exec(token.value);
        if (m !== null && sourceSet.has(m[1])) {
          found.add(m[1]);
          continue;
        }
        if (DISK_ROOTS.includes(token.value.split(/[.[]/, 1)[0])) hasDisk = true;
      }
    }
  }
  if (found.size > 1) {
    throw new Error(`占位符混用多个组装源（${[...found].join("、")}）：全部组装路径必须同属一个 source`);
  }
  if (found.size === 1 && hasDisk) {
    throw new Error(`占位符混用组装源（${[...found][0]}）与落盘四根路径：一个占位符只能取一类`);
  }
  return found.size === 1 ? [...found][0] : undefined;
}

// ---------------------------------------------------------------------------
// chip 序列化（模板文本 ↔ 文本/路径 token 序列）
// ---------------------------------------------------------------------------

/** 路径调用词法镜像（与 src/compile/placeholders.ts PATH_CALL_RE 同则，变更需两侧同步）。 */
const PATH_CALL_RE = /\{([A-Za-z_][\w.\[\]*]*)\}/g;

/**
 * 模板文本 → token 序列（{type:"text"|"path", value}；path 值不含花括号，按出现顺序）。
 * 非路径调用形态的花括号（空格/冒号/双花括号等）原样留在 text token。
 */
export function splitPathCalls(text) {
  const tokens = [];
  let last = 0;
  for (const m of text.matchAll(PATH_CALL_RE)) {
    if (m.index > last) tokens.push({ type: "text", value: text.slice(last, m.index) });
    tokens.push({ type: "path", value: m[1] });
    last = m.index + m[0].length;
  }
  if (last < text.length) tokens.push({ type: "text", value: text.slice(last) });
  return tokens;
}

/** token 序列 → 模板文本（path token 回填 {…}；splitPathCalls 的逆，往返恒等）。 */
export function joinPathTokens(tokens) {
  return tokens.map((t) => (t.type === "path" ? `{${t.value}}` : t.value)).join("");
}
