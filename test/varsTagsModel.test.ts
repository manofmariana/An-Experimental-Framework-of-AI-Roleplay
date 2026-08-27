/**
 * web/views/vars-tags-model.js 单元测试（unit 层）：
 * TAG 附加文件（vars-tags.json）编辑（世界页包级编辑；按声明树投影，无实例列）。覆盖：
 * - 视图模型：tagsTerminal/tagsContainer/tagsArray 投影、已有条目读出、
 *   数组 children 旧形态 hasLegacyChildren 标记；
 * - setNodeTags：沿途物化稀疏节点、嵌套路径、条目形状校验（name/category 恰居其一、
 *   level 1-7）、模板外路径拒绝、数组整型挂载（{tags, array} 形式，array = 元素类型名/
 *   内联为 "*"）、children 旧形态拒绝整型覆盖（不丢数据）；
 * - 稀疏回剪：清空条目摘掉空节点链，有内容祖先保留；
 * - getPayload 返回编辑后的工作副本本体；
 * - 系统声明分支并入：character 根投影 = 系统分支 + 作者子树（系统节点可挂附加
 *   条目，含系统容器子路径与 relations 整型挂载），world 根不变。
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  createVarsTagsModel,
  type TagsArrayNode,
  type TagsContainerNode,
  type TagsTerminalNode,
  type VarsTagsModel,
  type VarsTagsNodeView,
} from "../web/views/vars-tags-model.js";

/** 系统声明分支键序（= character 根投影呈现序前缀）。 */
const SYSTEM_KEYS = [
  "name", "gender", "age", "personality", "reaction", "level", "omniscience",
  "location", "initiative", "relations", "long_term_memory",
  "acted", "group", "channel", "timer", "isPlayer", "appearance",
];

// ---------------------------------------------------------------------------
// 夹具：模板 + 附加文件工作副本
// ---------------------------------------------------------------------------

function makeTemplate() {
  return {
    world: {
      children: {
        hp: "number",
        pool: "tag_list",
        loc: { children: { name: "string", items: "string_list" } },
        bag: { array: { type: "item" } },
      },
    },
    character: {
      children: {
        attachtags: "string_list",
        tags: { valueType: "string_list", formula: { op: "union_attach", paths: [] } },
        mood: "string",
      },
    },
    types: {
      item: { children: { count: "number", note: "string" } },
    },
  };
}

function makeVarsTags() {
  return {
    world: {
      children: {
        loc: { tags: [{ name: "场景", level: 2 }] },
      },
    },
    character: {},
  };
}

function modelOf(template: unknown, varsTags: unknown): VarsTagsModel {
  return createVarsTagsModel({ template, varsTags });
}

function childAt(view: { children: VarsTagsNodeView[] }, key: string): VarsTagsNodeView {
  const hit = view.children.find((n) => n.key === key);
  assert.ok(hit, `缺节点 ${key}`);
  return hit;
}

// ---------------------------------------------------------------------------
// 视图模型
// ---------------------------------------------------------------------------

