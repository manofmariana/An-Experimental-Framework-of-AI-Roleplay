/**
 * web/views/var-tree-model.js 单元测试（unit 层）：
 * 纯逻辑数据核心，零 DOM 零网络。只做实例状态编辑（结构编辑已迁世界页 var-decl-model，
 * 见 test/varDeclModel.test.ts）。覆盖：
 * - 视图模型：世界树滤 time 系统分支、实例简写读出、未声明键 unknown 呈现；
 * - 角色树 = 系统声明分支投影 + vars 实例树（同一棵树不分区）：系统分支值从类型化
 *   字段读出（timer/channel null 原样、initiative null = 容器无实例、relations =
 *   结构化数组按下标投影），系统只读收窄为 {acted, group, channel, timer, isPlayer, appearance}；
 * - 结构化数组：可折叠分支、元素增删（按元素结构物化空元素/按下标摘除）、元素内
 *   字段经 `键[下标]` 路径写值（嵌套数组递归）；
 * - 系统末端写值：回写类型化字段（omniscience 钳制 0-6、initiative null 两值齐全整体
 *   写入、relations 元素字段、long_term_memory）；系统调度字段拒写；
 * - 外壳 tags：全部末端可编——系统末端写 systemTags 侧车（数组层键 = `键[下标]`，
 *   relations 元素删除顺带重映射）、vars 末端写外壳；
 * - 从动判定：声明带 formula / 实例外壳带 formula 均只读且出结构化 formula 只读标注；
 * - vars 末端写值：外壳改写 / 无实例物化 / 简写物化 / 从动拒写 / valueType 校验；
 * - attachtags/tags 池 = string_list 纯名集合（值编辑走 string[] 校验）；
 * - 附加来源 tags 合并显示（sys.varsTags 读取期合并的只读 attachTags：节点级级联/
 *   末端级单挂/数组整型挂载 `[*]` 通配/cid 类别按属主分发，world 域 cid 跳过）+
 *   零泄漏红线（工作副本/保存载荷/侧车与附加前逐字节一致）；
 * - 保存载荷：world = 纯变量树工作副本本体（sys 不经本通道上送，状态编辑不动模板）。
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  createVarTreeModel,
  type ArrayElementNode,
  type ArrayNode,
  type ContainerNode,
  type TerminalNode,
  type VarTreeModel,
  type VarTreeNode,
} from "../web/views/var-tree-model.js";

// ---------------------------------------------------------------------------
// 夹具：原始模板（字符串简写 / 完整形末端 / 容器 / 结构化数组）+ 实例（外壳与简写混合）
// ---------------------------------------------------------------------------

function makeWorking() {
  const template = {
    world: {
      children: {
        hp: "number",
        luck: "number",
        pool: "tag_list",
        loc: { children: { name: "string", items: "string_list" } },
        bag: { array: { type: "item" } },
      },
    },
    character: {
      children: {
        attachtags: "string_list",
        tags: { valueType: "string_list", formula: { op: "union", terms: [{ attach: [] }] } },
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
  return {
    sys: {
      tagRegistry: { 暴怒: { name: "暴怒" }, 冷静: { name: "冷静" } },
      varsTemplate: template,
      varsTags: { world: {}, character: {} },
    },
    world: {
      time: { y: { value: 1, tags: [] } }, // time 系统分支（编辑器不呈现）
      hp: 5, // 简写末端
      luck: { value: 7, tags: [], formula: { expr: "1 + 1" } }, // 实例携带 formula → 从动
      loc: { name: "酒馆" }, // items 无实例
      bag: [{ count: 1, parts: [{ w: 2 }] }],
    },
    characters: {
      C1001: {
        name: "甲",
        gender: "女",
        age: "20",
        personality: "谨慎。",
        reaction: 3,
        level: 2,
        omniscience: 1,
        location: { name: "酒馆", level: 2 },
        initiative: null,
        relations: [{ cid: "C1002", name: "乙", impression: "老友" }],
        long_term_memory: ["记忆一", "记忆二"],
        timer: 120,
        group: 0,
        channel: null,
        acted: false,
        isPlayer: false,
        systemTags: { name: [{ name: "闻名", level: 2 }] },
        vars: {
          attachtags: { value: ["暴怒"], tags: [] },
          mood: "开心", // 简写末端
          str: { value: 3, tags: [{ name: "冷静", level: 1 }] },
          double_str: { value: 6, tags: [] },
        },
      },
      C1002: {
        name: "乙",
        relations: [],
        systemTags: {},
        vars: {
          attachtags: { value: [], tags: [] },
          custom: { value: 9, tags: [] }, // 未声明键 → unknown 呈现
        },
      },
    } as Record<string, any>,
  };
}

type Working = ReturnType<typeof makeWorking>;

function modelOf(working: Working): VarTreeModel {
  return createVarTreeModel({ world: working.world, characters: working.characters, sys: working.sys });
}

/** 按键取子节点（断言存在）。 */
function childAt(view: { children: VarTreeNode[] }, key: string): VarTreeNode {
  const hit = view.children.find((n) => n.key === key);
  assert.ok(hit, `缺节点 ${key}`);
  return hit;
}

