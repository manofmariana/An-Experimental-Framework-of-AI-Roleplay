/**
 * 树状变量编辑器数据核心（纯逻辑，零 DOM 零网络，node:test 可直接 import）。
 *
 * 持有直编工作副本 {world, characters}（调用方深拷贝后传入，全部编辑原地作用于副本），
 * 把实例状态投影为单棵视图树：
 * - 世界树根滤掉 time/_sys 程序键；实例值容错简写（裸值/扁平数组 = 无外壳末端）；
 * - 角色树 = 系统声明分支（镜像常量取自 system-char-decl.js，与 src/vars/systemChar.ts
 *   镜像同源；值从类型化字段投影：timer/channel null 原样呈现、initiative null =
 *   容器无实例、relations = 结构化数组按下标投影）+ vars 实例树，同一棵树的末端
 *   不再分区；
 * - 结构化数组渲染为可折叠分支：元素可增删（增 = 按元素结构物化空元素追加；删 =
 *   按下标摘除），元素内字段按元素结构递归渲染；元素自身无 tags 挂载位；
 * - 数组元素路径用 `键[下标]` 语法（如 items[0].name；通配 [*] 只出现在附加来源
 *   合并的查询变体中）；
 * - 系统只读收窄为 {acted, group, channel, timer, isPlayer} 五字段（「系统」徽记）；
 *   全部末端（含系统字段）外壳 tags 可编辑——系统末端写 systemTags 侧车（数组层
 *   侧车键 = `键[下标]` 路径，relations 元素删除时按下标重映射）、vars 末端写外壳；
 * - 从动末端 = 声明带 formula 或实例外壳带 formula：值只读，formula 出结构化只读标注；
 * - 实例缺声明的键（正常态不存在）以 unknown 只读节点呈现，不静默隐藏；
 * - 附加来源 tags（`_sys.varsTags` 读取期合并结果）以只读 attachTags 呈现在每个末端
 *   节点上（「附加」徽记、不可删改）——解析逻辑是 src/vars/template.ts
 *   resolveAttachTags 的镜像（节点级扇出到全部后代末端/末端级单挂/数组整型挂载
 *   `[*]` 通配/cid 类别按当前 scope 角色 CID 分发，world 域无属主遇 cid 条目跳过）；
 *   **只作显示，绝不写进实例值**：工作副本、getPayload 保存载荷、normalize 输入、
 *   systemTags 侧车都不含附加来源条目。
 *
 * 本模型只做**实例状态编辑**（游玩页直编 modal）；声明树结构编辑（增删声明/类型区/
 * formula 声明）在世界页包级编辑，见 var-decl-model（共享原语亦由该模块出）。
 *
 * 编辑操作（全部先校验后落副本，非法即抛错，消息给编辑器错误行原样展示）：
 * - writeTerminalValue / writeTerminalTags：末端写值（按 valueType 校验；从动拒写）与
 *   外壳 tags 编辑；系统路径回写类型化字段/侧车，vars 路径物化外壳写实例；
 * - initiative 为 null 时整容器写入（两值齐全才落对象，不提供清空回 null）；
 * - addRelationEntry / removeArrayElement：relations 条目增（按 cid 追加）删（按下标
 *   摘除并顺带重映射侧车）；条目字段写值走 writeTerminalValue（`relations[i].字段`）；
 * - addArrayElement / removeArrayElement：结构化数组元素增删，只动实例不动模板。
 */

import {
  VALUE_TYPES,
  classifyRawDecl,
  defaultValueFor,
  formulaViewOf,
  isIndexSegment,
  isPlainObject,
  splitVarPath,
  validateBaseName,
} from "./var-decl-model.js";

import {
  SYSTEM_CHAR_DECLS,
  SYSTEM_CHAR_KEYS,
  SYSTEM_CHAR_TYPES,
} from "./system-char-decl.js";

export { VALUE_TYPES, defaultValueFor };

export const WORLD_SCOPE = "world";

/** 世界根程序键（不进变量树，也不允许新增同名实例）。 */
const WORLD_PROGRAM_KEYS = new Set(["time", "_sys"]);

/** 角色系统只读字段（仅此五个，徽记「系统」；值走专用通道不开放编辑）。 */
export const CHAR_SYSTEM_FIELDS = ["acted", "group", "channel", "timer", "isPlayer"];

/** omniscience 前端钳制范围（0-6 整数）。 */
const OMNISCIENCE_CLAMP = { min: 0, max: 6 };

// ---------------------------------------------------------------------------
// 形状判定与值校验
// ---------------------------------------------------------------------------

/** 末端外壳判定：含 value 键的平面对象。 */
function isShell(v) {
  return isPlainObject(v) && Object.hasOwn(v, "value");
}

