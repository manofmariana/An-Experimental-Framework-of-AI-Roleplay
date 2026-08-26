/**
 * web/views/var-decl-model.js 单元测试（unit 层）：
 * 变量模板声明树结构编辑（世界页包级编辑；纯声明，无实例列）。覆盖：
 * - 视图模型：declTerminal/declContainer/declArray 投影、formula 结构化视图、
 *   character 根必需声明 canDelete 保护、类型区 typeRoot/声明字段投影；
 * - 结构新增：扁平末端（字符串简写声明）/ 结构体（{children:{}} 可递归）/ 结构化数组
 *   （{array:{type}} 引用已有类型或 {array:{children}} 内联元素结构）；保留名/冲突/
 *   程序键拒绝；character 根必需声明补齐豁免；
 * - 删除声明：摘声明（容器级联）、character 根必需声明保护、引用类型数组元素内拒绝；
 * - 类型区：新建类型（命名空结构体）、类型字段增删（只摘声明不波及实例——世界包编辑
 *   无实例）、删除类型前端预检引用（含数组元素 {type} 引用）；
 * - formula 声明编辑：简写升级完整形 / 清空、expr/union_attach 校验、character 根
 *   attachtags/tags 模板契约保护；类型声明内末端 formula 编辑（路径以类型根为基准，
 *   数组层经 [*] 段）；
 * - getTemplate 返回编辑后的模板工作副本本体；
 * - 系统声明分支并入：character 根视图 = 系统分支（system 标记 + 全操作禁）+ 作者
 *   子树原序；系统路径写操作全拒且副本不波及；保存载荷不含系统分支；character 根
 *   新增与系统键同名 = 冲突拒绝；作者 formula 可绑系统 number 末端。
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  createVarDeclModel,
  type DeclArrayNode,
  type DeclContainerNode,
  type DeclTerminalNode,
  type TypeDeclArrayNode,
  type TypeDeclTerminalNode,
  type TypeRootNode,
  type VarDeclModel,
  type VarDeclNode,
} from "../web/views/var-decl-model.js";

/** 系统声明分支键序（= character 根视图呈现序前缀）。 */
const SYSTEM_KEYS = [
  "name", "gender", "age", "personality", "reaction", "level", "omniscience",
  "location", "initiative", "relations", "long_term_memory",
  "acted", "group", "channel", "timer", "isPlayer",
];

// ---------------------------------------------------------------------------
// 夹具：原始模板（字符串简写 / 完整形末端 / 容器 / 结构化数组 / 类型区）
// ---------------------------------------------------------------------------

function makeTemplate() {
  return {
    world: {
      children: {
        hp: "number",
        pool: "string_list",
        loc: { children: { name: "string", items: "string_list" } },
        bag: { array: { type: "item" } },
      },
    },
    character: {
      children: {
        attachtags: "string_list",
        tags: { valueType: "string_list", formula: { op: "union_attach", paths: [] } },
        mood: "string",
        str: "number",
        double_str: { valueType: "number", formula: { expr: "str * 2", binds: { str: "str" } } },
        gear: { array: { type: "item" } },
      },
    },
    types: {
      item: { children: { count: "number", note: "string", parts: { array: { type: "part" } } } },
      part: { children: { w: "number" } },
    },
  };
}

function modelOf(template: unknown): VarDeclModel {
  return createVarDeclModel({ template });
}

/** 按键取子节点（断言存在）。 */
function childAt(view: { children: VarDeclNode[] }, key: string): VarDeclNode {
  const hit = view.children.find((n) => n.key === key);
  assert.ok(hit, `缺节点 ${key}`);
  return hit;
}

// ---------------------------------------------------------------------------
// 视图模型
// ---------------------------------------------------------------------------

