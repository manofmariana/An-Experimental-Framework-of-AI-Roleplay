/**
 * TAG 附加文件（vars-tags.json）编辑数据核心（纯逻辑，零 DOM 零网络，node:test 可直接 import）。
 *
 * 服务世界页「TAG 附加」子区：按 vars-template 声明树投影编辑视图（无实例列——类型容器
 * 节点以 {tags, type} 形式整型挂载，不展开实例名自由形态），每个节点可挂附加条目
 * （{name, level} | {category, level}，level 1-7 整数；名称下拉自同包 tags.json 注册表，
 * 自由输入不受限——与实例 tags 编辑同一口径）。character 根投影并入系统声明分支
 * （镜像常量取自 system-char-decl.js；类型解析回退系统类型 relation），系统节点同样
 * 可挂附加条目——与服务端 parseVarsTags 按并入后根校验的口径一致。
 *
 * 工作副本 = 调用方深拷贝的 {world, character} 两附加根；编辑原地作用于副本：
 * - setNodeTags(root, path, entries)：整条目表替换——路径先对拍模板（不存在即抛），
 *   沿途物化稀疏节点，空条目 + 空子树回剪（保持文件稀疏）；path = "" = 根节点自身
 *   条目（根挂条目 = 级联到该根全部末端；character 根可挂 {category:"cid"} 按属主分发）；
 * - 类型容器节点：已存在实例名自由形态（children 子树）时拒绝改挂整型条目
 *   （schema 二选一；实例名形态不在本编辑器管理面，原样保留不丢数据）；
 * - getPayload() 出保存载荷（PUT vars-tags 的请求体；服务端 parseVarsTags 对拍同包
 *   模板仍是最终闸）。
 */

import { classifyRawDecl, isPlainObject } from "./var-decl-model.js";
import { SYSTEM_CHAR_DECLS, SYSTEM_CHAR_TYPES } from "./system-char-decl.js";

function splitPath(path) {
  return path === "" ? [] : path.split(".");
}

/** 附加条目校验：{name 非空, level 1-7 整数} | {category 非空, level 1-7 整数}（恰居其一）。 */
function validateEntries(entries, at) {
  if (!Array.isArray(entries)) throw new Error(`附加条目须为数组（${at}）`);
  for (const e of entries) {
    if (!isPlainObject(e)) throw new Error(`附加条目形状非法（${at}）`);
    const hasName = typeof e.name === "string" && e.name !== "";
    const hasCategory = typeof e.category === "string" && e.category !== "";
    if (hasName === hasCategory) throw new Error(`附加条目须恰居 name/category 其一（${at}）`);
    if (!Number.isInteger(e.level) || e.level < 1 || e.level > 7) {
      throw new Error(`附加条目 level 须为 1-7 整数（${at}）`);
    }
  }
  return entries;
}

// ---------------------------------------------------------------------------
// 模型工厂
// ---------------------------------------------------------------------------

/**
 * @param {object} deps
 * @param {object} deps.template vars-template 原始声明树（只读对拍，不编辑）
 * @param {object} deps.varsTags vars-tags 工作副本（{world, character}；编辑直接改它）
 */