describe("vars-tags-model：视图模型", () => {
  it("声明树投影：末端/容器/结构化数组；已有条目读出", () => {
    const m = modelOf(makeTemplate(), makeVarsTags());
    const view = m.buildRootView("world");
    assert.deepEqual(view.children.map((n) => n.key), ["hp", "pool", "loc", "bag"]);

    const hp = childAt(view, "hp") as TagsTerminalNode;
    assert.equal(hp.kind, "tagsTerminal");
    assert.equal(hp.valueType, "number");
    assert.deepEqual(hp.entries, []);

    const loc = childAt(view, "loc") as TagsContainerNode;
    assert.equal(loc.kind, "tagsContainer");
    assert.deepEqual(loc.entries, [{ name: "场景", level: 2 }]);
    assert.deepEqual(loc.children.map((n) => n.key), ["name", "items"]);

    const bag = childAt(view, "bag") as TagsArrayNode;
    assert.equal(bag.kind, "tagsArray");
    assert.equal(bag.elementType, "item");
    assert.equal(bag.hasLegacyChildren, false);
  });

  it("数组整型条目读出；children 旧形态标记 hasLegacyChildren 且不出条目表", () => {
    const varsTags = {
      world: {
        children: {
          bag: { tags: [{ name: "装备", level: 3 }], array: "item" },
        },
      },
      character: {
        children: {
          attachtags: { tags: [{ category: "cid", level: 1 }] },
        },
      },
    };
    const m = modelOf(makeTemplate(), varsTags);
    const bag = childAt(m.buildRootView("world"), "bag") as TagsArrayNode;
    assert.deepEqual(bag.entries, [{ name: "装备", level: 3 }]);
    assert.equal(bag.hasLegacyChildren, false);

    const attachtags = childAt(m.buildRootView("character"), "attachtags") as TagsTerminalNode;
    assert.deepEqual(attachtags.entries, [{ category: "cid", level: 1 }]);

    // children 旧形态：不展开、不出条目表、保留不丢
    const legacyVarsTags = {
      world: { children: { bag: { children: { "0": { tags: [{ name: "名剑", level: 5 }] } } } } },
      character: {},
    };
    const m2 = modelOf(makeTemplate(), legacyVarsTags);
    const bag2 = childAt(m2.buildRootView("world"), "bag") as TagsArrayNode;
    assert.equal(bag2.hasLegacyChildren, true);
    assert.deepEqual(bag2.entries, []);
  });
});

// ---------------------------------------------------------------------------
// setNodeTags：物化 / 校验 / 回剪
// ---------------------------------------------------------------------------