describe("var-decl-model：视图模型", () => {
  it("声明树投影：末端 valueType/formula 视图、容器递归、引用类型数组不展开", () => {
    const m = modelOf(makeTemplate());
    const view = m.buildRootView("world");
    assert.deepEqual(view.children.map((n) => n.key), ["hp", "pool", "loc", "bag"]);

    const hp = childAt(view, "hp") as DeclTerminalNode;
    assert.equal(hp.kind, "declTerminal");
    assert.equal(hp.valueType, "number");
    assert.equal(hp.derived, false);
    assert.equal(hp.canDelete, true);

    const loc = childAt(view, "loc") as DeclContainerNode;
    assert.equal(loc.kind, "declContainer");
    assert.deepEqual(loc.children.map((n) => n.key), ["name", "items"]);

    const bag = childAt(view, "bag") as DeclArrayNode;
    assert.equal(bag.kind, "declArray");
    assert.equal(bag.elementType, "item");
    assert.equal(bag.children, undefined, "引用类型数组不展开元素字段");
    assert.equal(bag.canDelete, true);
  });

  it("内联元素结构数组展开并经 `[*]` 路径呈现", () => {
    const t = makeTemplate();
    (t.world.children as any).bag = { array: { children: { count: "number" } } };
    const m = modelOf(t);
    const bag = childAt(m.buildRootView("world"), "bag") as DeclArrayNode;
    assert.equal(bag.kind, "declArray");
    assert.equal(bag.elementType, null);
    assert.deepEqual(bag.children!.map((n) => [n.key, n.path]), [["count", "bag[*].count"]]);
  });

  it("character 根必需声明保护（attachtags/tags 不可删），formula 出结构化视图", () => {
    const m = modelOf(makeTemplate());
    const view = m.buildRootView("character");
    const attachtags = childAt(view, "attachtags") as DeclTerminalNode;
    assert.equal(attachtags.canDelete, false);
    const tags = childAt(view, "tags") as DeclTerminalNode;
    assert.equal(tags.canDelete, false);
    assert.equal(tags.derived, true);
    assert.deepEqual(tags.formula, { kind: "unionAttach", paths: [] });
    const dbl = childAt(view, "double_str") as DeclTerminalNode;
    assert.deepEqual(dbl.formula, { kind: "expr", expr: "str * 2", binds: { str: "str" } });
    assert.equal((childAt(view, "mood") as DeclTerminalNode).canDelete, true);
  });

  it("buildTypesView：类型根 + 声明字段（末端/容器/数组字段）；listTypeNames", () => {
    const m = modelOf(makeTemplate());
    assert.deepEqual(m.listTypeNames(), ["item", "part"]);
    const view = m.buildTypesView();
    assert.deepEqual(view.children.map((n) => n.key), ["item", "part"]);
    const item = view.children[0] as TypeRootNode;
    assert.equal(item.kind, "typeRoot");
    const count = childAt(item, "count") as TypeDeclTerminalNode;
    assert.equal(count.kind, "typeDeclTerminal");
    assert.equal(count.valueType, "number");
    assert.equal(count.typeName, "item");
    const parts = childAt(item, "parts") as TypeDeclArrayNode;
    assert.equal(parts.kind, "typeDeclArray");
    assert.equal(parts.elementType, "part");
  });

  it("listRoots = 世界 + 角色（共享模板）", () => {
    const m = modelOf(makeTemplate());
    assert.deepEqual(
      m.listRoots().map((r) => r.id),
      ["world", "character"],
    );
  });
});

// ---------------------------------------------------------------------------
// 结构新增（扁平末端 / 结构体 / 结构化数组——只动声明）
// ---------------------------------------------------------------------------