function terminalOf(view: { children: VarTreeNode[] }, key: string): TerminalNode {
  const node = childAt(view, key);
  assert.equal(node.kind, "terminal", `${key} 应为末端`);
  return node as TerminalNode;
}

// ---------------------------------------------------------------------------
// 视图模型
// ---------------------------------------------------------------------------

describe("var-tree-model：视图模型", () => {
  it("世界树滤掉 time 系统分支；简写末端读出值；结构化数组展开元素", () => {
    const m = modelOf(makeWorking());
    const tree = m.buildTree("world");
    const keys = tree.children.map((n) => n.key);
    assert.deepEqual(keys, ["hp", "luck", "pool", "loc", "bag"]); // time 系统分支不显示

    const hp = terminalOf(tree, "hp");
    assert.equal(hp.valueType, "number");
    assert.equal(hp.hasInstance, true);
    assert.equal(hp.value, 5); // 简写容错读出
    assert.deepEqual(hp.tags, []);
    assert.equal(hp.derived, false);
    assert.equal(hp.system, false);

    const loc = childAt(tree, "loc") as ContainerNode;
    assert.equal(loc.kind, "container");
    assert.equal(terminalOf(loc, "name").value, "酒馆");
    const items = terminalOf(loc, "items");
    assert.equal(items.hasInstance, false); // 有声明无实例
    assert.equal(items.value, undefined);

    const bag = childAt(tree, "bag") as ArrayNode;
    assert.equal(bag.kind, "array");
    assert.equal(bag.elementType, "item");
    assert.equal(bag.children.length, 1);
    const sword = bag.children[0] as ArrayElementNode;
    assert.equal(sword.kind, "arrayElement");
    assert.equal(sword.key, "0");
    assert.equal(sword.path, "bag[0]");
    assert.equal(sword.canRemoveElement, true);
    assert.equal(terminalOf(sword, "count").value, 1);
    assert.equal(terminalOf(sword, "note").hasInstance, false);
    const parts = childAt(sword, "parts") as ArrayNode;
    assert.equal(parts.kind, "array"); // 嵌套数组
    assert.equal(parts.children.length, 1); // 一个零件元素
    assert.equal((parts.children[0] as ArrayElementNode).path, "bag[0].parts[0]");
  });

  it("从动判定：声明带 formula 与实例外壳带 formula 均只读且出结构化只读标注", () => {
    const m = modelOf(makeWorking());
    const world = m.buildTree("world");
    const luck = terminalOf(world, "luck"); // 实例 formula
    assert.equal(luck.derived, true);
    assert.match(luck.formulaText!, /1 \+ 1/);
    assert.deepEqual(luck.formula, { kind: "expr", expr: "1 + 1", binds: {} });

    const char = m.buildTree("C1001");
    const dbl = terminalOf(char, "double_str"); // 声明 formula
    assert.equal(dbl.derived, true);
    assert.deepEqual(dbl.formula, { kind: "expr", expr: "str * 2", binds: { str: "str" } });

    const tags = terminalOf(char, "tags"); // union 从动
    assert.equal(tags.derived, true);
    assert.deepEqual(tags.formula, {
      kind: "union",
      paths: [],
      sys: { cid: false, location: false, channel: false },
      hasAttach: true,
    });
  });

  it("角色树：系统声明分支投影在前（系统调度字段只读徽记）、vars 树随后，同一棵树不分区", () => {
    const m = modelOf(makeWorking());
    const tree = m.buildTree("C1001");
    const keys = tree.children.map((n) => n.key);
    assert.deepEqual(keys, [
      "cid", "name", "gender", "age", "personality", "reaction", "level", "omniscience",
      "location", "initiative", "relations", "long_term_memory",
      "acted", "group", "channel", "timer", "isPlayer", "appearance",
      "attachtags", "tags", "mood", "str", "double_str", "gear",
    ]);
    assert.ok(tree.children.every((n) => n.key !== "vars" && n.key !== "systemTags"));

    // 系统分支末端 = 标准末端节点（值从类型化字段投影；外壳 tags 来自侧车）
    const name = terminalOf(tree, "name");
    assert.equal(name.valueType, "string");
    assert.equal(name.value, "甲");
    assert.equal(name.system, false);
    assert.deepEqual(name.tags, [{ name: "闻名", level: 2 }]); // 侧车
    assert.deepEqual(terminalOf(tree, "long_term_memory").value, ["记忆一", "记忆二"]);

    // 系统调度字段 + cid：system 徽记（值只读）；timer 有值、channel null 原样
    for (const key of ["cid", "acted", "group", "channel", "timer", "isPlayer", "appearance"]) {
      assert.equal(terminalOf(tree, key).system, true, key);
    }
    assert.equal(terminalOf(tree, "timer").value, 120);
    assert.equal(terminalOf(tree, "channel").value, null);

    // location / initiative = 普通容器（initiative null = 子末端皆无实例）
    const location = childAt(tree, "location") as ContainerNode;
    assert.equal(location.kind, "container");
    assert.equal(terminalOf(location, "name").value, "酒馆");
    assert.equal(terminalOf(location, "level").value, 2);
    const initiative = childAt(tree, "initiative") as ContainerNode;
    assert.equal(initiative.kind, "container");
    assert.ok(initiative.children.every((c) => c.kind === "terminal" && !c.hasInstance));

    // relations = 结构化数组（元素含 cid 字段，按下标投影）
    const relations = childAt(tree, "relations") as ArrayNode;
    assert.equal(relations.kind, "array");
    assert.equal(relations.elementType, "relation");
    const entry = relations.children[0] as ArrayElementNode;
    assert.equal(entry.kind, "arrayElement");
    assert.equal(entry.key, "0");
    assert.equal(entry.path, "relations[0]");
    assert.equal(terminalOf(entry, "cid").value, "C1002");
    assert.equal(terminalOf(entry, "name").value, "乙");
    assert.equal(terminalOf(entry, "impression").value, "老友");

    // vars 树照常：attachtags = string_list 纯名集合、tags 从动标注
    const attachtags = terminalOf(tree, "attachtags");
    assert.equal(attachtags.valueType, "string_list");
    assert.deepEqual(attachtags.value, ["暴怒"]);
    assert.equal(terminalOf(tree, "mood").value, "开心"); // 简写读出
    assert.deepEqual(terminalOf(tree, "str").tags, [{ name: "冷静", level: 1 }]);
  });

  it("实例侧未声明键以 unknown 只读呈现（不静默隐藏）", () => {
    const m = modelOf(makeWorking());
    const tree = m.buildTree("C1002");
    const custom = childAt(tree, "custom");
    assert.equal(custom.kind, "unknown");
  });

  it("listScopes = 世界 + 各 CID；getTagNames 来自 sys.tagRegistry", () => {
    const m = modelOf(makeWorking());
    assert.deepEqual(
      m.listScopes().map((s) => s.id),
      ["world", "C1001", "C1002"],
    );
    assert.equal(m.listScopes()[0]!.label, "世界");
    assert.deepEqual(m.getTagNames(), ["暴怒", "冷静"]);
  });
});

