/**
 * 变量模板声明树结构编辑数据核心（纯逻辑，零 DOM 零网络，node:test 可直接 import）。
 *
 * 持有世界包 vars-template 原始声明树工作副本 {world, character, types?}（调用方深拷贝
 * 后传入，全部编辑原地作用于副本），服务世界页「变量模板」子区：纯声明树结构编辑——
 * 无实例列、无值编辑（实例状态编辑在游玩页直编 modal，见 var-tree-model）。
 *
 * 同时是声明树共享原语的唯一出处（var-tree-model 复用）：VALUE_TYPES /
 * defaultValueFor / isPlainObject / classifyRawDecl / validateBaseName /
 * formulaViewOf / collectTypeRefs。
 *
 * 视图模型（buildRootView 世界/角色根 + buildTypesView 类型区）：
 * - 末端 = declTerminal（valueType + 结构化 formula 视图）；容器 = declContainer
 *   （可递归新增）；类型容器 = declTypeContainer（只显示类型引用，字段到类型区编辑）；
 * - character 根必需声明 attachtags/tags 保护性拒删（服务端 parse 仍是最终闸）；
 * - **character 根视图并入系统声明分支显示**（镜像常量取自 system-char-decl.js，
 *   系统节点 system 标记 + 全部操作禁用，作者子树原序随后；world 根不变）。系统
 *   分支只是显示注入：一切写操作对系统路径抛错，保存载荷仍是原始作者模板。
 *   formula 校验的根内路径解析同样并入系统分支（作者公式可绑系统 number 末端，
 *   与服务端 parseVarsTemplate 并入后解析口径一致）。
 *
 * 编辑操作（先校验后落副本，非法即抛错，消息给编辑器错误行原样展示）：
 * - addDecl / deleteDecl：容器「+」——扁平末端（五 valueType 字符串简写声明）/
 *   结构体（{children:{}}）/ 多实例容器（{type} 引用已有类型）；删除 = 摘声明；
 * - addType / deleteType / addTypeField / removeTypeField：类型区——新建类型 = 命名
 *   空结构体；删除类型前端预检引用（服务端保存时严格解析仍是最终闸）；
 * - setDeclFormula：末端 formula 声明编辑/清空（expr + binds 仅 number 末端，
 *   binds 值 = 同根 number 末端路径；union_attach 仅 string_list 末端，paths = 同根
 *   容器路径；character 根 attachtags 不得挂 formula、tags 必须保持 union_attach）；
 * - setTypeDeclFormula：类型声明内末端 formula 编辑/清空（binds/paths 以类型根为
 *   基准校验与展示；嵌套 {type} 引用内的末端不开放，到其类型上编辑）。
 */

import { SYSTEM_CHAR_DECLS, SYSTEM_CHAR_KEYS } from "./system-char-decl.js";

export const VALUE_TYPES = ["number", "string", "boolean", "string_list", "tag_list"];

/** 模板容器子键保留名（与服务端模板契约一致；character 根 tags 为契约豁免）。 */
const RESERVED_NAMES = new Set(["value", "tags", "formula"]);

/** character 根模板必需声明（删了服务端必拒，前端直接保护）。 */
const CHAR_ROOT_REQUIRED = new Set(["attachtags", "tags"]);

/** 公式标识符合法性（binds 键）。 */
const IDENT_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

// ---------------------------------------------------------------------------
// 共享原语（var-tree-model 复用）
// ---------------------------------------------------------------------------