describe("var-decl-model：结构新增", () => {
  it("扁平末端 = 字符串简写声明（根/嵌套容器/角色域）；视图立刻反映", () => {
    const t = makeTemplate();
    const m = modelOf(t);
    m.addDecl("world", "", { name: "gold", valueType: "number" });
    assert.equal((t.world.children as any).gold, "number");
    m.addDecl("world", "loc", { name: "open", valueType: "boolean" });
    assert.equal((t.world.children.loc.children as any).open, "boolean");
    m.addDecl("character", "", { name: "mp", valueType: "string_list" });
    assert.equal((t.character.children as any).mp, "string_list");
    const gold = childAt(m.buildRootView("world"), "gold") as DeclTerminalNode;
    assert.equal(gold.valueType, "number");
  });

  it("结构体：{children:{}} 声明，可递归加子字段（任意嵌套）", () => {
    const t = makeTemplate();
    const m = modelOf(t);
    m.addDecl("world", "", { name: "base", kind: "struct" });
    assert.deepEqual((t.world.children as any).base, { children: {} });
    m.addDecl("world", "base", { name: "core", kind: "struct" });
    m.addDecl("world", "base.core", { name: "hp", valueType: "number" });
    assert.equal((t.world.children as any).base.children.core.children.hp, "number");
  });

  it("结构化数组：引用类型 / 内联元素结构；未声明类型拒绝", () => {
    const t = makeTemplate();
    const m = modelOf(t);
    m.addDecl("world", "", { name: "warehouse", kind: "array", typeName: "item" });
    assert.deepEqual((t.world.children as any).warehouse, { array: { type: "item" } });
    m.addDecl("world", "", { name: "pack", kind: "arrayInline" });
    assert.deepEqual((t.world.children as any).pack, { array: { children: {} } });
    // 内联元素结构可经 [*] 路径加字段
    m.addDecl("world", "pack[*]", { name: "count", valueType: "number" });
    assert.equal((t.world.children as any).pack.array.children.count, "number");
    assert.throws(
      () => m.addDecl("world", "", { name: "bad", kind: "array", typeName: "nosuch" }),
      /未声明/,
    );
  });

  it("保留名/分隔符/下标括号/冲突/程序键/未知种类一律拒绝；引用类型数组元素内不开放", () => {
    const m = modelOf(makeTemplate());
    assert.throws(() => m.addDecl("world", "", { name: "value", valueType: "number" }), /保留名/);
    assert.throws(() => m.addDecl("world", "", { name: "tags", valueType: "number" }), /保留名/);
    assert.throws(() => m.addDecl("world", "", { name: "a.b", valueType: "number" }), /不得包含/);
    assert.throws(() => m.addDecl("world", "", { name: "a[0]", valueType: "number" }), /不得包含/);
    assert.throws(() => m.addDecl("world", "", { name: "hp", valueType: "number" }), /已存在/);
    assert.throws(() => m.addDecl("world", "", { name: "_sys", valueType: "number" }), /程序键/);
    assert.throws(() => m.addDecl("world", "", { name: "x", valueType: "wat" as never }), /未知 valueType/);
    assert.throws(() => m.addDecl("world", "hp", { name: "x", valueType: "number" }), /不是普通容器/);
    assert.throws(() => m.addDecl("world", "bag[*]", { name: "x", valueType: "number" }), /不开放新增/);
    assert.throws(() => m.addDecl("world", "", { name: "x", kind: "wat" as never }), /未知种类/);
  });

  it("character 根必需声明补齐豁免保留名（手改缺省模板修复通道）", () => {
    const t = { world: { children: {} }, character: { children: {} } };
    const m = modelOf(t);
    m.addDecl("character", "", { name: "attachtags", valueType: "string_list" });
    assert.equal((t.character.children as any).attachtags, "string_list");
    m.addDecl("character", "", { name: "tags", valueType: "string_list" });
    assert.equal((t.character.children as any).tags, "string_list");
    assert.throws(() => m.addDecl("character", "", { name: "tags", valueType: "string_list" }), /已存在/);
  });
});

// ---------------------------------------------------------------------------
// 删除声明
// ---------------------------------------------------------------------------

describe("var-decl-model：删除声明", () => {
  it("摘声明（容器级联）；视图立刻反映", () => {
    const t = makeTemplate();
    const m = modelOf(t);
    m.deleteDecl("world", "loc.items");
    assert.equal((t.world.children.loc.children as any).items, undefined);
    m.deleteDecl("world", "loc");
    assert.equal((t.world.children as any).loc, undefined);
    assert.equal(m.buildRootView("world").children.some((n) => n.key === "loc"), false);
  });

  it("内联元素结构内字段可删；引用类型数组元素内拒绝", () => {
    const t = makeTemplate();
    (t.world.children as any).pack = { array: { children: { count: "number", note: "string" } } };
    const m = modelOf(t);
    m.deleteDecl("world", "pack[*].note");
    assert.deepEqual((t.world.children as any).pack.array.children, { count: "number" });
    assert.throws(() => m.deleteDecl("world", "bag[*].count"), /元素内的节点不可删/);
  });

  it("character 根必需声明保护；不可解析拒绝", () => {
    const m = modelOf(makeTemplate());
    assert.throws(() => m.deleteDecl("character", "attachtags"), /不可删/);
    assert.throws(() => m.deleteDecl("character", "tags"), /不可删/);
    assert.throws(() => m.deleteDecl("world", "nosuch"), /不可解析/);
  });
});