// ---------------------------------------------------------------------------
// 系统末端写值（回写类型化字段）
// ---------------------------------------------------------------------------

describe("var-tree-model：系统末端写值", () => {
  it("string/number/string_list 系统末端写值；omniscience 钳制 0-6", () => {
    const w = makeWorking();
    const m = modelOf(w);
    m.writeTerminalValue("C1001", "name", "新名");
    assert.equal(w.characters.C1001.name, "新名");
    m.writeTerminalValue("C1001", "reaction", 9);
    assert.equal(w.characters.C1001.reaction, 9);
    m.writeTerminalValue("C1001", "long_term_memory", ["甲一", "乙二"]);
    assert.deepEqual(w.characters.C1001.long_term_memory, ["甲一", "乙二"]);

    m.writeTerminalValue("C1001", "omniscience", 9);
    assert.equal(w.characters.C1001.omniscience, 6); // 上钳
    m.writeTerminalValue("C1001", "omniscience", -3);
    assert.equal(w.characters.C1001.omniscience, 0); // 下钳
  });

  it("location 子字段写入；initiative null 须两值齐全整体写入（不清空回 null）", () => {
    const w = makeWorking();
    const m = modelOf(w);
    m.writeTerminalValue("C1001", "location.level", 5);
    assert.deepEqual(w.characters.C1001.location, { name: "酒馆", level: 5 });

    // initiative = null：子字段写入被拒
    assert.throws(() => m.writeTerminalValue("C1001", "initiative.value", 3), /两值齐全/);
    // 整体写入缺子字段被拒
    assert.throws(() => m.writeTerminalValue("C1001", "initiative", { value: 3 }), /两值齐全/);
    // 两值齐全 → 写回对象
    m.writeTerminalValue("C1001", "initiative", { value: 3, group: 1 });
    assert.deepEqual(w.characters.C1001.initiative, { value: 3, group: 1 });
    // 已有对象后子字段可写
    m.writeTerminalValue("C1001", "initiative.group", 2);
    assert.deepEqual(w.characters.C1001.initiative, { value: 3, group: 2 });
  });

  it("值类型错配即抛；系统调度字段拒写；未知路径拒写；世界作用域无系统分支", () => {
    const m = modelOf(makeWorking());
    assert.throws(() => m.writeTerminalValue("C1001", "reaction", "x"), /错配/);
    assert.throws(() => m.writeTerminalValue("C1001", "long_term_memory", [1]), /错配/);
    assert.throws(() => m.writeTerminalValue("C1001", "timer", 5), /只读/);
    assert.throws(() => m.writeTerminalValue("C1001", "acted", true), /只读/);
    assert.throws(() => m.writeTerminalValue("C1001", "isPlayer", true), /只读/);
    assert.throws(() => m.writeTerminalValue("C1001", "nosuch", 1), /不是已声明的末端/);
    assert.throws(() => m.writeTerminalValue("world", "name", "x"), /不是已声明的末端/);
  });

  it("relations 元素字段经末端写值回写；条目增删走数组元素通道", () => {
    const w = makeWorking();
    const m = modelOf(w);
    m.writeTerminalValue("C1001", "relations[0].name", "乙改");
    assert.deepEqual(w.characters.C1001.relations[0], { cid: "C1002", name: "乙改", impression: "老友" });
    assert.throws(() => m.writeTerminalValue("C1001", "relations[5].name", "x"), /不存在/);

    m.addRelationEntry("C1001", "C1003");
    assert.deepEqual(w.characters.C1001.relations[1], { cid: "C1003" });
    assert.throws(() => m.addRelationEntry("C1001", "C1003"), /已存在/);
    assert.throws(() => m.addRelationEntry("C1001", "@C1002"), /已存在/, "前导 @ 归一化后判重");
    m.writeTerminalValue("C1001", "relations[1].impression", "陌生");
    assert.deepEqual(w.characters.C1001.relations[1], { cid: "C1003", impression: "陌生" });

    // 视图立刻反映
    const relationsView = childAt(m.buildTree("C1001"), "relations") as ArrayNode;
    assert.deepEqual(relationsView.children.map((c) => c.key), ["0", "1"]);

    m.removeArrayElement("C1001", "relations", 0);
    assert.deepEqual(w.characters.C1001.relations, [{ cid: "C1003", impression: "陌生" }]);
    assert.throws(() => m.removeArrayElement("C1001", "relations", 5), /不存在/);
    // relations 之外的系统数组不存在；系统数组元素新增走 addRelationEntry
    assert.throws(() => m.addArrayElement("C1001", "relations"), /addRelationEntry/);
  });
});