describe("vars-tags-model：setNodeTags", () => {
  it("沿途物化稀疏节点（含嵌套路径）；视图立刻反映", () => {
    const t = makeTemplate();
    const v = makeVarsTags();
    const m = modelOf(t, v);
    m.setNodeTags("world", "hp", [{ name: "核心", level: 1 }]);
    assert.deepEqual((v.world.children as any).hp, { tags: [{ name: "核心", level: 1 }] });
    m.setNodeTags("world", "loc.name", [{ name: "地名", level: 4 }]);
    assert.deepEqual((v.world.children as any).loc.children.name, { tags: [{ name: "地名", level: 4 }] });
    // 既有条目不被波及
    assert.deepEqual((v.world.children as any).loc.tags, [{ name: "场景", level: 2 }]);

    m.setNodeTags("character", "mood", [{ category: "cid", level: 2 }]);
    assert.deepEqual((v.character as any).children.mood, { tags: [{ category: "cid", level: 2 }] });

    const hp = childAt(m.buildRootView("world"), "hp") as TagsTerminalNode;
    assert.deepEqual(hp.entries, [{ name: "核心", level: 1 }]);
  });

  it("条目形状校验：name/category 恰居其一、level 1-7 整数、非数组拒绝", () => {
    const m = modelOf(makeTemplate(), makeVarsTags());
    assert.throws(() => m.setNodeTags("world", "hp", [{ name: "x", category: "cid", level: 1 } as never]), /恰居/);
    assert.throws(() => m.setNodeTags("world", "hp", [{ level: 1 } as never]), /恰居/);
    assert.throws(() => m.setNodeTags("world", "hp", [{ name: "", level: 1 }]), /恰居/);
    assert.throws(() => m.setNodeTags("world", "hp", [{ name: "x", level: 0 }]), /1-7/);
    assert.throws(() => m.setNodeTags("world", "hp", [{ name: "x", level: 8 }]), /1-7/);
    assert.throws(() => m.setNodeTags("world", "hp", [{ name: "x", level: 1.5 }]), /1-7/);
    assert.throws(() => m.setNodeTags("world", "hp", "x" as never), /数组/);
  });

  it("模板外路径拒绝（含穿越末端与数组）", () => {
    const m = modelOf(makeTemplate(), makeVarsTags());
    assert.throws(() => m.setNodeTags("world", "nosuch", [{ name: "x", level: 1 }]), /不可解析/);
    assert.throws(() => m.setNodeTags("world", "hp.sub", [{ name: "x", level: 1 }]), /不可解析/);
    assert.throws(() => m.setNodeTags("world", "bag.count", [{ name: "x", level: 1 }]), /不可解析/, "数组不穿越");
  });

  it("数组整型挂载（{tags, array} 形式）；children 旧形态拒绝整型覆盖且不丢数据", () => {
    const t = makeTemplate();
    const v = makeVarsTags();
    const m = modelOf(t, v);
    m.setNodeTags("world", "bag", [{ name: "装备", level: 3 }]);
    assert.deepEqual((v.world.children as any).bag, { tags: [{ name: "装备", level: 3 }], array: "item" });

    const legacyVarsTags = {
      world: { children: { bag: { children: { "0": { tags: [{ name: "名剑", level: 5 }] } } } } },
      character: {},
    };
    const m2 = modelOf(makeTemplate(), legacyVarsTags);
    assert.throws(() => m2.setNodeTags("world", "bag", [{ name: "装备", level: 1 }]), /旧形态/);
    // 旧形态子树原样保留
    assert.deepEqual((legacyVarsTags.world.children.bag.children as any)["0"], { tags: [{ name: "名剑", level: 5 }] });
  });

  it("内联元素结构数组整型挂载 array = \"*\"", () => {
    const t = makeTemplate();
    (t.world.children as any).pack = { array: { children: { n: "number" } } };
    const v = makeVarsTags();
    const m = modelOf(t, v);
    m.setNodeTags("world", "pack", [{ name: "随行", level: 2 }]);
    assert.deepEqual((v.world.children as any).pack, { tags: [{ name: "随行", level: 2 }], array: "*" });
    const pack = childAt(m.buildRootView("world"), "pack") as TagsArrayNode;
    assert.equal(pack.elementType, null);
    assert.deepEqual(pack.entries, [{ name: "随行", level: 2 }]);
  });

  it("清空条目稀疏回剪：空节点链摘掉，有内容祖先保留；整型节点清空整体摘除", () => {
    const t = makeTemplate();
    const v = makeVarsTags();
    const m = modelOf(t, v);
    m.setNodeTags("world", "loc.name", [{ name: "地名", level: 4 }]);
    m.setNodeTags("world", "loc.name", []); // 清空 → name 节点摘除，loc 有 tags 保留
    assert.deepEqual(v.world.children.loc, { tags: [{ name: "场景", level: 2 }] });

    m.setNodeTags("world", "loc", []); // loc 也空 → 整链回剪（空壳 children 键一并摘）
    assert.deepEqual(v.world, {});

    m.setNodeTags("world", "bag", [{ name: "装备", level: 3 }]);
    m.setNodeTags("world", "bag", []); // 整型节点清空 → 节点整体摘除
    assert.deepEqual(v.world, {});
  });

  it("根节点自身条目：rootEntries 读出、setNodeTags 根路径写/清（级联到全根末端）", () => {
    const t = makeTemplate();
    const v = makeVarsTags();
    const m = modelOf(t, v);
    assert.deepEqual(m.buildRootView("world").rootEntries, []);

    // character 根挂 cid 类别条目（按属主分发到全角色全部末端）
    m.setNodeTags("character", "", [{ category: "cid", level: 1 }]);
    assert.deepEqual((v.character as any).tags, [{ category: "cid", level: 1 }]);
    assert.deepEqual(m.buildRootView("character").rootEntries, [{ category: "cid", level: 1 }]);

    m.setNodeTags("world", "", [{ name: "全域", level: 2 }]);
    assert.deepEqual((v.world as any).tags, [{ name: "全域", level: 2 }]);
    assert.deepEqual(m.buildRootView("world").rootEntries, [{ name: "全域", level: 2 }]);

    m.setNodeTags("world", "", []); // 清空根条目（既有子树不动）
    assert.equal(Object.hasOwn(v.world, "tags"), false);
    assert.deepEqual((v.world.children as any).loc, { tags: [{ name: "场景", level: 2 }] });
  });

  it("缺根键自动补空对象；getPayload 返回工作副本本体", () => {
    const t = makeTemplate();
    const v = {};
    const m = modelOf(t, v);
    m.setNodeTags("character", "mood", [{ name: "心境", level: 1 }]);
    const payload = m.getPayload();
    assert.equal(payload, v);
    assert.deepEqual((v as any).character.children.mood, { tags: [{ name: "心境", level: 1 }] });
    assert.deepEqual((v as any).world, {});
  });
});