// ---------------------------------------------------------------------------
// 类型区（新建类型 / 类型字段增删 / 删除类型）
// ---------------------------------------------------------------------------

describe("var-decl-model：类型区", () => {
  it("新建类型 = 命名 + 空结构体；随后逐字段定义（含结构体嵌套与数组字段）", () => {
    const t = makeTemplate();
    const m = modelOf(t);

    m.addType("tool");
    assert.deepEqual((t.types as any).tool, { children: {} });
    assert.throws(() => m.addType("tool"), /已存在/);
    assert.throws(() => m.addType("a.b"), /不得包含/);

    m.addTypeField("tool", "", { name: "name", valueType: "string" });
    m.addTypeField("tool", "", { name: "count", valueType: "number" });
    m.addTypeField("tool", "", { name: "attachtags", valueType: "string_list" });
    m.addTypeField("tool", "", { name: "spec", kind: "struct" });
    m.addTypeField("tool", "spec", { name: "w", valueType: "number" }); // 结构体内递归子字段
    m.addTypeField("tool", "", { name: "parts", kind: "array", typeName: "part" });
    m.addTypeField("tool", "", { name: "slots", kind: "arrayInline" });
    m.addTypeField("tool", "slots[*]", { name: "n", valueType: "number" }); // 内联元素结构经 [*] 加字段
    assert.deepEqual((t.types as any).tool.children, {
      name: "string",
      count: "number",
      attachtags: "string_list",
      spec: { children: { w: "number" } },
      parts: { array: { type: "part" } },
      slots: { array: { children: { n: "number" } } },
    });
    assert.throws(() => m.addTypeField("tool", "", { name: "name", valueType: "string" }), /已存在/);
    assert.throws(() => m.addTypeField("tool", "parts", { name: "x", valueType: "number" }), /数组层需要 \[\*\] 段/);
    assert.throws(() => m.addTypeField("tool", "parts[*]", { name: "x", valueType: "number" }), /请到类型/); // 穿越引用类型数组元素
    assert.throws(() => m.addTypeField("tool", "name", { name: "x", valueType: "number" }), /穿越末端/);
    assert.throws(() => m.addTypeField("nosuch", "", { name: "x", valueType: "number" }), /未声明/);
  });

  it("删除类型：未引用可删；被数组元素 {type} 引用前端预检拒绝", () => {
    const t = makeTemplate();
    const m = modelOf(t);
    m.addType("tmp");
    m.deleteType("tmp");
    assert.equal((t.types as any).tmp, undefined);

    assert.throws(() => m.deleteType("item"), /引用/); // world.bag / character.gear 数组引用
    assert.throws(() => m.deleteType("part"), /引用/); // item 声明内嵌套数组引用
    assert.throws(() => m.deleteType("nosuch"), /未声明/);
  });

  it("类型字段删除：只摘声明（世界包编辑无实例可波及）", () => {
    const t = makeTemplate();
    const m = modelOf(t);
    m.removeTypeField("item", "count");
    assert.equal((t.types as any).item.children.count, undefined);
    assert.equal((t.types as any).item.children.note, "string"); // 其余字段不动
    assert.throws(() => m.removeTypeField("item", "nosuch"), /不可解析/);
  });
});

// ---------------------------------------------------------------------------
// formula 声明编辑与清空
// ---------------------------------------------------------------------------