// ---------------------------------------------------------------------------
// vars 末端写值与 tags 编辑
// ---------------------------------------------------------------------------

describe("var-tree-model：vars 末端写值", () => {
  it("外壳改写 / 无实例物化 / 简写物化", () => {
    const w = makeWorking();
    const m = modelOf(w);
    m.writeTerminalValue("world", "hp", 42); // 简写 → 物化外壳
    assert.deepEqual(w.world.hp, { value: 42, tags: [] });
    m.writeTerminalValue("world", "loc.items", ["面包", "钥匙"]); // 无实例 → 物化
    const loc = w.world.loc as Record<string, unknown>;
    assert.deepEqual(loc.items, { value: ["面包", "钥匙"], tags: [] });
    m.writeTerminalValue("C1001", "mood", "低落"); // 角色域简写物化
    const vars = w.characters.C1001.vars as Record<string, unknown>;
    assert.deepEqual(vars.mood, { value: "低落", tags: [] });
    m.writeTerminalValue("C1001", "str", 9); // 外壳改写：tags 保留
    assert.deepEqual(vars.str, { value: 9, tags: [{ name: "冷静", level: 1 }] });
  });

  it("从动末端拒写（声明 formula / 实例 formula）", () => {
    const m = modelOf(makeWorking());
    assert.throws(() => m.writeTerminalValue("C1001", "double_str", 9), /从动/);
    assert.throws(() => m.writeTerminalValue("world", "luck", 9), /从动/);
  });

  it("valueType 校验：错配即抛，不污染副本", () => {
    const w = makeWorking();
    const m = modelOf(w);
    assert.throws(() => m.writeTerminalValue("world", "hp", "x"), /错配/);
    assert.throws(() => m.writeTerminalValue("world", "hp", Number.NaN), /错配/);
    assert.throws(() => m.writeTerminalValue("world", "loc.items", [1]), /错配/);
    assert.equal(w.world.hp, 5); // 未污染
    assert.throws(() => m.writeTerminalValue("world", "nosuch", 1), /不是已声明的末端/);
  });

  it("attachtags（string_list 纯名集合）值编辑走 writeTerminalValue 同一校验", () => {
    const w = makeWorking();
    const m = modelOf(w);
    m.writeTerminalValue("C1001", "attachtags", ["自由输入名"]);
    const vars = w.characters.C1001.vars as Record<string, { value: unknown }>;
    assert.deepEqual(vars.attachtags!.value, ["自由输入名"]);
    assert.throws(() => m.writeTerminalValue("C1001", "attachtags", [{ name: "x", level: 1 }]), /错配/);
  });

  it("数组元素内末端写值（`键[下标]` 路径；嵌套数组递归）", () => {
    const w = makeWorking();
    const m = modelOf(w);
    m.writeTerminalValue("world", "bag[0].count", 3);
    assert.deepEqual((w.world.bag as Record<string, unknown>[])[0]!.count, { value: 3, tags: [] });
    m.writeTerminalValue("world", "bag[0].note", "锋利"); // 无实例物化
    assert.deepEqual((w.world.bag as Record<string, unknown>[])[0]!.note, { value: "锋利", tags: [] });
    m.writeTerminalValue("world", "bag[0].parts[0].w", 9); // 嵌套数组
    const parts = (w.world.bag as Record<string, unknown>[])[0]!.parts as Record<string, unknown>[];
    assert.deepEqual(parts[0]!.w, { value: 9, tags: [] });
    m.writeTerminalValue("world", "bag[2].count", 1); // 元素缺失沿途补建（防御路径，DOM 只渲染已有元素）
    assert.deepEqual((w.world.bag as Record<string, unknown>[])[2], { count: { value: 1, tags: [] } });
  });
});