// ---------------------------------------------------------------------------
// 系统声明分支并入（character 根投影 = 系统分支 + 作者子树）
// ---------------------------------------------------------------------------

describe("vars-tags-model：系统声明分支并入", () => {
  it("character 根投影并入系统分支（键序在前，作者子树原序随后）；world 根不变", () => {
    const m = modelOf(makeTemplate(), makeVarsTags());
    const view = m.buildRootView("character");
    assert.deepEqual(view.children.map((n) => n.key), [...SYSTEM_KEYS, "attachtags", "tags", "mood"]);

    const name = childAt(view, "name") as TagsTerminalNode;
    assert.equal(name.kind, "tagsTerminal");
    assert.equal(name.valueType, "string");

    const location = childAt(view, "location") as TagsContainerNode;
    assert.equal(location.kind, "tagsContainer");
    assert.deepEqual(location.children.map((n) => n.key), ["name", "level"]);

    // relations = 系统结构化数组（元素类型解析回退系统类型 relation）
    const relations = childAt(view, "relations") as TagsArrayNode;
    assert.equal(relations.kind, "tagsArray");
    assert.equal(relations.elementType, "relation");
    assert.equal(relations.hasLegacyChildren, false);

    assert.deepEqual(m.buildRootView("world").children.map((n) => n.key), ["hp", "pool", "loc", "bag"]);
  });

  it("系统节点可挂附加条目：系统末端 / 系统容器子路径 / relations 整型挂载", () => {
    const t = makeTemplate();
    const v = makeVarsTags();
    const m = modelOf(t, v);
    m.setNodeTags("character", "name", [{ name: "核心", level: 1 }]);
    assert.deepEqual((v.character as any).children.name, { tags: [{ name: "核心", level: 1 }] });
    m.setNodeTags("character", "location.name", [{ name: "地名", level: 2 }]);
    assert.deepEqual((v.character as any).children.location.children.name, { tags: [{ name: "地名", level: 2 }] });
    m.setNodeTags("character", "relations", [{ category: "cid", level: 1 }]);
    assert.deepEqual((v.character as any).children.relations, { tags: [{ category: "cid", level: 1 }], array: "relation" });

    // 视图读出既有条目；清空稀疏回剪不受影响
    const name = childAt(m.buildRootView("character"), "name") as TagsTerminalNode;
    assert.deepEqual(name.entries, [{ name: "核心", level: 1 }]);
    m.setNodeTags("character", "location.name", []);
    assert.equal(Object.hasOwn((v.character as any).children, "location"), false);
  });

  it("系统分支外的路径仍按模板对拍拒绝", () => {
    const m = modelOf(makeTemplate(), makeVarsTags());
    assert.throws(() => m.setNodeTags("character", "nosuch", [{ name: "x", level: 1 }]), /不可解析/);
    assert.throws(() => m.setNodeTags("character", "name.sub", [{ name: "x", level: 1 }]), /不可解析/);
  });
});