export function createVarsTagsModel({ template, varsTags }) {
  if (!isPlainObject(template)) throw new Error("变量模板须为对象");
  if (!isPlainObject(varsTags)) throw new Error("TAG 附加文件须为对象");
  for (const root of ["world", "character"]) {
    if (varsTags[root] === undefined) varsTags[root] = {};
    if (!isPlainObject(varsTags[root])) throw new Error(`TAG 附加根 "${root}" 须为对象`);
  }

  function templateRootChildren(root) {
    const info = classifyRawDecl(template[root]);
    if (info === null || info.kind !== "container") return null;
    // character 根并入系统声明分支显示（系统分支键序在前，作者子树原序随后）
    return root === "character" ? { ...SYSTEM_CHAR_DECLS, ...info.children } : info.children;
  }

  function typeChildren(typeName) {
    // 系统类型 relation 回退（与服务端把系统类型并入 types 的口径一致）
    if (Object.hasOwn(SYSTEM_CHAR_TYPES, typeName)) return SYSTEM_CHAR_TYPES[typeName].children;
    const types = isPlainObject(template.types) ? template.types : {};
    const info = classifyRawDecl(types[typeName]);
    return info !== null && info.kind === "container" ? info.children : null;
  }

  /** 根内点分路径 → 声明信息（类型容器不穿越——附加树按声明层呈现；不可解析 = null）。 */
  function resolveDecl(root, path) {
    const segs = splitPath(path);
    let children = templateRootChildren(root);
    if (children === null) return null;
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
        children = next;
      } else {
        return null; // 穿越末端
      }
    }
    return info;
  }

  /** 附加根上按声明路径取已有节点（类型容器层 = {type} 整型节点本身；无 = null）。 */
  function tagsNodeAt(root, path) {
    let node = varsTags[root];
    for (const seg of splitPath(path)) {
      if (!isPlainObject(node) || !isPlainObject(node.children)) return null;
      const next = node.children[seg];
      if (!isPlainObject(next)) return null;
      node = next;
    }
    return node;
  }

  /** 节点已挂条目（无节点/无 tags = 空表；副本防外部 mutate 视图）。 */
  function entriesAt(root, path) {
    const node = tagsNodeAt(root, path);
    return node !== null && Array.isArray(node.tags) ? node.tags.map((e) => ({ ...e })) : [];
  }

  /** 稀疏回剪：沿路径自底向上摘掉 无 tags 且无 children 的空节点（空壳 children 键顺手摘）。 */
  function prune(root, path) {
    const segs = splitPath(path);
    const chain = [varsTags[root]];
    for (const seg of segs) {
      const next = chain[chain.length - 1].children?.[seg];
      if (!isPlainObject(next)) return;
      chain.push(next);
    }
    for (let i = segs.length; i >= 1; i--) {
      const node = chain[i];
      const hasTags = Array.isArray(node.tags) && node.tags.length > 0;
      const hasChildren = isPlainObject(node.children) && Object.keys(node.children).length > 0;
      // 整型节点（{tags, type} 形式）有条目即活；普通节点有条目或有子树即活
      const alive = node.type !== undefined ? hasTags : hasTags || hasChildren;
      if (alive) {
        if (!hasChildren) delete node.children;
        return;
      }
      delete chain[i - 1].children[segs[i - 1]];
      if (Object.keys(chain[i - 1].children).length === 0) delete chain[i - 1].children;
    }
  }

  // ---- 视图模型构建 ---------------------------------------------------------

  /**
   * 声明子树 → 附加编辑视图节点（tagsTerminal / tagsContainer / tagsTypeContainer）。
   * 类型容器不展开：entries = 整型（{type} 形式）条目；实例名形态存在时 hasInstanceForm
   * 标记（整型挂载被拒，实例名子树原样保留）。
   */
  function buildNode(root, key, path, raw) {
    const info = classifyRawDecl(raw);
    if (info === null) {
      return { key, path, kind: "unknown", display: JSON.stringify(raw) ?? "undefined" };
    }
    if (info.kind === "terminal") {
      return { key, path, kind: "tagsTerminal", valueType: info.valueType, entries: entriesAt(root, path) };
    }
    if (info.kind === "typeContainer") {
      const node = tagsNodeAt(root, path);
      const hasInstanceForm = node !== null && node.type === undefined && isPlainObject(node.children);
      return {
        key, path, kind: "tagsTypeContainer", typeName: info.typeName,
        entries: hasInstanceForm ? [] : entriesAt(root, path),
        hasInstanceForm,
      };
    }
    return {
      key, path, kind: "tagsContainer",
      entries: entriesAt(root, path),
      children: Object.entries(info.children).map(([childKey, childRaw]) =>
        buildNode(root, childKey, path === "" ? childKey : `${path}.${childKey}`, childRaw),
      ),
    };
  }

  // ---- 对外接口 -------------------------------------------------------------

  return {
    /** 根列表（世界 / 角色共享模板；切换分页用）。 */
    listRoots() {
      return [
        { id: "world", label: "世界" },
        { id: "character", label: "角色（共享模板）" },
      ];
    },

    /** 构建根附加编辑视图：{root, rootEntries, children}（rootEntries = 根节点自身条目）。 */
    buildRootView(root) {
      const children = templateRootChildren(root);
      return {
        root,
        rootEntries: entriesAt(root, ""),
        children:
          children === null
            ? []
            : Object.entries(children).map(([key, raw]) => buildNode(root, key, key, raw)),
      };
    },

    /**
     * 节点附加条目整条目表替换（空表 = 摘条目并稀疏回剪）。
     * 类型容器节点 = 整型挂载（{tags, type} 形式）；已存在实例名形态即拒（不丢数据）。
     */
    setNodeTags(root, path, entries) {
      const list = validateEntries(entries, path === "" ? "<根>" : path).map((e) => ({ ...e }));
      const info = resolveDecl(root, path);
      if (info === null) throw new Error(`路径 "${path}" 在模板中不可解析`);
      if (info.kind === "typeContainer") {
        const existing = tagsNodeAt(root, path);
        if (existing !== null && existing.type === undefined && isPlainObject(existing.children)) {
          throw new Error(`路径 "${path}" 存在实例名形态附加（本编辑器不管理），拒绝整型覆盖`);
        }
      }
      if (list.length === 0) {
        const node = tagsNodeAt(root, path);
        if (node !== null) {
          delete node.tags;
          if (node.type !== undefined && info.kind !== "typeContainer") delete node.type;
        }
        prune(root, path);
        return;
      }
      // 沿途物化稀疏节点
      let node = varsTags[root];
      for (const seg of splitPath(path)) {
        if (!isPlainObject(node.children)) node.children = {};
        if (!isPlainObject(node.children[seg])) node.children[seg] = {};
        node = node.children[seg];
      }
      if (info.kind === "typeContainer") {
        delete node.children; // 整型形态与 children 互斥（上面已拒实例名形态，此为防御）
        node.type = info.typeName;
      }
      node.tags = list;
    },

    /** 保存载荷：编辑后的附加文件工作副本本体（{world, character}）。 */
    getPayload() {
      return varsTags;
    },
  };
}