// ---------------------------------------------------------------------------
// 外壳 tags 编辑（系统末端写侧车、vars 末端写外壳）
// ---------------------------------------------------------------------------

describe("var-tree-model：外壳 tags 编辑", () => {
  it("vars 末端：合法写入；level 越界即抛；简写物化保留原值", () => {
    const w = makeWorking();
    const m = modelOf(w);
    m.writeTerminalTags("C1001", "str", [{ name: "暴怒", level: 2 }]);
    const vars = w.characters.C1001.vars as Record<string, { value: unknown; tags: unknown }>;
    assert.equal(vars.str!.value, 3); // 原值保留
    assert.deepEqual(vars.str!.tags, [{ name: "暴怒", level: 2 }]);

    m.writeTerminalTags("C1001", "mood", [{ name: "冷静", level: 7 }]); // 简写物化
    assert.deepEqual(vars.mood, { value: "开心", tags: [{ name: "冷静", level: 7 }] });

    assert.throws(() => m.writeTerminalTags("C1001", "str", [{ name: "x", level: 0 }]), /形状非法/);
    assert.throws(() => m.writeTerminalTags("C1001", "str", [{ name: "x", level: 8 }]), /形状非法/);
    assert.throws(() => m.writeTerminalTags("C1001", "str", [{ name: "", level: 1 }]), /形状非法/);
  });

  it("数组元素内 vars 末端 tags 写外壳（元素自身无 tags 挂载位）", () => {
    const w = makeWorking();
    const m = modelOf(w);
    m.writeTerminalTags("world", "bag[0].count", [{ name: "暴怒", level: 1 }]);
    const bag = w.world.bag as Record<string, unknown>[];
    assert.deepEqual((bag[0]!.count as { tags: unknown }).tags, [{ name: "暴怒", level: 1 }]);
    // 数组节点/元素对象不是末端：拒绝
    assert.throws(() => m.writeTerminalTags("world", "bag", []), /不是已声明的末端/);
    assert.throws(() => m.writeTerminalTags("world", "bag[0]", []), /不是已声明的末端/);
  });

  it("系统末端：写 systemTags 侧车（空表摘键），值不变", () => {
    const w = makeWorking();
    const m = modelOf(w);
    m.writeTerminalTags("C1001", "name", [{ name: "冷静", level: 1 }]);
    assert.deepEqual(w.characters.C1001.systemTags, { name: [{ name: "冷静", level: 1 }] });
    assert.equal(w.characters.C1001.name, "甲"); // 值不动
    // 视图立刻反映
    assert.deepEqual(terminalOf(m.buildTree("C1001"), "name").tags, [{ name: "冷静", level: 1 }]);

    m.writeTerminalTags("C1001", "relations[0].name", [{ name: "暴怒", level: 4 }]);
    assert.deepEqual(w.characters.C1001.systemTags["relations[0].name"], [{ name: "暴怒", level: 4 }]);
    // 系统调度字段的外壳 tags 同样可编
    m.writeTerminalTags("C1001", "timer", [{ name: "冷静", level: 2 }]);
    assert.deepEqual(w.characters.C1001.systemTags["timer"], [{ name: "冷静", level: 2 }]);

    m.writeTerminalTags("C1001", "name", []); // 空表摘键
    assert.equal(Object.hasOwn(w.characters.C1001.systemTags, "name"), false);
    // relations 条目删除顺带摘侧车（被删下标摘除、其后前移）
    m.writeTerminalTags("C1001", "relations[0].impression", [{ name: "冷静", level: 3 }]);
    m.addRelationEntry("C1001", "C1009");
    m.writeTerminalTags("C1001", "relations[1].name", [{ name: "闻名", level: 1 }]);
    m.removeArrayElement("C1001", "relations", 0);
    assert.equal(Object.hasOwn(w.characters.C1001.systemTags, "relations[0].impression"), false);
    assert.deepEqual(w.characters.C1001.systemTags["relations[0].name"], [{ name: "闻名", level: 1 }], "后位下标前移");
  });
});