describe("var-decl-model：formula 声明编辑", () => {
  it("expr 挂上（简写升级完整形）→ 视图从动；清空变回普通末端", () => {
    const t = makeTemplate();
    const m = modelOf(t);

    m.setDeclFormula("world", "hp", { expr: "str2 + 1", binds: { str2: "hp" } });
    assert.deepEqual((t.world.children as any).hp, { valueType: "number", formula: { expr: "str2 + 1", binds: { str2: "hp" } } });
    assert.equal((childAt(m.buildRootView("world"), "hp") as DeclTerminalNode).derived, true);

    m.setDeclFormula("world", "hp", null);
    assert.deepEqual((t.world.children as any).hp, { valueType: "number" }); // formula 键移除
    assert.equal((childAt(m.buildRootView("world"), "hp") as DeclTerminalNode).derived, false);
  });

  it("union_attach：仅 string_list 末端；paths 须解析到同根容器/数组声明", () => {
    const t = makeTemplate();
    const m = modelOf(t);
    m.setDeclFormula("world", "pool", { op: "union_attach", paths: ["loc", "bag"] });
    assert.deepEqual((t.world.children as any).pool, { valueType: "string_list", formula: { op: "union_attach", paths: ["loc", "bag"] } });

    assert.throws(() => m.setDeclFormula("world", "hp", { op: "union_attach", paths: [] }), /string_list/);
    assert.throws(() => m.setDeclFormula("world", "pool", { op: "union_attach", paths: ["loc.name"] }), /容器\/数组声明/);
    assert.throws(() => m.setDeclFormula("world", "pool", { op: "union_attach", paths: ["nosuch"] }), /不可解析/);
  });

  it("expr：仅 number 末端；binds 须解析到同根 number 末端（数组层经下标段）；标识符合法", () => {
    const m = modelOf(makeTemplate());
    // 数组元素内末端可作 binds 目标（[*] 通配或精确下标）
    m.setDeclFormula("world", "hp", { expr: "w + 1", binds: { w: "bag[*].count" } });
    m.setDeclFormula("world", "hp", { expr: "w + 1", binds: { w: "bag[0].count" } });
    assert.throws(() => m.setDeclFormula("world", "loc.name", { expr: "1", binds: {} }), /number 末端/);
    assert.throws(() => m.setDeclFormula("world", "hp", { expr: "  ", binds: {} }), /不能为空/);
    assert.throws(() => m.setDeclFormula("world", "hp", { expr: "x + 1", binds: { x: "loc.name" } }), /number 末端/);
    assert.throws(() => m.setDeclFormula("world", "hp", { expr: "x + 1", binds: { x: "nosuch" } }), /number 末端/);
    assert.throws(() => m.setDeclFormula("world", "hp", { expr: "x + 1", binds: { "1x": "hp" } }), /标识符/);
    assert.throws(() => m.setDeclFormula("world", "hp", { wat: true } as never), /formula 须为/);
  });

  it("character 根模板契约保护：attachtags 不得挂 formula；tags 必须保持 union_attach", () => {
    const m = modelOf(makeTemplate());
    assert.throws(() => m.setDeclFormula("character", "attachtags", { op: "union_attach", paths: [] }), /attachtags/);
    assert.throws(() => m.setDeclFormula("character", "tags", null), /union_attach/);
  });

  it("character 根 tags 维持 union_attach 的合法改写放行", () => {
    const t = makeTemplate();
    const m = modelOf(t);
    m.setDeclFormula("character", "tags", { op: "union_attach", paths: ["gear"] });
    assert.deepEqual((t.character.children as any).tags.formula, { op: "union_attach", paths: ["gear"] });
  });
});

// ---------------------------------------------------------------------------
// 类型声明内 formula 编辑（binds/paths 以类型根为基准）
// ---------------------------------------------------------------------------