/** 内容侧挂载表形状校验：{name 非空, level 1-7 整数}[]（名称自由输入，不查注册表）。 */
function validateTagList(value, at) {
  const ok =
    Array.isArray(value) &&
    value.every(
      (item) =>
        isPlainObject(item) &&
        typeof item.name === "string" &&
        item.name !== "" &&
        Number.isInteger(item.level) &&
        item.level >= 1 &&
        item.level <= 7,
    );
  if (!ok) throw new Error(`tags 形状非法（${at}）：期望 {name, level 1-7 整数}[]`);
  return value;
}

/** 按 valueType 校验末端值，通过即返回原值。 */
function validateValueFor(valueType, value, at) {
  switch (valueType) {
    case "number":
      if (typeof value !== "number" || !Number.isFinite(value)) break;
      return value;
    case "string":
      if (typeof value === "string") return value;
      break;
    case "boolean":
      if (typeof value === "boolean") return value;
      break;
    case "string_list":
      if (Array.isArray(value) && value.every((v) => typeof v === "string")) return value;
      break;
    case "tag_list":
      return validateTagList(value, at);
  }
  throw new Error(`值类型错配（${at}，期望 ${valueType}）`);
}

function splitPath(path) {
  return path === "" ? [] : path.split(".");
}

/** 路径首段（带下标语法的段先拆出键）。 */
function headKey(path) {
  try {
    return splitVarPath(path)[0] ?? "";
  } catch {
    return "";
  }
}

/** 数组元素路径的父数组路径（`items[0]` → `items`；无尾下标 = null）。 */
function arrayPathOf(elementPath) {
  const m = /^(.*)\[\d+\]$/.exec(elementPath);
  return m === null ? null : m[1];
}

// ---------------------------------------------------------------------------
// TAG 附加合并显示（只读；附加来源绝不写进实例值——零泄漏由测试钉死）
// ---------------------------------------------------------------------------

/**
 * src/vars/template.ts resolveAttachTags 的镜像（变更需同步）：把 TAG 附加条目解析为
 * 末端路径 → {name, level}[]（Map）——节点级条目扇出到全部后代末端、末端级条目
 * 只挂本末端、同名去重（先取者胜）；数组层无实例可枚举，以 `[*]` 占位（显示时按
 * 下标通配匹配）。
 * 显示特化差异：{category} 条目的 category 须在注册表声明的开放类别集合内（服务端
 * parse 已拒装未知类别，镜像防御性跳过）；cid 类按属主分发（ownerCid →
 * {name: ownerCid}），world 域无属主——遇 cid 条目跳过；其余类别归一化为类别名记号。
 *
 * @param {object} node 附加文件节点（{tags?, children?} | {tags?, array}）
 * @param {object} rootChildren 根声明子键表（character 域 = 系统声明分支并入后）
 * @param {(typeName: string) => (object|null)} typeChildrenOf 类型名 → 类型声明子键表
 * @param {{categories: Set<string>, ownerCid?: string}} opts
 * @returns {Map<string, Array<{name: string, level: number}>>}
 */