// ---------------------------------------------------------------------------
// 结构化数组元素增删（状态操作：只动实例不动模板）
// ---------------------------------------------------------------------------

describe("var-tree-model：数组元素增删", () => {
  it("新增元素按元素结构物化空白（嵌套容器递归、嵌套数组留空），不动模板", () => {
    const w = makeWorking();
    const m = modelOf(w);
    const tplBefore = JSON.stringify(w.sys.varsTemplate);
    m.addArrayElement("world", "bag");
    assert.deepEqual((w.world.bag as any)[1], {
      count: { value: 0, tags: [] },
      note: { value: "", tags: [] },
      parts: [], // 嵌套数组空白起步
    });
    assert.equal(JSON.stringify(w.sys.varsTemplate), tplBefore); // 模板不动

    // 角色域：数组实例整体缺失时补建
    m.addArrayElement("C1001", "gear");
    assert.deepEqual((w.characters.C1001.vars as any).gear[0].count, { value: 0, tags: [] });

    const bag = childAt(m.buildTree("world"), "bag") as ArrayNode;
    assert.deepEqual(bag.children.map((n) => n.key), ["0", "1"]);
  });

  it("非数组路径拒绝；系统数组走 addRelationEntry", () => {
    const m = modelOf(makeWorking());
    assert.throws(() => m.addArrayElement("world", "loc"), /不是结构化数组/);
    assert.throws(() => m.addArrayElement("C1001", "relations"), /addRelationEntry/);
    assert.throws(() => m.removeArrayElement("world", "loc", 0), /不是结构化数组/);
    assert.throws(() => m.removeArrayElement("world", "bag", 9), /不存在/);
  });

  it("删除元素只动实例不动模板", () => {
    const w = makeWorking();
    const m = modelOf(w);
    const tplBefore = JSON.stringify(w.sys.varsTemplate);
    m.removeArrayElement("world", "bag", 0);
    assert.deepEqual(w.world.bag, []);
    assert.equal(JSON.stringify(w.sys.varsTemplate), tplBefore);
    assert.throws(() => m.removeArrayElement("world", "bag", 0), /不存在/);
  });
});