describe("var-decl-model：类型内 formula 编辑", () => {
  it("expr 挂上（简写升级完整形）→ 视图从动；清空变回普通末端；binds 以类型根为基准", () => {
    const t = makeTemplate();
    const m = modelOf(t);
    m.setTypeDeclFormula("item", "count", { expr: "w + 1", binds: { w: "parts[*].w" } });
    assert.deepEqual((t.types as any).item.children.count, {
      valueType: "number",
      formula: { expr: "w + 1", binds: { w: "parts[*].w" } },
    });
    const view = m.buildTypesView();
    const item = view.children[0] as TypeRootNode;
    const count = childAt(item, "count") as TypeDeclTerminalNode;
    assert.equal(count.derived, true);
    assert.deepEqual(count.formula, { kind: "expr", expr: "w + 1", binds: { w: "parts[*].w" } });

    m.setTypeDeclFormula("item", "count", null);
    assert.deepEqual((t.types as any).item.children.count, { valueType: "number" });
  });

  it("binds 可穿越嵌套数组元素解析（与服务端内联口径一致）；跨元素结构末端拒绝", () => {
    const t = makeTemplate();
    const m = modelOf(t);
    // parts = {array:{type:part}} 嵌套数组：parts[*].w / parts[0].w 均可解析
    m.setTypeDeclFormula("item", "count", { expr: "w * 2", binds: { w: "parts[*].w" } });
    m.setTypeDeclFormula("item", "count", { expr: "w * 2", binds: { w: "parts[0].w" } });
    assert.throws(() => m.setTypeDeclFormula("item", "count", { expr: "x + 1", binds: { x: "note" } }), /number 末端/);
    assert.throws(() => m.setTypeDeclFormula("item", "count", { expr: "x + 1", binds: { x: "nosuch" } }), /number 末端/);
    assert.throws(() => m.setTypeDeclFormula("item", "note", { expr: "1" }), /number 末端/);
  });

  it("union_attach 仅 string_list 末端；paths 以类型根为基准解析到容器/数组", () => {
    const t = makeTemplate();
    const m = modelOf(t);
    m.addTypeField("item", "", { name: "attachtags", valueType: "string_list" });
    m.setTypeDeclFormula("item", "attachtags", { op: "union_attach", paths: ["parts"] });
    assert.deepEqual((t.types as any).item.children.attachtags, {
      valueType: "string_list",
      formula: { op: "union_attach", paths: ["parts"] },
    });
    assert.throws(() => m.setTypeDeclFormula("item", "count", { op: "union_attach", paths: [] }), /string_list/);
    assert.throws(() => m.setTypeDeclFormula("item", "attachtags", { op: "union_attach", paths: ["count"] }), /容器\/数组声明/);
  });

  it("引用类型数组元素内的末端不开放（到其类型上编辑）；不可解析拒绝", () => {
    const m = modelOf(makeTemplate());
    assert.throws(() => m.setTypeDeclFormula("item", "parts[*].w", { expr: "1" }), /请到类型/);
    assert.throws(() => m.setTypeDeclFormula("item", "nosuch", { expr: "1" }), /不可解析/);
    assert.throws(() => m.setTypeDeclFormula("nosuch", "count", { expr: "1" }), /未声明/);
  });
});

// ---------------------------------------------------------------------------
// 保存载荷
// ---------------------------------------------------------------------------

describe("var-decl-model：保存载荷", () => {
  it("getTemplate 返回编辑后的模板工作副本本体", () => {
    const t = makeTemplate();
    const m = modelOf(t);
    m.addDecl("world", "", { name: "gold", valueType: "number" });
    assert.equal(m.getTemplate(), t);
    assert.equal((m.getTemplate().world.children as any).gold, "number");
  });

  it("保存载荷不含系统声明分支（显示注入不物化进模板 JSON）", () => {
    const t = makeTemplate();
    const m = modelOf(t);
    m.addDecl("character", "", { name: "mp", valueType: "number" });
    const out = m.getTemplate();
    assert.deepEqual(Object.keys(out.character.children), ["attachtags", "tags", "mood", "str", "double_str", "gear", "mp"]);
    assert.deepEqual(Object.keys(out.world.children), ["hp", "pool", "loc", "bag"]);
  });
});

// ---------------------------------------------------------------------------
// 系统声明分支并入（显示注入：只读呈现，绝不写回）
// ---------------------------------------------------------------------------