function resolveAttachTagsMirror(node, rootChildren, typeChildrenOf, opts) {
  const result = new Map();
  const seen = new Map();

  const entryToMounts = (entry) => {
    if (!isPlainObject(entry)) return [];
    if (typeof entry.name === "string") return [{ name: entry.name, level: entry.level }];
    if (typeof entry.category !== "string") return [];
    if (!opts.categories.has(entry.category)) return [];
    if (entry.category === "cid") {
      return opts.ownerCid === undefined ? [] : [{ name: opts.ownerCid, level: entry.level }];
    }
    return [{ name: entry.category, level: entry.level }];
  };

  const attach = (path, mounts) => {
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

  /** 数组元素结构子键表（引用类型经 typeChildrenOf，内联直接取）。 */
  const elementChildrenOf = (info) =>
    info.elementType !== undefined ? typeChildrenOf(info.elementType) : info.elementChildren;

  /** 把级联条目挂到原始声明子树的全部后代末端（path = 子树根路径；数组层以 `[*]` 占位）。 */
  const cascadeDecl = (raw, path, inherited) => {
    const info = classifyRawDecl(raw);
    if (info === null) return;
    if (info.kind === "terminal") {
      attach(path, inherited);
      return;
    }
    if (info.kind === "array") {
      const children = elementChildrenOf(info);
      if (children == null) return;
      for (const [key, child] of Object.entries(children)) {
        cascadeDecl(child, `${path}[*].${key}`, inherited);
      }
      return;
    }
    for (const [key, child] of Object.entries(info.children)) {
      cascadeDecl(child, path === "" ? key : `${path}.${key}`, inherited);
    }
  };

  const walk = (tagNode, info, path, inherited) => {
    const own = (Array.isArray(tagNode.tags) ? tagNode.tags : []).flatMap(entryToMounts);
    const mounts = [...inherited, ...own];
    if (info.kind === "terminal") {
      attach(path, mounts);
      return;
    }
    if (info.kind === "array") {
      const children = elementChildrenOf(info);
      if (children == null) return;
      if (typeof tagNode.array === "string") {
        // 整型挂载：扇出到元素结构全部末端（[*] 占位）
        for (const [key, child] of Object.entries(children)) {
          cascadeDecl(child, `${path}[*].${key}`, mounts);
        }
      }
      return;
    }
    // 普通容器：本节点条目级联到未显式出现的后代末端，显式子键继承后继续下行
    const nodeChildren = isPlainObject(tagNode.children) ? tagNode.children : {};
    for (const [key, childRaw] of Object.entries(info.children)) {
      const childPath = path === "" ? key : `${path}.${key}`;
      const childNode = nodeChildren[key];
      const childInfo = classifyRawDecl(childRaw);
      if (childInfo === null) continue;
      if (childNode !== undefined) {
        walk(childNode, childInfo, childPath, mounts);
      } else {
        cascadeDecl(childRaw, childPath, mounts);
      }
    }
  };

  walk(node, { kind: "container", children: rootChildren }, "", []);
  return result;
}

// ---------------------------------------------------------------------------
// 模型工厂
// ---------------------------------------------------------------------------

/**
 * @param {object} working 工作副本（调用方深拷贝）
 * @param {object} working.world 世界状态（含 _sys；编辑直接改它，_sys.varsTemplate 只读对拍）
 * @param {object} working.characters CID → 角色状态（系统分支值在顶层类型化字段 +
 *   systemTags 侧车，vars 树在 .vars；relations = {cid, name?, impression?}[] 数组）
 */
export function createVarTreeModel({ world, characters }) {
  const sys = isPlainObject(world) && isPlainObject(world._sys) ? world._sys : null;
  const template = sys !== null && isPlainObject(sys.varsTemplate) ? sys.varsTemplate : null;
  const tagRegistry = sys !== null && isPlainObject(sys.tagRegistry) ? sys.tagRegistry : {};
  const varsTags = sys !== null && isPlainObject(sys.varsTags) ? sys.varsTags : null;
  // 注册表声明的开放类别集合（附加 {category} 条目的合法性判据）
  const declaredCategories = new Set();
  for (const entry of Object.values(tagRegistry)) {
    if (isPlainObject(entry) && typeof entry.category === "string") declaredCategories.add(entry.category);
  }

  // ---- 模板侧导航（只读对拍；角色根 = 系统声明分支 + vars 声明） ---------------

  function templateRootChildren(scope) {
    if (template === null) return null;
    const info = classifyRawDecl(scope === WORLD_SCOPE ? template.world : template.character);
    if (info === null || info.kind !== "container") return null;
    return scope === WORLD_SCOPE ? info.children : { ...SYSTEM_CHAR_DECLS, ...info.children };
  }

  function typeChildren(scope, typeName) {
    if (scope !== WORLD_SCOPE && Object.hasOwn(SYSTEM_CHAR_TYPES, typeName)) {
      return SYSTEM_CHAR_TYPES[typeName].children;
    }
    const types = template !== null && isPlainObject(template.types) ? template.types : {};
    const info = classifyRawDecl(types[typeName]);
    return info !== null && info.kind === "container" ? info.children : null;
  }

  /** 数组声明的元素结构子键表（引用类型经 typeChildren，内联直接取；不可解析 = null）。 */
  function elementChildrenOf(scope, info) {
    return info.elementType !== undefined ? typeChildren(scope, info.elementType) : info.elementChildren;
  }

  // ---- TAG 附加解析（每 scope 一次缓存；状态编辑不动 _sys.varsTags/模板） ---------------

  const attachMaps = new Map();

  /** scope 的附加解析结果（末端路径 → 只读附加挂载；world 域不传属主，cid 条目跳过）。 */
  function attachMapFor(scope) {
    let map = attachMaps.get(scope);
    if (map !== undefined) return map;
    const node =
      varsTags !== null && isPlainObject(varsTags[scope === WORLD_SCOPE ? "world" : "character"])
        ? varsTags[scope === WORLD_SCOPE ? "world" : "character"]
        : null;
    const rootChildren = templateRootChildren(scope);
    map =
      node !== null && rootChildren !== null
        ? resolveAttachTagsMirror(node, rootChildren, (t) => typeChildren(scope, t), {
            categories: declaredCategories,
            ...(scope === WORLD_SCOPE ? {} : { ownerCid: scope }),
          })
        : new Map();
    attachMaps.set(scope, map);
    return map;
  }

  const SEG_RE = /^([^[\]]+?)(?:\[(\d+|\*)\])?$/;

  /**
   * 末端附加来源 tags（只读展示；与实例/侧车 tags 按名去重，实例优先）：
   * 精确路径 + 数组元素层 `[*]` 通配变体合并（沿模板判定哪些段是数组元素段，
   * 非数组段不做盲通配）；产物绝不写回工作副本/保存载荷（附加来源零泄漏）。
   */
  function attachedTagsFor(scope, path, instanceTags) {
    const map = attachMapFor(scope);
    if (map.size === 0) return [];
    const held = new Set(instanceTags.map((t) => t.name));
    const out = [];
    const seen = new Set();
    const collect = (key) => {
      const list = map.get(key);
      if (list === undefined) return;
      for (const m of list) {
        if (seen.has(m.name) || held.has(m.name)) continue;
        seen.add(m.name);
        out.push(m);
      }
    };
    collect(path);
    // 通配变体：数组元素段（items[0]）同时生成 items[*] 变体
    let variants = [[]];
    let layerMap = templateRootChildren(scope) ?? {};
    let ok = true;
    for (const rawSeg of splitPath(path)) {
      const m = SEG_RE.exec(rawSeg);
      if (m === null) {
        ok = false;
        break;
      }
      const key = m[1];
      const index = m[2];
      const raw = layerMap[key];
      const info = raw !== undefined ? classifyRawDecl(raw) : null;
      if (info === null) {
        ok = false; // 声明外路径（unknown 节点）：仅精确查
        break;
      }
      if (info.kind === "array") {
        if (index === undefined) {
          ok = false;
          break;
        }
        variants = [
          ...variants.map((v) => [...v, `${key}[${index}]`]),
          ...variants.map((v) => [...v, `${key}[*]`]),
        ];
        const next = elementChildrenOf(scope, info);
        if (next == null) {
          ok = false;
          break;
        }
        layerMap = next;
        continue;
      }
      variants = variants.map((v) => [...v, key]);
      if (info.kind === "container") layerMap = info.children;
    }
    if (ok) {
      for (const v of variants) {
        const key = v.join(".");
        if (key !== path) collect(key);
      }
    }
    return out;
  }

  /**
   * 解析根内路径到原始声明节点（`键[数字]`/`键[*]` 下标段穿越数组元素结构）。
   * @returns {{raw: any, info: object, parent: {children: object, key: string}|null} | null}
   *   不可解析 = null
   */
  function resolveTemplatePath(scope, path) {
    let segs;
    try {
      segs = splitVarPath(path);
    } catch {
      return null;
    }
    const rootChildren = templateRootChildren(scope);
    if (rootChildren === null) return null;
    if (segs.length === 0) {
      return { raw: null, info: { kind: "container", children: rootChildren }, parent: null };
    }
    let map = rootChildren;
    for (let i = 0; i < segs.length; i++) {
      const key = segs[i];
      const raw = map[key];
      if (raw === undefined) return null;
      const info = classifyRawDecl(raw);
      if (info === null) return null;
      if (i === segs.length - 1) return { raw, info, parent: { children: map, key } };
      if (info.kind === "container") {
        map = info.children;
        continue;
      }
      if (info.kind === "array") {
        const idx = segs[i + 1];
        if (idx === undefined || !isIndexSegment(idx)) return null;
        i += 1; // 消费下标段
        const next = elementChildrenOf(scope, info);
        if (next == null) return null;
        if (i === segs.length - 1) return { raw: null, info: { kind: "container", children: next }, parent: null };
        map = next;
        continue;
      }
      return null; // 穿越末端
    }
    return null;
  }

  // ---- 角色记录与投影 ---------------------------------------------------------

  function charRecord(scope) {
    const c = isPlainObject(characters) ? characters[scope] : undefined;
    if (!isPlainObject(c)) throw new Error(`未知角色 "${scope}"`);
    return c;
  }

  /**
   * 角色状态 → 投影实例根（只读视角）：系统分支值从类型化字段读出（timer/channel
   * null 原样；initiative null = 无实例；relations 数组按下标投影，元素路径
   * `relations[i].字段`），系统末端外壳 tags 取自 systemTags 侧车，vars 树原样并入。
   * 编辑回写不走投影（系统路径回写类型化字段/侧车）。
   */
  function projectionOf(c) {
    const sidecar = isPlainObject(c.systemTags) ? c.systemTags : {};
    const shell = (value, p) => ({ value, tags: Array.isArray(sidecar[p]) ? sidecar[p] : [] });
    const loc = isPlainObject(c.location) ? c.location : { name: "", level: 0 };
    const relations = (Array.isArray(c.relations) ? c.relations : []).map((entry, i) => {
      const e = isPlainObject(entry) ? entry : {};
      return {
        cid: shell(typeof e.cid === "string" ? e.cid : "", `relations[${i}].cid`),
        name: shell(typeof e.name === "string" ? e.name : "", `relations[${i}].name`),
        impression: shell(typeof e.impression === "string" ? e.impression : "", `relations[${i}].impression`),
      };
    });
    const proj = {
      name: shell(c.name, "name"),
      gender: shell(c.gender, "gender"),
      age: shell(c.age, "age"),
      personality: shell(c.personality, "personality"),
      reaction: shell(c.reaction, "reaction"),
      level: shell(c.level, "level"),
      omniscience: shell(c.omniscience, "omniscience"),
      location: { name: shell(loc.name, "location.name"), level: shell(loc.level, "location.level") },
      relations,
      long_term_memory: shell(Array.isArray(c.long_term_memory) ? c.long_term_memory : [], "long_term_memory"),
      acted: shell(c.acted, "acted"),
      group: shell(c.group, "group"),
      channel: shell(c.channel ?? null, "channel"),
      timer: shell(c.timer ?? null, "timer"),
      isPlayer: shell(c.isPlayer, "isPlayer"),
    };
    if (isPlainObject(c.initiative)) {
      proj.initiative = {
        value: shell(c.initiative.value, "initiative.value"),
        group: shell(c.initiative.group, "initiative.group"),
      };
    }
    return { ...proj, ...(isPlainObject(c.vars) ? c.vars : {}) };
  }

  // ---- 实例侧导航（只读视角；角色根 = 投影） ------------------------------------

  function instanceRoot(scope) {
    if (scope === WORLD_SCOPE) return isPlainObject(world) ? world : {};
    return projectionOf(charRecord(scope));
  }

  function instanceAt(scope, path) {
    let node = instanceRoot(scope);
    for (const seg of splitVarPath(path)) {
      if ((!isPlainObject(node) && !Array.isArray(node)) || isShell(node)) return undefined;
      node = node[seg];
      if (node === undefined) return undefined;
    }
    return node;
  }

  /**
   * 确保 vars 树内 path 的父容器实例存在（沿途按声明补建：容器 → 对象、数组 → 数组、
   * 数组元素 → 对象），返回 {parent, key}（parent 可能是数组——key 为数字字符串下标）。
   */
  function ensureInstanceParent(scope, path) {
    const segs = splitVarPath(path);
    const key = segs[segs.length - 1];
    let node;
    let childrenMap;
    if (scope === WORLD_SCOPE) {
      node = world;
    } else {
      const c = characters[scope];
      if (!isPlainObject(c.vars)) c.vars = {};
      node = c.vars;
    }
    childrenMap = templateRootChildren(scope);
    for (const seg of segs.slice(0, -1)) {
      if (Array.isArray(node)) {
        // 数组层：seg = 下标；元素恒为对象结构，缺失补建空对象
        const idx = Number(seg);
        if (!isPlainObject(node[idx]) || isShell(node[idx])) node[idx] = {};
        node = node[idx];
        continue;
      }
      const info = childrenMap != null ? classifyRawDecl(childrenMap[seg]) : null;
      if ((!isPlainObject(node[seg]) && !Array.isArray(node[seg])) || isShell(node[seg])) {
        node[seg] = info !== null && info.kind === "array" ? [] : {};
      }
      node = node[seg];
      childrenMap =
        info === null
          ? null
          : info.kind === "container"
            ? info.children
            : info.kind === "array"
              ? elementChildrenOf(scope, info)
              : null;
    }
    return { parent: node, key };
  }

  /** 取实例数组本体（不存在/非数组 = null；只读下行不补建）。 */
  function arrayInstanceAt(scope, path) {
    let node = scope === WORLD_SCOPE ? world : charRecord(scope).vars;
    for (const seg of splitVarPath(path)) {
      if ((!isPlainObject(node) && !Array.isArray(node)) || isShell(node)) return null;
      node = node[seg];
      if (node === undefined) return null;
    }
    return Array.isArray(node) ? node : null;
  }

  /** 系统分支路径判定（角色作用域且首段为系统声明分支键）。 */
  function isSystemPath(scope, path) {
    return scope !== WORLD_SCOPE && SYSTEM_CHAR_KEYS.has(headKey(path));
  }

  // ---- 视图模型构建 -----------------------------------------------------------

  /** 构建一棵声明子树的视图节点。 */
  function buildNode(scope, key, path, raw, instValue) {
    const info = classifyRawDecl(raw);
    if (info === null) {
      return { key, path, kind: "unknown", display: JSON.stringify(instValue) ?? "undefined" };
    }
    if (info.kind === "terminal") {
      const shell = isShell(instValue) ? instValue : null;
      const hasInstance = instValue !== undefined;
      const value = shell !== null ? shell.value : hasInstance ? instValue : undefined; // 简写容错
      const tags = shell !== null && Array.isArray(shell.tags) ? shell.tags : [];
      const formula = shell !== null && shell.formula !== undefined ? shell.formula : info.formula;
      const derived = formula !== undefined;
      return {
        key, path, kind: "terminal",
        valueType: info.valueType,
        hasInstance,
        value,
        tags,
        attachTags: attachedTagsFor(scope, path, tags),
        derived,
        system: scope !== WORLD_SCOPE && CHAR_SYSTEM_FIELDS.includes(path),
        formula: derived ? formulaViewOf(formula) : null,
        formulaText: derived ? JSON.stringify(formula) : null,
      };
    }
    if (info.kind === "array") {
      const arr = Array.isArray(instValue) ? instValue : [];
      const elemChildren = elementChildrenOf(scope, info);
      const children = arr.map((el, i) =>
        buildArrayElement(scope, String(i), `${path}[${i}]`, elemChildren, el),
      );
      return { key, path, kind: "array", elementType: info.elementType ?? null, children };
    }
    // 普通容器：声明子键 + 实例侧未声明键（unknown 只读呈现）
    const instObj = isPlainObject(instValue) && !isShell(instValue) ? instValue : {};
    const children = Object.entries(info.children).map(([childKey, childRaw]) =>
      buildNode(scope, childKey, path === "" ? childKey : `${path}.${childKey}`, childRaw, instObj[childKey]),
    );
    for (const instKey of Object.keys(instObj)) {
      if (Object.hasOwn(info.children, instKey)) continue;
      if (scope === WORLD_SCOPE && path === "" && WORLD_PROGRAM_KEYS.has(instKey)) continue; // time/_sys 不显示
      children.push({
        key: instKey,
        path: path === "" ? instKey : `${path}.${instKey}`,
        kind: "unknown",
        display: JSON.stringify(instObj[instKey]) ?? "undefined",
      });
    }
    return { key, path, kind: "container", children };
  }

  /** 数组元素节点：按元素结构构建子树（元素自身无 tags 挂载位）。 */
  function buildArrayElement(scope, key, path, elemChildren, instValue) {
    const instObj = isPlainObject(instValue) && !isShell(instValue) ? instValue : {};
    const children =
      elemChildren == null
        ? []
        : Object.entries(elemChildren).map(([childKey, childRaw]) =>
            buildNode(scope, childKey, `${path}.${childKey}`, childRaw, instObj[childKey]),
          );
    for (const instKey of Object.keys(instObj)) {
      if (elemChildren != null && Object.hasOwn(elemChildren, instKey)) continue;
      children.push({ key: instKey, path: `${path}.${instKey}`, kind: "unknown", display: JSON.stringify(instObj[instKey]) ?? "undefined" });
    }
    return { key, path, kind: "arrayElement", children, canRemoveElement: true };
  }

  // ---- 系统分支回写 -------------------------------------------------------------

  /**
   * 系统分支末端写值（回写类型化字段）：单值字段 / location 子字段 / initiative 子字段
   * （null 时拒写，整体写入是唯一通道）/ relations 元素字段（`relations[i].字段`，
   * 含 cid）/ long_term_memory。五调度字段在上游已拒（只读）。
   */
  function writeSystemTerminal(scope, path, info, value) {
    const segs = splitVarPath(path);
    const field = segs[0];
    const c = charRecord(scope);
    if (segs.length === 1) {
      let v = validateValueFor(info.valueType, value, path);
      if (field === "omniscience" && typeof v === "number") {
        v = Math.min(OMNISCIENCE_CLAMP.max, Math.max(OMNISCIENCE_CLAMP.min, Math.trunc(v)));
      }
      c[field] = v;
      return;
    }
    if (field === "location" && segs.length === 2) {
      if (!isPlainObject(c.location)) throw new Error("location 缺失（形状异常）");
      c.location[segs[1]] = validateValueFor(info.valueType, value, path);
      return;
    }
    if (field === "initiative" && segs.length === 2) {
      if (!isPlainObject(c.initiative)) {
        throw new Error("initiative 当前为 null：请两值齐全后整体写入（不清空回 null）");
      }
      c.initiative[segs[1]] = validateValueFor(info.valueType, value, path);
      return;
    }
    if (field === "relations" && segs.length === 3 && /^\d+$/.test(segs[1])) {
      const list = Array.isArray(c.relations) ? c.relations : [];
      const entry = list[Number(segs[1])];
      if (!isPlainObject(entry)) throw new Error(`relations 条目 [${segs[1]}] 不存在`);
      entry[segs[2]] = validateValueFor(info.valueType, value, path);
      return;
    }
    throw new Error(`系统字段路径 "${path}" 不可写`);
  }

  /** 系统分支容器整体写入（initiative null → 对象的唯一通道：全子字段齐全校验后落对象）。 */
  function writeSystemContainer(scope, path, info, value) {
    const field = splitVarPath(path)[0];
    if (field !== "initiative") throw new Error(`系统容器 "${field}" 不开放整体写入`);
    if (!isPlainObject(value)) throw new Error(`字段 "initiative" 整体写入须为对象`);
    const out = {};
    for (const [childKey, childRaw] of Object.entries(info.children)) {
      const childInfo = classifyRawDecl(childRaw);
      if (value[childKey] === undefined) throw new Error(`字段 "initiative" 缺子字段 "${childKey}"（须两值齐全）`);
      out[childKey] = validateValueFor(childInfo.valueType, value[childKey], `initiative.${childKey}`);
    }
    charRecord(scope).initiative = out;
  }

  // ---- 对外接口 -------------------------------------------------------------

  return {
    /** 作用域列表：世界 + 各 CID（切换分页用）。 */
    listScopes() {
      const cids = isPlainObject(characters) ? Object.keys(characters) : [];
      return [{ id: WORLD_SCOPE, label: "世界" }, ...cids.map((cid) => ({ id: cid, label: cid }))];
    },

    /** 已注册 TAG 名列表（tags 编辑器下拉选项；自由输入不受此限）。 */
    getTagNames() {
      return Object.keys(tagRegistry);
    },

    /**
     * 构建作用域视图树：{scope, children}。世界树滤 time/_sys；角色树 = 系统声明分支
     * 投影（系统五字段只读徽记）+ vars 实例树，单树呈现不再分区；角色顶层未登记键
     * （系统分支/vars/systemTags 之外）以 unknown 只读节点呈现（fieldLevel 标记）。
     * 无模板时实例侧键全部以 unknown 节点呈现。
     */
    buildTree(scope) {
      const children = [];
      const rootChildren = templateRootChildren(scope);
      const rootInst = instanceRoot(scope);
      if (rootChildren !== null) {
        for (const [key, raw] of Object.entries(rootChildren)) {
          children.push(buildNode(scope, key, key, raw, rootInst[key]));
        }
        for (const instKey of Object.keys(rootInst)) {
          if (Object.hasOwn(rootChildren, instKey)) continue;
          if (scope === WORLD_SCOPE && WORLD_PROGRAM_KEYS.has(instKey)) continue;
          children.push({ key: instKey, path: instKey, kind: "unknown", display: JSON.stringify(rootInst[instKey]) ?? "undefined" });
        }
      } else {
        for (const [instKey, value] of Object.entries(rootInst)) {
          if (scope === WORLD_SCOPE && WORLD_PROGRAM_KEYS.has(instKey)) continue;
          children.push({ key: instKey, path: instKey, kind: "unknown", display: JSON.stringify(value) ?? "undefined" });
        }
      }
      if (scope !== WORLD_SCOPE) {
        const c = charRecord(scope);
        for (const key of Object.keys(c)) {
          if (key === "vars" || key === "systemTags" || SYSTEM_CHAR_KEYS.has(key)) continue;
          children.push({ key, path: key, kind: "unknown", fieldLevel: true, display: JSON.stringify(c[key]) ?? "undefined" });
        }
      }
      return { scope, children };
    },

    /**
     * 末端写值：按声明 valueType 校验；从动末端（声明/实例带 formula）与系统五字段
     * 拒写。系统路径回写类型化字段（initiative 容器整体写入 = null → 对象唯一通道）；
     * vars 路径实例缺失/简写时物化外壳（沿途按声明补建容器/数组）。
     */
    writeTerminalValue(scope, path, value) {
      const r = resolveTemplatePath(scope, path);
      if (r === null) throw new Error(`路径 "${path}" 不是已声明的末端`);
      if (isSystemPath(scope, path)) {
        if (CHAR_SYSTEM_FIELDS.includes(headKey(path))) throw new Error(`系统字段 "${headKey(path)}" 只读`);
        if (r.info.kind === "container") {
          writeSystemContainer(scope, path, r.info, value);
          return;
        }
        if (r.info.kind !== "terminal") throw new Error(`路径 "${path}" 不是已声明的末端`);
        writeSystemTerminal(scope, path, r.info, value);
        return;
      }
      if (r.info.kind !== "terminal") throw new Error(`路径 "${path}" 不是已声明的末端`);
      const inst = instanceAt(scope, path);
      const shell = isShell(inst) ? inst : null;
      if (r.info.formula !== undefined || (shell !== null && shell.formula !== undefined)) {
        throw new Error(`末端 "${path}" 为从动变量（formula 计算），只读`);
      }
      const v = validateValueFor(r.info.valueType, value, path);
      if (scope !== WORLD_SCOPE) {
        // vars 树写实例：投影是只读视图，须落到工作副本的 vars 上
        const { parent, key } = ensureInstanceParent(scope, path);
        const cur = parent[key];
        if (isShell(cur)) {
          cur.value = v;
          return;
        }
        parent[key] = { value: v, tags: [] };
        return;
      }
      if (shell !== null) {
        // 世界树实例即工作副本本体，原地写
        shell.value = v;
        return;
      }
      const { parent, key } = ensureInstanceParent(scope, path);
      parent[key] = { value: v, tags: [] };
    },

    /**
     * 外壳 tags 编辑（内容侧 TAG 挂载位；从动末端的外壳 tags 同样可编）：系统末端写
     * systemTags 侧车（空表摘键；数组层键 = `键[下标]` 路径），vars 末端写外壳
     * （实例缺失/简写时物化）。
     */
    writeTerminalTags(scope, path, tagList) {
      const r = resolveTemplatePath(scope, path);
      if (r === null || r.info.kind !== "terminal") throw new Error(`路径 "${path}" 不是已声明的末端`);
      const list = validateTagList(tagList, path);
      if (isSystemPath(scope, path)) {
        const c = charRecord(scope);
        if (!isPlainObject(c.systemTags)) c.systemTags = {};
        if (list.length === 0) delete c.systemTags[path];
        else c.systemTags[path] = list;
        return;
      }
      const inst = instanceAt(scope, path);
      const { parent, key } = ensureInstanceParent(scope, path);
      const cur = parent[key];
      if (isShell(cur)) {
        cur.tags = list;
        return;
      }
      parent[key] =
        cur === undefined
          ? { value: defaultValueFor(r.info.valueType), tags: list }
          : { value: cur, tags: list }; // 简写物化，保留原值
    },

    /**
     * relations 新增条目（系统数组元素）：按 cid 追加空条目（cid 非空且不重复；
     * 前导 @ 容忍剥除——与落库归一化同口径）。
     */
    addRelationEntry(scope, cid) {
      if (scope === WORLD_SCOPE) throw new Error("世界作用域没有角色字段");
      const norm = typeof cid === "string" && cid.startsWith("@") ? cid.slice(1) : cid;
      validateBaseName(norm);
      const c = charRecord(scope);
      if (!Array.isArray(c.relations)) c.relations = [];
      if (c.relations.some((e) => isPlainObject(e) && e.cid === norm)) throw new Error(`条目 "${norm}" 已存在`);
      c.relations.push({ cid: norm });
    },

    /**
     * 结构化数组新增元素：按元素结构物化空白元素追加（只动实例，不动模板）。
     * 系统分支的 relations 数组 = 走 addRelationEntry（cid 必填），此处拒绝。
     */
    addArrayElement(scope, arrayPath) {
      if (isSystemPath(scope, arrayPath)) {
        throw new Error(`系统数组 "${arrayPath}" 的元素新增走 addRelationEntry（cid 必填）`);
      }
      const r = resolveTemplatePath(scope, arrayPath);
      if (r === null || r.info.kind !== "array") throw new Error(`路径 "${arrayPath}" 不是结构化数组`);
      const elemChildren = elementChildrenOf(scope, r.info);
      if (elemChildren == null) throw new Error(`数组 "${arrayPath}" 的元素结构不可解析`);
      const { parent, key } = ensureInstanceParent(scope, arrayPath);
      if (!Array.isArray(parent[key])) parent[key] = [];
      parent[key].push(materializeBlank(elemChildren));
    },

    /**
     * 结构化数组删除元素：按下标摘除（只动实例，不动模板）。
     * 系统分支的 relations 数组 = 条目删除（顺带重映射侧车挂载：被删下标摘除、
     * 其后下标前移一位）。
     */
    removeArrayElement(scope, arrayPath, index) {
      if (!Number.isInteger(index) || index < 0) throw new Error(`下标 ${index} 非法`);
      if (isSystemPath(scope, arrayPath)) {
        if (arrayPath !== "relations") throw new Error(`系统数组 "${arrayPath}" 不开放元素删除`);
        const c = charRecord(scope);
        const list = Array.isArray(c.relations) ? c.relations : [];
        if (index >= list.length) throw new Error(`条目 [${index}] 不存在`);
        list.splice(index, 1);
        if (isPlainObject(c.systemTags)) {
          const remapped = {};
          for (const [k, v] of Object.entries(c.systemTags)) {
            const m = /^relations\[(\d+)\]\.(.+)$/.exec(k);
            if (m === null) {
              remapped[k] = v;
              continue;
            }
            const n = Number(m[1]);
            if (n === index) continue; // 被删条目的挂载摘除
            remapped[`relations[${n > index ? n - 1 : n}].${m[2]}`] = v;
          }
          c.systemTags = remapped;
        }
        return;
      }
      const r = resolveTemplatePath(scope, arrayPath);
      if (r === null || r.info.kind !== "array") throw new Error(`路径 "${arrayPath}" 不是结构化数组`);
      const arr = arrayInstanceAt(scope, arrayPath);
      if (arr === null || index >= arr.length) throw new Error(`元素 [${index}] 不存在`);
      arr.splice(index, 1);
    },

    /** 保存载荷：编辑后的工作副本（world 原样携带 _sys.varsTemplate——结构编辑不在此）。 */
    getPayload() {
      return { world, characters };
    },
  };
}

/** 按元素结构物化空白元素：末端取默认值、容器递归、嵌套数组留空数组。 */
function materializeBlank(childrenRaw) {
  const out = {};
  for (const [key, raw] of Object.entries(childrenRaw)) {
    const info = classifyRawDecl(raw);
    if (info === null) continue;
    if (info.kind === "terminal") out[key] = { value: defaultValueFor(info.valueType), tags: [] };
    else if (info.kind === "container") out[key] = materializeBlank(info.children);
    else out[key] = []; // 嵌套数组：空白起步
  }
  return out;
}