// ---------------------------------------------------------------------------
// 保存载荷
// ---------------------------------------------------------------------------

describe("var-tree-model：保存载荷", () => {
  it("getPayload 返回编辑后的工作副本本体（world = 纯变量树；sys 不经本通道）", () => {
    const w = makeWorking();
    const m = modelOf(w);
    const tplBefore = JSON.stringify(w.sys.varsTemplate);
    m.writeTerminalValue("world", "hp", 42);
    const payload = m.getPayload();
    assert.equal(payload.world, w.world);
    assert.equal(payload.characters, w.characters);
    assert.deepEqual((payload.world as Record<string, unknown>).hp, { value: 42, tags: [] });
    assert.equal(JSON.stringify(w.sys.varsTemplate), tplBefore); // 状态编辑不动模板
  });
});

// ---------------------------------------------------------------------------
// 附加来源 tags 合并显示（vars-tags 读取期合并的只读镜像；零泄漏红线）
// ---------------------------------------------------------------------------

/** 含 TAG 附加条目的工作副本：根级级联 / 末端级单挂 / 整型挂载 / cid 类别分发齐备。 */
function makeWorkingWithAttach() {
  const w = makeWorking();
  (w.sys as any).tagRegistry = {
    暴怒: { name: "暴怒" },
    冷静: { name: "冷静" },
    cid: { name: "cid", system: true, category: "cid" },
    channel: { name: "channel", system: true, category: "channel" },
  };
  (w.sys as any).varsTags = {
    world: {
      tags: [{ name: "全域", level: 2 }], // 根节点级：级联到 world 全部末端
      children: {
        loc: { tags: [{ category: "cid", level: 1 }] }, // world 域无属主：cid 条目跳过（loc 子树零附加）
        bag: { tags: [{ category: "channel", level: 3 }], array: "item" }, // 整型挂载：扇出到 item 全部末端（[*] 占位）
      },
    },
    character: {
      tags: [
        { category: "cid", level: 1 }, // character 根：cid 按属主分发到全部末端
        { name: "冷静", level: 5 }, // 与 str 实例持有同名：显示按名去重（实例优先）
      ],
      children: {
        str: { tags: [{ name: "刚毅", level: 3 }] }, // 末端级单挂
        gear: { tags: [{ name: "随身", level: 2 }], array: "item" }, // 整型挂载
      },
    },
  };
  return w;
}