describe("var-decl-model：系统声明分支并入", () => {
  it("character 根视图 = 系统分支（system 标记 + 全操作禁）+ 作者子树原序；world 根不变", () => {
    const m = modelOf(makeTemplate());
    const view = m.buildRootView("character");
    assert.deepEqual(view.children.map((n) => n.key), [...SYSTEM_KEYS, "attachtags", "tags", "mood", "str", "double_str", "gear"]);

    // 系统节点：system 标记 + 不可删
    const name = childAt(view, "name") as DeclTerminalNode;
    assert.equal(name.kind, "declTerminal");
    assert.equal(name.valueType, "string");
    assert.equal(name.system, true);
    assert.equal(name.canDelete, false);
    const timer = childAt(view, "timer") as DeclTerminalNode;
    assert.equal(timer.system, true);
    assert.equal(timer.valueType, "number");

    // 系统容器：子字段递归同禁
    const location = childAt(view, "location") as DeclContainerNode;
    assert.equal(location.kind, "declContainer");
    assert.equal(location.system, true);
    assert.equal(location.canDelete, false);
    assert.deepEqual(location.children.map((n) => n.key), ["name", "level"]);
    for (const c of location.children as DeclTerminalNode[]) {
      assert.equal(c.system, true);
      assert.equal(c.canDelete, false);
    }

    // relations = 系统结构化数组（declArray，elementType relation）
    const relations = childAt(view, "relations") as DeclArrayNode;
    assert.equal(relations.kind, "declArray");
    assert.equal(relations.elementType, "relation");
    assert.equal(relations.system, true);
    assert.equal(relations.canDelete, false);

    // 作者子树不受影响：非 system，必需声明保护不变
    const mood = childAt(view, "mood") as DeclTerminalNode;
    assert.equal(mood.system, false);
    assert.equal(mood.canDelete, true);
    const tags = childAt(view, "tags") as DeclTerminalNode;
    assert.equal(tags.system, false);
    assert.equal(tags.canDelete, false);

    // world 根无系统节点
    const wview = m.buildRootView("world");
    assert.deepEqual(wview.children.map((n) => n.key), ["hp", "pool", "loc", "bag"]);
    for (const n of wview.children) assert.equal((n as DeclTerminalNode).system, false);
  });

  it("系统路径一切写操作抛错，工作副本不被波及", () => {
    const t = makeTemplate();
    const m = modelOf(t);
    const before = JSON.stringify(t);
    assert.throws(() => m.addDecl("character", "location", { name: "x", valueType: "number" }), /系统声明分支/);
    assert.throws(() => m.addDecl("character", "relations", { name: "x", valueType: "number" }), /系统声明分支/);
    assert.throws(() => m.deleteDecl("character", "name"), /系统声明分支/);
    assert.throws(() => m.deleteDecl("character", "location.name"), /系统声明分支/);
    assert.throws(() => m.deleteDecl("character", "relations[*].name"), /系统声明分支/);
    assert.throws(() => m.setDeclFormula("character", "level", { expr: "1", binds: {} }), /系统声明分支/);
    assert.throws(() => m.setDeclFormula("character", "timer", null), /系统声明分支/);
    assert.equal(JSON.stringify(t), before);
  });

  it("character 根新增与系统分支键同名 = 冲突拒绝（name/location/timer/…）", () => {
    const m = modelOf(makeTemplate());
    assert.throws(() => m.addDecl("character", "", { name: "name", valueType: "string" }), /系统声明分支同名冲突/);
    assert.throws(() => m.addDecl("character", "", { name: "location", kind: "struct" }), /系统声明分支同名冲突/);
    assert.throws(() => m.addDecl("character", "", { name: "timer", valueType: "number" }), /系统声明分支同名冲突/);
    assert.throws(() => m.addDecl("character", "", { name: "isPlayer", valueType: "boolean" }), /系统声明分支同名冲突/);
  });

  it("作者 formula 可绑系统 number 末端 / union_attach 可指系统容器或数组（与服务端并入后解析口径一致）", () => {
    const t = makeTemplate();
    const m = modelOf(t);
    m.setDeclFormula("character", "str", { expr: "level * 2", binds: { level: "level" } });
    assert.deepEqual((t.character.children as any).str, {
      valueType: "number",
      formula: { expr: "level * 2", binds: { level: "level" } },
    });
    m.setDeclFormula("character", "tags", { op: "union_attach", paths: ["gear", "location", "relations"] });
    assert.deepEqual((t.character.children as any).tags.formula, { op: "union_attach", paths: ["gear", "location", "relations"] });
    // 系统 string 末端不是合法 binds 目标
    assert.throws(() => m.setDeclFormula("character", "str", { expr: "x + 1", binds: { x: "name" } }), /number 末端/);
  });
});