export function isPlainObject(v) {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** 原始声明节点判别：末端（简写/完整形）/ 容器 / 类型容器；不可判别 = null。 */
export function classifyRawDecl(raw) {
  if (typeof raw === "string") {
    return VALUE_TYPES.includes(raw) ? { kind: "terminal", valueType: raw, formula: undefined } : null;
  }
  if (!isPlainObject(raw)) return null;
  if (typeof raw.type === "string") return { kind: "typeContainer", typeName: raw.type };
  if (isPlainObject(raw.children)) return { kind: "container", children: raw.children };
  if (typeof raw.valueType === "string" && VALUE_TYPES.includes(raw.valueType)) {
    return { kind: "terminal", valueType: raw.valueType, formula: raw.formula };
  }
  return null;
}

/** 各 valueType 的默认初始值。 */
export function defaultValueFor(valueType) {
  switch (valueType) {
    case "number":
      return 0;
    case "string":
      return "";
    case "boolean":
      return false;
    case "string_list":
      return [];
    case "tag_list":
      return [];
    default:
      throw new Error(`未知 valueType "${valueType}"`);
  }
}

/** 变量名基础合法性：非空、无路径分隔符、非保留名。 */
export function validateBaseName(name) {
  if (typeof name !== "string" || name.trim() === "") throw new Error("变量名不能为空");
  if (name.includes(".")) throw new Error(`变量名 "${name}" 不得包含 "."`);
  if (RESERVED_NAMES.has(name)) throw new Error(`变量名 "${name}" 为保留名`);
}

/** formula 原始声明 → 结构化视图（expr / unionAttach；不可判别 = null）。 */
export function formulaViewOf(raw) {
  if (!isPlainObject(raw)) return null;
  if (raw.op === "union_attach") {
    return { kind: "unionAttach", paths: Array.isArray(raw.paths) ? [...raw.paths] : [] };
  }
  if (typeof raw.expr === "string") {
    return { kind: "expr", expr: raw.expr, binds: isPlainObject(raw.binds) ? { ...raw.binds } : {} };
  }
  return null;
}

/** 收集原始声明子树内全部 {type} 引用名。 */
export function collectTypeRefs(raw, out) {
  if (typeof raw === "string" || !isPlainObject(raw)) return;
  if (typeof raw.type === "string") {
    out.push(raw.type);
    return;
  }
  if (isPlainObject(raw.children)) {
    for (const child of Object.values(raw.children)) collectTypeRefs(child, out);
  }
}

function splitPath(path) {
  return path === "" ? [] : path.split(".");
}

// ---------------------------------------------------------------------------
// 模型工厂
// ---------------------------------------------------------------------------

/**
 * @param {object} deps
 * @param {object} deps.template vars-template 原始声明树工作副本（{world, character, types?}；
 *   编辑直接改它；缺 types 键视为空类型区）
 */
export function createVarDeclModel({ template }) {
  if (!isPlainObject(template)) throw new Error("变量模板须为对象");

  /** 根列表：世界 / 角色（共享模板）。 */
  const ROOTS = [
    { id: "world", label: "世界" },
    { id: "character", label: "角色（共享模板）" },
  ];

  // ---- 声明树导航 -----------------------------------------------------------

  function rootChildren(root) {
    const info = classifyRawDecl(template[root]);
    return info !== null && info.kind === "container" ? info.children : null;
  }

  /**
   * 系统分支写护栏：character 根首段命中系统声明键即拒——系统分支只是显示注入
   * （代码常量，不进模板文件），任何写操作不得落工作副本。
   */
  function assertNotSystemDecl(root, path) {
    const head = splitPath(path)[0] ?? "";
    if (root === "character" && SYSTEM_CHAR_KEYS.has(head)) {
      throw new Error(`"${head}" 属系统声明分支（代码常量），只读不写回`);
    }
  }

  function rawTypes() {
    return isPlainObject(template.types) ? template.types : {};
  }

  function typeChildren(typeName) {
    const info = classifyRawDecl(rawTypes()[typeName]);
    return info !== null && info.kind === "container" ? info.children : null;
  }

  /**
   * 解析根内点分路径到原始声明节点（类型容器按实例名自由穿越，实例名段解析为类型
   * 声明容器且 parent 置空——其下节点不开放增删）。character 根首层带系统声明分支
   * overlay：查找并入系统声明（formula 校验可解析系统末端），parent 仍指作者子树表
   * ——系统节点的写操作由各写操作的系统护栏先拒，不会落到这里。
   * @returns {{raw: any, info: object, parent: {children: object, key: string}|null,
   *            crossedType: boolean} | null} 不可解析 = null
   */
  function resolveDeclPath(root, path) {
    const segs = splitPath(path);
    const children = rootChildren(root);
    if (children === null) return null;
    if (segs.length === 0) {
      return { raw: null, info: { kind: "container", children }, parent: null, crossedType: false };
    }
    // layer：children = 普通容器子键表（sys = character 根首层的系统分支 overlay）；
    // typeInst = 类型容器层（键为自由实例名，解析为类型声明）
    let layer = { kind: "children", map: children, sys: root === "character" ? SYSTEM_CHAR_DECLS : null };
    let crossedType = false;
    for (let i = 0; i < segs.length; i++) {
      const key = segs[i];
      let raw = null;
      let info = null;
      let parent = null;
      if (layer.kind === "typeInst") {
        if (key === "") return null;
        info = { kind: "container", children: layer.map };
        crossedType = true;
      } else {
        raw = layer.map[key];
        if (raw === undefined) {
          if (!layer.sys || !Object.hasOwn(layer.sys, key)) return null;
          raw = layer.sys[key];
        }
        info = classifyRawDecl(raw);
        if (info === null) return null;
        parent = { children: layer.map, key };
      }
      if (i === segs.length - 1) return { raw, info, parent, crossedType };
      if (info.kind === "container") {
        layer = { kind: "children", map: info.children, sys: null };
      } else if (info.kind === "typeContainer") {
        const next = typeChildren(info.typeName);
        if (next === null) return null;
        layer = { kind: "typeInst", map: next };
      } else {
        return null; // 穿越末端
      }
    }
    return null;
  }

  /**
   * 类型声明内导航：沿 {children} 普通容器下行到目标容器子键表；穿越 {type} 引用或
   * 末端 = 抛错（嵌套类型容器的字段请到其类型上编辑）。
   */
  function typeDeclContainerAt(typeName, containerPath) {
    let children = typeChildren(typeName);
    if (children === null) throw new Error(`类型 "${typeName}" 未声明`);
    for (const seg of splitPath(containerPath)) {
      const raw = children[seg];
      const info = raw === undefined ? null : classifyRawDecl(raw);
      if (info === null) throw new Error(`类型 "${typeName}" 路径 "${containerPath || "<根>"}" 不可解析`);
      if (info.kind === "typeContainer") {
        throw new Error(`嵌套类型容器 "${seg}" 的字段请到类型 "${info.typeName}" 上编辑`);
      }
      if (info.kind !== "container") throw new Error(`类型 "${typeName}" 路径 "${containerPath}" 穿越末端`);
      children = info.children;
    }
    return children;
  }

  /**
   * 类型内路径解析（formula binds/paths 校验基准 = 类型根；嵌套 {type} 引用按模板语义
   * 穿越——实例名段自由，与服务端类型内联后的解析口径一致）。不可解析 = null。
   */
  function resolveInType(typeName, path) {
    let children = typeChildren(typeName);
    if (children === null) return null;
    const segs = splitPath(path);
    if (segs.length === 0) return { kind: "container", children };
    let info = null;
    for (let i = 0; i < segs.length; i++) {
      const raw = children[segs[i]];
      info = raw === undefined ? null : classifyRawDecl(raw);
      if (info === null) return null;
      if (i === segs.length - 1) return info;
      if (info.kind === "container") {
        children = info.children;
      } else if (info.kind === "typeContainer") {
        const next = typeChildren(info.typeName);
        if (next === null) return null;
        i += 1; // 实例名段（自由）
        if (i >= segs.length || segs[i] === "") return null;
        if (i === segs.length - 1) return { kind: "container", children: next };
        children = next;
      } else {
        return null; // 穿越末端
      }
    }
    return info;
  }

  /** 类型内末端定位（写 formula 用；穿越嵌套 {type} 引用 = 抛错，到其类型上编辑）。 */
  function typeDeclTerminalAt(typeName, path) {
    const segs = splitPath(path);
    if (segs.length === 0) throw new Error("字段路径为空");
    const children = typeDeclContainerAt(typeName, segs.slice(0, -1).join("."));
    const key = segs[segs.length - 1];
    const raw = children[key];
    const info = raw === undefined ? null : classifyRawDecl(raw);
    if (info === null) throw new Error(`类型 "${typeName}" 路径 "${path}" 不可解析`);
    if (info.kind !== "terminal") throw new Error(`类型 "${typeName}" 路径 "${path}" 不是末端`);
    return { children, key, raw, info };
  }

  /** 类型内 formula 校验（binds/paths 以类型根为基准；formula = null 直接放行）。 */
  function validateTypeFormula(typeName, valueType, formula) {
    if (formula === null) return;
    if (isPlainObject(formula) && formula.op === "union_attach") {
      if (valueType !== "string_list") throw new Error("union_attach 只能挂在 string_list 末端");
      if (!Array.isArray(formula.paths)) throw new Error("union_attach 须带 paths 数组");
      for (const p of formula.paths) {
        if (typeof p !== "string" || p.trim() === "") throw new Error("union_attach paths 含空路径");
        const target = resolveInType(typeName, p);
        if (target === null) throw new Error(`union_attach 路径 "${p}" 在类型 "${typeName}" 内不可解析`);
        if (target.kind === "terminal") throw new Error(`union_attach 路径 "${p}" 必须解析到容器声明`);
      }
      return;
    }
    if (isPlainObject(formula) && typeof formula.expr === "string") {
      if (valueType !== "number") throw new Error("expr 公式只能挂在 number 末端");
      if (formula.expr.trim() === "") throw new Error("表达式不能为空");
      const binds = isPlainObject(formula.binds) ? formula.binds : {};
      for (const [ident, p] of Object.entries(binds)) {
        if (!IDENT_RE.test(ident)) throw new Error(`binds 键 "${ident}" 不是合法标识符`);
        if (typeof p !== "string" || p.trim() === "") throw new Error(`binds "${ident}" 的路径为空`);
        const target = resolveInType(typeName, p);
        if (target === null || target.kind !== "terminal" || target.valueType !== "number") {
          throw new Error(`binds "${ident}" 的路径 "${p}" 必须解析到类型内 number 末端`);
        }
      }
      return;
    }
    throw new Error("formula 须为 {expr, binds?} 或 {op: \"union_attach\", paths} 或 null");
  }

  // ---- 视图模型构建 ---------------------------------------------------------

  /**
   * 声明子树 → 视图节点（类型容器不展开——其字段到类型区编辑）。
   * system = 系统声明分支节点：system 标记（呈现层徽记）+ canDelete 强制 false，
   * 容器子节点递归继承（系统容器内全禁）。
   */
  function buildNode(key, path, raw, canDelete, system = false) {
    const info = classifyRawDecl(raw);
    if (info === null) {
      return { key, path, kind: "unknown", display: JSON.stringify(raw) ?? "undefined" };
    }
    if (info.kind === "terminal") {
      const derived = info.formula !== undefined;
      return {
        key, path, kind: "declTerminal",
        valueType: info.valueType,
        derived,
        formula: derived ? formulaViewOf(info.formula) : null,
        canDelete: canDelete && !system,
        system,
      };
    }
    if (info.kind === "typeContainer") {
      return { key, path, kind: "declTypeContainer", typeName: info.typeName, canDelete: canDelete && !system, system };
    }
    return {
      key, path, kind: "declContainer",
      children: Object.entries(info.children).map(([childKey, childRaw]) =>
        buildNode(childKey, path === "" ? childKey : `${path}.${childKey}`, childRaw, true, system),
      ),
      canDelete: canDelete && !system,
      system,
    };
  }

  /** 结构新增规格 → 模板声明（kind 缺省 = terminal，字符串简写；无实例联动）。 */
  function buildDeclForSpec(spec) {
    const kind = spec.kind ?? "terminal";
    if (kind === "terminal") {
      if (!VALUE_TYPES.includes(spec.valueType)) throw new Error(`未知 valueType "${spec.valueType}"`);
      return spec.valueType; // 字符串简写
    }
    if (kind === "struct") return { children: {} };
    if (kind === "typeContainer") {
      if (typeof spec.typeName !== "string" || typeChildren(spec.typeName) === null) {
        throw new Error(`类型 "${spec.typeName}" 未声明（可先在类型区新建）`);
      }
      return { type: spec.typeName };
    }
    throw new Error(`未知种类 "${kind}"`);
  }

  /** formula 声明校验（expr / union_attach，对拍同根模板；formula = null 直接放行）。 */
  function validateFormula(root, valueType, formula) {
    if (formula === null) return;
    if (isPlainObject(formula) && formula.op === "union_attach") {
      if (valueType !== "string_list") throw new Error("union_attach 只能挂在 string_list 末端");
      if (!Array.isArray(formula.paths)) throw new Error("union_attach 须带 paths 数组");
      for (const p of formula.paths) {
        if (typeof p !== "string" || p.trim() === "") throw new Error("union_attach paths 含空路径");
        const target = resolveDeclPath(root, p);
        if (target === null) throw new Error(`union_attach 路径 "${p}" 在同根模板中不可解析`);
        if (target.info.kind === "terminal") throw new Error(`union_attach 路径 "${p}" 必须解析到容器声明`);
      }
      return;
    }
    if (isPlainObject(formula) && typeof formula.expr === "string") {
      if (valueType !== "number") throw new Error("expr 公式只能挂在 number 末端");
      if (formula.expr.trim() === "") throw new Error("表达式不能为空");
      const binds = isPlainObject(formula.binds) ? formula.binds : {};
      for (const [ident, p] of Object.entries(binds)) {
        if (!IDENT_RE.test(ident)) throw new Error(`binds 键 "${ident}" 不是合法标识符`);
        if (typeof p !== "string" || p.trim() === "") throw new Error(`binds "${ident}" 的路径为空`);
        const target = resolveDeclPath(root, p);
        if (target === null || target.info.kind !== "terminal" || target.info.valueType !== "number") {
          throw new Error(`binds "${ident}" 的路径 "${p}" 必须解析到同根 number 末端`);
        }
      }
      return;
    }
    throw new Error("formula 须为 {expr, binds?} 或 {op: \"union_attach\", paths} 或 null");
  }

  // ---- 对外接口 -------------------------------------------------------------

  return {
    /** 根列表（世界 / 角色共享模板；切换分页用）。 */
    listRoots() {
      return ROOTS.map((r) => ({ ...r }));
    },

    /** 已声明类型名列表（多实例容器新增与类型区用）。 */
    listTypeNames() {
      return Object.keys(rawTypes());
    },

    /**
     * 构建根声明树视图：{root, children}（declTerminal/declContainer/declTypeContainer）。
     * character 根 = 系统声明分支（显示注入，system 标记 + 全操作禁，键序 = 呈现序）
     * + 作者子树（原序随后）；作者声明与系统键同名（服务端拒装的非法模板）同样按
     * 系统节点只读呈现，与写护栏口径一致。world 根不变。
     */
    buildRootView(root) {
      const children = rootChildren(root);
      if (children === null) return { root, children: [] };
      const out = [];
      if (root === "character") {
        for (const [key, raw] of Object.entries(SYSTEM_CHAR_DECLS)) {
          out.push(buildNode(key, key, raw, false, true));
        }
      }
      for (const [key, raw] of Object.entries(children)) {
        const system = root === "character" && SYSTEM_CHAR_KEYS.has(key);
        out.push(buildNode(key, key, raw, !(root === "character" && CHAR_ROOT_REQUIRED.has(key)), system));
      }
      return { root, children: out };
    },

    /**
     * 构建类型区视图：{children} = 各类型根（kind: "typeRoot"），子节点为声明字段
     * （typeDeclTerminal / typeDeclContainer / typeDeclTypeRef；path 为类型内点分路径）。
     */
    buildTypesView() {
      const buildDeclNode = (typeName, key, path, raw) => {
        const info = classifyRawDecl(raw);
        if (info === null) return { key, path, kind: "unknown", display: JSON.stringify(raw) ?? "undefined" };
        if (info.kind === "terminal") {
          const derived = info.formula !== undefined;
          return {
            key, path, kind: "typeDeclTerminal", typeName, valueType: info.valueType,
            derived,
            formula: derived ? formulaViewOf(info.formula) : null,
          };
        }
        if (info.kind === "typeContainer") {
          return { key, path, kind: "typeDeclTypeRef", typeName, refTypeName: info.typeName };
        }
        return {
          key, path, kind: "typeDeclContainer", typeName,
          children: Object.entries(info.children).map(([childKey, childRaw]) =>
            buildDeclNode(typeName, childKey, `${path}.${childKey}`, childRaw),
          ),
        };
      };
      return {
        children: Object.entries(rawTypes()).map(([name, raw]) => {
          const info = classifyRawDecl(raw);
          const kids =
            info !== null && info.kind === "container"
              ? Object.entries(info.children).map(([childKey, childRaw]) => buildDeclNode(name, childKey, childKey, childRaw))
              : [];
          return { key: name, path: name, kind: "typeRoot", children: kids };
        }),
      };
    },

    /**
     * 普通容器下结构新增（只动声明，无实例联动）。系统分支容器路径护栏拒写；
     * character 根与系统声明分支键同名 = 冲突拒绝。
     * spec = {name, kind: "terminal"(缺省)|"struct"|"typeContainer", valueType?, typeName?}
     */
    addDecl(root, containerPath, spec) {
      assertNotSystemDecl(root, containerPath);
      if (root === "character" && containerPath === "" && CHAR_ROOT_REQUIRED.has(spec.name)) {
        // 必需声明补齐：保留名豁免，只过空名/分隔符基础校验
        if (spec.name.trim() === "") throw new Error("变量名不能为空");
        if (spec.name.includes(".")) throw new Error(`变量名 "${spec.name}" 不得包含 "."`);
      } else {
        validateBaseName(spec.name);
      }
      if (root === "world" && containerPath === "" && (spec.name === "time" || spec.name === "_sys")) {
        throw new Error(`变量名 "${spec.name}" 与世界程序键冲突`);
      }
      const r = resolveDeclPath(root, containerPath);
      if (r === null || r.info.kind !== "container") throw new Error(`路径 "${containerPath || "<根>"}" 不是普通容器`);
      if (r.crossedType) throw new Error("类型声明不开放新增变量（请到类型区编辑该类型）");
      if (Object.hasOwn(r.info.children, spec.name)) throw new Error(`变量 "${spec.name}" 已存在`);
      // character 根与系统声明分支键同名 = 冲突（服务端拒装，前端先报）
      if (root === "character" && containerPath === "" && SYSTEM_CHAR_KEYS.has(spec.name)) {
        throw new Error(`变量 "${spec.name}" 与系统声明分支同名冲突`);
      }
      r.info.children[spec.name] = buildDeclForSpec(spec);
    },

    /** 删除声明节点（character 根必需声明保护；系统分支路径拒删；类型声明内的节点不可删）。 */
    deleteDecl(root, path) {
      assertNotSystemDecl(root, path);
      const r = resolveDeclPath(root, path);
      if (r === null) throw new Error(`路径 "${path}" 不可解析`);
      if (r.crossedType) throw new Error("类型声明内的节点不可删（请到类型区编辑该类型）");
      if (r.parent === null) throw new Error(`路径 "${path}" 不可解析`);
      if (root === "character" && path === r.parent.key && CHAR_ROOT_REQUIRED.has(r.parent.key)) {
        throw new Error(`character 根必需声明 "${r.parent.key}" 不可删`);
      }
      delete r.parent.children[r.parent.key];
    },

    /** 新建类型：命名 + 空结构体（随后用 addTypeField 逐字段定义）。 */
    addType(name) {
      validateBaseName(name);
      if (!isPlainObject(template.types)) template.types = {};
      if (Object.hasOwn(template.types, name)) throw new Error(`类型 "${name}" 已存在`);
      template.types[name] = { children: {} };
    },

    /**
     * 删除类型：前端预检引用（world/character 根与其它类型声明内的 {type} 引用）；
     * 引用存在即拒删——服务端保存时严格解析仍是最终闸，错误原样展示。
     */
    deleteType(name) {
      const types = rawTypes();
      if (!Object.hasOwn(types, name)) throw new Error(`类型 "${name}" 未声明`);
      const checkRefs = (raw, where) => {
        const found = [];
        collectTypeRefs(raw, found);
        if (found.includes(name)) throw new Error(`类型 "${name}" 正被 ${where} 引用，不可删`);
      };
      checkRefs(template.world, "world 模板");
      checkRefs(template.character, "character 模板");
      for (const [otherName, raw] of Object.entries(types)) {
        if (otherName !== name) checkRefs(raw, `类型 "${otherName}"`);
      }
      delete types[name];
    },

    /** 类型字段新增：同 addDecl 的种类规格，只动类型声明。 */
    addTypeField(typeName, containerPath, spec) {
      validateBaseName(spec.name);
      const children = typeDeclContainerAt(typeName, containerPath);
      if (Object.hasOwn(children, spec.name)) throw new Error(`字段 "${spec.name}" 已存在`);
      children[spec.name] = buildDeclForSpec(spec);
    },

    /** 类型字段删除：只摘声明（世界包编辑无实例可波及；存量存档由读档严格解析兜底）。 */
    removeTypeField(typeName, path) {
      const segs = splitPath(path);
      if (segs.length === 0) throw new Error("字段路径为空");
      const children = typeDeclContainerAt(typeName, segs.slice(0, -1).join("."));
      const key = segs[segs.length - 1];
      if (!Object.hasOwn(children, key)) throw new Error(`类型 "${typeName}" 路径 "${path}" 不可解析`);
      delete children[key];
    },

    /**
     * 末端 formula 声明编辑/清空（formula = null 清空；只动声明层，简写声明升级为
     * {valueType, formula} 完整形）。校验：expr 仅 number 末端（binds 键 = 标识符、
     * 值 = 同根 number 末端路径），union_attach 仅 string_list 末端（paths = 同根容器
     * 路径）；character 根 attachtags 不得挂 formula、tags 必须保持 union_attach
     * （模板契约保护）；系统分支路径拒写（显示注入，不落模板）。
     */
    setDeclFormula(root, path, formula) {
      assertNotSystemDecl(root, path);
      const r = resolveDeclPath(root, path);
      if (r === null || r.info.kind !== "terminal") throw new Error(`路径 "${path}" 不是已声明的末端`);
      if (root === "character" && path === "attachtags" && formula !== null) {
        throw new Error("character 根 attachtags 不得携带 formula（模板契约）");
      }
      if (root === "character" && path === "tags") {
        if (formula === null || formula.op !== "union_attach") {
          throw new Error("character 根 tags 必须保持 union_attach formula（模板契约）");
        }
      }
      validateFormula(root, r.info.valueType, formula);
      if (r.parent === null) throw new Error(`路径 "${path}" 不可解析`);
      const raw = r.parent.children[r.parent.key];
      if (formula === null) {
        if (isPlainObject(raw)) delete raw.formula;
        return;
      }
      if (typeof raw === "string") r.parent.children[r.parent.key] = { valueType: raw, formula };
      else raw.formula = formula;
    },

    /**
     * 类型声明内末端 formula 编辑/清空（formula = null 清空；binds/paths 以类型根为
     * 基准校验——界面提示「类型内公式路径以类型为根」；服务端 rebase 已有，无需改）。
     * 嵌套 {type} 引用内的末端不开放（到其类型上编辑）。
     */
    setTypeDeclFormula(typeName, path, formula) {
      const r = typeDeclTerminalAt(typeName, path);
      validateTypeFormula(typeName, r.info.valueType, formula);
      if (formula === null) {
        if (isPlainObject(r.raw)) delete r.raw.formula;
        return;
      }
      if (typeof r.raw === "string") r.children[r.key] = { valueType: r.raw, formula };
      else r.raw.formula = formula;
    },

    /** 保存载荷：编辑后的模板工作副本本体（PUT vars-template 的请求体）。 */
    getTemplate() {
      return template;
    },
  };
}