describe("var-tree-model：附加来源 tags 合并显示（只读）", () => {
  it("节点级级联：根条目挂到全部后代末端；末端级单挂只挂本末端", () => {
    const m = modelOf(makeWorkingWithAttach());
    const world = m.buildTree("world");
    // 根级级联：hp/loc.name 都挂「全域」
    assert.deepEqual(terminalOf(world, "hp").attachTags, [{ name: "全域", level: 2 }]);
    const loc = childAt(world, "loc") as ContainerNode;
    assert.deepEqual(terminalOf(loc, "name").attachTags, [{ name: "全域", level: 2 }]);
    // world 域无属主：loc 上的 cid 条目跳过（loc.name 只有根级「全域」）

    const tree = m.buildTree("C1001");
    // 末端级单挂：str 挂「刚毅」，mood 不挂
    assert.deepEqual(terminalOf(tree, "str").attachTags, [
      { name: "C1001", level: 1 },
      { name: "刚毅", level: 3 },
    ]);
    assert.deepEqual(terminalOf(tree, "mood").attachTags, [
      { name: "C1001", level: 1 },
      { name: "冷静", level: 5 },
    ]);
  });

  it("cid 类别按当前 scope 角色 CID 分发；与实例持有同名按名去重（实例优先）", () => {
    const m = modelOf(makeWorkingWithAttach());
    // C1001/C1002 各自分发自身 CID；系统分支投影末端同样覆盖
    assert.deepEqual(terminalOf(m.buildTree("C1001"), "name").attachTags, [
      { name: "C1001", level: 1 },
      { name: "冷静", level: 5 },
    ]);
    assert.deepEqual(terminalOf(m.buildTree("C1002"), "attachtags").attachTags, [
      { name: "C1002", level: 1 },
      { name: "冷静", level: 5 },
    ]);
    // str 实例已持有「冷静」：附加同名条目去重不出现
    const strAttach = terminalOf(m.buildTree("C1001"), "str").attachTags;
    assert.ok(strAttach.every((t) => t.name !== "冷静"), "实例持有的同名附加条目应去重");
  });

  it("整型挂载：数组层 [*] 占位按下标匹配（含嵌套数组）", () => {
    const m = modelOf(makeWorkingWithAttach());
    const world = m.buildTree("world");
    const bag = childAt(world, "bag") as ArrayNode;
    const sword = bag.children[0] as ArrayElementNode;
    // bag {tags:[channel], array:item} → bag[*] 全部末端
    assert.deepEqual(terminalOf(sword, "count").attachTags, [
      { name: "全域", level: 2 },
      { name: "channel", level: 3 },
    ]);
    // 嵌套数组 parts：bag[*].parts[*].w
    const parts = childAt(sword, "parts") as ArrayNode;
    const blade = parts.children[0] as ArrayElementNode;
    assert.deepEqual(terminalOf(blade, "w").attachTags, [
      { name: "全域", level: 2 },
      { name: "channel", level: 3 },
    ]);
  });

  it("零泄漏红线：附加来源只作显示——工作副本/保存载荷/侧车与附加前逐字节一致", () => {
    const w = makeWorkingWithAttach();
    const before = JSON.stringify({ world: w.world, characters: w.characters });
    const m = modelOf(w);
    // 显示层确认附加条目在场
    assert.ok(terminalOf(m.buildTree("C1001"), "str").attachTags.length > 0);
    assert.ok(terminalOf(m.buildTree("world"), "hp").attachTags.length > 0);
    // 保存载荷与附加前完全一致（getPayload 即工作副本本体）
    assert.equal(JSON.stringify(m.getPayload()), before, "保存载荷不得含附加来源条目");
    // 编辑实例 tags 后仍不混入附加条目
    m.writeTerminalTags("C1001", "str", [{ name: "暴怒", level: 2 }]);
    const vars = w.characters.C1001.vars as Record<string, { tags: unknown }>;
    assert.deepEqual(vars.str!.tags, [{ name: "暴怒", level: 2 }]);
    assert.deepEqual(w.characters.C1001.systemTags, { name: [{ name: "闻名", level: 2 }] }, "侧车零泄漏");
    // 除上述实例 tags 编辑外，其余与附加前一致
    const after = JSON.parse(JSON.stringify(m.getPayload())) as any;
    after.characters.C1001.vars.str.tags = [{ name: "冷静", level: 1 }]; // 还原编辑位再整体比对
    assert.deepEqual(after, JSON.parse(before));
  });

  it("无 varsTags/无类别声明时 attachTags 恒为空（旧档兼容）", () => {
    const m = modelOf(makeWorking());
    for (const scope of ["world", "C1001"]) {
      const walk = (nodes: VarTreeNode[]): void => {
        for (const n of nodes) {
          if (n.kind === "terminal") assert.deepEqual(n.attachTags, [], `${scope}:${n.path}`);
          if ("children" in n) walk(n.children as VarTreeNode[]);
        }
      };
      walk(m.buildTree(scope).children);
    }
  });
});
